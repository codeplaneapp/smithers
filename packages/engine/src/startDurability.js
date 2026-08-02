// Compose the durability snapshot pieces into a start/stop handle the engine can
// drive around a single agent attempt. Returns a no-op handle when disabled, when
// there is no worktree, or when the worktree is not a jj repo (Tier 2 still needs
// jj as the store), so the engine call site stays a couple of lines.
//
// DI seams (isJjRepoFn / captureSnapshot / createWatcher) default to the real jj +
// fs watcher and are overridden in tests.

import { Effect } from "effect";
import { captureWorkspaceSnapshot, isJjRepo } from "@smthrs/vcs/jj";
import { getPlatformLayer } from "./platform-layer.js";
import { createSnapshotService } from "./snapshotService.js";
import { createWorkspaceWatcher } from "./workspaceWatcher.js";
import { pruneWorkspaceDurability } from "./pruneWorkspaceDurability.js";
import { appendGap, defaultGapSpoolPath } from "./durabilityGapSpool.js";
import { createSnapshotServer, nextSnapshotSocketPath } from "./snapshotServer.js";
import { logError, logInfo } from "@smthrs/observability/logging";

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

/** @type {Map<string, { activeRunId: string | null, activeCount: number, waiters: Array<any> }>} */
const workspaceAttemptLocks = new Map();
/** @type {Map<string, Promise<void>>} */
const workspaceSnapshotTails = new Map();
const WORKSPACE_ATTEMPT_LOCK_TIMEOUT_MS = 5 * 60_000;
const WORKSPACE_ATTEMPT_LOCK_LOG_AFTER_MS = 1_000;

/**
 * Release one member of the active run group and admit the next queued group.
 * Same-run attempts overlap; a child run sharing the worktree waits for the
 * parent run's watcher group so their checkpoints cannot absorb each other's
 * writes.
 *
 * @param {string} cwd
 * @param {{ activeRunId: string | null, activeCount: number, waiters: Array<any> }} lock
 */
function releaseWorkspaceAttempt(cwd, lock) {
  lock.activeCount -= 1;
  if (lock.activeCount > 0) return;
  lock.activeRunId = null;
  while (lock.waiters[0]?.settled) lock.waiters.shift();
  const first = lock.waiters.shift();
  if (!first) {
    if (workspaceAttemptLocks.get(cwd) === lock) workspaceAttemptLocks.delete(cwd);
    return;
  }
  const runId = first.runId;
  const admitted = [first];
  while (lock.waiters[0]?.runId === runId) admitted.push(lock.waiters.shift());
  lock.activeRunId = runId;
  lock.activeCount = admitted.length;
  for (const waiter of admitted) {
    waiter.settled = true;
    waiter.cleanup();
    waiter.resolve(makeWorkspaceAttemptRelease(cwd, lock));
  }
}

/**
 * @param {string} cwd
 * @param {{ activeRunId: string | null, activeCount: number, waiters: Array<any> }} lock
 */
function makeWorkspaceAttemptRelease(cwd, lock) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseWorkspaceAttempt(cwd, lock);
  };
}

/**
 * Durability watchers for attempts in one run may overlap. Different run
 * scopes sharing the same cwd are isolated for attribution (notably a parent
 * and its child workflow).
 *
 * @param {string} cwd
 * @param {string} runId
 * @param {{ signal?: AbortSignal; timeoutMs?: number; logAfterMs?: number; onWait?: () => void }} [options]
 * @returns {Promise<() => void>}
 */
