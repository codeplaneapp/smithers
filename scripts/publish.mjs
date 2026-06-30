#!/usr/bin/env node
// Build and publish every non-private workspace package at the root's current
// version. Expects a clean tree — run `pnpm version <patch|minor|major>` (or
// equivalent) first to bump + commit + tag.
//
// Usage:
//   pnpm run release                 # check clean, verify changelog, build, lint, typecheck, test, fetch jj, publish, gh release
//   pnpm run release -- --dry-run    # same but stop before `pnpm publish`
//   pnpm run release -- --otp=123456
//   pnpm run release -- --skip-build
//   pnpm run release -- --skip-checks  # skip lint/typecheck/test
//   pnpm run release -- --skip-git   # skip the clean-tree check
//   pnpm run release -- --skip-gh-release  # skip creating the GitHub release

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = rootPackage.version;

function log(step, msg) {
  console.log(`\n▸ [${step}] ${msg}`);
}
function run(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}
function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
function runArgs(cmd, args) {
  console.log(`  $ ${[cmd, ...args].map(shellQuote).join(" ")}`);
  const out = spawnSync(cmd, args, { stdio: "inherit", cwd: root });
  if (out.status !== 0) throw new Error(`command failed: ${cmd} ${args.join(" ")}`);
}
function gitStatusPorcelain() {
  const out = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git status failed:\n${out.stderr ?? ""}`);
  return out.stdout.trim();
}
function workspacePackages() {
  const packages = [];
  for (const entry of ["packages", "apps", "e2e", ".smithers"]) {
    const entryPath = join(root, entry);
    const dirs =
      existsSync(join(entryPath, "package.json"))
        ? [entryPath]
        : existsSync(entryPath)
          ? readdirSync(entryPath).map((name) => join(entryPath, name))
          : [];
    for (const dir of dirs) {
      const packagePath = join(dir, "package.json");
      if (!existsSync(packagePath)) continue;
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      if (!pkg.name || pkg.private) continue;
      packages.push({ name: pkg.name, version: pkg.version });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}
function npmHasVersion(name, packageVersion) {
  const out = spawnSync("npm", ["view", `${name}@${packageVersion}`, "version", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (out.status === 0) return true;
  const msg = `${out.stdout}\n${out.stderr}`;
  if (msg.includes("E404") || msg.includes("404 Not Found")) return false;
  throw new Error(`could not check npm registry for ${name}@${packageVersion}:\n${msg.trim()}`);
}
function publishArgsForUnpublishedPackages() {
  log("publish", "checking npm registry for already-published package versions");
  const packages = workspacePackages();
  const mismatched = packages.filter((pkg) => pkg.version !== version);
  if (mismatched.length > 0) {
    throw new Error(
      `workspace package versions must match root ${version} before release:\n${mismatched
        .map((pkg) => `  ${pkg.name}: ${pkg.version}`)
        .join("\n")}`,
    );
  }

  const published = packages.filter((pkg) => npmHasVersion(pkg.name, pkg.version));
  for (const pkg of published) {
    console.log(`  = ${pkg.name}@${pkg.version} already published — skipping`);
  }
  if (published.length === packages.length) return null;
  return [
    "-r",
    ...published.flatMap((pkg) => ["--filter", `!${pkg.name}`]),
    "publish",
    "--access",
    "public",
    "--no-git-checks",
    ...(OTP ? [`--otp=${OTP}`] : []),
  ];
}

log("version", `releasing v${version} (from root package.json)`);

try {
  readFileSync(join(root, "docs", "changelogs", `${version}.mdx`));
} catch {
  throw new Error(`docs/changelogs/${version}.mdx missing — write it before releasing`);
}
for (const docsArtifact of [`llms-v${version}.txt`, `llms-full-v${version}.txt`]) {
  try {
    readFileSync(join(root, "docs", docsArtifact));
  } catch {
    throw new Error(`docs/${docsArtifact} missing — run bun scripts/generate-llms.ts and commit the versioned docs artifacts before releasing`);
  }
}
for (const packageArtifact of ["llms.txt", "llms-full.txt"]) {
  try {
    readFileSync(join(root, "packages", "smithers", "docs", packageArtifact));
  } catch {
    throw new Error(`packages/smithers/docs/${packageArtifact} missing — run bun scripts/generate-llms.ts and commit the npm-bundled docs artifacts before releasing`);
  }
}

if (!SKIP_GIT) {
  log("git", "checking clean working tree");
  // Ignore *.d.ts drift for the same reason the post-build guard does below:
  // rollup-plugin-dts is non-deterministic, so a prior build (e.g. a test run)
  // can leave declaration files dirty without indicating a forgotten commit.
  // They are rebuilt immediately before pack anyway. Any OTHER dirty file still
  // fails — the bump must be committed before releasing.
  const dirty = gitStatusPorcelain()
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.slice(3).trim().endsWith(".d.ts"))
    .join("\n");
  if (dirty) {
    throw new Error(
      `working tree is dirty — run \`pnpm version <patch|minor|major>\` first, or pass --skip-git:\n${dirty}`,
    );
  }
}

log("llms", "pnpm check:llms");
run("pnpm check:llms");

if (!SKIP_BUILD) {
  log("build", "pnpm -r build");
  run("pnpm -r build");

  // The build regenerates committed declaration files (each package's
  // src/*.d.ts via `tsup --dts-only`). If the build changes a tracked file,
  // a generated artifact was committed stale and would ship out of date —
  // exactly how 0.24.0 published a stale packages/smithers/src/index.d.ts.
  // Fail loudly so it gets regenerated and committed before release.
  if (!SKIP_GIT) {
    log("git", "checking build left no stale committed artifacts");
    const drift = gitStatusPorcelain();
    if (drift) {
      // Ignore *.d.ts drift. rollup-plugin-dts is non-deterministic for large
      // declaration files (named-import order, `__default` alias depth), so a
      // committed copy can never byte-match a fresh build. It does not matter for
      // the published artifact: this same `pnpm -r build` regenerates every
      // declaration immediately before `pnpm publish` packs the working tree, so
      // what ships is always freshly built. Still fail on any OTHER changed file
      // — the deterministic generated artifacts (openapi.yaml, llms-*.txt, the
      // seeded workflow pack) that genuinely indicate a stale commit.
      const realDrift = drift
        .split("\n")
        .filter(Boolean)
        .filter((line) => !line.slice(3).trim().endsWith(".d.ts"));
      if (realDrift.length > 0) {
        throw new Error(
          "`pnpm -r build` changed committed files — a generated artifact (e.g. " +
            "openapi.yaml or an llms bundle) is stale and would ship out of date. " +
            `Commit the regenerated files before releasing:\n${realDrift.join("\n")}`,
        );
      }
    }
  }
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

log("jj", "pnpm fetch:jj");
run("pnpm fetch:jj");

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

const publishArgs = publishArgsForUnpublishedPackages();
if (DRY_RUN) {
  log(
    "publish",
    publishArgs
      ? `DRY RUN — would run: ${["pnpm", ...publishArgs].map(shellQuote).join(" ")}`
      : "DRY RUN — all public workspace package versions are already on npm",
  );
} else if (!publishArgs) {
  log("publish", "all public workspace package versions are already on npm");
} else {
  log("publish", "pnpm -r publish --access public --no-git-checks");
  runArgs("pnpm", publishArgs);
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
