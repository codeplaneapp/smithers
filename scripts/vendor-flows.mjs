/**
 * Vendors the flows packages into `vendor/flows/` as reproducible tarballs.
 *
 * The flows alpha is not published. Every stage of the flows migration still
 * has to import the library from this repository, so the tarballs stand in for
 * the registry until the alpha ships. See `vendor/flows/README.md`
 * for the wiring and for the swap that removes this directory.
 *
 * The source checkout is an argument, or `SMITHERS_FLOWS_REPO`, and defaults to
 * the sibling `../flows/flows` next to this repository. Packing reads that
 * checkout and writes nothing to it: each package is staged into a temporary
 * copy whose `exports` are rewritten from `publishConfig.exports`, exactly the
 * way `scripts/pack-release.mjs` in the flows repository does it, because those
 * manifests point `exports` at TypeScript source that only resolves inside the
 * flows workspace.
 *
 * `pnpm pack` writes byte-identical tarballs for identical inputs, so re-running
 * this script produces no diff. Tarballs in `vendor/flows/` that fall out of the
 * closure are removed.
 *
 * usage:
 *   node scripts/vendor-flows.mjs [<flows-checkout>]
 *   node scripts/vendor-flows.mjs --check [<flows-checkout>]   fail if a re-pack would change anything, writing nothing
 *   node scripts/vendor-flows.mjs --list  [<flows-checkout>]   print the closure
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the vendored tarballs and their manifest live. */
export const vendorDirectory = join(repoRoot, "vendor", "flows");

/**
 * The flows packages this repository names directly.
 *
 * `@smthrs/flows` is the umbrella; the rest are what the migration lanes import
 * on their own. Everything these depend on is vendored with them, because no
 * `@smthrs/*` name in the flows tree is on the registry.
 */
export const rootPackages = [
  "@smthrs/flows",
  "@smthrs/flow",
  "@smthrs/engine",
  "@smthrs/engine-store",
  "@smthrs/plan",
  "@smthrs/journal",
  "@smthrs/run-store",
  "@smthrs/harness",
  "@smthrs/model",
  "@smthrs/core",
  "@smthrs/std",
  "@smthrs/patterns",
];

/**
 * Resolves the flows checkout to pack from.
 *
 * The default is relative to this repository, never an absolute path belonging
 * to one machine.
 */
export const flowsCheckout = (argument) =>
  resolve(repoRoot, argument ?? process.env.SMITHERS_FLOWS_REPO ?? join("..", "flows", "flows"));

/** Reads every `packages/*` manifest in a flows checkout, keyed by package name. */
export const readFlowsManifests = (checkout) => {
  const packagesRoot = join(checkout, "packages");
  if (!existsSync(packagesRoot)) {
    throw new Error(`${checkout} does not look like a flows checkout: no packages/ directory`);
  }
  const manifests = new Map();
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesRoot, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private || typeof manifest.name !== "string") continue;
    manifests.set(manifest.name, { directory: entry.name, manifest });
  }
  return manifests;
};

/**
 * The `@smthrs/*` closure of `names`, sorted by package name.
 *
 * A tarball whose dependency is missing from `vendor/flows/` would send pnpm to
 * the registry for a name nobody published, so the closure is transitive over
 * both `dependencies` and `peerDependencies`.
 */
export const closureOf = (names, manifests) => {
  const found = new Set();
  const pending = [...names];
  while (pending.length > 0) {
    const name = pending.pop();
    const entry = manifests.get(name);
    if (entry === undefined) {
      throw new Error(`${name} is not a publishable package of the flows checkout`);
    }
    if (found.has(name)) continue;
    found.add(name);
    const { dependencies, peerDependencies } = entry.manifest;
    for (const dependency of Object.keys({ ...dependencies, ...peerDependencies })) {
      if (dependency.startsWith("@smthrs/")) pending.push(dependency);
    }
  }
  return [...found].sort();
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Produces the manifest that belongs in a tarball.
 *
 * The flows manifests keep `exports` pointed at `src/*.ts` so the flows
 * workspace type-checks against source. A consumer needs the built artifacts,
 * which is what `publishConfig.exports` names.
 */
export const publicationManifest = (manifest) => {
  const publishConfig = manifest.publishConfig;
  if (!isRecord(publishConfig) || !isRecord(publishConfig.exports)) {
    throw new TypeError(`${String(manifest.name ?? "package")} must declare publishConfig.exports`);
  }
  const { exports, ...publishedConfig } = publishConfig;
  return { ...manifest, exports, publishConfig: publishedConfig };
};

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
};