async function acquireWorkspaceAttempt(cwd, runId, options = {}) {
  const {
    signal,
    timeoutMs = WORKSPACE_ATTEMPT_LOCK_TIMEOUT_MS,
    logAfterMs = WORKSPACE_ATTEMPT_LOCK_LOG_AFTER_MS,
  } = options;
  if (signal?.aborted) throw signal.reason ?? new Error("Durability worktree lock wait aborted");
  let lock = workspaceAttemptLocks.get(cwd);
  if (!lock) {
    lock = { activeRunId: null, activeCount: 0, waiters: [] };
    workspaceAttemptLocks.set(cwd, lock);
  }
  if (lock.activeCount === 0 || (lock.activeRunId === runId && lock.waiters.length === 0)) {
    lock.activeRunId = runId;
    lock.activeCount += 1;
    return makeWorkspaceAttemptRelease(cwd, lock);
  }
  return new Promise((resolve, reject) => {
    let timeout;
    let waitLog;
    let removeAbort = () => {};
    const waiter = {
      runId,
      settled: false,
      resolve,
      cleanup: () => {
        clearTimeout(timeout);
        clearTimeout(waitLog);
        removeAbort();
      },
    };
    const fail = (error) => {
      if (waiter.settled) return;
      waiter.settled = true;
      waiter.cleanup();
      const index = lock.waiters.indexOf(waiter);
      if (index >= 0) lock.waiters.splice(index, 1);
      reject(error);
    };
    timeout = setTimeout(() => {
      const error = new Error(`Timed out waiting ${timeoutMs}ms for durability worktree lock: ${cwd}`);
      error.name = "DurabilityLockTimeoutError";
      fail(error);
    }, timeoutMs);
    waitLog = setTimeout(() => options.onWait?.(), logAfterMs);
    if (signal) {
      const onAbort = () => fail(signal.reason ?? new Error("Durability worktree lock wait aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    }
    lock.waiters.push(waiter);
  });
}

/**
 * Serialize only the brief JJ capture operation across every watcher using a
 * worktree. Capture contention becomes a durability gap, never an attempt
 * failure.
 *
 * @param {string} cwd
 * @param {{ signal?: AbortSignal; timeoutMs?: number; logAfterMs?: number; onWait?: () => void }} [options]
 * @returns {Promise<() => void>}
 */
async function acquireWorkspaceSnapshot(cwd, options = {}) {
  const {
    signal,
    timeoutMs = WORKSPACE_ATTEMPT_LOCK_TIMEOUT_MS,
    logAfterMs = WORKSPACE_ATTEMPT_LOCK_LOG_AFTER_MS,
  } = options;
  if (signal?.aborted) throw signal.reason ?? new Error("Durability snapshot lock wait aborted");
  const previous = workspaceSnapshotTails.get(cwd) ?? Promise.resolve();
  let resolveCurrent = () => {};
  const current = new Promise((resolve) => {
    resolveCurrent = resolve;
  });
  workspaceSnapshotTails.set(cwd, current);
  let timeout;
  let waitLog;
  let removeAbort = () => {};
  try {
    const waits = [
      previous,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(`Timed out waiting ${timeoutMs}ms for durability snapshot lock: ${cwd}`);
          error.name = "DurabilityLockTimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ];
    if (signal) {
      waits.push(
        new Promise((_, reject) => {
          const onAbort = () => reject(signal.reason ?? new Error("Durability snapshot lock wait aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        }),
      );
    }
    waitLog = setTimeout(() => options.onWait?.(), logAfterMs);
    await Promise.race(waits);
  } catch (error) {
    void previous.finally(() => {
      if (workspaceSnapshotTails.get(cwd) === current) workspaceSnapshotTails.delete(cwd);
      resolveCurrent();
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(waitLog);
    removeAbort();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (workspaceSnapshotTails.get(cwd) === current) workspaceSnapshotTails.delete(cwd);
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
 * @property {(gap: { request: unknown, reason: string, needsAttention?: boolean }) => void} [onGap]
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
        "durability snapshot waiting for shared worktree",
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
        needsAttention: Boolean(gap.needsAttention),
        ts: nowMs(),
      }));
  const base = { runId, nodeId, iteration, attempt, cwd };
  let releaseWorkspaceRun;
  try {
    releaseWorkspaceRun = await acquireWorkspaceAttempt(cwd, runId, {
      signal,
      timeoutMs: lockTimeoutMs,
      logAfterMs: lockLogAfterMs,
      onWait: onLockWait,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "DurabilityLockTimeoutError") {
      const reason = error.message;
      logError(
        "durability disabled after shared worktree lock timeout",
        { runId, nodeId, iteration, attempt, cwd, reason },
        "engine:durability",
      );
      try {
        onGapEffective({ request: { ...base, source: "watch", tier: 2 }, reason, needsAttention: true });
      } catch {
        // Durability and its diagnostic sink are both best-effort.
      }
    }
    return NOOP_HANDLE;
  }
  const captureSnapshotSerialized = async (captureCwd) => {
    if (signal?.aborted) return { skipped: true };
    let release;
    try {
      release = await acquireWorkspaceSnapshot(captureCwd, {
        signal,
        timeoutMs: lockTimeoutMs,
        logAfterMs: lockLogAfterMs,
        onWait: onLockWait,
      });
    } catch (error) {
      if (signal?.aborted) return { skipped: true };
      throw error;
    }
    try {
      if (signal?.aborted) return { skipped: true };
      return await captureSnapshot(captureCwd);
    } finally {
      release();
    }
  };
  const service = createSnapshotService({
    captureSnapshot: captureSnapshotSerialized,
    adapter,
    nowMs,
    onGap: onGapEffective,
  });
  /** @param {Record<string, unknown>} req */
  const watchSnapshot = (req) =>
    service.snapshot({ ...base, source: "watch", tier: 2, label: null, toolUseId: null, ...req });
  let watcher;
  try {
    watcher = createWatcher({
      cwd,
      onSettle: () => {
        void watchSnapshot({});
      },
    });
  } catch (error) {
    releaseWorkspaceRun();
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
        releaseWorkspaceRun();
      }
    },
  };
}
