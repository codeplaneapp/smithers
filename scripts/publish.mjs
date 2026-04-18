#!/usr/bin/env node
// Publish every non-private workspace package at a single version derived
// from the newest docs/changelogs/*.mdx file.
//
// Usage:
//   pnpm run publish                 # full run: bump, install, build, publish, tag
//   pnpm run publish -- --dry-run    # report target version + publishable list, touch nothing
//   pnpm run publish -- --version=0.16.0
//   pnpm run publish -- --otp=123456
//   pnpm run publish -- --typecheck  # run pnpm -r typecheck before build (opt-in)
//   pnpm run publish -- --skip-build
//   pnpm run publish -- --skip-git   # skip the clean-tree check, commit, and tag

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const DRY_RUN = !!args["dry-run"];
const SKIP_BUILD = !!args["skip-build"];
const SKIP_GIT = !!args["skip-git"];
const TYPECHECK = !!args["typecheck"];
const OTP = typeof args.otp === "string" ? args.otp : null;

function log(step, msg) {
  console.log(`\n▸ [${step}] ${msg}`);
}

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root, ...opts });
}

function cmpSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function resolveTargetVersion() {
  if (typeof args.version === "string") return args.version;
  const dir = join(root, "docs", "changelogs");
  const versions = readdirSync(dir)
    .filter((f) => /^\d+\.\d+\.\d+\.mdx$/.test(f))
    .map((f) => f.replace(/\.mdx$/, ""));
  if (versions.length === 0) throw new Error("no changelog files found in docs/changelogs/");
  versions.sort(cmpSemver);
  return versions[versions.length - 1];
}

function collectWorkspacePackageJsons() {
  const dirs = [
    ...readdirSync(join(root, "packages"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, "packages", d.name)),
    ...readdirSync(join(root, "apps"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, "apps", d.name)),
  ];
  const results = [];
  for (const d of dirs) {
    const path = join(d, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      results.push({ path, pkg });
    } catch {
      // no package.json — skip
    }
  }
  results.push({
    path: join(root, "package.json"),
    pkg: JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
  });
  return results;
}

function setVersion(entry, version) {
  if (entry.pkg.version === version) return false;
  entry.pkg.version = version;
  writeFileSync(entry.path, JSON.stringify(entry.pkg, null, 2) + "\n");
  return true;
}

function assertCleanGit() {
  const out = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error("git status failed");
  if (out.stdout.trim()) {
    throw new Error(
      `working tree is dirty — commit or stash first, or pass --skip-git:\n${out.stdout}`,
    );
  }
}

function changelogExists(version) {
  const p = join(root, "docs", "changelogs", `${version}.mdx`);
  try {
    readFileSync(p, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const version = resolveTargetVersion();
  log("version", `target ${version} (from docs/changelogs/${version}.mdx)`);
  if (!changelogExists(version)) {
    throw new Error(`docs/changelogs/${version}.mdx missing — write it before publishing`);
  }

  const entries = collectWorkspacePackageJsons();
  const publishable = entries
    .filter((e) => !e.pkg.private && e.pkg.name !== "smithers-monorepo")
    .map((e) => `${e.pkg.name}@${e.pkg.version}→${version}`);

  if (DRY_RUN) {
    log("dry-run", `would bump ${entries.length} package.json files to ${version}`);
    log("dry-run", `would publish ${publishable.length} packages:`);
    for (const p of publishable) console.log(`    ${p}`);
    log("dry-run", `would commit "release: v${version}" and tag v${version}`);
    console.log(`\n✓ dry run complete — no files modified`);
    return;
  }

  if (!SKIP_GIT) {
    log("git", "checking clean working tree");
    assertCleanGit();
  }

  log("bump", `setting version=${version} on root + all workspace packages`);
  let bumped = 0;
  for (const e of entries) {
    if (setVersion(e, version)) bumped++;
  }
  console.log(`  bumped ${bumped} package(s); ${publishable.length} publishable`);

  log("install", "pnpm install (refresh lockfile for new versions)");
  run("pnpm install");

  if (TYPECHECK) {
    log("typecheck", "pnpm -r typecheck");
    run("pnpm -r typecheck");
  } else {
    log("typecheck", "skipped (pass --typecheck to enable)");
  }

  if (!SKIP_BUILD) {
    log("build", "pnpm -r build");
    run("pnpm -r build");
  } else {
    log("build", "skipped (--skip-build)");
  }

  const otpFlag = OTP ? ` --otp=${OTP}` : "";
  log("publish", "pnpm -r publish --access public --no-git-checks");
  run(`pnpm -r publish --access public --no-git-checks${otpFlag}`);

  if (SKIP_GIT) {
    log("git", "skipped commit + tag (--skip-git)");
  } else {
    log("git", `commit + tag v${version}`);
    run("git add -A");
    run(`git commit -m "release: v${version}"`);
    run(`git tag v${version}`);
    console.log(`\n  → push with: git push && git push --tags`);
  }

  console.log(`\n✓ v${version} done`);
}

main().catch((err) => {
  console.error(`\n✗ publish failed: ${err.message}`);
  process.exit(1);
});