/**
 * Fails before packing when the flows checkout has no ESM build for a module.
 *
 * ESM is what this repository resolves, so an incomplete `dist/esm` is fatal.
 * `dist/cjs` is packed when it is there and reported when it is not: a working
 * flows checkout often carries a stale CJS build, and refusing to vendor over
 * that would mean this script only ever ran against a release build.
 */
const assertBuilt = async (packageRoot, name) => {
  const sourceRoot = join(packageRoot, "src");
  const staleCommonJs = [];
  for (const source of await sourceFiles(sourceRoot)) {
    const modulePath = relative(sourceRoot, source).slice(0, -3);
    try {
      await Promise.all([
        access(join(packageRoot, "dist", "esm", `${modulePath}.js`)),
        access(join(packageRoot, "dist", "esm", `${modulePath}.d.ts`)),
      ]);
    } catch {
      throw new Error(
        `${name} has no ESM build for ${modulePath} in ${packageRoot}/dist/esm; run \`pnpm build\` in the flows checkout`,
      );
    }
    try {
      await access(join(packageRoot, "dist", "cjs", `${modulePath}.js`));
    } catch {
      staleCommonJs.push(modulePath);
    }
  }
  return staleCommonJs.sort();
};

const copyFilter = (packageRoot) => (source) => {
  const path = relative(packageRoot, source);
  if (path === "") return true;
  const segments = path.split(sep);
  return (
    !segments.some((segment) => segment === "node_modules" || segment === "coverage" || segment === ".smithers") &&
    !basename(path).endsWith(".tsbuildinfo")
  );
};

const run = (command, args, cwd) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });

/** The tarball name pnpm reported, without the directory it wrote it to. */
export const packResultFilename = (result, packageName) => {
  if (!isRecord(result) || typeof result.filename !== "string") {
    throw new Error(`pnpm pack returned no filename for ${String(packageName)}`);
  }
  return basename(result.filename);
};

const packPackage = async (name, entry, checkout, destination, stagingRoot) => {
  const packageRoot = join(checkout, "packages", entry.directory);
  const staleCommonJs = await assertBuilt(packageRoot, name);
  const staged = join(stagingRoot, entry.directory);
  await cp(packageRoot, staged, { recursive: true, filter: copyFilter(packageRoot) });
  await writeFile(join(staged, "package.json"), `${JSON.stringify(publicationManifest(entry.manifest), null, 2)}\n`);
  const output = await run(
    "pnpm",
    ["--dir", staged, "pack", "--json", "--config.ignore-scripts=true", "--pack-destination", destination],
    staged,
  );
  const filename = packResultFilename(JSON.parse(output), name);
  return {
    name,
    version: entry.manifest.version,
    filename,
    integrity: `sha256-${createHash("sha256")
      .update(await readFile(join(destination, filename)))
      .digest("base64")}`,
    staleCommonJs,
  };
};

/**
 * The manifest of the workspace package that installs the vendored tarballs.
 *
 * This package exists so the flows dependency edges live somewhere pnpm reads
 * and bun does not. `pnpm-workspace.yaml` lists `vendor/flows`; the `workspaces`
 * array in the root manifest, which is what bun reads, deliberately does not.
 * bun cannot express a version-scoped override, and the only override form it
 * understands would redirect this repository's own `@smthrs/engine`, so the
 * flows edges have to stay outside its view. `.npmrc` public-hoists `@flows/*`
 * into the root `node_modules`, which is what makes the aliases importable from
 * anywhere in the repository.
 */
export const vendorPackage = (packed, substrate) => {
  const byName = new Map(packed.map((entry) => [entry.name, entry]));
  return {
    name: "@smthrs/flows-vendor",
    version: "0.0.0",
    private: true,
    type: "module",
    description: "Installs the vendored flows tarballs under @flows/* until the flows alpha is published",
    scripts: { test: "node --test resolution.test.mjs" },
    dependencies: Object.fromEntries(
      [...rootPackages]
        .sort()
        .map((name) => [name.replace("@smthrs/", "@flows/"), `file:./${byName.get(name).filename}`]),
    ),
    devDependencies: {
      "@effect/platform-node": substrate.platformNode,
      effect: substrate.effect,
    },
  };
};

/**
 * The Effect versions a flows consumer installs alongside the library.
 *
 * Read from the flows checkout rather than restated, so `resolution.test.mjs`
 * cannot drift from the pin the library was built against.
 */
export const substrateVersions = (checkout) => {
  const read = (directory) => JSON.parse(readFileSync(join(checkout, "packages", directory, "package.json"), "utf8"));
  return {
    effect: read("flow").dependencies.effect,
    platformNode: read("platform-node").dependencies["@effect/platform-node"],
  };
};

