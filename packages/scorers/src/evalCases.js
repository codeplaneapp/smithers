import crypto from "node:crypto";
import { createScorer } from "./createScorer.js";
import { isEvalInfraFailure } from "./isEvalInfraFailure.js";
/** @typedef {import("./types.js").Scorer} Scorer */
/** @typedef {import("./EvalCaseInput.ts").EvalCaseInput} EvalCaseInput */
/** @typedef {import("./EvalDatasetParseResult.ts").EvalDatasetParseResult} EvalDatasetParseResult */
/** @typedef {import("./EvalAssertion.ts").EvalAssertion} EvalAssertion */
/** @typedef {import("./EvalJudge.ts").EvalJudge} EvalJudge */
/** @typedef {import("./EvalJudgeRunner.ts").EvalJudgeRunner} EvalJudgeRunner */

/**
 * The canonical, server-side EVAL domain — dataset parsing, case grading, and
 * the scorer that turns a graded case into a real `_smithers_scorers` row.
 * Pure (no I/O), so it is usable both from the `evals` gateway extension
 * (`apps/cli/src/evals-extension.js`) and from a seeded workflow via the
 * public `smthrs/evals` subpath (a seeded `.smithers/workflows/
 * *.tsx` file can only import `smthrs` — `@smthrs/*`
 * is not resolvable from a user's project under pnpm's strict install).
 *
 * `parseEvalDataset` preserves multi's `src/evals/evalReport.ts` base parsing
 * semantics so the client that authors a dataset and the server that persists
 * it agree on id fallback, JSONL comments, and duplicate-id rejection. Judge
 * validation is the packaged server-side extension to that shared shape.
 */

// ---------------------------------------------------------------------------
// Shared low-level primitives (also used by apps/cli/src/eval-suite.js's
// `smithers eval` CLI command, which re-points its own same-named helpers at
// these so there is exactly ONE implementation of each).
// ---------------------------------------------------------------------------

const RUN_ID_MAX_LENGTH = 64;

/** Assertion-spec keys the `smithers eval` CLI has always supported
 *  (`{status, output, outputContains, errorContains}`). `evaluateEvalCase`
 *  treats an `expected` object whose keys are ALL within this set as an
 *  assertion spec rather than a literal expected-output value. */
const EVAL_EXPECTED_KEYS = new Set(["status", "output", "outputContains", "errorContains"]);
const EVAL_JUDGE_KEYS = new Set(["instructions", "threshold"]);

/** Case-run statuses the assertion-spec `expected.status` may target — the
 *  underlying engine/CLI job-state vocabulary (NOT the simplified
 *  `EvalCaseResult.status` the `evals` extension persists). */
export const EVAL_CASE_STATUSES = [
  "finished",
  "continued",
  "failed",
  "cancelled",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
];

/** The score `scorerVerdict.score` (and `evalAssertionScorer`'s own score)
 *  must clear to count as a pass. Mirrors multi's `EVAL_PASS_THRESHOLD` in
 *  `src/evals/evalReport.ts` so "passed" reads the same on both sides. */
export const EVAL_PASS_THRESHOLD = 0.8;

/**
 * Normalize and validate an authored judge assertion.
 * @param {unknown} value
 * @param {string} [label]
 * @returns {{ instructions: string; threshold: number } | undefined}
 */
