#!/usr/bin/env node
// Build and publish every non-private workspace package at the root's current
// version. Expects a clean tree — run `pnpm version <patch|minor|major>` (or
// equivalent) first to bump + commit + tag.
//
// Usage:
//   pnpm run release                 # check clean, verify changelog, build, lint, typecheck, test, publish, gh release
//   pnpm run release -- --dry-run    # same but stop before `pnpm publish`
//   pnpm run release -- --otp=123456
//   pnpm run release -- --skip-build
//   pnpm run release -- --skip-checks  # skip lint/typecheck/test
//   pnpm run release -- --skip-git   # skip the clean-tree check
//   pnpm run release -- --skip-gh-release  # skip creating the GitHub release

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
const SKIP_CHECKS = !!args["skip-checks"];
const SKIP_GIT = !!args["skip-git"];
const SKIP_GH_RELEASE = !!args["skip-gh-release"];
const OTP = typeof args.otp === "string" ? args.otp : null;
const GH_REPO = "smithersai/smithers";

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

log("llms", "pnpm check:llms");
run("pnpm check:llms");

if (!SKIP_BUILD) {
  log("build", "pnpm -r build");
  run("pnpm -r build");
} else {
  log("build", "skipped (--skip-build)");
}

if (!SKIP_CHECKS) {
  log("lint", "pnpm lint");
  run("pnpm lint");

  log("typecheck", "pnpm typecheck");
  run("pnpm typecheck");

  log("typecheck:examples", "pnpm typecheck:examples");
  run("pnpm typecheck:examples");

  log("test", "pnpm test");
  run("pnpm test");
} else {
  log("checks", "skipped (--skip-checks)");
}

if (!DRY_RUN) {
  log("auth", "checking npm login");
  const who = spawnSync("npm", ["whoami"], { cwd: root, encoding: "utf8" });
  if (who.status === 0) {
    console.log(`  logged in as ${who.stdout.trim()}`);
  } else {
    console.log("  not logged in — running `npm login`");
    run("npm login");
  }
}

const otpFlag = OTP ? ` --otp=${OTP}` : "";
if (DRY_RUN) {
  log("publish", `DRY RUN — would run: pnpm -r publish --access public --no-git-checks${otpFlag}`);
} else {
  log("publish", "pnpm -r publish --access public --no-git-checks");
  run(`pnpm -r publish --access public --no-git-checks${otpFlag}`);
}

const tag = `v${version}`;
if (SKIP_GH_RELEASE) {
  log("gh-release", "skipped (--skip-gh-release)");
} else if (DRY_RUN) {
  log("gh-release", `DRY RUN — would create GitHub release ${tag} on ${GH_REPO}`);
} else {
  const gh = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (gh.status !== 0) {
    console.log("  gh CLI not found — install https://cli.github.com/ then run:");
    console.log(
      `    gh release create ${tag} --repo ${GH_REPO} --title ${tag} --notes-file docs/changelogs/${version}.mdx`,
    );
  } else {
    log("gh-release", `creating GitHub release ${tag}`);
    const exists = spawnSync(
      "gh",
      ["release", "view", tag, "--repo", GH_REPO],
      { cwd: root, encoding: "utf8" },
    );
    if (exists.status === 0) {
      console.log(`  release ${tag} already exists — skipping`);
    } else {
      const tagOnRemote = spawnSync(
        "git",
        ["ls-remote", "--exit-code", "--tags", "origin", tag],
        { cwd: root, encoding: "utf8" },
      );
      if (tagOnRemote.status !== 0) {
        console.log(`  tag ${tag} not on origin — pushing`);
        run(`git push origin ${tag}`);
      }
      run(
        `gh release create ${tag} --repo ${GH_REPO} --title ${tag} --notes-file docs/changelogs/${version}.mdx --latest --verify-tag`,
      );
    }
  }
}

console.log(`\n✓ v${version} ${DRY_RUN ? "(dry run) " : ""}done`);
