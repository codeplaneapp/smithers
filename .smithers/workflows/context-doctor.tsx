// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Context Doctor
// smithers-description: Run deterministic checks over a context contract and report missing goals, inputs, verification, approvals, and report specs.
// smithers-tags: quality, context-engineering
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import AdvisePrompt from "../prompts/context-doctor-advise.mdx";

const inputSchema = z.object({
  contract: z
    .string()
    .default("{}")
    .describe("JSON string of a context contract to diagnose."),
});

// Severity ranking used by the deterministic checks below.
const severitySchema = z.enum(["ok", "warning", "error", "info"]);

const issueSchema = z.object({
  check: z.string().describe("Stable id of the check that produced this issue."),
  severity: severitySchema,
  message: z.string().describe("Human-readable explanation of the finding."),
});

// 1. Deterministic diagnosis of the contract (pure JS, no agent).
const checkSchema = z.looseObject({
  issues: z.array(issueSchema).default([]),
  summary: z.string(),
  score: z.number().describe("0–100 health score; 100 means every check passed."),
});

// 2. Agent advice on how to resolve each non-ok finding. Each fix is paired
//    to the check id it resolves so remediation is verifiable per finding.
const adviseSchema = z.looseObject({
  fixes: z
    .array(
      z.object({
        check: z.string().describe("The check id of the issue this fix resolves."),
        fix: z.string().describe("One concrete, imperative suggestion resolving that issue."),
      }),
    )
    .default([])
    .describe("One {check, fix} pair per non-ok issue, ordered error → warning → info."),
  summary: z.string(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  check: checkSchema,
  advise: adviseSchema,
});

// --- Deterministic contract checks: the hardcoded path, no agent involved. ---

type Severity = z.infer<typeof severitySchema>;
type Issue = z.infer<typeof issueSchema>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function ok(check: string, message: string): Issue {
  return { check, severity: "ok", message };
}

function fail(check: string, severity: Severity, message: string): Issue {
  return { check, severity, message };
}

function diagnose(raw: string): z.infer<typeof checkSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      issues: [fail("parse", "error", "Contract is not valid JSON: " + reason)],
      summary: "Could not parse the contract as JSON.",
      score: 0,
    };
  }

  if (!isObject(parsed)) {
    return {
      issues: [fail("parse", "error", "Contract must be a JSON object at the top level.")],
      summary: "Contract is valid JSON but not an object.",
      score: 0,
    };
  }

  const contract = parsed;
  const issues: Issue[] = [];

  // hasGoal — a non-empty goal statement exists.
  if (isNonEmptyString(contract.goal)) {
    issues.push(ok("hasGoal", "Contract declares a goal."));
  } else {
    issues.push(fail("hasGoal", "error", "Missing a non-empty `goal` describing the intended outcome."));
  }

  // hasOutputSpec — the contract says what artifact/output it produces.
  const outputSpec = contract.outputSpec ?? contract.output;
  if (isNonEmptyString(outputSpec) || isObject(outputSpec)) {
    issues.push(ok("hasOutputSpec", "Contract declares an output spec."));
  } else {
    issues.push(fail("hasOutputSpec", "error", "Missing an `outputSpec` describing the produced artifact."));
  }

  // hasAcceptanceCriteria — at least one acceptance criterion is listed.
  const acceptanceCriteria = asArray(contract.acceptanceCriteria ?? contract.acceptance_criteria);
  if (acceptanceCriteria.length > 0) {
    issues.push(ok("hasAcceptanceCriteria", acceptanceCriteria.length + " acceptance criteria declared."));
  } else {
    issues.push(fail("hasAcceptanceCriteria", "error", "Missing `acceptanceCriteria`; no way to know when the work is done."));
  }

  // allBlockingCriteriaHaveVerification — every blocking criterion names a
  // verification. Plain-string criteria cannot declare `blocking` or
  // `verification` at all, so they are flagged rather than silently passing.
  const stringCriteria = acceptanceCriteria.filter((c) => typeof c === "string");
  const blocking = acceptanceCriteria.filter((c) => isObject(c) && c.blocking === true);
  const unverified = blocking.filter(
    (c) => isObject(c) && !isNonEmptyString(c.verification) && !isNonEmptyString(c.verify),
  );
  if (unverified.length > 0) {
    issues.push(
      fail(
        "allBlockingCriteriaHaveVerification",
        "error",
        unverified.length + " blocking criterion/criteria lack a `verification` step.",
      ),
    );
  } else if (stringCriteria.length > 0) {
    issues.push(
      fail(
        "allBlockingCriteriaHaveVerification",
        "warning",
        stringCriteria.length +
          " plain-string acceptance criteria cannot declare `blocking` or `verification`; convert them to {text, blocking, verification} objects.",
      ),
    );
  } else if (blocking.length === 0) {
    issues.push(ok("allBlockingCriteriaHaveVerification", "No blocking acceptance criteria to verify."));
  } else {
    issues.push(ok("allBlockingCriteriaHaveVerification", "Every blocking criterion names a verification."));
  }

  // allRequiredInputsHaveSource — every required input declares where it comes from.
  const inputs = asArray(contract.inputs);
  const requiredInputs = inputs.filter((i) => isObject(i) && i.required === true);
  if (requiredInputs.length === 0) {
    issues.push(ok("allRequiredInputsHaveSource", "No required inputs to source."));
  } else {
    const sourceless = requiredInputs.filter((i) => isObject(i) && !isNonEmptyString(i.source));
    if (sourceless.length === 0) {
      issues.push(ok("allRequiredInputsHaveSource", "Every required input declares a `source`."));
    } else {
      issues.push(
        fail(
          "allRequiredInputsHaveSource",
          "error",
          sourceless.length + " required input(s) are missing a `source`.",
        ),
      );
    }
  }

  // allSideEffectsHaveApproval — every side effect declares an approval gate.
  // Plain-string entries cannot declare `approval`, so they count as unguarded.
  const sideEffects = asArray(contract.sideEffects ?? contract.side_effects);
  if (sideEffects.length === 0) {
    issues.push(ok("allSideEffectsHaveApproval", "No declared side effects."));
  } else {
    const unguarded = sideEffects.filter(
      (s) => !isObject(s) || (s.approval !== true && !isNonEmptyString(s.approval)),
    );
    if (unguarded.length === 0) {
      issues.push(ok("allSideEffectsHaveApproval", "Every side effect is gated by an approval."));
    } else {
      issues.push(
        fail(
          "allSideEffectsHaveApproval",
          "warning",
          unguarded.length +
            " side effect(s) have no `approval` gate (plain-string entries cannot declare one; use {name, approval} objects).",
        ),
      );
    }
  }

  // reportSpecExists — the contract says how to report results.
  const reportSpec = contract.reportSpec ?? contract.report ?? contract.report_spec;
  if (isNonEmptyString(reportSpec) || isObject(reportSpec)) {
    issues.push(ok("reportSpecExists", "Contract declares a report spec."));
  } else {
    issues.push(fail("reportSpecExists", "info", "No `reportSpec`; results have no declared reporting format."));
  }

  const total = issues.length;
  const passed = issues.filter((i) => i.severity === "ok").length;
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const score = total === 0 ? 100 : Math.round((passed / total) * 100);

  const summary =
    errors > 0
      ? errors + " error(s) and " + warnings + " warning(s) — contract is incomplete (score " + score + "/100)."
      : warnings > 0
        ? warnings + " warning(s) — contract is usable but could be tightened (score " + score + "/100)."
        : "Contract passes every check (score " + score + "/100).";

  return { issues, summary, score };
}

/**
 * Context Doctor. A deterministic `check` task parses the contract and runs the
 * seven structural checks; an agent `advise` task then suggests concrete fixes
 * for each non-ok finding.
 */
export default smithers((ctx) => {
  const check = ctx.outputMaybe("check", { nodeId: "check" });

  return (
    <Workflow name="context-doctor">
      <Sequence>
        {/* 1 — Deterministic diagnosis of the contract (pure JS, no agent).
            Input fields arrive null when unsupplied — coalesce to the
            documented default so a bare invocation diagnoses an empty
            contract instead of the string "null". */}
        <Task id="check" output={outputs.check}>
          {() => diagnose(ctx.input.contract ?? "{}")}
        </Task>

        {/* 2 — Agent advice for resolving every non-ok finding. */}
        {check ? (
          <Task id="advise" output={outputs.advise} agent={agents.cheapFast}>
            <AdvisePrompt
              summary={check.summary}
              score={check.score}
              issues={check.issues}
            />
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
