import { findVcsRoot } from "@smthrs/vcs/find-root";
import { reapWorktrees } from "@smthrs/engine/reapWorktrees";
import { compactLegacySnapshots, retainRunHistory } from "@smthrs/db/run-history-gc";
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
 *   adapter?: import("@smthrs/db/adapter").SmithersDb | null;
 *   olderThanMs?: number;
 *   dryRun?: boolean;
 *   includeUnmanaged?: boolean;
 *   forceWorktrees?: boolean;
 *   nowMs?: number;
 *   sandboxDir?: string;
 *   tempRoots?: string[];
 *   liveCwds?: string[] | null;
 *   sizeOf?: (path: string) => Promise<number>;
 *   env?: NodeJS.ProcessEnv;
 *   dbRetentionDays?: number | null;
 *   dbChunkSize?: number;
 *   snapshotBatchSize?: number;
 * }} [options]
 */
export async function runWorkspaceGc(options = {}) {
  const cwd = options.cwd ?? cliWorkspace.cwd();
  const workspaceRoot = findSmithersAnchorDir(cwd) ?? cwd;
  const olderThanMs = options.olderThanMs ?? 7 * DAY_MS;
  const dryRun = options.dryRun ?? false;
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env ?? process.env;
  const configuredRetention = options.dbRetentionDays ?? env.SMITHERS_DB_RETENTION_DAYS;
  let dbRetentionDays = null;
  if (configuredRetention !== undefined && configuredRetention !== null && configuredRetention !== "") {
    dbRetentionDays = Number(configuredRetention);
    if (!Number.isFinite(dbRetentionDays) || dbRetentionDays < 0) {
      throw new Error("SMITHERS_DB_RETENTION_DAYS must be a nonnegative number");
    }
  }
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
      env,
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
      env,
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
    const retention =
      adapter && dbRetentionDays !== null
        ? await retainRunHistory(adapter, {
            cutoffMs: nowMs - dbRetentionDays * DAY_MS,
            dryRun,
            chunkSize: options.dbChunkSize,
          })
        : {
            enabled: false,
            dryRun,
            retentionDays: null,
            removedRuns: [],
            rowsByTable: {},
            interrupted: false,
            skipped: adapter ? "retention-not-configured" : "no-database",
          };
    if (retention.enabled) retention.retentionDays = dbRetentionDays;
    // Delete explicitly retained history first so snapshot compaction never
    // spends I/O deduplicating payloads that this invocation will remove.
    const snapshots = adapter
      ? await compactLegacySnapshots(adapter, {
          dryRun,
          batchSize: options.snapshotBatchSize,
        })
      : {
          dryRun,
          migratedRows: 0,
          clearedInlineBytes: 0,
          batches: 0,
          remainingRows: 0,
          remainingInlineBytes: 0,
          interrupted: false,
          skipped: "no-database",
        };
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
      database: {
        snapshots,
        retention,
        vacuumed: false,
      },
    };
  } finally {
    await cleanup();
  }
}
