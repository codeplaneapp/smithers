#!/usr/bin/env node
// Simulates what an END USER's npm resolves when installing our published
// packages, and fails on dependency duplication the pnpm monorepo hides.
//
// Why: pnpm dedupes across the workspace and our root overrides pin one copy,
// so check-single-effect-version.mjs stays green even when npm users get 20
// nested copies of effect (0.31.0 shipped ~660MB of duplicated effect because
// our exact pins conflicted with the @effect/* ecosystem's caret ranges).
//
// How: pack every publishable workspace package's manifest into a minimal
// tarball (rewriting workspace:* to real versions), point a throwaway fixture
// at all of them with file: deps, run `npm install --package-lock-only` so
// npm's own arborist builds the tree, then assert on the resolved lockfile.
//
// Usage: node scripts/check-npm-dedupe.mjs [--max-packages <n>] [--keep-tmp]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keepTmp = args.includes("--keep-tmp");
const maxPackagesFlag = args.indexOf("--max-packages");
const maxPackages = maxPackagesFlag === -1 ? 925 : Number(args[maxPackagesFlag + 1]);
const npmInstallArgs = [
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--loglevel=error",
];

// Deps that must resolve to exactly one copy for npm users. effect duplicated
// 20x and pglite 3x in the 0.31.0 install tree.
const SINGLETONS = ["effect", "@electric-sql/pglite"];
// Optional peers that must NOT appear in a default install at all.
const OPTIONAL_ABSENT = [
  "playwright",
  "koffi",
  "@daytonaio/sdk",
  "@aws-sdk/client-ecs",
  "@aws-sdk/client-codebuild",
  "@aws-sdk/client-s3",
  "@aws-sdk/client-cloudwatch-logs",
  "@google-cloud/run",
  "@google-cloud/storage",
  "@vercel/sandbox",
  "@cloudflare/sandbox",
  "microsandbox",
];

function workspacePackages() {
  const packages = [];
  for (const entry of ["packages", "apps", "e2e", ".smithers"]) {
    const entryPath = join(root, entry);
    const dirs = existsSync(join(entryPath, "package.json"))
      ? [entryPath]
      : existsSync(entryPath)
        ? readdirSync(entryPath).map((name) => join(entryPath, name))
        : [];
    for (const dir of dirs) {
      const packagePath = join(dir, "package.json");
      if (!existsSync(packagePath)) continue;
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      if (!pkg.name || pkg.private) continue;
      packages.push({ name: pkg.name, version: pkg.version, manifest: pkg });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

function rewriteWorkspaceProtocol(manifest, versionByName) {
  const clone = JSON.parse(JSON.stringify(manifest));
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = clone[section];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        const version = versionByName.get(name);
        if (!version) throw new Error(`${manifest.name}: no workspace version for ${name}`);
        deps[name] = version;
      }
    }
  }
  return clone;
}

// Minimal POSIX ustar tarball holding a single package/package.json — enough
// for npm arborist to resolve metadata; --package-lock-only never unpacks
// sources.
function manifestTarball(manifest) {
  const body = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, 100);
  header.write("0000644", 100, 8);
  header.write("0000000", 108, 8);
  header.write("0000000", 116, 8);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8);
  header.write("0", 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  const end = Buffer.alloc(1024);
  return gzipSync(Buffer.concat([header, body, pad, end]));
}

function copiesOf(lockPackages, name) {
  const top = `node_modules/${name}`;
  const copies = [];
  for (const key of Object.keys(lockPackages)) {
    if (key === top || key.endsWith(`/node_modules/${name}`)) copies.push(key);
  }
  return copies;
}

function main() {
  const packages = workspacePackages();
  const versionByName = new Map(packages.map((pkg) => [pkg.name, pkg.version]));
  const tmp = mkdtempSync(join(tmpdir(), "smithers-npm-dedupe-"));
  try {
    const tgzDir = join(tmp, "tgz");
    mkdirSync(tgzDir);
    const fixtureDeps = {};
    const fixtureOptional = {};
    for (const pkg of packages) {
      const rewritten = rewriteWorkspaceProtocol(pkg.manifest, versionByName);
      const file = join(tgzDir, `${pkg.name.replace("/", "-")}-${pkg.version}.tgz`);
      writeFileSync(file, manifestTarball(rewritten));
      // os/cpu-restricted packages (jj binaries) are optionalDependencies in
      // real consumers; npm hard-fails EBADPLATFORM on non-optional ones.
      if (rewritten.os || rewritten.cpu) fixtureOptional[pkg.name] = `file:${file}`;
      else fixtureDeps[pkg.name] = `file:${file}`;
    }
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify(
        {
          name: "npm-dedupe-fixture",
          private: true,
          version: "0.0.0",
          dependencies: fixtureDeps,
          optionalDependencies: fixtureOptional,
        },
        null,
        2,
      ),
    );

    console.log(`resolving ${packages.length} workspace packages with npm arborist (registry metadata)...`);
    const install =
      process.platform === "win32"
        ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...npmInstallArgs], {
            cwd: tmp,
            stdio: "inherit",
            timeout: 10 * 60_000,
          })
        : spawnSync("npm", npmInstallArgs, { cwd: tmp, stdio: "inherit", timeout: 10 * 60_000 });
    if (install.error || install.status !== 0) {
      throw new Error(`npm install --package-lock-only failed: ${install.error?.message ?? `exit ${install.status}`}`);
    }
    const lock = JSON.parse(readFileSync(join(tmp, "package-lock.json"), "utf8"));
    const lockPackages = lock.packages ?? {};

    const failures = [];
    for (const name of SINGLETONS) {
      const copies = copiesOf(lockPackages, name);
      const versions = new Set(copies.map((key) => lockPackages[key]?.version));
      if (copies.length > 1 || versions.size > 1) {
        failures.push(
          `${name} resolves to ${copies.length} copie(s) at ${[...versions].join(", ")}:\n  - ${copies.join("\n  - ")}`,
        );
      } else if (copies.length === 1) {
        console.log(`ok: ${name}@${[...versions][0]} (single copy)`);
      } else {
        console.log(`ok: ${name} not in tree`);
      }
    }
    for (const name of OPTIONAL_ABSENT) {
      const copies = copiesOf(lockPackages, name);
      if (copies.length > 0) {
        failures.push(
          `${name} must stay out of the default install (optional peer), found:\n  - ${copies.join("\n  - ")}`,
        );
      }
    }
    console.log(`ok: ${OPTIONAL_ABSENT.length} optional peers absent from default install`);

    const total = Object.keys(lockPackages).filter((key) => key.startsWith("node_modules/")).length;
    console.log(`resolved package count: ${total} (budget ${maxPackages})`);
    if (total > maxPackages) {
      failures.push(`package count ${total} exceeds budget ${maxPackages}`);
    }

    if (keepTmp) console.log(`fixture kept at ${tmp}`);
    if (failures.length > 0) {
      console.error(`\nnpm dedupe check failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
      process.exitCode = 1;
    }
  } finally {
    if (!keepTmp) rmSync(tmp, { recursive: true, force: true });
  }
}

main();
