// `smithers restore <runId> --node <id>` — restore a worktree to a durability
// checkpoint (the latest for the node by default, or a specific --seq). Reuses
// the vcs revert (jj restore --from <commit_id>). DI seam on `revert` for tests.

import { spawn } from "node:child_process";
import { resolveJjBinary } from "@smithers-orchestrator/vcs/resolveJjBinary";
import { retryTask } from "@smithers-orchestrator/time-travel/retry-task";
import { Effect } from "effect";
import { listScopedWorkspaceSnapshots } from "./snapshot-scope.js";

/**
 * Upper bound on a single `jj restore`. Restore is a recovery path, so a stuck
 * repo lock, a jj wrapper that blocks, or a hung filesystem has to surface as a
 * typed failure instead of wedging the caller — `smithers restore` would never
 * return, and the MCP server drives this same code in-process, so a stuck jj
 * would also block cancellation and shutdown of every other tool call.
 */
export const RESTORE_TIMEOUT_MS = 120_000;

/** Grace given to a SIGTERM'd jj before escalating to SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** @param {unknown} id */
function short(id) {
  return id ? String(id).slice(0, 12) : "";
}

/**
 * Restore the working copy from a jj commit id (jj restore --from <commit>),
 * shelling out to the resolved jj binary. Mirrors vcs revertToJjPointer without
 * pulling the Effect/platform-bun layer into the CLI.
 *
 * Async (never spawnSync): a synchronous spawn blocks the Node/Bun event loop
 * for as long as jj runs, so a hung jj is unkillable and uncancellable. Bounded
 * by `timeoutMs` and an optional `signal`; either one terminates jj and resolves
 * a typed failure.
 *
 * @param {string} commitId
 * @param {string} cwd
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export function defaultRevert(commitId, cwd, options = {}) {
  let bin = "jj";
  try {
    bin = resolveJjBinary().path || "jj";
  } catch {
    bin = "jj";
  }
  const timeoutMs = Math.max(1, options.timeoutMs ?? RESTORE_TIMEOUT_MS);
  const signal = options.signal;
  // Never start a destructive restore that is already cancelled.
  if (signal?.aborted) return Promise.resolve({ success: false, error: "jj restore aborted" });
  return new Promise((resolve) => {
    let child;
    try {
      // stdin/stdout ignored: nothing reads them, and an inherited stdin
      // would let a prompting jj wait on a tty forever.
      child = spawn(bin, ["restore", "--from", commitId], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolve({
        success: false,
        error: `failed to spawn ${bin}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    let stderr = "";
    let settled = false;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    /** @param {{ success: boolean, error?: string }} result */
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    // Terminate a jj that stopped responding, escalating so a process that
    // ignores SIGTERM still cannot keep the CLI alive.
    const stop = () => {
      child.kill("SIGTERM");
      const escalation = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      escalation.unref?.();
      child.once("close", () => {
        clearTimeout(escalation);
      });
    };
    const onAbort = () => {
      stop();
      settle({ success: false, error: "jj restore aborted" });
    };
    const timer = setTimeout(() => {
      stop();
      settle({ success: false, error: `jj restore timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.on("error", (error) => settle({ success: false, error: `failed to spawn ${bin}: ${error.message}` }));
    child.on("close", (code, closeSignal) => {
      if (code === 0) settle({ success: true });
      else
        settle({
          success: false,
          error: (
            stderr || (code === null ? `jj terminated with ${closeSignal}` : `jj exited with code ${code}`)
          ).trim(),
        });
    });

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A durability checkpoint row as returned by `listWorkspaceCheckpoints`.
 * @typedef {{
 *   nodeId: string,
 *   iteration?: number,
 *   seq: number,
 *   attempt?: number,
 *   jjCommitId: string,
 *   jjCwd: string,
 *   createdAtMs?: number,
 *   runId?: string,
 *   ownerNodeId?: string,
 *   ownerIteration?: number,
 * }} Checkpoint
 */

/**
 * Pick the target checkpoint deterministically: filter by node (+optional
 * iteration/seq), then the chronologically latest (ties broken by attempt then
 * seq, since seq resets per attempt).
 * @param {Array<Checkpoint>} checkpoints
 * @param {{ runId?: string, nodeId: string, iteration?: number, seq?: number }} sel
 * @returns {Checkpoint | null}
 */
export function pickTargetCheckpoint(checkpoints, sel) {
  let cands = checkpoints.filter((c) => c.nodeId === sel.nodeId || c.ownerNodeId === sel.nodeId);
  if (sel.iteration !== undefined)
    cands = cands.filter((c) =>
      c.ownerNodeId === sel.nodeId
        ? Number(c.ownerIteration) === Number(sel.iteration)
        : Number(c.iteration) === Number(sel.iteration),
    );
  if (sel.seq !== undefined) cands = cands.filter((c) => Number(c.seq) === Number(sel.seq));
  const requestedRunMatches = cands.filter((c) => c.runId === sel.runId && c.nodeId === sel.nodeId);
  if (requestedRunMatches.length > 0) cands = requestedRunMatches;
  if (cands.length === 0) return null;
  cands.sort(
    (a, b) =>
      Number(a.createdAtMs) - Number(b.createdAtMs) ||
      Number(a.attempt) - Number(b.attempt) ||
      Number(a.seq) - Number(b.seq),
  );
  return cands[cands.length - 1];
}

/**
 * A restore behind child-run checkpoints invalidates the owning Subflow nodes
 * through the normal retry reset path. That keeps the child run, node, output,
 * and attempt rows coherent and makes a parent resume recreate the discarded
 * workspace changes.
 *
 * @param {any} adapter
 * @param {string} runId
 * @param {Checkpoint} target
 * @returns {Promise<{ success: boolean, owners: Array<{ nodeId: string, iteration: number, createdAtMs: number }>, error?: string }>}
 */
async function prepareNewerChildWorkInvalidation(adapter, runId, target) {
  if (
    typeof adapter?.listRunDescendants !== "function" ||
    typeof adapter?.listWorkspaceStates !== "function" ||
    typeof adapter?.getNode !== "function"
  ) {
    return { success: true, owners: [] };
  }
  const { checkpoints } = await listScopedWorkspaceSnapshots(adapter, runId);
  const owners = new Map();
  for (const checkpoint of checkpoints) {
    if (
      checkpoint.ownerNodeId &&
      checkpoint.runId !== runId &&
      checkpoint.jjCwd === target.jjCwd &&
      Number(checkpoint.createdAtMs) > Number(target.createdAtMs ?? 0)
    ) {
      const key = `${checkpoint.ownerNodeId}\u0000${checkpoint.ownerIteration ?? 0}`;
      const previous = owners.get(key);
      if (!previous || Number(checkpoint.createdAtMs) < previous.createdAtMs) {
        owners.set(key, {
          nodeId: checkpoint.ownerNodeId,
          iteration: checkpoint.ownerIteration ?? 0,
          createdAtMs: Number(checkpoint.createdAtMs),
        });
      }
    }
  }
  const ordered = [...owners.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  if (ordered.length === 0) return { success: true, owners: ordered };
  if (typeof adapter?.getRun === "function") {
    const run = await adapter.getRun(runId);
    if (!run) return { success: false, owners: ordered, error: `Run not found: ${runId}` };
    if (
      run.status === "running" ||
      run.status === "waiting-approval" ||
      run.status === "waiting-event" ||
      run.status === "waiting-timer" ||
      run.status === "waiting-quota"
    ) {
      return { success: false, owners: ordered, error: `Run is still running: ${runId}` };
    }
  }
  return { success: true, owners: ordered };
}

/**
 * @param {any} adapter
 * @param {string} runId
 * @param {Array<{ nodeId: string, iteration: number }>} owners
 * Build every retry reset before touching the filesystem, but intercept the
 * transactions that would apply them. The captured Effects are committed
 * together only after jj has successfully restored the checkpoint. This
 * prevents a failed restore (or a later invalid owner) from erasing any
 * durable child work.
 *
 * @returns {Promise<{ success: boolean, effects: Array<any>, error?: string }>}
 */
async function stageNewerChildWorkInvalidation(adapter, runId, owners) {
  const effects = [];
  if (owners.length === 0) return { success: true, effects };
  const stagedAdapter = new Proxy(adapter, {
    get(target, property) {
      if (property === "withTransaction") {
        return async (_writeGroup, operation) => {
          effects.push(operation);
          return true;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  for (const owner of owners) {
    const result = await retryTask(stagedAdapter, {
      runId,
      nodeId: owner.nodeId,
      iteration: owner.iteration,
      resetDependents: true,
    });
    if (!result.success) {
      return {
        success: false,
        effects: [],
        error: result.error ?? `could not invalidate child work owned by ${owner.nodeId}`,
      };
    }
  }
  return { success: true, effects };
}

/**
 * Commit all staged retry resets under one database transaction. An Effect
 * failure rolls the whole owner set back instead of leaving earlier owners
 * reset when a later write fails.
 *
 * @param {any} adapter
 * @param {Array<any>} effects
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function commitNewerChildWorkInvalidation(adapter, effects) {
  if (effects.length === 0) return { success: true };
  if (typeof adapter?.withTransaction !== "function") {
    return { success: false, error: "database adapter does not support transactions" };
  }
  try {
    await adapter.withTransaction(
      "restore-child-work-invalidation",
      Effect.gen(function* () {
        for (const operation of effects) {
          yield* operation;
        }
      }),
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {{
 *   adapter?: { getRun?: Function, listRunDescendants?: Function, listWorkspaceCheckpoints: (runId: string) => Promise<Array<Checkpoint>>, listWorkspaceStates?: Function },
 *   runId: string,
 *   nodeId: string,
 *   iteration?: number,
 *   seq?: number,
 *   target?: Checkpoint,
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   revert?: (commitId: string, cwd: string, options?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<{ success: boolean, error?: string }>,
 * }} opts
 * @returns {Promise<{ exitCode: number }>}
 */
export async function runRestoreOnce(opts) {
  const { adapter, runId, nodeId, iteration, seq, stdout, stderr } = opts;
  const revert = opts.revert ?? defaultRevert;

  // Reuse a preselected target when the caller already picked one (the
  // semantic tool reports it), so we never re-list and risk selecting a
  // different checkpoint than the one reported. But still validate it against
  // the requested node/iteration/seq — a stale or mis-reported target must be
  // rejected rather than silently reverting the wrong checkpoint. Validation
  // runs the preselected row through the same predicate as the listing path
  // (`pickTargetCheckpoint`) so the two can never diverge.
  const selection = { runId, nodeId, iteration, seq };
  let target = null;
  if (opts.target) {
    target = pickTargetCheckpoint([opts.target], selection);
    if (!target) {
      // Include the target's own iteration/seq so an iteration-only
      // mismatch is legible. `run ${runId}` remains useful request context
      // even though the target row is validated directly.
      stderr.write(
        `Preselected checkpoint (node ${opts.target.nodeId} iteration ${opts.target.iteration ?? 0} seq ${opts.target.seq}) does not match requested node ${nodeId}${iteration !== undefined ? ` iteration ${iteration}` : ""}${seq !== undefined ? ` seq ${seq}` : ""} for run ${runId}\n`,
      );
      return { exitCode: 1 };
    }
  } else if (adapter) {
    const scoped =
      typeof adapter.listWorkspaceStates === "function"
        ? await listScopedWorkspaceSnapshots(adapter, runId)
        : { checkpoints: await adapter.listWorkspaceCheckpoints(runId) };
    target = pickTargetCheckpoint(scoped.checkpoints, selection);
  }
  if (!target) {
    stderr.write(
      `No matching durability checkpoint for run ${runId} node ${nodeId}${seq !== undefined ? ` seq ${seq}` : ""}\n`,
    );
    return { exitCode: 1 };
  }
  const invalidationPlan = await prepareNewerChildWorkInvalidation(adapter, runId, target);
  if (!invalidationPlan.success) {
    stderr.write(`Restore invalidation failed: ${invalidationPlan.error ?? "unknown error"}\n`);
    return { exitCode: 1 };
  }
  const stagedInvalidation = await stageNewerChildWorkInvalidation(adapter, runId, invalidationPlan.owners);
  if (!stagedInvalidation.success) {
    stderr.write(`Restore invalidation failed: ${stagedInvalidation.error ?? "unknown error"}\n`);
    return { exitCode: 1 };
  }
  const result = await revert(target.jjCommitId, target.jjCwd, { timeoutMs: opts.timeoutMs, signal: opts.signal });
  if (!result?.success) {
    stderr.write(`Restore failed: ${result?.error ?? "unknown error"}\n`);
    return { exitCode: 1 };
  }
  const invalidation = await commitNewerChildWorkInvalidation(adapter, stagedInvalidation.effects);
  if (!invalidation.success) {
    stderr.write(`Restore invalidation failed: ${invalidation.error ?? "unknown error"}\n`);
    return { exitCode: 1 };
  }
  stdout.write(`Restored ${target.jjCwd} to checkpoint #${target.seq} (${short(target.jjCommitId)})\n`);
  return { exitCode: 0 };
}
