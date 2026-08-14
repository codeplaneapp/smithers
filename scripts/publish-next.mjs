#!/usr/bin/env node
// Publish every non-private workspace package as a `next`-channel snapshot of
// the current commit. CI runs this (.github/workflows/release-next.yml) for
// every fully green commit on main. It only ever publishes under the npm
// `next` dist-tag and only ever moves the `next` git tag, so the `latest`
// dist-tag and the vX.Y.Z release tags stay exactly where `pnpm release`
// (scripts/publish.mjs) put them.
//
// Version scheme: <root version>-next.<commit epoch>.g<short sha>, e.g.
// 0.28.0-next.1752480000.g0932f089ef11. The version is derived from the
// commit, so re-running for the same commit is a no-op (idempotent), and the
// epoch prerelease identifier keeps semver ordering aligned with commit time.
// CI completion order can invert commit order (an older commit's CI can finish
// after a newer commit already published), so before advancing the `next`
// dist-tag or git tag the script compares epochs and, when it is the stale
// side of that race, restores the newer dist-tag instead of clobbering it.
//
// Usage:
//   node scripts/publish-next.mjs                 # propagate version, build, fetch jj, publish --tag next, advance the next git tag
//   node scripts/publish-next.mjs --dry-run       # stop before publish; still rewrites versions in the working tree
//   node scripts/publish-next.mjs --skip-build
//   node scripts/publish-next.mjs --skip-git-tag  # do not push the next git tag to origin

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Build the next-channel snapshot version for a commit.
 *
 * The epoch is a numeric prerelease identifier so semver orders snapshots by
 * commit time; the sha identifier is prefixed with `g` (git convention) so it
 * is always alphanumeric — a purely numeric short sha with a leading zero
 * would be an invalid semver numeric identifier.
 *
 * @param {string} baseVersion the root package.json version, e.g. "0.28.0"
 * @param {number} commitEpoch committer timestamp in seconds
 * @param {string} shortSha abbreviated commit sha
 */
export function computeNextVersion(baseVersion, commitEpoch, shortSha) {
  if (baseVersion.includes("-")) {
    throw new Error(`root version "${baseVersion}" is already a prerelease — refusing to stack a -next suffix on it`);
  }
  if (!Number.isInteger(commitEpoch) || commitEpoch <= 0) {
    throw new Error(`invalid commit epoch "${commitEpoch}"`);
  }
  if (!/^[0-9a-f]{4,40}$/.test(shortSha)) {
    throw new Error(`invalid short sha "${shortSha}"`);
  }
  return `${baseVersion}-next.${commitEpoch}.g${shortSha}`;
}

/**
 * Extract the commit epoch from a next-channel version, or null when the
 * version is not from the next channel (e.g. a plain 0.27.0 release).
 *
 * @param {string} version
 * @returns {number | null}
 */
