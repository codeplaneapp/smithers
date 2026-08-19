/**
 * Proves the vendored flows packages are usable and that vendoring them did not
 * take over the `@smthrs/*` names this workspace owns.
 *
 * The flows tree and this tree both publish under `@smthrs/*`. Nine names exist
 * in both. The migration depends on one resolution rule: the bare name is always
 * this workspace's package, and the flows copy is only reachable under a
 * `@flows/*` alias. Everything below states that rule as an assertion, because
 * a `pnpm.overrides` entry keyed on a bare name would silently break it and the
 * type checker would not notice.
 *
 * See `README.md` next to this file for the wiring and for the swap that removes
 * `vendor/flows/` once the flows alpha is published.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const vendorDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(vendorDirectory, "..", "..");
const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const vendorManifest = JSON.parse(readFileSync(join(vendorDirectory, "manifest.json"), "utf8"));

/**
 * The package directory a specifier resolves to, as Node resolves it.
 *
 * Resolution has to go through `import.meta.resolve` rather than a
 * `<specifier>/package.json` lookup: this workspace's packages do not export
 * their manifest, so asking for it reports a resolution failure that says
 * nothing about where the package itself lives.
 */
const packageRootOf = (specifier) => {
  let directory = dirname(fileURLToPath(import.meta.resolve(specifier)));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    assert.notEqual(parent, directory, `${specifier} resolved outside any package`);
    directory = parent;
  }
  return realpathSync(directory);
};

const manifestOf = (specifier) => {
  const packageRoot = packageRootOf(specifier);
  return { packageRoot, manifest: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) };
};

/**
 * The `@smthrs/*` names that exist in both trees.
 *
 * The first seven are the collision the migration lives with. `observability`
 * and `cli` collide too, and `observability` is inside the vendored closure,
 * so both are held to the same rule.
 */
const collidingNames = [
  "@smthrs/engine",
  "@smthrs/gateway",
  "@smthrs/memory",
  "@smthrs/sandbox",
  "@smthrs/scorers",
  "@smthrs/testing",
  "@smthrs/time-travel",
  "@smthrs/observability",
  "@smthrs/cli",
];

test("the @flows aliases resolve to the vendored flows packages", () => {
  for (const alias of ["@flows/flow", "@flows/engine"]) {
    const { packageRoot, manifest } = manifestOf(alias);
    assert.equal(manifest.name, alias.replace("@flows/", "@smthrs/"), `${alias} resolved to ${manifest.name}`);
    assert.match(
      packageRoot,
      /node_modules[/\\]\.pnpm[/\\]/,
      `${alias} should come from a vendored tarball, not from ${packageRoot}`,
    );
  }
});

test("the flows quick start runs in process and greets Ada", async () => {
  const [NodeCrypto, { FlowEngine }, { Action, Flow, Interpreter }, Effect, Layer, Schema] = await Promise.all([
    import("@effect/platform-node/NodeCrypto"),
    import("@flows/engine"),
    import("@flows/flow"),
    import("effect/Effect"),
    import("effect/Layer"),
    import("effect/Schema"),
  ]);

  const Greet = Action.make("examples/Greet", {
    payload: { name: Schema.String },
    success: Schema.String,
  });
  const Greeting = Flow.make("examples/Greeting", {
    payload: { name: Schema.String },
    success: Schema.String,
    body: (payload) => Greet.call(payload),
  });
  const GreetingLayer = Layer.mergeAll(
    Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`)),
    Interpreter.layer(Greeting),
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
  );

  const greeting = await Effect.runPromise(
    Greeting.execute({ name: "Ada" }, { executionId: "greeting-ada-1" }).pipe(Effect.provide(GreetingLayer)),
  );
  assert.equal(greeting, "Hello, Ada.");
});

test("the colliding bare names still resolve to this workspace", () => {
  for (const name of collidingNames) {
    const { packageRoot, manifest } = manifestOf(name);
    assert.equal(manifest.name, name);
    assert.equal(
      manifest.version,
      rootManifest.version,
      `${name} resolved to ${manifest.version}, not this workspace's ${rootManifest.version}`,
    );
    assert.ok(
      packageRoot.startsWith(join(realpathSync(repoRoot), "packages")) ||
        packageRoot.startsWith(join(realpathSync(repoRoot), "apps")),
      `${name} resolved to ${packageRoot}, outside this workspace`,
    );
    assert.doesNotMatch(
      packageRoot,
      /node_modules[/\\]\.pnpm[/\\]/,
      `${name} resolved to a vendored copy at ${packageRoot}`,
    );
  }
});

