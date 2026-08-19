/**
 * The default `classifyError` / `resolveRetry` pair.
 *
 * Spec 1.5. These are services, not engine internals: `createWaitingSeam`
 * takes them as an option, so a host that knows more about its providers than
 * Smithers does can replace either one without touching the executor. The
 * defaults carry the behaviour `engine.js` had inline —
 * `isQuotaTaskFailure` / `isRetryableTaskFailure` — plus the wake deadline
 * that turns a quota failure into a park rather than a retry.
 *
 * @typedef {import("./WaitWakeClassifiers.ts").ErrorClassification} ErrorClassification
 * @typedef {import("./WaitWakeClassifiers.ts").RetryResolution} RetryResolution
 * @typedef {import("./WaitWakeClassifiers.ts").WaitWakeClassifiers} WaitWakeClassifiers
 */
import { providerFamilyFor } from "./providerFamily.js";

/**
 * Codes that can never succeed on a retry, whatever the budget says.
 * `AGENT_CONFIG_INVALID` is a deterministic configuration failure (unknown
 * model, "LLM not set"); retrying only multiplies cost.
 */
const NON_RETRYABLE_CODES = new Set(["AGENT_CONFIG_INVALID"]);

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function asRecord(value) {
  return value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : null;
}

/** @param {unknown} raw @returns {Record<string, unknown> | null} */
function parseJsonRecord(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Normalize the several shapes a failure reaches the seam as: a raw attempt
 * row (`{ errorJson, metaJson }`), a `SmithersError`, or a plain object.
 * @param {unknown} failure
 * @returns {{ code: string | null; details: Record<string, unknown>; meta: Record<string, unknown>; message: string }}
 */
function normalizeFailure(failure) {
  const record = asRecord(failure) ?? {};
  const errorJson = parseJsonRecord(record.errorJson);
  const meta = parseJsonRecord(record.metaJson) ?? asRecord(record.meta) ?? {};
  const source = errorJson ?? record;
  const details = asRecord(source.details) ?? {};
  const code = typeof source.code === "string" ? source.code : null;
  const message = [source.message, details.underlying, record.message]
    .filter((part) => typeof part === "string")
    .join("\n");
  return { code, details, meta, message };
}

/**
 * Re-read a reset deadline out of provider text for failures that reached the
 * seam without one. `BaseCliAgent.classifyQuotaError` already resolves the
 * Claude/Fable wall-clock-in-a-named-zone banner into `quotaResetAtMs`, so
 * only the two zone-free forms need handling here.
 * @param {string} message
 * @param {number} nowMs
 * @returns {{ wakeAt?: number; resetHint?: string }}
 */
function readResetDeadline(message, nowMs) {
  const absolute = /try again at\s+([A-Z][a-z]+ \d+(?:st|nd|rd|th)?,?\s+\d{4}\s+\d+:\d+\s+(?:AM|PM))/i.exec(message);
  if (absolute) {
    const parsed = Date.parse(absolute[1].replace(/(\d+)(st|nd|rd|th)\b/gi, "$1"));
    return Number.isFinite(parsed) && parsed > nowMs
      ? { wakeAt: parsed, resetHint: absolute[0] }
      : { resetHint: absolute[0] };
  }
  const relative = /retry after\s+(\d+)\s+second/i.exec(message);
  if (relative) {
    const deltaMs = Number(relative[1]) * 1000;
    return deltaMs > 0 ? { wakeAt: nowMs + deltaMs, resetHint: relative[0] } : { resetHint: relative[0] };
  }
  return {};
}

/**
 * @type {WaitWakeClassifiers["classifyError"]}
 */
export function classifyError(failure, context) {
  const { code, details, meta, message } = normalizeFailure(failure);
  const engineId = typeof details.agentEngine === "string" ? details.agentEngine : null;
  const providerFamily = providerFamilyFor(engineId, message);

  const isQuota = code === "AGENT_QUOTA_EXCEEDED" || details.failureQuota === true || meta.failureQuota === true;
  if (isQuota) {
    const declared = Number(details.quotaResetAtMs);
    const wakeAt = Number.isFinite(declared) && declared > context.nowMs ? declared : undefined;
    const fallback = wakeAt === undefined ? readResetDeadline(message, context.nowMs) : {};
    const resolved = wakeAt ?? fallback.wakeAt;
    const hint = typeof details.resetHint === "string" ? details.resetHint : fallback.resetHint;
    return {
      kind: "quota",
      providerFamily,
      ...(resolved !== undefined ? { wakeAt: resolved } : {}),
      ...(hint !== undefined ? { resetHint: hint } : {}),
    };
  }

  // An explicit retryable flag beats every heuristic below it.
  if (meta.failureRetryable === false) {
    return { kind: "fatal", providerFamily, ...(code ? { code } : {}) };
  }
  if (meta.failureRetryable === true) {
    return { kind: "transient", providerFamily };
  }
  if (code && NON_RETRYABLE_CODES.has(code)) {
    return { kind: "fatal", providerFamily, code };
  }
  // A non-agent task that produced invalid output is deterministic; an agent
  // that did can be re-prompted.
  if (code === "INVALID_OUTPUT" && meta.kind !== "agent") {
    return { kind: "fatal", providerFamily, code };
  }
  return { kind: "transient", providerFamily };
}

/** Retry backoff for a transient failure: 1s, 2s, 4s, capped at 30s. */
function backoffMs(attemptsUsed) {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attemptsUsed));
}

/**
 * @type {WaitWakeClassifiers["resolveRetry"]}
 */
export function resolveRetry(classification, context) {
  if (classification.kind === "quota") {
    // A quota failure never spends a retry: the run parks until the provider
    // resets and then retries as if the attempt never occurred. A park with no
    // deadline is still a park — it waits for an operator or a manual resume
    // rather than burning the budget in a hot loop.
    return {
      action: "park",
      reason: "quota",
      ...(classification.wakeAt !== undefined ? { wakeAt: classification.wakeAt } : {}),
    };
  }
  if (classification.kind === "fatal") {
    return { action: "fail", reason: "non-retryable" };
  }
  if (context.attemptsUsed > context.retries) {
    return { action: "fail", reason: "budget-exhausted" };
  }
  return { action: "retry", waitMs: backoffMs(context.attemptsUsed) };
}

/** @type {WaitWakeClassifiers} */
export const defaultWaitWakeClassifiers = Object.freeze({ classifyError, resolveRetry });
