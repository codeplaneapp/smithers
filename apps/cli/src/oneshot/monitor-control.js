import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { isPidAlive, parseRuntimeOwnerPid } from "@smithers-orchestrator/engine/runtime-owner";
import { terminateRunOwner } from "../cancel-cascade.js";
import { BUILTIN_RESUME_CONFIG_KEY, buildBuiltinRelaunch } from "../resume-target.js";
import { resolveHijackCandidate, waitForHijackCandidate } from "../hijack.js";
import { startOneshotStatusUpdater } from "./startOneshotStatusUpdater.js";

const ATTACH_LEASE_MS = 35_000;
const RESTART_RELEASE_TIMEOUT_MS = 15_000;
const RESTART_RELEASE_POLL_MS = 100;
const STEER_PROCESS_TIMEOUT_MS = 15 * 60_000;
const STEER_NODE_ID = "steer";
const MAX_STEER_CHARS = 16_000;
const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "canceled", "continued"]);

/** @param {unknown} value */
function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value */
function parseJsonObject(value) {
  if (typeof value !== "string") return asObject(value);
  try {
    return asObject(JSON.parse(value));
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} run */
export function builtinResumeConfigOf(run) {
  const config = parseJsonObject(run.configJson);
  const resume = asObject(config?.[BUILTIN_RESUME_CONFIG_KEY]);
  if (
    resume?.command !== "oneshot" ||
    !Array.isArray(resume.args) ||
    !resume.args.every((arg) => typeof arg === "string") ||
    typeof resume.cwd !== "string"
  ) {
    throw new Error("This run is not a restartable built-in oneshot");
  }
  return {
    command: resume.command,
    args: /** @type {string[]} */ (resume.args),
    cwd: resume.cwd,
  };
}

/**
 * Claude Code cannot accept stdin injection in an already-running `-p`
 * process. Smithers therefore asks the engine for its durable hijack handoff,
 * interrupts at the next agent-event boundary, resumes that same session with
 * the appended message, then resumes the workflow. Other engines fail
 * explicitly until they have an equally reliable boundary handoff.
 *
 * @param {{ engine: string; mode: string; resume?: string; cwd: string }} candidate
 * @param {string} message
 */
export function buildSteeringLaunchSpec(candidate, message) {
  if (candidate.engine !== "claude-code" || candidate.mode !== "native-cli" || !candidate.resume) {
    throw new Error(
      `UI steering is unavailable for ${candidate.engine}; Claude Code is currently supported via interrupt and resume`,
    );
  }
  const env = { ...process.env };
  if (env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = "";
  if (env.CLAUDECODE) env.CLAUDECODE = "";
  return {
    command: "claude",
    args: [
      "--resume",
      candidate.resume,
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--",
      message,
    ],
    cwd: candidate.cwd,
    env,
  };
}

/** @param {import("node:child_process").ChildProcess} child */
function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

/** @param {import("node:child_process").ChildProcess} child */
function waitForChildSpawn(child) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

/**
 * @param {Promise<unknown>} completion
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} timeoutMs
 * @param {(pid: number | null) => Promise<unknown>} terminateOwner
 */
async function waitForSteeringCompletion(completion, child, timeoutMs, terminateOwner) {
  let timer;
  const timedOut = Symbol("timed-out");
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
  });
  try {
    const result = await Promise.race([completion, timeout]);
    if (result !== timedOut) return result;
    let termination;
    try {
      termination = await terminateOwner(Number.isInteger(child.pid) ? child.pid : null);
    } catch (failure) {
      const error = new Error(
        `claude-code steering process timed out after ${timeoutMs}ms and could not be terminated: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      error.recoveryUnsafe = true;
      throw error;
    }
    if (!termination?.terminated) {
      const error = new Error(
        `claude-code steering process timed out after ${timeoutMs}ms and its process group is still alive`,
      );
      error.recoveryUnsafe = true;
      throw error;
    }
    throw new Error(`claude-code steering process timed out after ${timeoutMs}ms`);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * @param {any} adapter
 * @param {string} runId
 * @param {{
 *   timeoutMs: number;
 *   pollMs: number;
 *   ownerAlive: (pid: number) => boolean;
 *   terminateOwner: (pid: number | null) => Promise<{ terminated?: boolean } | unknown>;
 * }} options
 */
async function waitForRestartRelease(adapter, runId, options) {
  const deadline = Date.now() + options.timeoutMs;
  let latest = null;
  while (true) {
    latest = await adapter.getRun(runId);
    if (!latest || TERMINAL_RUN_STATUSES.has(String(latest.status).toLowerCase())) return;
    const ownerPid = parseRuntimeOwnerPid(latest.runtimeOwnerId);
    if (ownerPid !== null && !options.ownerAlive(ownerPid)) return;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(options.pollMs, Math.max(1, deadline - Date.now())));
  }

  const ownerPid = parseRuntimeOwnerPid(latest?.runtimeOwnerId);
  if (ownerPid === null) {
    throw new Error(`Timed out waiting for run ${runId} to release its workspace; no owner pid was recorded`);
  }
  await options.terminateOwner(ownerPid);
  if (options.ownerAlive(ownerPid)) {
    throw new Error(`Timed out waiting for run ${runId} to release its workspace; owner ${ownerPid} is still alive`);
  }
}

/** @param {Record<string, unknown> | null | undefined} run */
function runWasHijacked(run) {
  const error = parseJsonObject(run?.errorJson);
  return error?.code === "RUN_HIJACKED";
}

/**
 * @param {any} adapter
 * @param {string} runId
 * @param {string} type
 * @param {Record<string, unknown>} payload
 */
async function recordControlEvent(adapter, runId, type, payload) {
  const timestampMs = Date.now();
  await adapter.insertEventWithNextSeq({
    runId,
    timestampMs,
    type,
    payloadJson: JSON.stringify({ type, runId, timestampMs, ...payload }),
  });
}

/**
 * Host-owned controls mounted by the CLI Gateway. Server only transports the
 * requests; CLI owns agent argv, builtin resume argv, and narrator selection.
 *
 * @param {{
 *   cliEntry: string;
 *   cancelRun: (adapter: any, runId: string) => Promise<unknown>;
 *   spawnImpl?: typeof spawn;
 *   narratorStart?: typeof startOneshotStatusUpdater;
 *   resolveCandidate?: typeof resolveHijackCandidate;
 *   waitForCandidate?: typeof waitForHijackCandidate;
 *   attachLeaseMs?: number;
 *   steerTimeoutMs?: number;
 *   restartReleaseTimeoutMs?: number;
 *   restartReleasePollMs?: number;
 *   terminateOwner?: typeof terminateRunOwner;
 *   ownerAlive?: typeof isPidAlive;
 * }} options
 */
export function createOneshotMonitorControl(options) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const narratorStart = options.narratorStart ?? startOneshotStatusUpdater;
  const resolveCandidate = options.resolveCandidate ?? resolveHijackCandidate;
  const waitForCandidate = options.waitForCandidate ?? waitForHijackCandidate;
  const attachLeaseMs = options.attachLeaseMs ?? ATTACH_LEASE_MS;
  const steerTimeoutMs = options.steerTimeoutMs ?? STEER_PROCESS_TIMEOUT_MS;
  const restartReleaseTimeoutMs = options.restartReleaseTimeoutMs ?? RESTART_RELEASE_TIMEOUT_MS;
  const restartReleasePollMs = options.restartReleasePollMs ?? RESTART_RELEASE_POLL_MS;
  const terminateOwner = options.terminateOwner ?? terminateRunOwner;
  const ownerAlive = options.ownerAlive ?? isPidAlive;
  /** @type {Map<string, { updater: { enabled?: boolean; stop: () => Promise<void> }; timer: ReturnType<typeof setTimeout> }>} */
  const attached = new Map();
  /** @type {Set<string>} */
  const attaching = new Set();
  /** @type {Set<string>} */
  const steering = new Set();
  /** @type {Set<string>} */
  const restarting = new Set();

  const launchBuiltin = async (config, runId, resume) => {
    const launch = buildBuiltinRelaunch(config, { runId, resume });
    const child = spawnImpl(process.execPath, [options.cliEntry, ...launch.args], {
      cwd: launch.cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SMITHERS_ONESHOT_RUN_ID: runId },
    });
    await waitForChildSpawn(child);
    child.unref();
    return child;
  };

  async function stopAttached(runId) {
    const entry = attached.get(runId);
    if (!entry) return;
    attached.delete(runId);
    clearTimeout(entry.timer);
    await entry.updater.stop();
  }

  return {
    async attach({ runId, adapter }) {
      const existing = attached.get(runId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => void stopAttached(runId), attachLeaseMs);
        existing.timer.unref?.();
        return { runId, status: "attached", narrator: existing.updater.enabled !== false };
      }
      if (attaching.has(runId)) throw new Error("A monitor attachment is already being started");
      attaching.add(runId);
      try {
        const run = await adapter.getRun(runId);
        if (!run) throw new Error(`Run not found: ${runId}`);
        const resume = builtinResumeConfigOf(run);
        if (run.status !== "running") {
          return { runId, status: "attached", narrator: false };
        }
        const config = parseJsonObject(run.configJson);
        const oneshot = asObject(config?.oneshot);
        const updater = narratorStart({
          adapter,
          runId,
          goal: typeof oneshot?.goal === "string" ? oneshot.goal : "Complete the oneshot goal",
          cwd: resume.cwd,
        });
        const timer = setTimeout(() => void stopAttached(runId), attachLeaseMs);
        timer.unref?.();
        attached.set(runId, { updater, timer });
        return { runId, status: "attached", narrator: updater.enabled !== false };
      } finally {
        attaching.delete(runId);
      }
    },

    async steer({ runId, message, adapter }) {
      const trimmed = String(message ?? "").trim();
      if (!trimmed) throw new Error("Steering message is required");
      if (trimmed.length > MAX_STEER_CHARS) throw new Error(`Steering message exceeds ${MAX_STEER_CHARS} characters`);
      if (steering.has(runId)) throw new Error("A steering message is already being delivered");
      steering.add(runId);
      let deliveryStarted = false;
      try {
        const run = await adapter.getRun(runId);
        if (!run) throw new Error(`Run not found: ${runId}`);
        const resume = builtinResumeConfigOf(run);
        const messageId = crypto.randomUUID();
        const initialCandidate = await resolveCandidate(adapter, runId);
        if (!initialCandidate) {
          const error = "No resumable agent session is recorded yet";
          await recordControlEvent(adapter, runId, "OneshotSteerFailed", {
            nodeId: STEER_NODE_ID,
            messageId,
            message: trimmed,
            delivery: "failed",
            error,
          });
          return { runId, messageId, status: "failed", error };
        }
        try {
          buildSteeringLaunchSpec(initialCandidate, trimmed);
        } catch (failure) {
          const error = failure instanceof Error ? failure.message : String(failure);
          await recordControlEvent(adapter, runId, "OneshotSteerFailed", {
            nodeId: STEER_NODE_ID,
            messageId,
            message: trimmed,
            engine: initialCandidate.engine,
            delivery: "failed",
            error,
          });
          return { runId, messageId, status: "failed", engine: initialCandidate.engine, error };
        }
        await recordControlEvent(adapter, runId, "OneshotSteerQueued", {
          nodeId: STEER_NODE_ID,
          messageId,
          message: trimmed,
          engine: initialCandidate.engine,
          delivery: "queued",
        });
        deliveryStarted = true;
        void (async () => {
          let hijackRequested = false;
          let handoffCompleted = false;
          let resumed = false;
          try {
            let candidate = initialCandidate;
            if (run.status === "running") {
              const requestedAtMs = Date.now();
              await adapter.requestRunHijack(runId, requestedAtMs, initialCandidate.engine);
              hijackRequested = true;
              await recordControlEvent(adapter, runId, "RunHijackRequested", {
                target: initialCandidate.engine,
                reason: "oneshot-steer",
              });
              candidate = await waitForCandidate(adapter, runId, { timeoutMs: 30_000 });
              handoffCompleted = true;
            }
            const spec = buildSteeringLaunchSpec(candidate, trimmed);
            const child = spawnImpl(spec.command, spec.args, {
              cwd: spec.cwd,
              env: spec.env,
              stdio: "ignore",
              detached: true,
            });
            const completion = waitForChild(child);
            void completion.catch(() => undefined);
            await waitForChildSpawn(child);
            await recordControlEvent(adapter, runId, "OneshotSteerDelivered", {
              nodeId: STEER_NODE_ID,
              messageId,
              engine: candidate.engine,
              delivery: "delivered",
            });
            const code = await waitForSteeringCompletion(completion, child, steerTimeoutMs, terminateOwner);
            if (code !== 0) throw new Error(`${candidate.engine} steering process exited with code ${code}`);
            await recordControlEvent(adapter, runId, "OneshotSteerAcknowledged", {
              nodeId: STEER_NODE_ID,
              messageId,
              engine: candidate.engine,
              delivery: "agent-acked",
            });
            await launchBuiltin(resume, runId, true);
            resumed = true;
          } catch (error) {
            if (hijackRequested) {
              try {
                await adapter.clearRunHijack(runId);
              } catch {}
            }
            let recoveryError;
            if (!resumed && error?.recoveryUnsafe !== true) {
              let latestRun = null;
              try {
                latestRun = await adapter.getRun(runId);
              } catch {}
              if (handoffCompleted || runWasHijacked(latestRun)) {
                try {
                  await launchBuiltin(resume, runId, true);
                  resumed = true;
                } catch (failure) {
                  recoveryError = failure instanceof Error ? failure.message : String(failure);
                }
              }
            }
            await recordControlEvent(adapter, runId, "OneshotSteerFailed", {
              nodeId: STEER_NODE_ID,
              messageId,
              delivery: "failed",
              error: error instanceof Error ? error.message : String(error),
              resumed,
              ...(recoveryError ? { recoveryError } : {}),
            }).catch(() => undefined);
          } finally {
            steering.delete(runId);
          }
        })();
        return { runId, messageId, status: "queued", engine: initialCandidate.engine };
      } finally {
        if (!deliveryStarted) steering.delete(runId);
      }
    },

    async restart({ runId, adapter }) {
      if (restarting.has(runId)) throw new Error("A restart is already being launched");
      restarting.add(runId);
      const nextRunId = `${runId}-restart-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
      try {
        const run = await adapter.getRun(runId);
        if (!run) throw new Error(`Run not found: ${runId}`);
        const resume = builtinResumeConfigOf(run);
        await recordControlEvent(adapter, runId, "OneshotRestartRequested", {
          restartedAsRunId: nextRunId,
          priorStatus: run.status,
        });
        if (
          ["running", "paused", "waiting-approval", "waiting-event", "waiting-timer", "waiting-quota"].includes(
            run.status,
          )
        ) {
          await options.cancelRun(adapter, runId);
          await waitForRestartRelease(adapter, runId, {
            timeoutMs: restartReleaseTimeoutMs,
            pollMs: restartReleasePollMs,
            ownerAlive,
            terminateOwner,
          });
        }
        const child = await launchBuiltin(resume, nextRunId, false);
        await recordControlEvent(adapter, runId, "OneshotRestartLaunched", {
          restartedAsRunId: nextRunId,
          pid: child.pid ?? null,
        });
        return { runId, restartedAsRunId: nextRunId, status: "launched", pid: child.pid ?? null };
      } catch (error) {
        await recordControlEvent(adapter, runId, "OneshotRestartFailed", {
          restartedAsRunId: nextRunId,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        throw error;
      } finally {
        restarting.delete(runId);
      }
    },

    async dispose() {
      await Promise.all([...attached.keys()].map((runId) => stopAttached(runId)));
    },
  };
}