export function parseNextEpoch(version) {
  const match = /-next\.(\d+)\./.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * Decide whether this commit's snapshot may take over the `next` pointers
 * (npm dist-tag + git tag). False only when the registry's current `next`
 * version is a snapshot of a NEWER commit — the CI-finish-order race — in
 * which case we publish the version but leave the pointers on the newer one.
 *
 * @param {string | null | undefined} currentNextVersion the registry's current next dist-tag version
 * @param {number} commitEpoch this commit's epoch
 */
export function shouldAdvanceNext(currentNextVersion, commitEpoch) {
  if (!currentNextVersion) return true;
  const currentEpoch = parseNextEpoch(currentNextVersion);
  if (currentEpoch === null) return true;
  return commitEpoch >= currentEpoch;
}

/**
 * List every non-private workspace package (same walk as publish.mjs).
 *
 * @param {string} rootDir
 * @returns {{ name: string, version: string, dir: string }[]}
 */
export function workspacePackages(rootDir) {
  const packages = [];
  for (const entry of ["packages", "apps", "e2e", ".smithers"]) {
    const entryPath = join(rootDir, entry);
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
      packages.push({ name: pkg.name, version: pkg.version, dir });
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Rewrite the root and every non-private workspace package.json to `version`.
 * Workspace-internal deps stay on the workspace: protocol — pnpm substitutes
 * the concrete version at pack time. Returns the rewritten file paths.
 *
 * @param {string} rootDir
 * @param {string} version
 */
export function propagateVersion(rootDir, version) {
  const changed = [];
  const targets = [
    join(rootDir, "package.json"),
    ...workspacePackages(rootDir).map((pkg) => join(pkg.dir, "package.json")),
  ];
  for (const path of targets) {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    if (pkg.version === version) continue;
    pkg.version = version;
    writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
    changed.push(path);
  }
  return changed;
}

/**
 * Sync gateway-client's DEFAULT_CLIENT_VERSION handshake pin (same contract
 * bump.mjs enforces for real releases) so a next-channel client reports the
 * version it was actually published as.
 *
 * @param {string} rootDir
 * @param {string} version
 */
export function syncGatewayClientVersion(rootDir, version) {
  const clientPath = join(rootDir, "packages", "gateway-client", "src", "SmithersGatewayClient.ts");
  const source = readFileSync(clientPath, "utf8");
  const synced = source.replace(/(const DEFAULT_CLIENT_VERSION = ")[^"]+(")/, `$1${version}$2`);
  if (!synced.includes(`DEFAULT_CLIENT_VERSION = "${version}"`)) {
    throw new Error(
      `publish-next.mjs could not sync DEFAULT_CLIENT_VERSION in ${clientPath} — the pin pattern no longer matches; update the regex in scripts/publish-next.mjs`,
    );
  }
  if (synced !== source) writeFileSync(clientPath, synced);
  return clientPath;
}

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
function git(args) {
  const out = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${out.stderr ?? ""}`);
  return out.stdout.trim();
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
function npmNextDistTag(name) {
  const out = spawnSync("npm", ["view", name, "dist-tags.next", "--json"], { cwd: root, encoding: "utf8" });
  if (out.status !== 0) {
    const msg = `${out.stdout}\n${out.stderr}`;
    if (msg.includes("E404") || msg.includes("404 Not Found")) return null;
    throw new Error(`could not read the next dist-tag for ${name}:\n${msg.trim()}`);
  }
  const trimmed = out.stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? true];
    }),
  );
  const DRY_RUN = !!args["dry-run"];
  const SKIP_BUILD = !!args["skip-build"];
  const SKIP_GIT_TAG = !!args["skip-git-tag"];

  const baseVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const commitEpoch = Number(git(["show", "-s", "--format=%ct", "HEAD"]));
  const sha = git(["rev-parse", "HEAD"]);
  const version = computeNextVersion(baseVersion, commitEpoch, sha.slice(0, 12));

  log("version", `next-channel snapshot ${version} for commit ${sha}`);

  // The canonical package's current `next` pointer decides the race below.
  const currentNext = npmNextDistTag("smthrs");
  const advanceNext = shouldAdvanceNext(currentNext, commitEpoch);
  if (!advanceNext) {
    log(
      "dist-tag",
      `registry next (${currentNext}) is a newer commit's snapshot — publishing without advancing the next pointers`,
    );
  }

  log("publish", "checking npm registry for already-published package versions");
  const packages = workspacePackages(root);
  const published = packages.filter((pkg) => npmHasVersion(pkg.name, version));
  for (const pkg of published) {
    console.log(`  = ${pkg.name}@${version} already published — skipping`);
  }

  if (published.length < packages.length) {
    log("version", `propagating ${version} to ${packages.length} workspace package(s)`);
    propagateVersion(root, version);
    syncGatewayClientVersion(root, version);

    if (!SKIP_BUILD) {
      log("build", "pnpm -r build");
      // apps/cli's dts rollup needs more heap than Node's default worker limit
      // or tsup dies with ERR_WORKER_OUT_OF_MEMORY.
      execSync("pnpm -r build", {
        stdio: "inherit",
        cwd: root,
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" },
      });
    } else {
      log("build", "skipped (--skip-build)");
    }

    log("jj", "pnpm fetch:jj");
    run("pnpm fetch:jj");

    const publishArgs = [
      "-r",
      ...published.flatMap((pkg) => ["--filter", `!${pkg.name}`]),
      "publish",
      "--access",
      "public",
      "--no-git-checks",
      "--tag",
      "next",
    ];
    if (DRY_RUN) {
      log("publish", `DRY RUN — would run: ${["pnpm", ...publishArgs].map(shellQuote).join(" ")}`);
      console.log(`\n✓ ${version} (dry run) done`);
      return;
    }
    log("publish", "pnpm -r publish --access public --no-git-checks --tag next");
    runArgs("pnpm", publishArgs);
  } else if (DRY_RUN) {
    log("publish", `DRY RUN — every workspace package already has ${version} on npm`);
    console.log(`\n✓ ${version} (dry run) done`);
    return;
  } else {
    log("publish", `every workspace package already has ${version} on npm`);
  }

  if (advanceNext) {
    // pnpm publish --tag next only tags the packages it publishes in THIS run;
    // packages skipped as already-published (a resumed partial publish) would
    // keep a stale pointer, so pin every package's next tag explicitly.
    log("dist-tag", `ensuring next -> ${version} on every package`);
    for (const pkg of packages) {
      runArgs("npm", ["dist-tag", "add", `${pkg.name}@${version}`, "next"]);
    }
  } else {
    // We published with --tag next (pnpm always tags), which just yanked the
    // pointer backwards off the newer snapshot — put it back on every package
    // that has the newer version.
    log("dist-tag", `restoring next -> ${currentNext}`);
    for (const pkg of packages) {
      if (!npmHasVersion(pkg.name, currentNext)) continue;
      runArgs("npm", ["dist-tag", "add", `${pkg.name}@${currentNext}`, "next"]);
    }
  }

  if (SKIP_GIT_TAG) {
    log("git-tag", "skipped (--skip-git-tag)");
  } else if (!advanceNext) {
    log("git-tag", "skipped — a newer commit already owns the next pointers");
  } else {
    log("git-tag", `pointing the next tag at ${sha}`);
    run(`git push --force origin ${sha}:refs/tags/next`);
  }

  console.log(`\n✓ ${version} done — npm latest and the vX.Y.Z tags were not touched`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
