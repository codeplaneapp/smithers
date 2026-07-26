#!/usr/bin/env node
// Download the upstream jj (Jujutsu) release binaries into the per-platform
// `@smithers-orchestrator/jj-<platform>` packages so Smithers can ship a
// bundled jj. Run this before `pnpm release`; the binaries are gitignored and
// never committed.
//
// Usage:
//   pnpm fetch:jj                 # latest jj release
//   JJ_VERSION=v0.28.0 pnpm fetch:jj
//   pnpm fetch:jj --force         # re-download even if a binary is present
//
// The release matrix below maps each npm platform package to the Rust target
// triple jj publishes its release assets under (github.com/jj-vcs/jj/releases).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORCE = process.argv.includes("--force");
const REPO = "jj-vcs/jj";

/** @type {Array<{ pkg: string; target: string; archive: "tar.gz" | "zip"; bin: string }>} */
const MATRIX = [
  { pkg: "jj-darwin-arm64", target: "aarch64-apple-darwin", archive: "tar.gz", bin: "jj" },
  { pkg: "jj-darwin-x64", target: "x86_64-apple-darwin", archive: "tar.gz", bin: "jj" },
  { pkg: "jj-linux-arm64", target: "aarch64-unknown-linux-musl", archive: "tar.gz", bin: "jj" },
  { pkg: "jj-linux-x64", target: "x86_64-unknown-linux-musl", archive: "tar.gz", bin: "jj" },
  { pkg: "jj-win32-x64", target: "x86_64-pc-windows-msvc", archive: "zip", bin: "jj.exe" },
];

async function resolveVersion() {
  if (process.env.JJ_VERSION) return process.env.JJ_VERSION;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "smithers-fetch-jj", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} resolving latest jj release; set JJ_VERSION to pin one`);
  const tag = (await res.json()).tag_name;
  if (!tag) throw new Error("latest jj release has no tag_name");
  return tag;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { "User-Agent": "smithers-fetch-jj" }, redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function extractBinary(archivePath, archiveKind, binName, workDir) {
  if (archiveKind === "tar.gz") {
    const r = spawnSync("tar", ["-xzf", archivePath, "-C", workDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`tar failed for ${archivePath}`);
  } else {
    const r = spawnSync("unzip", ["-o", "-q", archivePath, "-d", workDir], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`unzip failed for ${archivePath} (need the \`unzip\` tool)`);
  }
  // jj archives place the binary at the top level; find it defensively.
  const found = findFile(workDir, binName);
  if (!found) throw new Error(`could not find ${binName} inside ${archivePath}`);
  return found;
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

const version = await resolveVersion();
console.log(`▸ fetching jj ${version} for ${MATRIX.length} platforms (repo ${REPO})`);

for (const { pkg, target, archive, bin } of MATRIX) {
  const binDir = join(root, "packages", pkg, "bin");
  const dest = join(binDir, bin);
  if (existsSync(dest) && !FORCE) {
    // A cached binary may have come from a tarball or copy operation that
    // stripped its executable bits. Normalize it before publish just as we do
    // for a fresh download; otherwise the next package can preserve mode 0644.
    if (bin !== "jj.exe") chmodSync(dest, 0o755);
    console.log(`  = ${pkg}: ${bin} present (use --force to refresh)`);
    continue;
  }
  mkdirSync(binDir, { recursive: true });
  const asset = `jj-${version}-${target}.${archive}`;
  const url = `https://github.com/${REPO}/releases/download/${version}/${asset}`;
  const work = mkdtempSync(join(tmpdir(), "jj-fetch-"));
  try {
    const archivePath = join(work, asset);
    console.log(`  ↓ ${pkg}: ${asset}`);
    await download(url, archivePath);
    const extracted = extractBinary(archivePath, archive, bin, work);
    copyFileSync(extracted, dest);
    if (bin !== "jj.exe") chmodSync(dest, 0o755);
    console.log(`  ✓ ${pkg}: ${bin}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

console.log("▸ done. Binaries are gitignored; commit nothing — `pnpm release` publishes them.");
