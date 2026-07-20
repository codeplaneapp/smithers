/** @jsxImportSource smithers-orchestrator */
// The generic fluency-eval engine. Every suite is a thin wrapper:
//
//   import { createFluencyEval } from "../../lib/eval-kit";
//   export default createFluencyEval({ suite: "knowledge-cli" });
//
// One candidate <Task> (weak model under test) → one verify step (deterministic
// compute child, or a judge <Task> on a sota model). The candidate self-reports
// oneShot + friction; the verifier sets the hard `passed` the case asserts on.
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { EVAL_DB_PATH } from "./paths.js";
import { resolveCandidate, resolveJudge } from "./model-matrix.js";
import { candidateReport, type CandidateReport, evalVerdict, qualityScore } from "./report-schema.js";
import { docsGapScorer, frictionScorer, oneShotScorer, schemaAdherenceScorer } from "./scorers.js";
import { computeVerdict, normalizeVerify, type VerifyKind } from "./verify.js";

const verifyShape = z.object({
  kind: z.enum(["contains", "equals", "graph", "sql", "query", "build", "ui-functional", "judge"]).default("contains"),
  must: z.array(z.string()).default([]),
  mustNot: z.array(z.string()).default([]),
  answer: z.string().nullable().default(null),
  rubric: z.string().nullable().default(null),
  sql: z.string().nullable().default(null),
  expect: z.string().nullable().default(null),
  db: z.string().nullable().default(null),
  required: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  taskId: z.string().default("task").describe("Stable id of the logical task (for the scorecard)."),
  area: z.string().default("unknown").describe("Feature area bucket."),
  feature: z.string().default("unknown").describe("Specific feature id this exercises."),
  task: z
    .string()
    .default("Describe the Smithers task to one-shot.")
    .describe("The exact instruction handed to the candidate."),
  model: z.string().default("sonnet").describe("Candidate model name from evals/agents.ts."),
  context: z.string().nullable().default(null).describe("Optional extra context/files for the candidate."),
  verify: verifyShape.optional(),
  judgeModel: z.string().default("opus").describe("Model for judge-verify + sampled docs-gap scorer."),
});

const DEFAULT_TASK = "Describe the Smithers task to one-shot.";

const DOCS_PREAMBLE =
  "You are an AI agent using Smithers (a durable control plane for coding agents) for a real task. " +
  "The Smithers docs and skill ARE available to you — consult them, do not rely on memory:\n" +
  "  • `bunx smithers-orchestrator docs` / `docs-full` print the LLM docs bundle\n" +
  "  • skills/smithers/SKILL.md and skills/smithers/llms-full.txt\n" +
  "  • docs/llms-core.txt and the docs/llms-*.txt topic fragments\n" +
  "Ground your answer in those docs. If something you need is missing, unclear, or wrong in the docs, " +
  "do your best AND record it honestly in `friction` — that is the most valuable output here.\n" +
  "IMPORTANT: Do NOT create, edit, or delete any files on disk, and do NOT run the workflow. " +
  "Produce your ENTIRE answer only in the structured `artifact` field. Reading docs/source is fine.";