export function normalizeEvalJudge(value, label = "judge") {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const unknownKeys = Object.keys(value).filter((key) => !EVAL_JUDGE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unsupported assertion keys: ${unknownKeys.join(", ")}.`);
  }
  if (typeof value.instructions !== "string" || value.instructions.trim() === "") {
    throw new Error(`${label}.instructions must be a non-empty string.`);
  }
  const threshold = value.threshold === undefined ? EVAL_PASS_THRESHOLD : value.threshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`${label}.threshold must be a number between 0 and 1.`);
  }
  return { instructions: value.instructions.trim(), threshold };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function stableHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 8);
}

/**
 * Slugify a free-form token into a stable, filesystem/run-id-safe form,
 * hash-suffixing when the slug would exceed `maxLength` so two long-but-
 * distinct inputs never collide after truncation.
 * @param {string} value
 * @param {string} [fallback]
 * @param {number} [maxLength]
 * @returns {string}
 */
export function slugifyEvalToken(value, fallback = "case", maxLength = 32) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const normalized = slug || fallback;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 9)).replace(/-+$/g, "")}-${stableHash(normalized)}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deep-equal via a canonicalized (key-sorted) JSON encoding.
 * @param {unknown} actual
 * @param {unknown} expected
 * @returns {boolean}
 */
export function jsonEquals(actual, expected) {
  return stableJson(actual) === stableJson(expected);
}

/**
 * Subset match: every key/entry of `expected` must be present (and, for
 * nested objects/arrays, recursively contained) in `actual`. Scalars fall
 * back to `jsonEquals`.
 * @param {unknown} actual
 * @param {unknown} expected
 * @returns {boolean}
 */
export function jsonContains(actual, expected) {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      return false;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (!jsonContains(actual[key], value)) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) {
      return false;
    }
    const matchedActualIndexes = new Set();
    return expected.every((entry) => {
      const matchIndex = actual.findIndex(
        (actualEntry, index) => !matchedActualIndexes.has(index) && jsonContains(actualEntry, entry),
      );
      if (matchIndex < 0) {
        return false;
      }
      matchedActualIndexes.add(matchIndex);
      return true;
    });
  }
  return jsonEquals(actual, expected);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function formatEvalError(error) {
  if (error === undefined || error === null) {
    return "";
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (isPlainObject(error)) {
    if (typeof error.message === "string") {
      return error.message;
    }
    return stableJson(error);
  }
  return String(error);
}

/**
 * Normalize (and validate) an assertion-spec `expected` object: defaults
 * `status` to `"finished"` when absent, rejects unsupported keys and an
 * unrecognized `status` value.
 * @param {unknown} value
 * @param {string} label
 * @returns {{ status: string; [key: string]: unknown }}
 */
export function normalizeExpected(value, label = "expected") {
  if (value === undefined || value === null) {
    return { status: "finished" };
  }
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const unknownKeys = Object.keys(value).filter((key) => !EVAL_EXPECTED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unsupported assertion keys: ${unknownKeys.join(", ")}.`);
  }
  const status = value.status ?? "finished";
  if (typeof status !== "string" || !EVAL_CASE_STATUSES.includes(status)) {
    throw new Error(`${label}.status must be one of ${EVAL_CASE_STATUSES.join(", ")}.`);
  }
  return { ...value, status };
}

// ---------------------------------------------------------------------------
// Dataset parsing (shared base semantics with multi's evalReport.ts)
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} row
 * @param {number} index
 * @returns {EvalCaseInput}
 */
function caseFromRow(row, index) {
  const explicitId = typeof row.id === "string" && row.id.trim() !== "" ? row.id.trim() : undefined;
  const explicitName = typeof row.name === "string" && row.name.trim() !== "" ? row.name.trim() : undefined;
  const id = explicitId ?? explicitName ?? `case-${index + 1}`;
  const hasExpected = "expected" in row;
  const judge = normalizeEvalJudge(row.judge, `Dataset row ${index + 1} judge`);
  if ("input" in row) {
    return {
      id,
      name: explicitName,
      input: row.input,
      ...(hasExpected ? { expected: row.expected } : {}),
      ...(judge ? { judge } : {}),
    };
  }
  const { id: _id, name: _name, expected: _expected, judge: _judge, ...rest } = row;
  return {
    id,
    name: explicitName,
    input: rest,
    ...(hasExpected ? { expected: row.expected } : {}),
    ...(judge ? { judge } : {}),
  };
}

/**
 * Parse JSONL: one JSON object per non-blank, non-`#`-comment line. Returns
 * `undefined` (not an error) when ANY line fails to parse as a JSON object,
 * so the caller can report the more useful whole-document JSON error instead.
 * @param {string} text
 * @returns {Record<string, unknown>[] | undefined}
 */
function tryParseJsonl(text) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    try {
      const parsed = JSON.parse(line);
      if (!isPlainObject(parsed)) return undefined;
      rows.push(parsed);
    } catch {
      return undefined;
    }
  }
  return rows;
}

/**
 * Parse a suite's authored dataset text as a JSON array of case objects, or —
 * when that fails — JSONL (one JSON object per line). Validates non-empty,
 * every row is an object, and no two rows resolve to the same case id.
 * Malformed input (unparseable JSON/JSONL, a non-array/non-object top level,
 * duplicate ids) is reported as an honest `{ ok: false, error }`, never
 * silently dropped or coerced. Judge assertions are normalized and validated
 * before any cases are returned.
 * @param {string} text
 * @returns {EvalDatasetParseResult}
 */
