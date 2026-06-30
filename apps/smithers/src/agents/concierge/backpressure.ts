/**
 * Backpressure planning: turn a {@link ContextContract}'s acceptance criteria
 * into a gate matrix — one {@link Gate} per criterion describing how it gets
 * verified, how hard it gates the work, what happens on failure, and what
 * evidence must be captured to prove it passed.
 *
 * Pure TS (no React, no clock, no randomness): the same contract always yields
 * the same gates, in the same order as `contract.acceptanceCriteria`. The
 * `verificationMethod` is chosen by deterministic lowercase substring matching
 * against a fixed keyword set, so the classification never depends on a model
 * call or the environment.
 */

import type { ContextContract } from "./contextContract";

/**
 * One gate derived from an acceptance criterion. `verificationMethod` is how the
 * criterion is checked; `gateType` is how hard it gates (a `blocking` criterion
 * must pass before the work is done); `failureAction` is the one-line action to
 * take when the gate fails; `evidenceRequired` lists the artifacts that must be
 * captured to prove the gate passed.
 */
export type Gate = {
  criterion: string;
  verificationMethod:
    | "schema"
    | "unit_test"
    | "integration_test"
    | "eval"
    | "review"
    | "approval"
    | "trace"
    | "manual_check";
  gateType: "blocking" | "warning" | "informational";
  failureAction: string;
  evidenceRequired: string[];
};

/**
 * Deterministic keyword heuristics that map a criterion's text to a
 * `verificationMethod`. Each entry is a fixed lowercase-substring keyword set;
 * the first matching method (in this declared order) wins, so the classification
 * is stable and order-sensitive. A criterion that matches nothing falls through
 * to `manual_check`.
 */
const METHOD_KEYWORDS: ReadonlyArray<{
  method: Gate["verificationMethod"];
  keywords: readonly string[];
}> = [
  { method: "schema", keywords: ["schema", "valid", "parse", "type-check", "typecheck"] },
  { method: "approval", keywords: ["approve", "publish", "deploy", "release", "sign-off"] },
  { method: "unit_test", keywords: ["unit test", "test", "pass", "assert", "coverage"] },
  {
    method: "integration_test",
    keywords: ["integration", "end-to-end", "end to end", "e2e", "smoke"],
  },
  { method: "eval", keywords: ["eval", "benchmark", "score", "regression", "accuracy"] },
  { method: "review", keywords: ["cite", "source", "review", "reference", "citation"] },
  { method: "trace", keywords: ["trace", "log", "observ", "telemetry", "span"] },
];

/**
 * Classify a single criterion into a `verificationMethod` by deterministic
 * lowercase substring matching against {@link METHOD_KEYWORDS}. The first entry
 * (in declared order) with any matching keyword wins; if nothing matches the
 * criterion falls back to `manual_check`.
 */
function pickVerificationMethod(criterion: string): Gate["verificationMethod"] {
  const haystack = criterion.toLowerCase();
  for (const { method, keywords } of METHOD_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return method;
    }
  }
  return "manual_check";
}

/**
 * The evidence each `verificationMethod` requires to prove the gate passed.
 * Fixed per method so the gate matrix is deterministic and self-documenting.
 */
const EVIDENCE_BY_METHOD: Record<Gate["verificationMethod"], readonly string[]> = {
  schema: ["schema_validation_output"],
  unit_test: ["unit_test_results"],
  integration_test: ["integration_test_results"],
  eval: ["eval_report", "score"],
  review: ["review_notes", "cited_sources"],
  approval: ["approval_record"],
  trace: ["trace_id", "log_excerpt"],
  manual_check: ["checklist_note"],
};

/**
 * Build the backpressure gate matrix for a contract: one {@link Gate} per
 * acceptance criterion, in the same order as `contract.acceptanceCriteria`.
 *
 * For each criterion: `verificationMethod` is chosen by
 * {@link pickVerificationMethod}; `gateType` is `blocking` when the criterion is
 * blocking, otherwise `warning`; `failureAction` describes what to do when the
 * gate fails (a blocking failure halts the work, a non-blocking one is recorded
 * and surfaced); and `evidenceRequired` is the fixed evidence list for the
 * chosen method (a fresh array per gate, so callers may mutate it freely).
 *
 * Deterministic per contract — no randomness, no I/O.
 */
export function planBackpressure(contract: ContextContract): Gate[] {
  return contract.acceptanceCriteria.map((c) => {
    const verificationMethod = pickVerificationMethod(c.criterion);
    const gateType: Gate["gateType"] = c.blocking ? "blocking" : "warning";
    const failureAction = c.blocking
      ? `Halt the work and fix: ${c.criterion}`
      : `Record the failure and surface: ${c.criterion}`;
    return {
      criterion: c.criterion,
      verificationMethod,
      gateType,
      failureAction,
      evidenceRequired: [...EVIDENCE_BY_METHOD[verificationMethod]],
    };
  });
}
