/**
 * The Context Contract doctor: a deterministic set of readiness checks over a
 * {@link ContextContract}, mirroring the workflow doctor (`runDoctor` in
 * `../store/workflowDocs`). Each check yields exactly one issue — `ok` when it
 * passes, otherwise a `warning`/`error`/`info` finding with a one-line message
 * and optional detail — so the result is a stable, ordered scorecard the console
 * can render and unit-test without a DOM.
 *
 * Pure TS (no React, no clock, no randomness): the same contract always produces
 * the same issues, in the same order.
 */

import type { ContextContract } from "./contextContract";

/** A context-doctor finding: a severity, a one-line message, optional detail. */
export type ContextDoctorIssue = {
  /** The stable check identifier this issue came from (e.g. `hasGoal`). */
  check: string;
  severity: "ok" | "warning" | "error" | "info";
  message: string;
  detail?: string;
};

/**
 * Heuristic for a side effect that looks risky enough to demand approval. Kept
 * deterministic: a lowercase substring match against a fixed keyword set, so the
 * same description always classifies the same way (no model call, no clock).
 */
const RISKY_SIDE_EFFECT_KEYWORDS = [
  "delete",
  "drop",
  "remove",
  "destroy",
  "deploy",
  "push",
  "publish",
  "production",
  "prod",
  "force",
  "overwrite",
  "truncate",
  "payment",
  "charge",
  "send",
  "email",
  "rm ",
];

/** Whether a side-effect description matches the deterministic "risky" keyword set. */
function looksRisky(description: string): boolean {
  const haystack = description.toLowerCase();
  return RISKY_SIDE_EFFECT_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

/**
 * Run every context-doctor check over a contract, returning one issue per check
 * in a fixed order. Deterministic per contract — no randomness, no I/O. Checks:
 *   - `hasGoal` — the contract states a non-empty goal.
 *   - `hasOutputSpec` — at least one declared output.
 *   - `hasAcceptanceCriteria` — at least one acceptance criterion.
 *   - `allBlockingCriteriaHaveVerification` — every blocking criterion has a
 *     non-null `verificationMethod`.
 *   - `allRequiredInputsHaveSource` — every input has a non-null `source`.
 *   - `allSideEffectsHaveApproval` — every risky side effect requires approval.
 *   - `reportSpecExists` — a `reportSpec` is specified.
 */
export function runContextDoctor(contract: ContextContract): ContextDoctorIssue[] {
  const issues: ContextDoctorIssue[] = [];

  // hasGoal
  if (contract.goal.trim() === "") {
    issues.push({
      check: "hasGoal",
      severity: "error",
      message: "No goal is stated.",
      detail: "The contract needs a goal before an agent can start.",
    });
  } else {
    issues.push({ check: "hasGoal", severity: "ok", message: "Goal is stated." });
  }

  // hasOutputSpec
  if (contract.outputs.length === 0) {
    issues.push({
      check: "hasOutputSpec",
      severity: "warning",
      message: "No outputs are declared.",
      detail: "Specify what the work should produce.",
    });
  } else {
    issues.push({
      check: "hasOutputSpec",
      severity: "ok",
      message: `${contract.outputs.length} output(s) declared.`,
    });
  }

  // hasAcceptanceCriteria
  if (contract.acceptanceCriteria.length === 0) {
    issues.push({
      check: "hasAcceptanceCriteria",
      severity: "warning",
      message: "No acceptance criteria are defined.",
      detail: "Without criteria the work cannot be graded as done.",
    });
  } else {
    issues.push({
      check: "hasAcceptanceCriteria",
      severity: "ok",
      message: `${contract.acceptanceCriteria.length} acceptance criteria defined.`,
    });
  }

  // allBlockingCriteriaHaveVerification
  const blocking = contract.acceptanceCriteria.filter((c) => c.blocking);
  const unverifiedBlocking = blocking.filter((c) => c.verificationMethod === null);
  if (blocking.length === 0) {
    issues.push({
      check: "allBlockingCriteriaHaveVerification",
      severity: "ok",
      message: "No blocking criteria to verify.",
    });
  } else if (unverifiedBlocking.length > 0) {
    issues.push({
      check: "allBlockingCriteriaHaveVerification",
      severity: "error",
      message: `${unverifiedBlocking.length} blocking criterion(s) have no verification method.`,
      detail: unverifiedBlocking.map((c) => c.criterion).join("; "),
    });
  } else {
    issues.push({
      check: "allBlockingCriteriaHaveVerification",
      severity: "ok",
      message: `All ${blocking.length} blocking criteria have a verification method.`,
    });
  }

  // allRequiredInputsHaveSource
  const unsourced = contract.inputs.filter((input) => input.source === null);
  if (contract.inputs.length === 0) {
    issues.push({
      check: "allRequiredInputsHaveSource",
      severity: "ok",
      message: "No inputs to source.",
    });
  } else if (unsourced.length > 0) {
    issues.push({
      check: "allRequiredInputsHaveSource",
      severity: "warning",
      message: `${unsourced.length} input(s) have no source.`,
      detail: unsourced.map((input) => input.name).join("; "),
    });
  } else {
    issues.push({
      check: "allRequiredInputsHaveSource",
      severity: "ok",
      message: `All ${contract.inputs.length} inputs have a source.`,
    });
  }

  // allSideEffectsHaveApproval
  const riskyUnapproved = contract.sideEffects.filter(
    (effect) => looksRisky(effect.description) && !effect.requiresApproval,
  );
  if (contract.sideEffects.length === 0) {
    issues.push({
      check: "allSideEffectsHaveApproval",
      severity: "ok",
      message: "No side effects declared.",
    });
  } else if (riskyUnapproved.length > 0) {
    issues.push({
      check: "allSideEffectsHaveApproval",
      severity: "warning",
      message: `${riskyUnapproved.length} risky side effect(s) do not require approval.`,
      detail: riskyUnapproved.map((effect) => effect.description).join("; "),
    });
  } else {
    issues.push({
      check: "allSideEffectsHaveApproval",
      severity: "ok",
      message: `${contract.sideEffects.length} side effect(s) are gated appropriately.`,
    });
  }

  // reportSpecExists
  if (contract.reportSpec === null || contract.reportSpec.trim() === "") {
    issues.push({
      check: "reportSpecExists",
      severity: "info",
      message: "No report spec is set.",
      detail: "The work will not produce a structured report.",
    });
  } else {
    issues.push({ check: "reportSpecExists", severity: "ok", message: "Report spec is set." });
  }

  return issues;
}
