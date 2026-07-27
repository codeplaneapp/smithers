// Compose the durability snapshot pieces into a start/stop handle the engine can
// drive around a single agent attempt. Returns a no-op handle when disabled, when
// there is no worktree, or when the worktree is not a jj repo (Tier 2 still needs
// jj as the store), so the engine call site stays a couple of lines.
//
// DI seams (isJjRepoFn / captureSnapshot / createWatcher) default to the real jj +
// fs watcher and are overridden in tests.

import { Effect } from "effect";
import { captureWorkspaceSnapshot, isJjRepo } from "@smithers-orchestrator/vcs/jj";
import { getPlatformLayer } from "./platform-layer.js";
import { createSnapshotService } from "./snapshotService.js";
import { createWorkspaceWatcher } from "./workspaceWatcher.js";
import { pruneWorkspaceDurability } from "./pruneWorkspaceDurability.js";
import { appendGap, defaultGapSpoolPath } from "./durabilityGapSpool.js";
import { createSnapshotServer, nextSnapshotSocketPath } from "./snapshotServer.js";
import { logInfo } from "@smithers-orchestrator/observability/logging";

/**
 * Build a human label from a CLI hook payload (Claude PostToolUse JSON or our own).
 * @param {Record<string, any>} p
 */
function hookLabel(p) {
  const tool = p.label ?? p.toolName ?? p.tool_name ?? "tool";
  const file = p.filePath ?? p.tool_input?.file_path ?? "";
  return String(file ? `${tool} ${file}` : tool).slice(0, 200);
}

/**
 * @template A
 * @param {Effect.Effect<A, never, any>} effect
 * @returns {Promise<A>}
 */
const runVcs = (effect) => Effect.runPromise(effect.pipe(Effect.provide(getPlatformLayer())));

/** @type {Map<string, Promise<void>>} */
const workspaceAttemptTails = new Map();
const WORKSPACE_ATTEMPT_LOCK_TIMEOUT_MS = 5 * 60_000;
const WORKSPACE_ATTEMPT_LOCK_LOG_AFTER_MS = 1_000;

/**
 * Durability checkpoints represent one task's writes, so two attempts may not
 * mutate the same worktree while either watcher is active.
 * @param {string} cwd
 * @param {{ signal?: AbortSignal; timeoutMs?: number; logAfterMs?: number; onWait?: () => void }} [options]
 * @returns {Promise<() => void>}
 */
