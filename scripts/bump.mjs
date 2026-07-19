#!/usr/bin/env node
// Called by the `version` lifecycle hook after `pnpm version <patch|minor|major>`
// bumps the root. Propagates the root's new version to every non-private
// workspace package, refreshes the lockfile, and stages everything so that
// pnpm's own `git commit` + tag includes the whole bump in one commit.

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// publish.mjs refuses to release without the committed versioned llms bundles
// (docs/llms-v<version>.txt and docs/llms-full-v<version>.txt), so `main`
// regenerates them after the bump and stages every match of these patterns.
// A `*` is only supported in the final path segment and is expanded
// in-process — the paths never pass through a shell.
export const llmsArtifactPatterns = [
  "docs/llms*.txt",
  "packages/smithers/docs/llms*.txt",
  "apps/cli/docs/llms*.txt",
  "apps/cli/docs/SKILL.md",
  "skills/smithers/llms-full.txt",
];

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Expand release artifact patterns into concrete absolute file paths without
 * any shell evaluation. Literal patterns pass through as-is; a wildcard
 * pattern that matches nothing throws so a broken docs generation cannot
 * silently produce an incomplete release commit.
 *
 * @param {string} rootDir
 * @param {readonly string[]} patterns
 * @returns {string[]}
 */
export function expandArtifactPatterns(rootDir, patterns) {
  const expanded = [];
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      expanded.push(join(rootDir, ...pattern.split("/")));
      continue;
    }
    const segments = pattern.split("/");
    const basename = segments.pop() ?? "";
    if (!basename.includes("*") || segments.some((segment) => segment.includes("*"))) {
      throw new Error(
        `unsupported artifact pattern "${pattern}" — a * is only supported in the final path segment`,
      );
    }
    const dir = join(rootDir, ...segments);
    const matcher = new RegExp(`^${basename.split("*").map(escapeRegExp).join(".*")}$`);
    const matches = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && matcher.test(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort();
    if (matches.length === 0) {
      throw new Error(`release artifact pattern "${pattern}" matched no files in ${dir}`);
    }
    expanded.push(...matches);
  }
  return expanded;
}

/**
 * Stage paths with git invoked directly — an argument vector plus a `--`
 * separator — so no path is ever shell-evaluated or parsed as an option.
 *
 * @param {string} rootDir
 * @param {readonly string[]} paths
 * @param {NodeJS.ProcessEnv} [env] overridable so tests can front a fake git on PATH
 */
export function stageReleasePaths(rootDir, paths, env = process.env) {
  execFileSync("git", ["add", "--", ...paths], { cwd: rootDir, stdio: "inherit", env });
}

function main() {
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
  if (!syncedProvider.includes(`DEFAULT_ORCHESTRATOR_VERSION = "${version}"`)) {
    throw new Error(
      `bump.mjs could not sync DEFAULT_ORCHESTRATOR_VERSION in ${providerPath} — the pin pattern no longer matches; update the regex in scripts/bump.mjs`,
    );
  }
  if (syncedProvider !== provider) {
    writeFileSync(providerPath, syncedProvider);
    changed.push(providerPath);
    console.log(`  synced DEFAULT_ORCHESTRATOR_VERSION in ${providerPath}`);
  }

  // gateway-client reports DEFAULT_CLIENT_VERSION in its connect handshake when
  // the caller supplies none; a test asserts it matches package.json, so sync it
  // here too or a release bump would leave every default client stale.
  const clientPath = join(root, "packages", "gateway-client", "src", "SmithersGatewayClient.ts");
  const clientSource = readFileSync(clientPath, "utf8");
  const syncedClient = clientSource.replace(
    /(const DEFAULT_CLIENT_VERSION = ")[^"]+(")/,
    `$1${version}$2`,
  );
  if (!syncedClient.includes(`DEFAULT_CLIENT_VERSION = "${version}"`)) {
    throw new Error(
      `bump.mjs could not sync DEFAULT_CLIENT_VERSION in ${clientPath} — the pin pattern no longer matches; update the regex in scripts/bump.mjs`,
    );
  }
  if (syncedClient !== clientSource) {
    writeFileSync(clientPath, syncedClient);
    changed.push(clientPath);
    console.log(`  synced DEFAULT_CLIENT_VERSION in ${clientPath}`);
  }

  // react-reconciler identifies its renderer version to React DevTools. Keep
  // that runtime value aligned with the package manifest on every release.
  const reconcilerPath = join(root, "packages", "react-reconciler", "src", "reconciler.js");
  const reconcilerSource = readFileSync(reconcilerPath, "utf8");
  const syncedReconciler = reconcilerSource.replace(
    /(const injectedDevToolsConfig = \{[\s\S]*?\n\s*version: ")[^"]+(")/,
    `$1${version}$2`,
  );
  if (!syncedReconciler.includes(`version: "${version}"`)) {
    throw new Error(
      `bump.mjs could not sync the React DevTools renderer version in ${reconcilerPath} — the pin pattern no longer matches; update the regex in scripts/bump.mjs`,
    );
  }
  if (syncedReconciler !== reconcilerSource) {
    writeFileSync(reconcilerPath, syncedReconciler);
    changed.push(reconcilerPath);
    console.log(`  synced React DevTools renderer version in ${reconcilerPath}`);
  }

  execSync("pnpm install --prefer-offline", { cwd: root, stdio: "inherit" });

  console.log("▸ regenerating llms bundles for the new version");
  execSync("pnpm docs:llms", { cwd: root, stdio: "inherit" });

  stageReleasePaths(root, [
    ...changed,
    join(root, "pnpm-lock.yaml"),
    ...expandArtifactPatterns(root, llmsArtifactPatterns),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
