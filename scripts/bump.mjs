#!/usr/bin/env node
// Called by the `version` lifecycle hook after `pnpm version <patch|minor|major>`
// bumps the root. Propagates the root's new version to every non-private
// workspace package, refreshes the lockfile, and stages everything so that
// pnpm's own `git commit` + tag includes the whole bump in one commit.

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

console.log(`▸ propagating version ${version} to workspace packages`);

const dirs = [
  ...readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, "packages", d.name)),
  ...readdirSync(join(root, "apps"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, "apps", d.name)),
];

const changed = [];
for (const d of dirs) {
  const path = join(d, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    continue;
  }
  if (pkg.private) continue;
  if (pkg.version === version) continue;
  pkg.version = version;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  changed.push(path);
}
console.log(`  bumped ${changed.length} workspace package(s)`);

// .smithers/lib/plue-provider.ts pins the orchestrator version it provisions;
// its test asserts the pin matches the root version, so sync it here.
const providerPath = join(root, ".smithers", "lib", "plue-provider.ts");
const provider = readFileSync(providerPath, "utf8");
const syncedProvider = provider.replace(
  /(export const DEFAULT_ORCHESTRATOR_VERSION = ")[^"]+(")/,
  `$1${version}$2`,
);
if (syncedProvider !== provider) {
  writeFileSync(providerPath, syncedProvider);
  changed.push(providerPath);
  console.log(`  synced DEFAULT_ORCHESTRATOR_VERSION in ${providerPath}`);
}

execSync("pnpm install --prefer-offline", { cwd: root, stdio: "inherit" });

// publish.mjs refuses to release without the committed versioned llms bundles
// (docs/llms-v<version>.txt and docs/llms-full-v<version>.txt), so regenerate
// them now that the root version is bumped.
console.log("▸ regenerating llms bundles for the new version");
execSync("pnpm docs:llms", { cwd: root, stdio: "inherit" });
const llmsArtifacts = [
  "docs/llms*.txt",
  "packages/smithers/docs/llms*.txt",
  "apps/cli/docs/llms*.txt",
  "apps/cli/docs/SKILL.md",
  "skills/smithers/llms-full.txt",
];

const toStage = [
  ...changed.map((p) => `"${p}"`),
  `"${join(root, "pnpm-lock.yaml")}"`,
  ...llmsArtifacts.map((p) => `"${join(root, p)}"`),
].join(" ");
execSync(`git add ${toStage}`, { cwd: root, stdio: "inherit" });