test("no override sends a bare @smthrs name to a vendored tarball", () => {
  // A bare key matches every range, including the `workspace:*` this repo's own
  // packages depend on each other with. Keying on `<name>@<version>` restricts
  // the override to the flows edges, which are all exact `0.1.0`.
  for (const field of ["overrides", "pnpm.overrides"]) {
    const overrides = field === "overrides" ? rootManifest.overrides : rootManifest.pnpm?.overrides;
    for (const [key, value] of Object.entries(overrides ?? {})) {
      if (!String(value).startsWith("file:vendor/flows/")) continue;
      assert.ok(
        key.includes("@", 1),
        `${field}["${key}"] is keyed on a bare name, so it also captures this workspace's own ${key};` +
          " key it on <name>@<version> instead",
      );
    }
  }
});

test("the flows edges stay out of every bun-visible manifest", () => {
  // bun reads `workspaces` from the root manifest and has no version-scoped
  // override, so a bun-visible manifest that names a flows edge either fails to
  // resolve or takes over this workspace's own `@smthrs/engine`. Keeping
  // vendor/flows out of that array is what keeps `bun install` working.
  // vendor/flows/README.md records the measurements.
  assert.ok(
    Array.isArray(rootManifest.workspaces) && !rootManifest.workspaces.includes("vendor/flows"),
    "the root manifest's workspaces array must not include vendor/flows; bun reads it",
  );
  const pnpmWorkspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  assert.match(pnpmWorkspace, /^\s*- "vendor\/flows"$/m, "pnpm-workspace.yaml must include vendor/flows");
  assert.match(
    readFileSync(join(repoRoot, ".npmrc"), "utf8"),
    /^public-hoist-pattern\[\]=@flows\/\*$/m,
    ".npmrc must public-hoist @flows/* or the aliases are unreachable outside vendor/flows",
  );
  // The hoist, not just its configuration: repository code outside this package
  // resolves `@flows/*` through the root node_modules and nothing else.
  for (const alias of ["@flows/flow", "@flows/engine"]) {
    const hoisted = join(repoRoot, "node_modules", ...alias.split("/"));
    assert.ok(existsSync(hoisted), `${alias} is not hoisted into the root node_modules; check .npmrc`);
    assert.match(
      realpathSync(hoisted),
      /node_modules[/\\]\.pnpm[/\\]/,
      `the hoisted ${alias} does not come from a vendored tarball`,
    );
  }
  for (const name of Object.keys(rootManifest.dependencies ?? {})) {
    assert.ok(!name.startsWith("@flows/"), `the root manifest declares ${name}; bun reads it, vendor/flows owns it`);
  }
  for (const name of Object.keys(rootManifest.devDependencies ?? {})) {
    assert.ok(!name.startsWith("@flows/"), `the root manifest declares ${name}; bun reads it, vendor/flows owns it`);
  }
});

test("the vendor workspace package installs every aliased flows package", () => {
  const vendorPackage = JSON.parse(readFileSync(join(vendorDirectory, "package.json"), "utf8"));
  const byName = new Map(vendorManifest.map((entry) => [entry.name, entry]));
  for (const [alias, specifier] of Object.entries(vendorPackage.dependencies)) {
    const flowsName = alias.replace("@flows/", "@smthrs/");
    const entry = byName.get(flowsName);
    assert.ok(entry !== undefined, `${alias} aliases ${flowsName}, which is not vendored`);
    assert.equal(specifier, `file:./${entry.filename}`, `${alias} does not point at its tarball`);
    assert.equal(manifestOf(alias).manifest.name, flowsName, `${alias} does not resolve to ${flowsName}`);
  }
});

test("every vendored tarball is present, intact, and overridden at its exact version", () => {
  assert.ok(vendorManifest.length > 0, "vendor/flows/manifest.json lists no tarballs");
  const overrides = rootManifest.pnpm?.overrides ?? {};
  for (const entry of vendorManifest) {
    const tarball = join(vendorDirectory, entry.filename);
    assert.ok(existsSync(tarball), `vendor/flows/${entry.filename} is missing; run node scripts/vendor-flows.mjs`);
    // The integrity the manifest recorded, not just the file name. A tarball
    // rewritten out of band — by a half-finished re-vendor against a different
    // flows checkout, say — installs without complaint and is invisible
    // otherwise.
    assert.equal(
      `sha256-${createHash("sha256").update(readFileSync(tarball)).digest("base64")}`,
      entry.integrity,
      `vendor/flows/${entry.filename} does not match the integrity in manifest.json`,
    );
    assert.equal(
      overrides[`${entry.name}@${entry.version}`],
      `file:vendor/flows/${entry.filename}`,
      `${entry.name}@${entry.version} has no override, so pnpm would look for it on the registry`,
    );
  }
});