export function parseEvalDataset(text) {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "Dataset is empty." };
  /** @type {Record<string, unknown>[] | undefined} */
  let rows;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      if (!parsed.every(isPlainObject)) {
        return { ok: false, error: "Every dataset row must be a JSON object." };
      }
      rows = /** @type {Record<string, unknown>[]} */ (parsed);
    } else if (isPlainObject(parsed)) {
      return {
        ok: false,
        error: "Dataset must be a JSON array of case objects (a single object is not a list).",
      };
    }
  } catch {
    // Not whole-document JSON — fall through to JSONL below.
  }
  if (rows === undefined) {
    rows = tryParseJsonl(trimmed);
  }
  if (rows === undefined) {
    return { ok: false, error: "Could not parse the dataset as a JSON array or JSONL (one JSON object per line)." };
  }
  if (rows.length === 0) {
    return { ok: false, error: "Dataset has no cases." };
  }
  /** @type {EvalCaseInput[]} */
  const cases = [];
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    let parsedCase;
    try {
      parsedCase = caseFromRow(row, index);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (seen.has(parsedCase.id)) {
      return { ok: false, error: `Duplicate case id "${parsedCase.id}" (row ${index + 1}).` };
    }
    seen.add(parsedCase.id);
    cases.push(parsedCase);
  }
  return { ok: true, cases };
}

// ---------------------------------------------------------------------------
// Case grading
// ---------------------------------------------------------------------------

/**
 * Grade one case run against its dataset `expected` value. Two modes:
 *
 *  - Assertion spec: `expected` is `undefined`/`null`, or a plain object
 *    whose keys are ALL within `{status, output, outputContains,
 *    errorContains}` — the established `smithers eval` assertion semantics
 *    (status defaults to `"finished"`).
 *  - Expected OUTPUT: any other `expected` value — an object/array matches by
 *    subset (`jsonContains`), everything else by deep equality
 *    (`jsonEquals`), PLUS the implicit "case run finished" assertion.
 *
 * Never throws: an unparsable assertion spec degrades to a single failed
 * assertion carrying the validation message, so a malformed dataset case
 * fails honestly instead of crashing the parent run.
 *
 * A failed case is additionally stamped `inconclusive: true` when the case
 * expected to finish, did not, and its error matches a known harness/
 * environment signature (`isEvalInfraFailure`): the workflow's behavior was
 * never observed, so the red must not be read as a product defect.
 * `passed` stays false either way — callers that ignore the stamp keep the
 * fail-closed behavior.
 * @param {{ expected?: unknown; status?: string; output?: unknown; error?: unknown }} args
 * @returns {{ assertions: EvalAssertion[]; passed: boolean; inconclusive: boolean }}
 */
export function evaluateEvalCase({ expected, status, output, error }) {
  const actualStatus = status ?? "error";
  const isAssertionSpec =
    expected === undefined ||
    expected === null ||
    (isPlainObject(expected) && Object.keys(expected).every((key) => EVAL_EXPECTED_KEYS.has(key)));
  /** @type {EvalAssertion[]} */
  const assertions = [];
  let expectedStatus = "finished";
  if (isAssertionSpec) {
    let normalized;
    try {
      normalized = normalizeExpected(expected);
    } catch (err) {
      return {
        assertions: [{ description: err instanceof Error ? err.message : String(err), passed: false }],
        passed: false,
        inconclusive: false,
      };
    }
    expectedStatus = normalized.status;
    assertions.push({
      description: `case run status is "${normalized.status}"`,
      passed: actualStatus === normalized.status,
    });
    if (Object.prototype.hasOwnProperty.call(normalized, "output")) {
      assertions.push({
        description: "output equals expected.output",
        passed: jsonEquals(output, normalized.output),
      });
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "outputContains")) {
      assertions.push({
        description: "output contains expected.outputContains",
        passed: jsonContains(output, normalized.outputContains),
      });
    }
    if (Object.prototype.hasOwnProperty.call(normalized, "errorContains")) {
      const actualError = formatEvalError(error);
      assertions.push({
        description: `error contains "${String(normalized.errorContains)}"`,
        passed: actualError.includes(String(normalized.errorContains)),
      });
    }
  } else {
    assertions.push({
      description: "case run finished",
      passed: actualStatus === "finished",
    });
    const isSubsetMatch = isPlainObject(expected) || Array.isArray(expected);
    assertions.push({
      description: isSubsetMatch ? "output matches expected (subset)" : "output equals expected",
      passed: isSubsetMatch ? jsonContains(output, expected) : jsonEquals(output, expected),
    });
  }
  const passed = assertions.every((assertion) => assertion.passed);
  return {
    assertions,
    passed,
    inconclusive:
      !passed &&
      expectedStatus === "finished" &&
      actualStatus !== "finished" &&
      isEvalInfraFailure(formatEvalError(error)),
  };
}

/**
 * Compose deterministic case grading with an optional asynchronous LLM-judge
 * assertion. The synchronous `evaluateEvalCase` API remains unchanged for
 * callers that cannot or should not resolve an agent.
 *
 * Judge-runner errors become failed assertions so an unavailable provider or
 * malformed response fails the affected case without aborting the suite.
 * @param {{ expected?: unknown; judge?: EvalJudge; input?: unknown; status?: string; output?: unknown; error?: unknown }} args
 * @param {EvalJudgeRunner} [runJudge]
 * @returns {Promise<{ assertions: EvalAssertion[]; passed: boolean; inconclusive: boolean }>}
 */
