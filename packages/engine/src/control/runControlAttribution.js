/**
 * Attribution normalization for the control verbs.
 *
 * The journal entry is the durable record of who paused, cancelled, steered,
 * or hijacked a run and why, so the fields are bounded before they are
 * written: a control verb must not be a way to append unbounded operator text
 * to the event stream.
 *
 * @typedef {import("./RunControl.ts").RunControlAttribution} RunControlAttribution
 */

const MAX_FIELD_LENGTH = 1024;
const TRANSPORTS = new Set(["cli", "rpc", "signal", "engine"]);

/** @param {unknown} value @param {string} fallback @returns {string} */
function boundedText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text.length > 0 ? text : fallback).slice(0, MAX_FIELD_LENGTH);
}

/**
 * @param {Partial<RunControlAttribution> | null | undefined} attribution
 * @returns {RunControlAttribution}
 */
export function normalizeRunControlAttribution(attribution) {
  const source = attribution ?? {};
  const transport = TRANSPORTS.has(String(source.transport)) ? source.transport : undefined;
  const requestId = typeof source.requestId === "string" ? source.requestId.slice(0, MAX_FIELD_LENGTH) : undefined;
  const clientPid =
    Number.isSafeInteger(source.clientPid) && Number(source.clientPid) > 0 ? Number(source.clientPid) : undefined;
  return {
    // "unattributed" is deliberately a value rather than an omission: a
    // journal entry that says nobody claimed the verb is still evidence, and
    // it is greppable.
    actor: boundedText(source.actor, "unattributed"),
    reason: boundedText(source.reason, "unattributed"),
    ...(transport !== undefined ? { transport } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(clientPid !== undefined ? { clientPid } : {}),
  };
}

/**
 * The cancellation-attribution shape `SmithersDb.requestRunCancel` and
 * `claimRunCancellation` already persist on the run row. Mapping onto it keeps
 * `smithers cancel` writing the same columns it always did while the journal
 * gains the actor and reason.
 * @param {RunControlAttribution} attribution
 * @param {import("./RunControl.ts").RunControlVerb} verb
 */
export function runCancellationAttributionFor(attribution, verb) {
  return {
    // `kind` is the transport enum the run row validates against
    // (signal | rpc | cli | engine), not the verb; the verb, the reason, and
    // the actor go into the free-text detail and identity fields, which is
    // where an existing reader already looks for them.
    kind: attribution.transport ?? "cli",
    detail: `${verb}: ${attribution.reason}`,
    clientIdentity: attribution.actor,
    ...(attribution.requestId !== undefined ? { requestId: attribution.requestId } : {}),
    ...(attribution.clientPid !== undefined ? { clientPid: attribution.clientPid } : {}),
  };
}
