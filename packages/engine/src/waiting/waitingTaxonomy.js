/**
 * The waiting taxonomy, as one open vocabulary.
 *
 * Stage 1.4 of `.smithers/specs/flows-migration.md`. `engine.js` used to reach
 * a park by picking one of four inline `waiting-*` run statuses at each call
 * site. Every park now produces a `WaitingAnnotation` — `{ reason, wakeAt?,
 * token? }` — first, and the run status is derived from it. That is the shape
 * `FlowRuntime.annotateWaiting` takes, so the same value drives both engines
 * and neither one owns a private list of waiting states.
 *
 * @typedef {import("./WaitingAnnotation.ts").WaitingAnnotation} WaitingAnnotation
 * @typedef {import("./WaitingAnnotation.ts").WaitingReason} WaitingReason
 * @typedef {import("@smthrs/scheduler/WaitReason").WaitReason} WaitReason
 */

/** @type {ReadonlySet<WaitingReason>} */
export const WAITING_REASONS = new Set(["approval", "event", "timer", "quota", "released"]);

/**
 * The durable run status each waiting reason parks under. `released` has no
 * status of its own: the row keeps whatever resumable status it already had
 * and the sweep finds it by reason, exactly as the flows run driver does.
 * @type {Readonly<Record<Exclude<WaitingReason, "released">, string>>}
 */
const RUN_STATUS_BY_REASON = Object.freeze({
  approval: "waiting-approval",
  event: "waiting-event",
  timer: "waiting-timer",
  quota: "waiting-quota",
});

/** @param {unknown} value @returns {value is WaitingReason} */
export function isWaitingReason(value) {
  return typeof value === "string" && WAITING_REASONS.has(/** @type {WaitingReason} */ (value));
}

/**
 * @param {WaitingAnnotation} annotation
 * @returns {string | null} the run status to persist, or null for `released`
 */
export function runStatusForWaitingAnnotation(annotation) {
  if (annotation.reason === "released") return null;
  return RUN_STATUS_BY_REASON[annotation.reason];
}

/**
 * Inverse of {@link runStatusForWaitingAnnotation}, for reading a row that was
 * parked before this module existed.
 * @param {string | null | undefined} status
 * @returns {WaitingReason | null}
 */
export function waitingReasonForRunStatus(status) {
  if (!status) return null;
  for (const [reason, candidate] of Object.entries(RUN_STATUS_BY_REASON)) {
    if (candidate === status) return /** @type {WaitingReason} */ (reason);
  }
  return null;
}

/** @param {unknown} value @returns {number | undefined} */
function positiveTimestamp(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * @param {WaitingReason} reason
 * @param {{ wakeAt?: number | undefined; token?: string | null | undefined }} [extra]
 * @returns {WaitingAnnotation}
 */
export function makeWaitingAnnotation(reason, extra = {}) {
  const wakeAt = positiveTimestamp(extra.wakeAt);
  const token = typeof extra.token === "string" && extra.token.length > 0 ? extra.token : undefined;
  return {
    reason,
    ...(wakeAt !== undefined ? { wakeAt } : {}),
    ...(token !== undefined ? { token } : {}),
  };
}

/**
 * Translate the scheduler's `WaitReason` into the waiting taxonomy.
 *
 * The token is the compare-and-swap material a wake handler matches against,
 * so it is the identity of the thing being waited on: the approval's node id,
 * the signal name, the bound node id. A timer has no token — its identity is
 * the deadline it already carries in `wakeAt`.
 *
 * `RetryBackoff` is deliberately absent: an in-process backoff sleep is not a
 * park, and the caller keeps sleeping rather than annotating a wait.
 *
 * @param {WaitReason} waitReason
 * @param {{ quotaWakeAtMs?: number | undefined }} [options]
 * @returns {WaitingAnnotation}
 */
export function waitingAnnotationForWaitReason(waitReason, options = {}) {
  switch (waitReason._tag) {
    case "Approval":
      return makeWaitingAnnotation("approval", { token: waitReason.nodeId });
    case "Event":
      return makeWaitingAnnotation("event", { token: waitReason.eventName });
    case "Timer":
      return makeWaitingAnnotation("timer", { wakeAt: waitReason.resumeAtMs });
    case "Quota":
      // The wake deadline is whatever the injected classifier resolved; the
      // scheduler's own `resetAtMs` is the fallback when no classifier ran.
      return makeWaitingAnnotation("quota", {
        wakeAt: options.quotaWakeAtMs ?? waitReason.resetAtMs,
      });
    case "Bound":
      return makeWaitingAnnotation("event", { token: waitReason.nodeId });
    default:
      // HotReload, OrphanRecovery, ExternalTrigger, RetryBackoff: an external
      // trigger with no identity and no deadline.
      return makeWaitingAnnotation("event");
  }
}

/**
 * Read an annotation back off a persisted payload (a `RunStatusChanged` event
 * payload or a run row's `errorJson`), tolerating rows written before stage
 * 1.4.
 * @param {unknown} value
 * @returns {WaitingAnnotation | null}
 */
export function parseWaitingAnnotation(value) {
  if (!value || typeof value !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (!isWaitingReason(record.reason)) return null;
  return makeWaitingAnnotation(record.reason, {
    wakeAt: positiveTimestamp(record.wakeAt),
    token: typeof record.token === "string" ? record.token : undefined,
  });
}
