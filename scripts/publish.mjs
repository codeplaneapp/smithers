#!/usr/bin/env node
// Build and publish every non-private workspace package at the root's current
// version. Expects a clean tree — run `pnpm version <patch|minor|major>` (or
// equivalent) first to bump + commit + tag.
//
// Usage:
//   pnpm run release                 # check clean, verify changelog, build, publish
//   pnpm run release -- --dry-run    # same but stop before `pnpm publish`
//   pnpm run release -- --otp=123456
//   pnpm run release -- --skip-build
//   pnpm run release -- --skip-git   # skip the clean-tree check

import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY_RUN = !!args["dry-run"];
const SKIP_BUILD = !!args["skip-build"];
const SKIP_GIT = !!args["skip-git"];
const OTP = typeof args.otp === "string" ? args.otp : null;

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function log(step, msg) {
  console.log(`\n▸ [${step}] ${msg}`);
}
function run(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

log("version", `releasing v${version} (from root package.json)`);

try {
  readFileSync(join(root, "docs", "changelogs", `${version}.mdx`));
} catch {
  throw new Error(`docs/changelogs/${version}.mdx missing — write it before releasing`);
}

if (!SKIP_GIT) {
  log("git", "checking clean working tree");
  const out = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (out.stdout.trim()) {
    throw new Error(
      `working tree is dirty — run \`pnpm version <patch|minor|major>\` first, or pass --skip-git:\n${out.stdout}`,
    );
  }
}

if (!SKIP_BUILD) {
  log("build", "pnpm -r build");
  run("pnpm -r build");
} else {
  log("build", "skipped (--skip-build)");
}

const otpFlag = OTP ? ` --otp=${OTP}` : "";
if (DRY_RUN) {
  log("publish", `DRY RUN — would run: pnpm -r publish --access public --no-git-checks${otpFlag}`);
} else {
  log("publish", "pnpm -r publish --access public --no-git-checks");
  run(`pnpm -r publish --access public --no-git-checks${otpFlag}`);
}

console.log(`\n✓ v${version} ${DRY_RUN ? "(dry run) " : ""}done`);