function artifactContract(kind: VerifyKind): string {
  if (kind === "graph") {
    return [
      "Deliverable: put a COMPLETE, self-contained Smithers workflow file in `artifact` (artifactKind: workflow-tsx).",
      "Requirements that make it verifiable:",
      "  • It MUST start with the pragma: /** @jsxImportSource smithers-orchestrator */",
      "  • Import everything from 'smithers-orchestrator' (and 'zod' for schemas).",
      "  • Construct any agent INLINE (e.g. new ClaudeCodeAgent({ model: 'claude-sonnet-5' })).",
      "  • Do NOT import project-relative paths like '../agents' or '../prompts/*.mdx' — it must stand alone.",
      "  • It must render with `smithers graph` (a valid <Workflow> tree with typed <Task> outputs).",
    ].join("\n");
  }
  if (kind === "sql" || kind === "query") {
    return "Deliverable: put a single SQL query (SQLite dialect) that answers the question in `artifact` (artifactKind: sql). No prose, just the query.";
  }
  if (kind === "build") {
    return [
      "Deliverable: put a COMPLETE, self-contained custom workflow UI bundle in `artifact` (artifactKind: ui-tsx). One file.",
      "Requirements:",
      "  • Start with the pragma: /** @jsxImportSource react */",
      "  • Import the gateway hooks from 'smithers-orchestrator/gateway-react' (createGatewayReactRoot + the hooks you need: useGatewayRun, useGatewayRunEvents, useGatewayNodeOutput, useGatewayApprovals, useGatewayActions, useGatewayRuns).",
      "  • Read the run to scope to from `?runId` in location.search.",
      "  • Mount with createGatewayReactRoot(<App />). Handle loading / empty / error states.",
      "  • It must be valid TSX that transpiles. Do not invent hooks or props that don't exist.",
    ].join("\n");
  }
  if (kind === "ui-functional") {
    return [
      "Deliverable: put a COMPLETE, self-contained custom workflow UI bundle in `artifact` (artifactKind: ui-tsx). One file.",
      "This UI will be booted in a REAL browser against a REAL run and graded on OBSERVED behavior, not just source. It must actually work.",
      "Requirements:",
      "  • Start with the pragma: /** @jsxImportSource react */",
      "  • Import from 'smithers-orchestrator/gateway-react': createGatewayReactRoot, useGatewayRun, useGatewayRunEvents, useGatewayNodeOutput, useGatewayApprovals, useGatewayActions.",
      "  • Read the run to scope to from `?runId` in location.search.",
      "  • Show the run's live STATUS (from useGatewayRun().data.status).",
      "  • Stream and render the LIVE EVENTS from useGatewayRunEvents(runId, { afterSeq: 0 }). Each frame is { event: string, payload: { nodeId, error, ... } } — surface EVERY task node (plan, build, flaky, report), not just one.",
      "  • Render the 'report' node's OUTPUT via useGatewayNodeOutput({ runId, nodeId: 'report', iteration: 0 }).",
      "  • SURFACE THE FAILED NODE: the 'flaky' task fails — show its failed state and error message (NodeFailed frames carry payload.error).",
      "  • Show PENDING APPROVALS from useGatewayApprovals({ filter: { runId } }) with a working Approve button that calls useGatewayActions().submitApproval({ runId, nodeId, approved: true }).",
      "  • Mount with createGatewayReactRoot(<App />). Handle loading / empty / error states. Do not invent hooks or props that don't exist.",
    ].join("\n");
  }
  if (kind === "contains" || kind === "equals") {
    return "Deliverable: put ONLY the answer/command in `artifact` (artifactKind: cli-command or answer). Be concise — no surrounding prose in `artifact`.";
  }
  return "Deliverable: put your complete answer/code in `artifact` with the most fitting artifactKind.";
}

function candidatePrompt(task: string, context: string | null, kind: VerifyKind): string {
  return [
    DOCS_PREAMBLE,
    "",
    "TASK:",
    task,
    context ? `\nCONTEXT:\n${context}` : "",
    "",
    artifactContract(kind),
    "",
    "Then fill the structured output honestly: set `oneShot` true ONLY if you got it right first-try with no guessing or doc gaps, and list every friction point in `friction`.",
  ]
    .filter(Boolean)
    .join("\n");
}

function judgePrompt(task: string, report: { artifact?: string; summary?: string }, rubric: string | null): string {
  return [
    "You are grading whether a candidate agent's artifact satisfies a Smithers task.",
    "",
    `TASK:\n${task}`,
    rubric ? `\nRUBRIC (pass criteria):\n${rubric}` : "",
    "",
    `CANDIDATE ARTIFACT:\n${report.artifact ?? "(none)"}`,
    "",
    "Decide: did it satisfy the task? Set `passed` (the hard gate), `score` (0-1 correctness), a short `reason`, set `method` to \"judge\", and list per-criterion `checks`.",
  ]
    .filter(Boolean)
    .join("\n");
}

function qualityPrompt(
  report: { artifact?: string },
  functional?: { renderedText?: string; features?: Record<string, boolean>; passed?: boolean },
): string {
  const lines = [
    "You rate a Smithers custom workflow UI bundle (React + smithers-orchestrator/gateway-react).",
    "Score 0-1 on: correct use of createGatewayReactRoot + the gateway hooks (useGatewayRun/RunEvents/NodeOutput/Approvals/Actions/Runs); handling of loading/empty/error states; scoping to the ?runId in location.search; clean component structure; sensible layout/UX and basic accessibility; and absence of obvious bugs or invented APIs.",
  ];
  if (functional) {
    lines.push(
      "",
      "This UI was ALSO booted in a real browser against a real run. The OBSERVED FEATURES below are GROUND TRUTH for what actually rendered/worked — trust them over the source. In particular, if `approvalLive` is true the UI DID mount, DID render approvals, and its Approve button DID work, so do NOT penalize for an apparently-missing createGatewayReactRoot mount or an 'unused' submitApproval — the source shown may simply be truncated past the cutoff. Judge on: did it, for every task, stream live events, render node output, surface the FAILED node, and drive a working approval — plus polish/UX/accessibility. Penalize features that are `false` in OBSERVED FEATURES.",
      `OBSERVED FEATURES (rendered/worked in the browser): ${JSON.stringify(functional.features ?? {})}`,
      `OBSERVED DOM TEXT (excerpt):\n${(functional.renderedText ?? "(none)").slice(0, 2000)}`,
    );
  }
  lines.push(
    "",
    `UI BUNDLE${functional ? " (may be truncated below — OBSERVED FEATURES above are ground truth; if approvalLive is true the UI DID mount and the mount call exists past any cutoff)" : ""}:\n${(report.artifact ?? "(none)").slice(0, functional ? 24_000 : 6_000)}`,
    "",
    "Set `score` (0-1) and a short `reason`.",
  );
  return lines.join("\n");
}