async function acquireWorkspaceAttempt(cwd, options = {}) {
  const { signal, timeoutMs = WORKSPACE_ATTEMPT_LOCK_TIMEOUT_MS, logAfterMs = WORKSPACE_ATTEMPT_LOCK_LOG_AFTER_MS } =
    options;
  if (signal?.aborted) throw signal.reason ?? new Error("Durability worktree lock wait aborted");
  const previous = workspaceAttemptTails.get(cwd) ?? Promise.resolve();
  /** @type {() => void} */
  let resolveCurrent = () => {};
  const current = new Promise((resolve) => {
    resolveCurrent = resolve;
  });
  workspaceAttemptTails.set(cwd, current);
  let timeout;
  let waitLog;
  /** @type {(() => void) | undefined} */
  let removeAbort;
  try {
    const waiters = [
      previous,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting ${timeoutMs}ms for durability worktree lock: ${cwd}`)),
          timeoutMs,
        );
      }),
    ];
    if (signal) {
      waiters.push(
        new Promise((_, reject) => {
          const onAbort = () => reject(signal.reason ?? new Error("Durability worktree lock wait aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        }),
      );
    }
    waitLog = setTimeout(() => options.onWait?.(), logAfterMs);
    await Promise.race(waiters);
  } catch (error) {
    void previous.finally(() => {
      if (workspaceAttemptTails.get(cwd) === current) workspaceAttemptTails.delete(cwd);
      resolveCurrent();
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(waitLog);
    removeAbort?.();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (workspaceAttemptTails.get(cwd) === current) workspaceAttemptTails.delete(cwd);
    resolveCurrent();
  };
}

const NOOP_HANDLE = {
  active: false,
  socketPath: null,
  /** @returns {Promise<{ skipped: true }>} */
  async snapshot() {
    return { skipped: true };
  },
  async stop() {},
};

/**
 * @typedef {object} StartDurabilityOptions
 * @property {boolean} enabled
 * @property {{ upsertWorkspaceState: Function, insertWorkspaceCheckpoint: Function }} adapter
 * @property {string} runId
 * @property {string} nodeId
 * @property {number} [iteration]
 * @property {number} [attempt]
 * @property {string | undefined} cwd
 * @property {() => number} [nowMs]
 * @property {(gap: { request: unknown, reason: string }) => void} [onGap]
 * @property {(cwd: string) => Promise<boolean>} [isJjRepoFn]
 * @property {(cwd: string) => Promise<{ commitId: string, changeId: string, operationId: string } | null>} [captureSnapshot]
 * @property {(deps: { cwd: string, onSettle: () => void }) => { close: () => void, watching?: boolean }} [createWatcher]
 * @property {boolean} [withSocket] When true, open a snapshot socket server so a CLI agent's hook can request strict Tier 1 snapshots.
 * @property {(deps: { runId: string, nodeId: string, snapshot: Function }) => Promise<{ socketPath: string, close: () => void }>} [createSocketServer]
 * @property {AbortSignal} [signal] Cancels a queued wait for another attempt using the same worktree.
 * @property {number} [lockTimeoutMs]
 * @property {number} [lockLogAfterMs]
 * @property {() => void} [onLockWait]
 */

/**
 * @param {StartDurabilityOptions} opts
 * @returns {Promise<{ active: boolean, snapshot: (req?: Record<string, unknown>) => Promise<unknown>, stop: () => Promise<void> }>}
 */
export async function startDurability(opts) {
  const {
    enabled,
    adapter,
    runId,
    nodeId,
    iteration = 0,
    attempt = 0,
    cwd,
    nowMs = () => Date.now(),
    onGap,
    isJjRepoFn = (c) => runVcs(isJjRepo(c)),
    captureSnapshot = (c) => runVcs(captureWorkspaceSnapshot(c)),
    createWatcher = createWorkspaceWatcher,
    withSocket = false,
    createSocketServer = createSnapshotServer,
    signal,
    lockTimeoutMs,
    lockLogAfterMs,
    onLockWait = () =>
      logInfo(
        "durability attempt waiting for shared worktree",
        { runId, nodeId, iteration, attempt, cwd },
        "engine:durability",
      ),
  } = opts;

  if (!enabled || !cwd) return NOOP_HANDLE;

  let isJj = false;
  try {
    isJj = await isJjRepoFn(cwd);
  } catch {
    isJj = false;
  }
  if (!isJj) return NOOP_HANDLE;

  // Default gaps to a durable spool (outside the worktree) so they survive an
  // engine crash even though the engine passes no onGap. An explicit onGap wins.
  const spoolPath = defaultGapSpoolPath(runId);
  const onGapEffective =
    onGap ??
    ((gap) =>
      appendGap(spoolPath, {
        runId,
        nodeId,
        iteration,
        attempt,
        cwd,
        reason: gap.reason,
        ts: nowMs(),
      }));
  const service = createSnapshotService({ captureSnapshot, adapter, nowMs, onGap: onGapEffective });
  const base = { runId, nodeId, iteration, attempt, cwd };
  /** @param {Record<string, unknown>} req */
  const watchSnapshot = (req) =>
    service.snapshot({ ...base, source: "watch", tier: 2, label: null, toolUseId: null, ...req });
  const releaseWorkspaceAttempt = await acquireWorkspaceAttempt(cwd, {
    signal,
    timeoutMs: lockTimeoutMs,
    logAfterMs: lockLogAfterMs,
    onWait: onLockWait,
  });
  let watcher;
  try {
    watcher = createWatcher({
      cwd,
      onSettle: () => {
        void watchSnapshot({});
      },
    });
  } catch (error) {
    releaseWorkspaceAttempt();
    throw error;
  }

  // Optional Unix-socket server so a CLI agent's PostToolUse hook can request a
  // strict Tier 1 snapshot. Created only when the engine asks (withSocket), so
  // unit tests and the default path never open a real socket.
  let socketServer = null;
  if (withSocket) {
    try {
      socketServer = await createSocketServer({
        socketPath: nextSnapshotSocketPath(),
        onHook: async (payload) => {
          const result = await service.snapshot({
            ...base,
            source: "hook",
            tier: 1,
            label: hookLabel(payload),
            toolUseId: payload.toolUseId ?? payload.tool_use_id ?? null,
          });
          return { ok: !(result && result.gap), seq: result && result.seq };
        },
      });
    } catch {
      socketServer = null;
    }
  }

  return {
    active: true,
    // Socket path for a CLI agent's hook to call back into (null if no socket).
    socketPath: socketServer?.socketPath ?? null,
    // Request a durability snapshot. Defaults to a Tier 2 "watch" snapshot
    // (the debounced filesystem watcher's own writes); the in-process tool
    // wrap and CLI hooks override `source` ("wrap"/"hook"), `tier` (1),
    // `label`, and `toolUseId` via `req`.
    snapshot: (req = {}) =>
      service.snapshot({ ...base, source: "watch", tier: 2, label: null, toolUseId: null, ...req }),
    async stop() {
      try {
        watcher.close();
        socketServer?.close();
        // Final flush so the last settled write is captured even if the
        // trailing-idle debounce never fired before the attempt ended.
        await watchSnapshot({});
        // Bound table growth: keep the latest checkpoints/states per scope.
        // Run-scoped + best-effort, so it never affects the run.
        await pruneWorkspaceDurability({ adapter, runId });
      } finally {
        releaseWorkspaceAttempt();
      }
    },
  };
}
