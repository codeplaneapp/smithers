#!/usr/bin/env node
// Pack every publishable workspace package into real tarballs and emit an
// npm-installable dependency map for them.
//
// Why: the only honest way to test what an end user gets is to install what we
// would publish. Testing against a workspace link hides missing dependencies,
// files left out of `files`, and source that only Bun can parse. Testing
// against the registry tests the last release, not the working tree.
//
// `pnpm pack` is used rather than `npm pack` because it rewrites `workspace:*`
// ranges to real versions. Those versions still point at the registry, so the
// caller pins every one of them back to a local tarball through npm
// `overrides` (see `overridesFor`).
//
// Usage: node scripts/pack-workspace-tarballs.mjs <destination-dir>
// Prints JSON: { "<package name>": "<absolute tarball path>", ... }
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every workspace directory holding a publishable package.
 * @returns {Array<{ name: string; dir: string }>}
 */
export function publishablePackages(root = repoRoot) {
  /** @type {Array<{ name: string; dir: string }>} */
  const found = [];
  const roots = [join(root, "packages"), join(root, "apps")];
  const dirs = [join(root, ".smithers")];
  for (const parent of roots) {
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) dirs.push(join(parent, entry));
  }
  for (const dir of dirs) {
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private || !manifest.name) continue;
    found.push({ name: manifest.name, dir });
  }
  return found;
}

/**
 * @param {string} destination
 * @param {string} [root]
 * @returns {Record<string, string>} package name -> absolute tarball path
 */
export function packWorkspaceTarballs(destination, root = repoRoot) {
  mkdirSync(destination, { recursive: true });
  /** @type {Record<string, string>} */
  const tarballs = {};
  for (const { name, dir } of publishablePackages(root)) {
    const output = execFileSync("pnpm", ["pack", "--config.ignore-scripts=true", "--pack-destination", destination], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarball = output.trim().split("\n").filter(Boolean).at(-1);
    if (!tarball || !existsSync(tarball)) throw new Error(`pnpm pack produced no tarball for ${name}: ${output}`);
    tarballs[name] = tarball;
  }
  return tarballs;
}

/**
 * npm `overrides` that pin every workspace package name to its local tarball,
 * so a plain `npm install` resolves the working tree instead of the registry.
 *
 * @param {Record<string, string>} tarballs
 * @returns {Record<string, string>}
 */
export function overridesFor(tarballs) {
  return Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`]));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const destination = process.argv[2];
  if (!destination) {
    console.error("usage: node scripts/pack-workspace-tarballs.mjs <destination-dir>");
    process.exit(2);
  }
  console.log(JSON.stringify(packWorkspaceTarballs(resolve(destination)), null, 2));
}