export type FluencyEvalOptions = {
  /** Stable suite id — also the eval-report filename stem. */
  suite: string;
};

/** Build a fluency-eval workflow. Returned value is the default export of a
 * suite's `eval.tsx`, run by `smithers eval`/`smithers up`. */
export function createFluencyEval(opts: FluencyEvalOptions) {
  const { Workflow, Task, Sequence, smithers, outputs } = createSmithers(
    {
      input: inputSchema,
      candidate: candidateReport,
      verdict: evalVerdict,
      quality: qualityScore,
    },
    { dbPath: EVAL_DB_PATH },
  );

  return smithers((ctx) => {
    const task = ctx.input.task ?? DEFAULT_TASK;
    const context = ctx.input.context ?? null;
    const model = ctx.input.model ?? "sonnet";
    const judgeModel = ctx.input.judgeModel ?? "opus";
    const verify = normalizeVerify(ctx.input.verify);

    const candidateAgent = resolveCandidate(model);
    const judge = resolveJudge(judgeModel);
    const report = ctx.outputMaybe("candidate", { nodeId: "candidate" }) as CandidateReport | undefined;

    // Scorers grade non-binary quality (never block the run). UI-authoring (build)
    // cases get their AI quality score from a first-class `quality` Task instead
    // (a fire-and-forget judge scorer gets dropped when the judge is slow).
    const scorers = {
      schema: { scorer: schemaAdherenceScorer() },
      oneShot: { scorer: oneShotScorer },
      friction: { scorer: frictionScorer },
      docsGap: { scorer: docsGapScorer(judge), sampling: { type: "ratio" as const, rate: 0.34 } },
    };
    const isUi = verify.kind === "build" || verify.kind === "ui-functional";
    // For ui-functional cases, feed the quality judge what actually rendered in
    // the browser (from the verify verdict), not just the source. The output KEY
    // is "verdict" (outputs.verdict); the node id is "verify".
    const verdict = ctx.outputMaybe("verdict", { nodeId: "verify" }) as
      | { renderedText?: string; features?: Record<string, boolean>; passed?: boolean }
      | undefined;
    const functionalObservations =
      verify.kind === "ui-functional" && verdict
        ? { renderedText: verdict.renderedText, features: verdict.features, passed: verdict.passed }
        : undefined;

    return (
      <Workflow name={`fluency-${opts.suite}`}>
        <Sequence>
          {/* 1 — The candidate-under-test attempts the task on a (usually weak) model. */}
          <Task
            id="candidate"
            output={outputs.candidate}
            agent={candidateAgent}
            retries={1}
            heartbeatTimeoutMs={600_000}
            scorers={scorers}
          >
            {candidatePrompt(task, context, verify.kind)}
          </Task>

          {/* 2 — Independent verification → the hard `passed` the case asserts on. */}
          {report
            ? verify.kind === "judge"
              ? (
                <Task id="verify" output={outputs.verdict} agent={judge} retries={1}>
                  {judgePrompt(task, report, verify.rubric)}
                </Task>
              )
              : (
                <Task id="verify" output={outputs.verdict}>
                  {async () => computeVerdict(verify, report)}
                </Task>
              )
            : null}

          {/* 3 — UI (build) cases: a first-class AI quality score. A judge Task
              (not a fire-and-forget scorer) so the score reliably persists;
              continueOnFail keeps a flaky judge from failing the eval. */}
          {report && isUi ? (
            <Task
              id="quality"
              output={outputs.quality}
              agent={judge}
              continueOnFail
              retries={1}
              heartbeatTimeoutMs={300_000}
            >
              {qualityPrompt(report, functionalObservations)}
            </Task>
          ) : null}
        </Sequence>
      </Workflow>
    );
  });
}
