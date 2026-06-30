// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Backpressure Plan
// smithers-description: Turn acceptance criteria into a gate matrix (schema/test/eval/review/approval/trace) so a workflow cannot just try-its-best and move on.
// smithers-tags: quality, backpressure
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import ExtractCriteriaPrompt from "../prompts/backpressure-plan-extract-criteria.mdx";
import PlanGatesPrompt from "../prompts/backpressure-plan-plan-gates.mdx";

const DEFAULT_PROMPT = "Describe the goal and its acceptance criteria in plain English.";

const inputSchema = z.object({
  prompt: z
    .string()
    .default(DEFAULT_PROMPT)
    .describe("The goal / acceptance criteria to turn into a backpressure gate matrix."),
});

// 1. The flat list of testable acceptance criteria pulled out of the prompt.
const criteriaSchema = z.looseObject({
  criteria: z
    .array(z.string())
    .default([])
    .describe("One atomic, verifiable acceptance criterion per entry."),
});

// 2. The gate matrix: every criterion mapped to how it is verified and enforced.
const gatesSchema = z.looseObject({
  gates: z
    .array(
      z.object({
        criterion: z.string().describe("The acceptance criterion this gate enforces."),
        verificationMethod: z
          .enum([
            "schema",
            "unit_test",
            "integration_test",
            "eval",
            "review",
            "approval",
            "trace",
            "manual_check",
          ])
          .describe("How the criterion is checked."),
        gateType: z
          .enum(["blocking", "warning", "informational"])
          .describe("blocking stops the run; warning flags; informational only records."),
        checkedBy: z.string().describe("Who/what runs the check (a task id, scorer, human role, or tool)."),
        failureAction: z.string().describe("What happens when this gate fails."),
        evidenceRequired: z
          .array(z.string())
          .default([])
          .describe("Concrete artifacts that prove the gate passed (logs, diffs, reports, traces)."),
        humanApprovalRequired: z
          .boolean()
          .default(false)
          .describe("True if a durable human approval gate is needed for this criterion."),
      }),
    )
    .default([])
    .describe("One gate per criterion; every blocking criterion maps to a verification method."),
  summary: z.string().default("").describe("2-3 sentence overview of the backpressure plan."),
});

// 3. Deterministic parity check: the matrix is only trustworthy when every
//    extracted criterion has exactly one gate, in order, verbatim.
const verifySchema = z.object({
  match: z.boolean().describe("True when gates cover every criterion, one each, same order, verbatim."),
  criteriaCount: z.number(),
  gateCount: z.number(),
  missing: z.array(z.string()).default([]).describe("Criteria with no verbatim gate."),
  unverifiedBlocking: z
    .array(z.string())
    .default([])
    .describe("Blocking gates whose verificationMethod is manual_check with no named checker."),
  summary: z.string(),
});

// 4. The run's printed terminal result: a concise, human-meaningful roll-up of
//    the plan (counts, verdict, gaps) drawn only from what the stages produced.
const outputSchema = z.object({
  verdict: z.string().describe("pass when every criterion maps to one in-order gate, else fail."),
  criteriaCount: z.number().describe("Acceptance criteria extracted from the goal."),
  gateCount: z.number().describe("Gates produced in the matrix."),
  blockingGates: z.number().describe("Gates that stop the run on failure."),
  humanApprovals: z.number().describe("Gates that require a durable human approval."),
  missing: z.array(z.string()).describe("Criteria with no matching gate."),
  summary: z.string().describe("Plain-English overview of the backpressure plan and its verdict."),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  extractCriteria: criteriaSchema,
  planGates: gatesSchema,
  verify: verifySchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  // Input fields arrive null (not the zod default) when unsupplied — coalesce
  // so the prompts never see an empty goal section.
  const prompt = ctx.input.prompt ?? DEFAULT_PROMPT;

  // Gate the plan-gates stage on the extracted criteria being available.
  const criteria = ctx.outputMaybe("extractCriteria", { nodeId: "extract-criteria" });
  const gates = ctx.outputMaybe("planGates", { nodeId: "plan-gates" });
  const criteriaList = Array.isArray(criteria?.criteria) ? criteria.criteria : [];

  // Gate the printed terminal roll-up on the parity check having run.
  const verify = ctx.outputMaybe("verify", { nodeId: "verify" });

  return (
    <Workflow name="backpressure-plan">
      <Sequence>
        {/* 1 — Pull the prompt apart into atomic, verifiable acceptance criteria. */}
        <Task id="extract-criteria" output={outputs.extractCriteria} agent={agents.smart}>
          <ExtractCriteriaPrompt prompt={prompt} />
        </Task>

        {/* 1b — Backpressure on the plan itself: a goal with no verifiable
            criteria must fail loudly, not produce an empty gate matrix. */}
        {criteria && criteriaList.length === 0 ? (
          <Task id="no-verifiable-acceptance-criteria" output={outputs.verify} retries={0}>
            {() => {
              throw new Error(
                "The goal contains no verifiable acceptance criteria — nothing to plan gates for. " +
                  "Restate the goal with at least one criterion a person or check could mark pass or fail.",
              );
            }}
          </Task>
        ) : null}

        {/* 2 — Map each criterion to a verification method + enforcement gate. */}
        {criteria && criteriaList.length > 0 ? (
          <Task id="plan-gates" output={outputs.planGates} agent={agents.smart}>
            <PlanGatesPrompt criteria={criteriaList} prompt={prompt} />
          </Task>
        ) : null}

        {/* 3 — Deterministic parity check of the matrix against the criteria. */}
        {criteria && criteriaList.length > 0 && gates ? (
          <Task id="verify" output={outputs.verify}>
            {() => {
              const wanted = criteriaList;
              const gateList = Array.isArray(gates.gates) ? gates.gates : [];
              const produced = gateList.map((gate) => gate.criterion);
              const missing = wanted.filter((criterion) => !produced.includes(criterion));
              const orderedMatch =
                produced.length === wanted.length &&
                wanted.every((criterion, index) => produced[index] === criterion);
              const unverifiedBlocking = gateList
                .filter((gate) => gate.gateType === "blocking" && gate.verificationMethod === "manual_check" && gate.checkedBy.trim().length === 0)
                .map((gate) => gate.criterion);
              const match = orderedMatch && unverifiedBlocking.length === 0;
              const summary = match
                ? `All ${wanted.length} criteria are covered by one gate each, in order.`
                : `Gate matrix mismatch: ${missing.length} criteria missing, ${produced.length}/${wanted.length} gates, ${unverifiedBlocking.length} unverified blocking gate(s).`;
              return {
                match,
                criteriaCount: wanted.length,
                gateCount: produced.length,
                missing,
                unverifiedBlocking,
                summary,
              };
            }}
          </Task>
        ) : null}

        {/* 4 — Concise terminal roll-up so the run prints something useful. */}
        {verify ? (
          <Task id="output" output={outputs.output}>
            {() => {
              const planGates = gates ? gates.gates : [];
              const blockingGates = planGates.filter((gate) => gate.gateType === "blocking").length;
              const humanApprovals = planGates.filter((gate) => gate.humanApprovalRequired).length;
              const planSummary = gates && gates.summary.trim().length > 0 ? gates.summary.trim() : "";
              const summary = [planSummary, verify.summary]
                .filter((part) => part.trim().length > 0)
                .join(" ");
              return {
                verdict: verify.match ? "pass" : "fail",
                criteriaCount: verify.criteriaCount,
                gateCount: verify.gateCount,
                blockingGates,
                humanApprovals,
                missing: verify.missing,
                summary: summary.length > 0 ? summary : verify.summary,
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
