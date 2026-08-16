import { findVcsRoot } from "@smthrs/vcs/find-root";
import { reapWorktrees } from "@smthrs/engine/reapWorktrees";
import { findSmithersAnchorDir } from "smthrs/findSmithersAnchorDir";
import { join } from "node:path";
import { cliWorkspace } from "./cliWorkspace.js";
import { filesystemUsage } from "./diskUsage.js";
import { findAndOpenDb } from "./find-db.js";
import { reapDetachedRunLogs } from "./reapDetachedRunLogs.js";
import { reapSandboxRoots } from "./reapSandboxRoots.js";
import { listLiveProcessCwds, reapUnmanagedScratch } from "./reapUnmanagedScratch.js";
import { reapUnownedCampaignWorktrees } from "./campaignWorktrees.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Run every disk-hygiene pass with one store snapshot and one age policy.
 * Deletion remains ownership-aware: logs, sandboxes, and worktrees need a
 * terminal owning run; legacy temp artifacts require a separate explicit opt-in.
 *
 * @param {{
 *   cwd?: string;
 *   adapter?: Pick<import("@smthrs/db/adapter").SmithersDb, "getRun"> | null;
 *   olderThanMs?: number;
 *   dryRun?: boolean;
 *   includeUnmanaged?: boolean;
 *   forceWorktrees?: boolean;
 *   nowMs?: number;
 *   sandboxDir?: string;
 *   tempRoots?: string[];
 *   liveCwds?: string[] | null;
 *   sizeOf?: (path: string) => Promise<number>;
 * }} [options]
 */
export async function runWorkspaceGc(options = {}) {
  const cwd = options.cwd ?? cliWorkspace.cwd();
  const workspaceRoot = findSmithersAnchorDir(cwd) ?? cwd;
  const olderThanMs = options.olderThanMs ?? 7 * DAY_MS;
  const dryRun = options.dryRun ?? false;
  const nowMs = options.nowMs ?? Date.now();
  const before = filesystemUsage(workspaceRoot);
  const liveCwds =
    options.includeUnmanaged && options.liveCwds === undefined ? listLiveProcessCwds() : options.liveCwds;
  let adapter = options.adapter;
  let cleanup = () => {};
  if (adapter === undefined) {
    try {
      const opened = await findAndOpenDb(cwd);
      adapter = opened.adapter;
      cleanup = opened.cleanup;
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error)?.code !== "CLI_DB_NOT_FOUND") throw error;
      adapter = null;
    }
  }

  try {
    const logs = await reapDetachedRunLogs({
      cwd: workspaceRoot,
      adapter,
      olderThanMs,
      dryRun,
      nowMs,
      allowAbsentRuns: false,
      minimumAgeForSizeCap: true,
    });
    const legacyLogs = await reapDetachedRunLogs({
      cwd: workspaceRoot,
      logDir: join(workspaceRoot, ".smithers", "workflows"),
      adapter,
      olderThanMs,
      dryRun,
      nowMs,
      allowAbsentRuns: false,
      minimumAgeForSizeCap: true,
    });
    const sandboxes = await reapSandboxRoots({
      cwd: workspaceRoot,
      adapter: adapter ?? undefined,
      sandboxDir: options.sandboxDir,
      olderThanMs,
      dryRun,
      nowMs,
      sizeOf: options.sizeOf,
    });
    const vcs = findVcsRoot(workspaceRoot);
    const worktrees = vcs
      ? await reapWorktrees({
          rootDir: vcs.root,
          getRunStatus: async (runId) => (adapter ? (await adapter.getRun(runId))?.status : null),
          olderThanMs,
          dryRun,
          force: options.forceWorktrees ?? false,
          nowMs,
        })
      : { removed: [], skipped: [], bytesFreed: 0, dryRun };
    const unownedWorktrees = vcs
      ? await reapUnownedCampaignWorktrees({
          rootDir: vcs.root,
          includeUnmanaged: options.includeUnmanaged,
          olderThanMs,
          dryRun,
          nowMs,
          liveCwds,
          sizeOf: options.sizeOf,
        })
      : { removed: [], skipped: [], bytesFreed: 0, totalBytes: 0, dryRun, includeUnmanaged: false };
    const unmanagedScratch = await reapUnmanagedScratch({
      includeUnmanaged: options.includeUnmanaged,
      olderThanMs,
      dryRun,
      nowMs,
      tempRoots: options.tempRoots,
      liveCwds,
      sizeOf: options.sizeOf,
    });
    const bytesFreed =
      logs.bytesFreed +
      legacyLogs.bytesFreed +
      sandboxes.bytesFreed +
      worktrees.bytesFreed +
      unownedWorktrees.bytesFreed +
      unmanagedScratch.bytesFreed;
    return {
      cwd: workspaceRoot,
      dryRun,
      olderThanMs,
      bytesFreed,
      disk: { before, after: filesystemUsage(workspaceRoot) },
      logs,
      legacyLogs,
      sandboxes,
      worktrees,
      unownedWorktrees,
      unmanagedScratch,
    };
  } finally {
    cleanup();
  }
}
