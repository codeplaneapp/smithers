/**
 * Read the attributed control history of a run back out of its journal.
 *
 * This is the read side of `createRunControl`: `smithers why`, the fault
 * cases, and any operator tooling answer "who paused this, and why" from here
 * rather than from a column.
 *
 * @typedef {import("./RunControl.ts").RunControlAttribution} RunControlAttribution
 * @typedef {import("./RunControl.ts").RunControlVerb} RunControlVerb
 * @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb
 */
import { Effect } from "effect";
import { RUN_CONTROL_APPLIED_EVENT_TYPE, RUN_CONTROL_EVENT_TYPE } from "./runControlEventTypes.js";

/**
 * @typedef {object} RunControlJournalEntry
 * @property {number} seq
 * @property {"requested" | "applied"} phase
 * @property {RunControlVerb} verb
 * @property {string} actor
 * @property {string} reason
 * @property {number} timestampMs
 * @property {boolean} [accepted]
 * @property {string | null} [status]
 * @property {string} [refusedBecause]
 * @property {string | null} [target]
 */

/** @param {unknown} raw */
function parsePayload(raw) {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? /** @type {Record<string, unknown>} */ (parsed) : null;
  } catch {
    return null;
  }
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ verb?: RunControlVerb }} [query]
 * @returns {Promise<RunControlJournalEntry[]>}
 */
export async function readRunControlJournal(adapter, runId, query = {}) {
  const [requested, applied] = await Promise.all([
    Effect.runPromise(adapter.listEventsByType(runId, RUN_CONTROL_EVENT_TYPE)),
    Effect.runPromise(adapter.listEventsByType(runId, RUN_CONTROL_APPLIED_EVENT_TYPE)),
  ]);
  /** @type {RunControlJournalEntry[]} */
  const entries = [];
  for (const [phase, rows] of /** @type {const} */ ([
    ["requested", requested],
    ["applied", applied],
  ])) {
    for (const row of rows) {
      const payload = parsePayload(row.payloadJson ?? row.payload_json);
      if (!payload || typeof payload.verb !== "string") continue;
      if (query.verb && payload.verb !== query.verb) continue;
      entries.push({
        seq: Number(row.seq ?? -1),
        phase,
        verb: /** @type {RunControlVerb} */ (payload.verb),
        actor: typeof payload.actor === "string" ? payload.actor : "unattributed",
        reason: typeof payload.reason === "string" ? payload.reason : "unattributed",
        timestampMs: Number(payload.timestampMs ?? row.timestampMs ?? row.timestamp_ms ?? 0),
        ...(typeof payload.accepted === "boolean" ? { accepted: payload.accepted } : {}),
        ...(payload.status !== undefined ? { status: /** @type {string | null} */ (payload.status) } : {}),
        ...(typeof payload.refusedBecause === "string" ? { refusedBecause: payload.refusedBecause } : {}),
        ...(payload.target !== undefined ? { target: /** @type {string | null} */ (payload.target) } : {}),
      });
    }
  }
  return entries.sort((a, b) => a.seq - b.seq);
}
