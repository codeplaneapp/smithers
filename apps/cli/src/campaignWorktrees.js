import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { listSmithersWorktrees } from "@smthrs/engine/listSmithersWorktrees";
import { runGit } from "@smthrs/engine/runGit";
import { directorySizeBytes } from "./diskUsage.js";
import { listLiveProcessCwds } from "./reapUnmanagedScratch.js";

/** @param {string} parent @param {string} child */
function containsPath(parent, child) {
  const root = canonicalPath(parent);
  const candidate = canonicalPath(child);
  return candidate !== root && candidate.startsWith(`${root}${sep}`);
}

/** @param {string} path */
function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** @param {string} rootDir @param {string} path */
function isCampaignPath(rootDir, path) {
  return [resolve(rootDir, ".smithers", "workflows", ".worktrees"), resolve(rootDir, ".smithers", "worktrees")].some(
    (root) => containsPath(root, path),
  );
}

/** @param {string} output */
function parseWorktreePorcelain(output) {
  return output
    .trim()
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      if (!path) return null;
      return {
        path: resolve(path),
        head: lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length) ?? null,
        branch: lines.find((line) => line.startsWith("branch "))?.slice("branch ".length) ?? null,
        locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
        prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
      };
    })
    .filter(Boolean);
}

/**
 * Campaign workflows historically created registered Git worktrees directly
 * under Smithers' hidden worktree roots, before the engine added owner files.
 * Surface only those exact locations; arbitrary human worktrees stay invisible.
 *
 * @param {string} rootDir
 */
export async function listUnownedCampaignWorktrees(rootDir) {
  const root = canonicalPath(rootDir);
  const result = await runGit(root, ["worktree", "list", "--porcelain"]);
  if (result.code !== 0) return [];
  const owned = new Set((await listSmithersWorktrees(root)).map((entry) => canonicalPath(entry.path)));
  return parseWorktreePorcelain(result.stdout)
    .map((entry) => ({ ...entry, path: canonicalPath(entry.path) }))
    .filter((entry) => entry.path !== root && isCampaignPath(root, entry.path) && !owned.has(entry.path))
    .map((entry) => {
      let updatedAtMs = 0;
      try {
        updatedAtMs = lstatSync(entry.path).mtimeMs;
      } catch {}
      return {
        ...entry,
        exists: existsSync(entry.path),
        updatedAtMs,
        vcsType: existsSync(join(entry.path, ".jj")) ? "jj" : "git",
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** @param {string} worktreePath @param {string} rootDir @param {string | null} head */
async function hasUnpublishedWork(worktreePath, rootDir, head) {
  if (!head) return true;
  const status = await runGit(worktreePath, ["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim() !== "") return true;
  const onRemote = await runGit(worktreePath, ["branch", "-r", "--contains", head]);
  if (onRemote.code === 0 && onRemote.stdout.trim() !== "") return false;
  const rootHead = await runGit(rootDir, ["rev-parse", "HEAD"]);
  if (rootHead.code === 0) {
    const merged = await runGit(rootDir, ["merge-base", "--is-ancestor", head, rootHead.stdout.trim()]);
    if (merged.code === 0) return false;
  }
  for (const upstream of ["origin/main", "main"]) {
    const cherry = await runGit(rootDir, ["cherry", upstream, head]);
    const lines = cherry.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (cherry.code === 0 && lines.length > 0 && lines.every((line) => line.startsWith("-"))) return false;
  }
  return true;
}

/**
 * Reclaim legacy campaign worktrees only after explicit opt-in. Unlike the
 * owned-worktree `force` path, this never discards unpublished changes: an
 * unowned lane must be clean and its HEAD must already exist upstream.
 *
 * @param {{
 *   rootDir: string;
 *   includeUnmanaged?: boolean;
 *   olderThanMs?: number;
 *   nowMs?: number;
 *   dryRun?: boolean;
 *   liveCwds?: string[] | null;
 *   sizeOf?: (path: string) => Promise<number>;
 * }} options
 */
export async function reapUnownedCampaignWorktrees(options) {
  const rootDir = canonicalPath(options.rootDir);
  const includeUnmanaged = options.includeUnmanaged ?? false;
  const olderThanMs = options.olderThanMs ?? 7 * 24 * 60 * 60 * 1_000;
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun ?? false;
  const liveCwds =
    includeUnmanaged && options.liveCwds === undefined ? listLiveProcessCwds() : (options.liveCwds ?? null);
  const canonicalLiveCwds = liveCwds?.map(canonicalPath) ?? null;
  const sizeOf = options.sizeOf ?? directorySizeBytes;
  const removed = [];
  const skipped = [];
  let bytesFreed = 0;
  let totalBytes = 0;

  for (const worktree of await listUnownedCampaignWorktrees(rootDir)) {
    const bytes = worktree.exists ? await sizeOf(worktree.path) : 0;
    totalBytes += bytes;
    const entry = { path: worktree.path, branch: worktree.branch, head: worktree.head, bytes };
    if (!includeUnmanaged) {
      skipped.push({ ...entry, reason: "requires-include-unmanaged" });
      continue;
    }
    if (worktree.locked) {
      skipped.push({ ...entry, reason: "locked" });
      continue;
    }
    if (worktree.vcsType === "jj") {
      skipped.push({ ...entry, reason: "unowned-jj-workspace" });
      continue;
    }
    if (nowMs - worktree.updatedAtMs < olderThanMs) {
      skipped.push({ ...entry, reason: "too-recent" });
      continue;
    }
    if (canonicalLiveCwds === null) {
      skipped.push({ ...entry, reason: "live-process-check-unavailable" });
      continue;
    }
    if (canonicalLiveCwds.some((cwd) => cwd === worktree.path || cwd.startsWith(`${worktree.path}${sep}`))) {
      skipped.push({ ...entry, reason: "live-process" });
      continue;
    }
    if (worktree.exists && (await hasUnpublishedWork(worktree.path, rootDir, worktree.head))) {
      skipped.push({ ...entry, reason: "unpublished-work" });
      continue;
    }
    if (!dryRun && worktree.exists) {
      const remove = await runGit(rootDir, ["worktree", "remove", worktree.path]);
      if (remove.code !== 0) {
        skipped.push({ ...entry, reason: "remove-failed" });
        continue;
      }
    }
    removed.push(entry);
    bytesFreed += bytes;
  }
  if (!dryRun && removed.length > 0) await runGit(rootDir, ["worktree", "prune"]);
  return { removed, skipped, bytesFreed, totalBytes, dryRun, includeUnmanaged };
}
