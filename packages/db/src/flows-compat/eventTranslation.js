/**
 * The event-shape translator: `_smithers_events` rows to flows journal producer
 * events, and back.
 *
 * A Smithers event row is `(run_id, seq, timestamp_ms, type, payload_json)`. A
 * journal entry is `(run_id, seq, event_id, source_id, source_seq,
 * emitted_at_ms, event_type, payload, meta)`. Two fields need a decision:
 *
 * - `payload_json` is text on the Smithers side and a decoded value on the
 *   journal side, so the translator parses it. Text that is not JSON — only
 *   reachable through a hand-written row — is carried under
 *   {@link UNPARSEABLE_PAYLOAD_KEY} so the reverse direction still reproduces
 *   the original bytes.
 * - `timestamp_ms` is the engine's event clock, which is not the journal's
 *   `emitted_at_ms` (the journal stamps its own commit time). It travels in
 *   `meta.smithers.timestampMs`.
 *
 * Round-tripping is exact except for credentials: the journal redacts payloads
 * on write by design (`@flows/journal`'s `Redaction`), so a payload carrying a
 * bearer token comes back with the placeholder. `_smithers_events` keeps the
 * verbatim row it always kept; the journal keeps the redacted history.
 */

/** Producer id for events this process writes through the journal. */
export const LIVE_EVENT_SOURCE_ID = "smithers-adapter";
/** Producer id for rows backfilled from `_smithers_events` by the migration. */
export const LEGACY_EVENT_SOURCE_ID = "smithers-legacy";
/** Key carrying `payload_json` text that is not valid JSON. */
export const UNPARSEABLE_PAYLOAD_KEY = "@smithers/unparseable-payload-json";

/**
 * @param {string | null | undefined} payloadJson
 * @returns {unknown}
 */
function decodePayload(payloadJson) {
  const text = typeof payloadJson === "string" ? payloadJson : "null";
  try {
    return JSON.parse(text);
  } catch {
    return { [UNPARSEABLE_PAYLOAD_KEY]: text };
  }
}

/**
 * @param {unknown} payload
 * @returns {string}
 */
function encodePayload(payload) {
  if (
    payload !== null &&
    typeof payload === "object" &&
    Object.hasOwn(/** @type {Record<string, unknown>} */ (payload), UNPARSEABLE_PAYLOAD_KEY)
  ) {
    return String(/** @type {Record<string, unknown>} */ (payload)[UNPARSEABLE_PAYLOAD_KEY]);
  }
  return JSON.stringify(payload ?? null);
}

/**
 * Translate a Smithers event row into a journal producer event.
 *
 * @param {{ runId: string; seq?: number; timestampMs: number; type: string; payloadJson?: string | null }} row
 * @param {{ sourceId?: string; sourceSeq?: number }} [options]
 * @returns {{ runId: string; sourceId: string; sourceSeq?: number; eventType: string; payload: unknown; meta: unknown }}
 */
export function toJournalEventInput(row, options = {}) {
  const input = {
    runId: row.runId,
    sourceId: options.sourceId ?? LIVE_EVENT_SOURCE_ID,
    eventType: row.type,
    payload: decodePayload(row.payloadJson),
    meta: { smithers: { timestampMs: Number(row.timestampMs) } },
  };
  if (options.sourceSeq !== undefined) {
    return { ...input, sourceSeq: options.sourceSeq };
  }
  return input;
}

/**
 * Translate a committed journal entry back into a Smithers event row.
 *
 * @param {{ runId: string; seq: number; emittedAtMs?: number; eventType: string; payload: unknown; meta?: unknown }} entry
 * @returns {{ runId: string; seq: number; timestampMs: number; type: string; payloadJson: string }}
 */
export function toSmithersEventRow(entry) {
  const meta = /** @type {{ smithers?: { timestampMs?: unknown } }} */ (
    entry.meta !== null && typeof entry.meta === "object" ? entry.meta : {}
  );
  const timestampMs = Number(meta.smithers?.timestampMs ?? entry.emittedAtMs ?? 0);
  return {
    runId: entry.runId,
    seq: Number(entry.seq),
    timestampMs,
    type: entry.eventType,
    payloadJson: encodePayload(entry.payload),
  };
}
