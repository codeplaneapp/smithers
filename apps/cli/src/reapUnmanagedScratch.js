import { lstatSync, readlinkSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { directorySizeBytes } from "./diskUsage.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PREVIOUS_UPGRADE_PATTERN = /^upgrade-smthrs.*\.previous.*$/;

/**
 * List process working directories for the live-use guard. Linux exposes them
 * through procfs; macOS/BSD use lsof. A failed inventory returns null, which
 * makes the reaper retain every unmanaged candidate.
 *
 * @returns {string[] | null}
 */
export function listLiveProcessCwds() {
  if (process.platform === "linux") {
    try {
      const paths = [];
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const path = readlinkSync(`/proc/${name}/cwd`);
          if (isAbsolute(path)) paths.push(resolve(path));
        } catch {}
      }
      return paths;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    const result = spawnSync("lsof", ["-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 10_000 });
    if (result.error || result.status !== 0) return null;
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("n/") && isAbsolute(line.slice(1)))
      .map((line) => resolve(line.slice(1)));
  }
  return null;
}

/** @param {string} parent @param {string} child */
function containsPath(parent, child) {
  const root = canonicalPath(parent);
  const candidate = canonicalPath(child);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** @param {string} path */
function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Find the two legacy campaign scratch shapes reported in #1491:
 * `<tmp>/smithers/*` lane directories and `upgrade-smthrs*.previous*`
 * backups. They predate ownership metadata, so deletion requires the explicit
 * `includeUnmanaged` opt-in, a minimum age, and a successful live-cwd scan.
 *
 * @param {{
 *   includeUnmanaged?: boolean;
 *   dryRun?: boolean;
 *   olderThanMs?: number;
 *   nowMs?: number;
 *   tempRoots?: string[];
 *   liveCwds?: string[] | null;
 *   sizeOf?: (path: string) => Promise<number>;
 *   warn?: (line: string) => void;
 * }} [options]
 */
export async function reapUnmanagedScratch(options = {}) {
  const includeUnmanaged = options.includeUnmanaged ?? false;
  const dryRun = options.dryRun ?? false;
  const olderThanMs = options.olderThanMs ?? 7 * DAY_MS;
  const nowMs = options.nowMs ?? Date.now();
  const sizeOf = options.sizeOf ?? directorySizeBytes;
  const roots = (options.tempRoots ?? defaultTempRoots()).map(canonicalPath);
  const liveCwds =
    includeUnmanaged && options.liveCwds === undefined ? listLiveProcessCwds() : (options.liveCwds ?? null);
  const canonicalLiveCwds = liveCwds?.map(canonicalPath) ?? null;
  const candidatePaths = new Set();

  for (const root of roots) {
    const resolvedRoot = canonicalPath(root);
    try {
      for (const entry of readdirSync(resolvedRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && PREVIOUS_UPGRADE_PATTERN.test(entry.name)) {
          candidatePaths.add(canonicalPath(join(resolvedRoot, entry.name)));
        }
      }
    } catch {}
    const smithersScratch = join(resolvedRoot, "smithers");
    try {
      for (const entry of readdirSync(smithersScratch, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          candidatePaths.add(canonicalPath(join(smithersScratch, entry.name)));
        }
      }
    } catch {}
  }

  const removed = [];
  const skipped = [];
  let bytesFreed = 0;
  let totalBytes = 0;
  for (const path of [...candidatePaths].sort()) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const recognized = roots.some((root) => {
      const resolvedRoot = canonicalPath(root);
      return (
        containsPath(join(resolvedRoot, "smithers"), path) ||
        (canonicalPath(path).startsWith(`${resolvedRoot}${sep}`) &&
          PREVIOUS_UPGRADE_PATTERN.test(canonicalPath(path).slice(resolvedRoot.length + 1)))
      );
    });
    if (!recognized) continue;
    const bytes = await sizeOf(path);
    totalBytes += bytes;
    if (!includeUnmanaged) {
      skipped.push({ path, bytes, reason: "requires-include-unmanaged" });
      continue;
    }
    if (nowMs - stat.mtimeMs < olderThanMs) {
      skipped.push({ path, bytes, reason: "too-recent" });
      continue;
    }
    if (canonicalLiveCwds === null) {
      skipped.push({ path, bytes, reason: "live-process-check-unavailable" });
      continue;
    }
    if (canonicalLiveCwds.some((cwd) => containsPath(path, cwd))) {
      skipped.push({ path, bytes, reason: "live-process" });
      continue;
    }
    try {
      if (!dryRun) rmSync(path, { recursive: true, force: true });
      removed.push({ path, bytes });
      bytesFreed += bytes;
    } catch (error) {
      skipped.push({ path, bytes, reason: "remove-failed" });
      safeWarn(options.warn, `[smithers] Warning: scratch GC could not remove ${path}: ${messageOf(error)}\n`);
    }
  }
  return { removed, skipped, bytesFreed, totalBytes, dryRun, includeUnmanaged };
}

function defaultTempRoots() {
  const roots = new Set([canonicalPath(tmpdir())]);
  if (process.platform === "darwin") roots.add(canonicalPath("/private/tmp"));
  return [...roots];
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {((line: string) => void) | undefined} warn @param {string} line */
function safeWarn(warn, line) {
  try {
    (warn ?? ((text) => process.stderr.write(text)))(line);
  } catch {}
}
