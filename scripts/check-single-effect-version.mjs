#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versions = new Map();

function addVersion(version, source) {
  if (!version) return;
  const normalized = version.trim();
  if (!normalized) return;
  const sources = versions.get(normalized) ?? [];
  sources.push(source);
  versions.set(normalized, sources);
}

function readPackageVersion(packageJsonPath, source) {
  if (!existsSync(packageJsonPath)) return;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof pkg.version === "string") {
      addVersion(pkg.version, source);
    }
  } catch {
    // Ignore unreadable package metadata; lockfile checks still run below.
  }
}

function collectPnpmLockVersions() {
  const lockPath = join(root, "pnpm-lock.yaml");
  if (!existsSync(lockPath)) return;
  const lock = readFileSync(lockPath, "utf8");
  for (const match of lock.matchAll(/^ {2}effect@([^:\s(]+):$/gm)) {
    addVersion(match[1], "pnpm-lock.yaml");
  }
}

function collectBunLockVersions() {
  const lockPath = join(root, "bun.lock");
  if (!existsSync(lockPath)) return;
  const lock = readFileSync(lockPath, "utf8");
  for (const match of lock.matchAll(/"effect"\s*:\s*\[\s*"effect@([^"]+)"/g)) {
    addVersion(match[1], "bun.lock");
  }
}

function collectInstalledVersions() {
  readPackageVersion(
    join(root, "node_modules", "effect", "package.json"),
    "node_modules/effect",
  );

  const pnpmStore = join(root, "node_modules", ".pnpm");
  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore)) {
      if (!entry.startsWith("effect@")) continue;
      readPackageVersion(
        join(pnpmStore, entry, "node_modules", "effect", "package.json"),
        `node_modules/.pnpm/${entry}`,
      );
    }
  }

  try {
    const cliRequire = createRequire(join(root, "apps", "cli", "src", "index.js"));
    readPackageVersion(
      cliRequire.resolve("effect/package.json"),
      "apps/cli import resolution",
    );
  } catch {
    // Missing installs are handled by the lockfile check.
  }
}

collectPnpmLockVersions();
collectBunLockVersions();
collectInstalledVersions();

if (versions.size === 0) {
  console.error("Could not find a resolved effect version in the lockfiles or install.");
  process.exit(1);
}

if (versions.size > 1) {
  console.error("Expected exactly one resolved effect version for the CLI, found:");
  for (const [version, sources] of [...versions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.error(`  effect@${version}`);
    for (const source of sources) {
      console.error(`    - ${source}`);
    }
  }
  process.exit(1);
}

const [version] = versions.keys();
console.log(`effect version OK: ${version}`);
