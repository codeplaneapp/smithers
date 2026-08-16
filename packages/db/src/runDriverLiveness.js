import { execFileSync } from "node:child_process";
import { isPidAlive, parseRuntimeOwnerIdentity } from "./runtime-owner.js";

/**
 * Force-resume ownership guard.
 *
 * Attaching a second engine to a run that is still being driven splits
 * scheduling in two: both drivers render the same graph, both claim tasks, and
 * both write run/attempt state, so attempts get double-bumped and the frame log
 * interleaves two histories. Heartbeat freshness alone is too weak to decide
 * this (a driver killed 2s ago still looks fresh, and a driver on a remote host
 * never had a probe-able PID), so this module collects *evidence* instead:
 *
 *   - the recorded owner PID is alive on this host AND was not recycled;
 *   - a non-local owner is still heartbeating;
 *   - a durable resume claim (an owner id that is not a `pid:` identity) is
 *     still heartbeating, i.e. another resumer holds the lock.
 *
 * A crashed driver leaves a dead PID, so ordinary crash recovery still resumes
 * with no extra flag — that is the common case and must not regress.
 */

/** Heartbeat-stale threshold; mirrors engine.js (`RUN_HEARTBEAT_STALE_MS`). */
export const RUN_DRIVER_HEARTBEAT_STALE_MS = 30_000;

/**
 * `ps` reports start time with one-second resolution, so a driver whose start
 * is within this window of the last heartbeat it wrote is not treated as a
 * recycled PID.
 */
const PID_RECYCLE_TOLERANCE_MS = 2_000;

/** The named override that every force-resume surface accepts. */
export const STEAL_OWNERSHIP_FLAG = "--steal-ownership";

/**
 * A run in one of these states has no driver by definition: every terminal
 * transition nulls `runtimeOwnerId`/`heartbeatAtMs` in the same write. Checking
 * the status too means a crashed process that left a stale owner behind on a
 * terminal row can never be mistaken for a live driver — which matters because
 * Subflow auto-retry resets *failed* child runs through this guard.
 */
const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "canceled"]);

/**
 * Best-effort wall-clock start time of a local process, or null when it cannot
 * be determined. Callers treat null as "no evidence of recycling".
 *
 * @param {number} pid
 * @returns {number | null}
 */
export function readProcessStartMs(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    if (!raw) return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A PID that started AFTER the last heartbeat the run recorded cannot be the
 * process that wrote that heartbeat: the operating system handed the number to
 * something else. Fails closed (returns false) whenever the evidence is
 * missing, so an unknown process is still treated as the live driver.
 *
 * @param {number} pid
 * @param {number | null} heartbeatAtMs
 * @param {(pid: number) => number | null} readStartMs
 * @returns {boolean}
 */
function isRecycledPid(pid, heartbeatAtMs, readStartMs) {
  if (typeof heartbeatAtMs !== "number") return false;
  const startedAtMs = readStartMs(pid);
  if (startedAtMs === null) return false;
  return startedAtMs - heartbeatAtMs > PID_RECYCLE_TOLERANCE_MS;
}

/**
 * @typedef {object} RunDriverLiveness
 * @property {boolean} live
 * @property {"no-owner"|"run-terminal"|"owner-pid-alive"|"owner-pid-dead"|"owner-pid-recycled"|"remote-owner-heartbeat"|"remote-owner-stale"|"resume-claim-held"|"resume-claim-stale"} evidence
 * @property {number | null} ownerPid
 * @property {string | null} runtimeOwnerId
 * @property {boolean} heartbeatFresh
 */

/**
 * Decide whether `run` still has a live driver.
 *
 * @param {{ status?: string | null; runtimeOwnerId?: string | null; heartbeatAtMs?: number | null } | null | undefined} run
 * @param {{ now?: number; localHostname?: string; isPidAlive?: (pid: number) => boolean; readProcessStartMs?: (pid: number) => number | null }} [options]
 * @returns {RunDriverLiveness}
 */
export function classifyRunDriverLiveness(run, options = {}) {
  const now = options.now ?? Date.now();
  const pidAlive = options.isPidAlive ?? isPidAlive;
  const readStartMs = options.readProcessStartMs ?? readProcessStartMs;
  const heartbeatAtMs = typeof run?.heartbeatAtMs === "number" ? run.heartbeatAtMs : null;
  const heartbeatFresh = heartbeatAtMs !== null && now - heartbeatAtMs <= RUN_DRIVER_HEARTBEAT_STALE_MS;
  const runtimeOwnerId = run?.runtimeOwnerId ?? null;
  const base = { ownerPid: /** @type {number | null} */ (null), runtimeOwnerId, heartbeatFresh };
  if (!runtimeOwnerId) return { ...base, live: false, evidence: "no-owner" };
  if (typeof run?.status === "string" && TERMINAL_RUN_STATUSES.has(run.status)) {
    return { ...base, live: false, evidence: "run-terminal" };
  }
  const identity = options.localHostname
    ? parseRuntimeOwnerIdentity(runtimeOwnerId, options.localHostname)
    : parseRuntimeOwnerIdentity(runtimeOwnerId);
  if (identity?.isLocal) {
    const ownerPid = identity.pid;
    if (!pidAlive(ownerPid)) return { ...base, ownerPid, live: false, evidence: "owner-pid-dead" };
    if (isRecycledPid(ownerPid, heartbeatAtMs, readStartMs)) {
      return { ...base, ownerPid, live: false, evidence: "owner-pid-recycled" };
    }
    return { ...base, ownerPid, live: true, evidence: "owner-pid-alive" };
  }
  if (identity) {
    // A remote owner's PID belongs to another host; the durable heartbeat is
    // the only evidence available, and probing a local PID with the same
    // number would be worse than useless.
    return {
      ...base,
      ownerPid: null,
      live: heartbeatFresh,
      evidence: heartbeatFresh ? "remote-owner-heartbeat" : "remote-owner-stale",
    };
  }
  // Not a `pid:` identity: a durable resume claim owner id, written by whoever
  // won `claimRunForResume`. A fresh claim heartbeat means the lock is held.
  return {
    ...base,
    live: heartbeatFresh,
    evidence: heartbeatFresh ? "resume-claim-held" : "resume-claim-stale",
  };
}

/**
 * @param {{ status?: string | null; runtimeOwnerId?: string | null; heartbeatAtMs?: number | null } | null | undefined} run
 * @param {Parameters<typeof classifyRunDriverLiveness>[1]} [options]
 * @returns {boolean}
 */
export function isRunDriverAlive(run, options) {
  return classifyRunDriverLiveness(run, options).live;
}

/**
 * Human-readable reason for a refusal, always naming the exact override flag.
 *
 * @param {string} runId
 * @param {RunDriverLiveness} liveness
 * @returns {string}
 */
export function describeLiveDriverRefusal(runId, liveness) {
  const who =
    liveness.evidence === "owner-pid-alive"
      ? `live driver process ${liveness.ownerPid}`
      : liveness.evidence === "remote-owner-heartbeat"
        ? `a heartbeating driver on another host (${liveness.runtimeOwnerId})`
        : `a held resume claim (${liveness.runtimeOwnerId})`;
  return `Run ${runId} is still owned by ${who}. Attaching a second engine would split-brain the run; stop the owner first, or pass ${STEAL_OWNERSHIP_FLAG} to take ownership anyway.`;
}