export async function evaluateEvalCaseAsync({ expected, judge, input, status, output, error }, runJudge) {
  const deterministic = evaluateEvalCase({ expected, status, output, error });
  if (judge === undefined) {
    return deterministic;
  }
  /** @type {{ instructions: string; threshold: number } | undefined} */
  let normalizedJudge;
  try {
    normalizedJudge = normalizeEvalJudge(judge);
  } catch (err) {
    const assertion = {
      description: err instanceof Error ? err.message : String(err),
      passed: false,
      score: 0,
      reason: "Invalid judge assertion.",
    };
    return {
      assertions: [...deterministic.assertions, assertion],
      passed: false,
      inconclusive: deterministic.inconclusive,
    };
  }
  if (!normalizedJudge) {
    return deterministic;
  }
  const description = `LLM judge score >= ${normalizedJudge.threshold}: ${normalizedJudge.instructions}`;
  /** @type {EvalAssertion} */
  let assertion;
  if (!runJudge) {
    assertion = {
      description,
      passed: false,
      score: 0,
      reason: "No LLM judge runner was provided.",
    };
  } else {
    try {
      const verdict = await runJudge({
        judge: normalizedJudge,
        input,
        expected,
        status,
        output,
        error,
      });
      const score =
        typeof verdict?.score === "number" && Number.isFinite(verdict.score)
          ? Math.max(0, Math.min(1, verdict.score))
          : 0;
      assertion = {
        description,
        passed: score >= normalizedJudge.threshold,
        score,
        reason:
          typeof verdict?.reason === "string" && verdict.reason.trim() !== ""
            ? verdict.reason
            : "Judge returned no reason.",
      };
    } catch (err) {
      assertion = {
        description,
        passed: false,
        score: 0,
        reason: `LLM judge failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const assertions = [...deterministic.assertions, assertion];
  return {
    assertions,
    passed: assertions.every((entry) => entry.passed),
    inconclusive: deterministic.inconclusive,
  };
}

/**
 * Readable, collision-free run id for ONE case's child workflow run.
 * Embeds the parent eval run's id (not just the suite+case) so two concurrent
 * launches of the same suite never mint the same child run id.
 * @param {string} suiteId
 * @param {string} caseId
 * @param {string} evalRunId
 * @returns {string}
 */
export function evalCaseRunId(suiteId, caseId, evalRunId) {
  const suite = slugifyEvalToken(suiteId, "suite", 16);
  const testCase = slugifyEvalToken(caseId, "case", 16);
  const run = slugifyEvalToken(evalRunId, "run", 16);
  const base = `evalcase-${run}-${suite}-${testCase}`;
  if (base.length <= RUN_ID_MAX_LENGTH) {
    return base;
  }
  return `${base.slice(0, RUN_ID_MAX_LENGTH - 9).replace(/-+$/g, "")}-${stableHash(base)}`;
}

// ---------------------------------------------------------------------------
// Scorer seam
// ---------------------------------------------------------------------------

/**
 * The `eval-suite-run` workflow attaches this scorer to every case `<Task>`.
 * When the task finishes, the engine's async scorer runner (`runScorersAsync`)
 * calls `score({ output })` with the task's OWN return value — which the
 * workflow shapes to include an `assertions: EvalAssertion[]` array — and
 * writes a real `_smithers_scorers` row (`run_id` = the eval run, `node_id` =
 * `case-<caseId>`). This is the ONLY place a case's pass/fail becomes a
 * scored row; `listScoresForRuns`/`getScoreDetail` read it unmodified.
 * @returns {Scorer}
 */
export function evalAssertionScorer() {
  return createScorer({
    id: "eval-assertions",
    name: "Eval Assertions",
    description: "Scores 1 when every assertion recorded on the case's own output row passed, else 0.",
    score: async ({ output }) => {
      const assertions =
        isPlainObject(output) && Array.isArray(/** @type {any} */ (output).assertions)
          ? /** @type {EvalAssertion[]} */ (/** @type {any} */ (output).assertions)
          : [];
      if (assertions.length === 0) {
        return { score: 1, reason: "No assertions recorded; case passes on completion alone." };
      }
      const failed = assertions.filter((assertion) => !assertion.passed);
      if (failed.length === 0) {
        return { score: 1, reason: `All ${assertions.length} assertion(s) passed.` };
      }
      return {
        score: 0,
        reason: `${failed.length}/${assertions.length} assertion(s) failed: ${failed.map((assertion) => assertion.description).join("; ")}`,
      };
    },
  });
}