/** Every tarball in `directory`, so a re-run can report or prune it. */
const vendoredFiles = (directory) =>
  existsSync(directory)
    ? readdirSync(directory)
        .filter((file) => file.endsWith(".tgz"))
        .sort()
    : [];

const digest = (directory, file) =>
  createHash("sha256")
    .update(readFileSync(join(directory, file)))
    .digest("hex");

const snapshot = (directory) => {
  const files = vendoredFiles(directory);
  const manifestPath = join(directory, "manifest.json");
  const packagePath = join(directory, "package.json");
  return {
    tarballs: Object.fromEntries(files.map((file) => [file, digest(directory, file)])),
    manifest: existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined,
    package: existsSync(packagePath) ? readFileSync(packagePath, "utf8") : undefined,
  };
};

const differences = (before, after) => {
  const changed = [];
  for (const file of new Set([...Object.keys(before.tarballs), ...Object.keys(after.tarballs)])) {
    if (before.tarballs[file] !== after.tarballs[file]) {
      changed.push(
        before.tarballs[file] === undefined
          ? `${file} added`
          : after.tarballs[file] === undefined
            ? `${file} removed`
            : `${file} changed`,
      );
    }
  }
  if (before.manifest !== after.manifest) changed.push("manifest.json changed");
  if (before.package !== after.package) changed.push("package.json changed");
  return changed.sort();
};

/**
 * Packs the closure into `destination`, replacing whatever was there.
 *
 * `--check` passes a temporary destination so a mismatch never leaves
 * `vendor/flows/` half rewritten.
 */
export const vendor = async (checkout, destination = vendorDirectory) => {
  const manifests = readFlowsManifests(checkout);
  const closure = closureOf(rootPackages, manifests);
  await mkdir(destination, { recursive: true });
  const stagingRoot = await mkdtemp(join(tmpdir(), "smithers-vendor-flows-"));
  try {
    const packed = [];
    for (const name of closure) {
      packed.push(await packPackage(name, manifests.get(name), checkout, destination, stagingRoot));
    }
    const keep = new Set(packed.map((entry) => entry.filename));
    for (const file of vendoredFiles(destination)) {
      if (!keep.has(file)) await rm(join(destination, file));
    }
    const pinned = packed.map(({ staleCommonJs, ...entry }) => entry);
    await writeFile(join(destination, "manifest.json"), `${JSON.stringify(pinned, null, 2)}\n`);
    await writeFile(
      join(destination, "package.json"),
      `${JSON.stringify(vendorPackage(packed, substrateVersions(checkout)), null, 2)}\n`,
    );
    return packed;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
};

const usage = [
  "usage: node scripts/vendor-flows.mjs [<flows-checkout>]",
  "       node scripts/vendor-flows.mjs --check [<flows-checkout>]",
  "       node scripts/vendor-flows.mjs --list  [<flows-checkout>]",
  "",
  `the checkout defaults to $SMITHERS_FLOWS_REPO, then to ${join("..", "flows", "flows")}`,
].join("\n");

export const main = async (args) => {
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  const flags = new Set(args.filter((argument) => argument.startsWith("--")));
  const checkout = flowsCheckout(args.find((argument) => !argument.startsWith("--")));

  if (flags.has("--list")) {
    console.log(closureOf(rootPackages, readFlowsManifests(checkout)).join("\n"));
    return;
  }

  const checking = flags.has("--check");
  const before = snapshot(vendorDirectory);
  const destination = checking ? await mkdtemp(join(tmpdir(), "smithers-vendor-flows-check-")) : vendorDirectory;
  let packed;
  let changed;
  try {
    packed = await vendor(checkout, destination);
    changed = differences(before, snapshot(destination));
  } finally {
    if (checking) await rm(destination, { recursive: true, force: true });
  }
  for (const entry of packed.filter((candidate) => candidate.staleCommonJs.length > 0)) {
    console.log(
      `${entry.name}: no CJS build for ${entry.staleCommonJs.join(", ")};` +
        " the tarball's `require` conditions do not resolve for those modules",
    );
  }

  if (checking) {
    if (changed.length > 0) {
      throw new Error(
        `vendor/flows/ is out of date against ${checkout}:\n  ${changed.join("\n  ")}\n` +
          "run `node scripts/vendor-flows.mjs` and commit the result",
      );
    }
    console.log(`vendor/flows/ matches ${checkout}: ${packed.length} tarballs`);
    return;
  }
  console.log(
    changed.length === 0
      ? `vendor/flows/ unchanged: ${packed.length} tarballs from ${checkout}`
      : `vendored ${packed.length} tarballs from ${checkout}:\n  ${changed.join("\n  ")}`,
  );
};

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  await main(process.argv.slice(2));
}
