// Public subpath `smthrs/evals`. A seeded/user workflow file
// (`.smithers/workflows/*.tsx`) can only import the `smthrs`
// package itself — `@smthrs/*` scoped packages are internal
// workspace deps, not resolvable from a user's project under pnpm's strict
// install. This subpath re-exports the pure eval domain
// (`@smthrs/scorers/evalCases`) plus two thin store helpers so
// `eval-suite-run` (`.smithers/workflows/eval-suite-run.tsx`) needs no other
// internal import. Both take the RAW db handle `createSmithers(...)` already
// hands every workflow (`const { db } = createSmithers({...})`) — NOT a
// `SmithersDb` instance, which lives in the internal `@smthrs/
// db` package a user workflow cannot import; these helpers wrap it themselves.
import { SmithersDb } from "@smthrs/db/adapter";

export * from "@smthrs/scorers/evalCases";

// A composed `listCases` response is bounded by the gateway's
// EXTENSION_PAYLOAD_MAX_BYTES (4 MiB). Clamp any single JSON blob well under
// that per-case share so one runaway case output can never approach it.
const MAX_FIELD_JSON_BYTES = 256 * 1024;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function encodeBoundedJsonField(value) {
  if (value === undefined) {
    return null;
  }
  const encoded = JSON.stringify(value);
  if (encoded.length <= MAX_FIELD_JSON_BYTES) {
    return encoded;
  }
  return JSON.stringify({
    truncated: true,
    originalBytes: encoded.length,
    preview: encoded.slice(0, 2048),
  });
}

/**
 * Read a saved eval suite and decode its canonical dataset. The ONLY read a
 * workflow needs to plan its fan-out — the `evals` gateway extension owns the
 * write side (`ext.evals.saveSuite`).
 * @param {unknown} db  The raw db handle from `createSmithers(...)`.
 * @param {string} suiteId
 * @returns {Promise<{
 *   suiteId: string;
 *   name: string;
 *   workflowKey: string;
 *   workflowPath: string;
 *   workflowRoot: string;
 *   cases: import("@smthrs/scorers/EvalCaseInput.ts").EvalCaseInput[];
 * } | undefined>}
 */
export async function readEvalSuite(db, suiteId) {
  const adapter = new SmithersDb(/** @type {any} */ (db));
  const row = await adapter.getEvalSuite(suiteId);
  if (!row) {
    return undefined;
  }
  return {
    suiteId: row.suiteId,
    name: row.name,
    workflowKey: row.workflowKey,
    workflowPath: row.workflowPath,
    workflowRoot: row.workflowRoot,
    cases: JSON.parse(row.datasetJson),
  };
}

/**
 * Upsert one case's live result row (JSON-encoding, and bounding the byte
 * size of, the decoded input/expected/actual/assertions fields the caller
 * passes). Keyed by `${evalRunId}:${caseId}` — the same id the `evals`
 * gateway extension's `listCases` resource reads back.
 * @param {unknown} db  The raw db handle from `createSmithers(...)`.
 * @param {{
 *   id: string;
 *   evalRunId: string;
 *   suiteId: string;
 *   caseId: string;
 *   caseIndex: number;
 *   name?: string | null;
 *   status: "queued" | "running" | "ok" | "failed" | "cancelled";
 *   caseRunId?: string | null;
 *   input?: unknown;
 *   expected?: unknown;
 *   actual?: unknown;
 *   assertions?: Array<{ description: string; passed: boolean }>;
 *   error?: string | null;
 *   startedAtMs?: number | null;
 *   finishedAtMs?: number | null;
 *   durationMs?: number | null;
 * }} row
 * @returns {Promise<void>}
 */
export async function writeEvalCaseRow(db, row) {
  const adapter = new SmithersDb(/** @type {any} */ (db));
  await adapter.upsertEvalCaseResult({
    id: row.id,
    evalRunId: row.evalRunId,
    suiteId: row.suiteId,
    caseId: row.caseId,
    caseIndex: row.caseIndex,
    name: row.name ?? null,
    status: row.status,
    caseRunId: row.caseRunId ?? null,
    inputJson: encodeBoundedJsonField(row.input),
    expectedJson: encodeBoundedJsonField(row.expected),
    actualJson: encodeBoundedJsonField(row.actual),
    assertionsJson: encodeBoundedJsonField(row.assertions),
    error: row.error ?? null,
    startedAtMs: row.startedAtMs ?? null,
    finishedAtMs: row.finishedAtMs ?? null,
    durationMs: row.durationMs ?? null,
  });
}
