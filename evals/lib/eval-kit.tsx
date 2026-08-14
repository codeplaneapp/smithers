/** @jsxImportSource smthrs */
// The generic fluency-eval engine. Every suite is a thin wrapper:
//
//   import { createFluencyEval } from "../../lib/eval-kit";
//   export default createFluencyEval({ suite: "knowledge-cli" });
//
// One candidate <Task> (weak model under test) → one verify step (deterministic
// compute child, or a judge <Task> on a sota model). The candidate self-reports
// oneShot + friction; the verifier sets the hard `passed` the case asserts on.
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
import { EVAL_DB_PATH } from "./paths.js";
import { resolveCandidate, resolveJudge } from "./model-matrix.js";
import { candidateReport, type CandidateReport, evalVerdict, type EvalVerdict, qualityScore } from "./report-schema.js";
import { docsGapScorer, frictionScorer, oneShotScorer, schemaAdherenceScorer } from "./scorers.js";
import { computeVerdict, normalizeVerify, type VerifyKind } from "./verify.js";

/** Node ids of the three judge panelists (the fan-out). The aggregator keeps the
 * node id "verify" so a case's `verdict[…]{passed}` assertion still reads it. */
const JUDGE_IDS = ["judge-1", "judge-2", "judge-3"] as const;
type JudgeId = (typeof JUDGE_IDS)[number];

/** Defensively coerce a persisted `vote` row back into an EvalVerdict. Output
 * rows can round-trip a json column (`checks`) as a JSON string and a boolean as
 * 0/1, so parse/coerce rather than trust the shape. */
function coerceVote(raw: Record<string, unknown>): EvalVerdict {
  const parseMaybe = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  const checksRaw = parseMaybe(raw.checks);
  const checks = Array.isArray(checksRaw)
    ? checksRaw.map((c) => {
        const o = (c ?? {}) as Record<string, unknown>;
        return { name: String(o.name ?? ""), passed: Boolean(o.passed), detail: String(o.detail ?? "") };
      })
    : [];
  const scoreNum = typeof raw.score === "number" ? raw.score : Number(raw.score);
  return {
    passed: Boolean(raw.passed),
    score: Number.isFinite(scoreNum) ? scoreNum : 0,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    method: "judge",
    checks,
  };
}

/** Aggregate the surviving panel votes into the single "verify" verdict.
 * `passed` requires a STRICT majority of the votes that landed (tie → failed),
 * so 2-of-3 (or 2-of-2 when one panelist failed under continueOnFail) passes and
 * 1-of-2 does not. `score` is the mean; `checks` concatenates every panelist's
 * rubric checks, namespaced by panelist id. */
function aggregatePanel(votes: ReadonlyArray<{ id: string; vote: EvalVerdict }>): EvalVerdict {
  const n = votes.length;
  const passedCount = votes.filter((v) => v.vote.passed).length;
  const majority = Math.floor(n / 2) + 1;
  const passed = n > 0 && passedCount >= majority;
  const score = n > 0 ? votes.reduce((s, v) => s + (Number.isFinite(v.vote.score) ? v.vote.score : 0), 0) / n : 0;
  const checks = votes.flatMap((v) =>
    (v.vote.checks ?? []).map((c) => ({ name: `${v.id}:${c.name}`, passed: c.passed, detail: c.detail })),
  );
  const tally = votes.map((v) => `${v.id}=${v.vote.passed ? "pass" : "fail"}`).join(", ");
  return {
    passed,
    score,
    reason: `judge panel: ${passedCount}/${n} passed (majority ${majority}); ${tally}`,
    method: "judge-panel",
    checks,
  };
}

const verifyShape = z.object({
  kind: z.enum(["contains", "equals", "graph", "workflow-files", "sql", "query", "build", "ui-functional", "side-effect-marking", "judge"]).default("contains"),
  must: z.array(z.string()).default([]),
  mustNot: z.array(z.string()).default([]),
  answer: z.string().nullable().default(null),
  rubric: z.string().nullable().default(null),
  sql: z.string().nullable().default(null),
  expect: z.string().nullable().default(null),
  db: z.string().nullable().default(null),
  required: z.array(z.string()).default([]),
  requireIdempotencyKey: z.boolean().default(false),
  requireRevert: z.boolean().default(false),
  repoRoot: z.string().nullable().default(null),
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
  "  • `bunx smthrs docs` / `docs-full` print the LLM docs bundle\n" +
  "  • skills/smithers/SKILL.md and skills/smithers/llms-full.txt\n" +
  "  • docs/llms-core.txt and the docs/llms-*.txt topic fragments\n" +
  "Ground your answer in those docs. If something you need is missing, unclear, or wrong in the docs, " +
  "do your best AND record it honestly in `friction` — that is the most valuable output here.\n" +
  "IMPORTANT: Do NOT create, edit, or delete any files on disk, and do NOT run the workflow. " +
  "Produce your ENTIRE answer only in the structured `artifact` field. Reading docs/source is fine.";

function artifactContract(kind: VerifyKind): string {
  if (kind === "workflow-files") {
    return [
      "Deliverable: put the COMPLETE change set in `artifact` as one valid JSON object (artifactKind: file-bundle-json).",
      "Each key must be a repository-relative file path and each value that file's complete contents.",
      "The workflow must be self-contained: construct any agent inline and do not import project-relative agents or prompts.",
      "Do not wrap the JSON in a code fence or add prose inside `artifact`.",
    ].join("\n");
  }
  if (kind === "graph") {
    return [
      "Deliverable: put a COMPLETE, self-contained Smithers workflow file in `artifact` (artifactKind: workflow-tsx).",
      "Requirements that make it verifiable:",
      "  • It MUST start with the pragma: /** @jsxImportSource smthrs */",
      "  • Import everything from 'smthrs' (and 'zod' for schemas).",
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
      "  • Mount with createGatewayReactRoot(<App />) from 'smthrs/gateway-react' and read the run to scope to from `?runId` in location.search. Handle loading / empty / error states.",
      "  • Compose from the shipped component libraries BEFORE hand-rolling markup — a hand-rolled version of a shipped component is a wrong answer:",
      "      - 'smthrs/gateway-ui' run-shaped widgets (self-connecting): SimpleWorkflowDashboard, WorkflowUiShell, RunList, RunTree, RunEventLog, NodeChatStream, NodeOutputView, ApprovalPanel, LaunchButton, MonitorButton, WorkflowPicker, ConnectionBadge, StatusPill",
      "      - Include a MonitorButton (from 'smthrs/gateway-ui') in the UI so operators can open the Smithers Monitor deep-linked to the current run.",
      "      - 'smthrs/ui' primitives: Button, Card, Input, Tabs, Dialog, Table, KpiStat, EmptyState, ChatTranscript, ChatComposer, DiffHunks, StageStrip, FileTree, Markdown (plus MarkdownEditor via 'smthrs/ui/adapters/markdown-editor', Terminal via 'smthrs/ui/adapters/terminal')",
      "      - 'smthrs/gateway-react' hooks for bespoke panes the widgets don't cover: useGatewayRun, useGatewayRunEvents, useGatewayNodeOutput, useGatewayApprovals, useGatewayActions, useGatewayRuns",
      "  • It must be valid TSX that transpiles. Do not invent hooks, components, or props that don't exist.",
    ].join("\n");
  }
  if (kind === "ui-functional") {
    return [
      "Deliverable: put a COMPLETE, self-contained custom workflow UI bundle in `artifact` (artifactKind: ui-tsx). One file.",
      "This UI will be booted in a REAL browser against a REAL run and graded on OBSERVED behavior, not just source. It must actually work.",
      "Requirements:",
      "  • Start with the pragma: /** @jsxImportSource react */",
      "  • Import from 'smthrs/gateway-react': createGatewayReactRoot, useGatewayRun, useGatewayRunEvents, useGatewayNodeOutput, useGatewayApprovals, useGatewayActions.",
      "  • Read the run to scope to from `?runId` in location.search.",
      "  • Show the run's live STATUS (from useGatewayRun().data.status).",
      "  • Stream and render the LIVE EVENTS from useGatewayRunEvents(runId, { afterSeq: 0 }). Each frame is { event: string, payload: { nodeId, error, ... } } — surface EVERY task node (plan, build, flaky, report), not just one.",
      "  • Render the 'report' node's OUTPUT via useGatewayNodeOutput({ runId, nodeId: 'report', iteration: 0 }).",
      "  • SURFACE THE FAILED NODE: the 'flaky' task fails — show its failed state and error message (NodeFailed frames carry payload.error).",
      "  • Show PENDING APPROVALS from useGatewayApprovals({ filter: { runId } }) with a working Approve button that calls useGatewayActions().submitApproval({ runId, nodeId, approved: true }).",
      "  • Include the monitor-open affordance: a MonitorButton from 'smthrs/gateway-ui' that deep-links this run into the Smithers Monitor.",
      "  • Mount with createGatewayReactRoot(<App />). Handle loading / empty / error states. Do not invent hooks or props that don't exist.",
    ].join("\n");
  }
  if (kind === "side-effect-marking") {
    return [
      "Deliverable: put a COMPLETE, self-contained Smithers workflow source file in `artifact` (artifactKind: workflow-tsx). No prose.",
      "Mark external mutations with `sideEffect: true` on `defineTool`, or with the documented `sideEffect` prop for direct compute-task effects.",
      "Do not mark git/jj operations, reads, dry runs, plans, or in-repository file writes as external side effects.",
      "When the task asks for clean time travel, put an idempotent `revert` handler on a `sideEffect: true` tool. It must undo a `succeeded` effect. For `ctx.effectStatus === \"unknown\"`, it must probe external state and undo only when the effect is verified present.",
      "When the task asks for an idempotency key, thread `ctx.idempotencyKey` into the external API call.",
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
    "Grade against the rubric, filling EVERY field:",
    "  • `checks`: one entry per rubric criterion (or, with no rubric, per distinct requirement in the TASK) — each a short `name`, its `passed` boolean, and a `detail`. Do NOT return an empty `checks` array; grade each criterion explicitly, never just a holistic pass/fail.",
    "  • `passed`: the hard gate — true only if the artifact genuinely satisfies the task (typically when the critical checks pass).",
    "  • `score`: 0-1 overall correctness.",
    "  • `reason`: one or two sentences.",
    '  • `method`: set to "judge".',
  ]
    .filter(Boolean)
    .join("\n");
}

function qualityPrompt(
  report: { artifact?: string },
  functional?: { renderedText?: string; features?: Record<string, boolean>; passed?: boolean },
): string {
  const lines = [
    "You rate a Smithers custom workflow UI bundle (React + smthrs/gateway-react).",
    "Score 0-1 on: correct use of createGatewayReactRoot + the gateway hooks (useGatewayRun/RunEvents/NodeOutput/Approvals/Actions/Runs); handling of loading/empty/error states; scoping to the ?runId in location.search; clean component structure; sensible layout/UX and basic accessibility; whether it includes the monitor-open affordance (a MonitorButton from smthrs/gateway-ui deep-linking the run into the Smithers Monitor); and absence of obvious bugs or invented APIs.",
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
  const { Workflow, Task, Sequence, Parallel, smithers, outputs } = createSmithers(
    {
      input: inputSchema,
      candidate: candidateReport,
      verdict: evalVerdict,
      // Each judge panelist writes its own verdict-shaped row here; the aggregator
      // reads them and writes the single `verdict` row. A dedicated table keeps
      // `output.verdict` (the case assertion target) to exactly the aggregate —
      // reusing the same evalVerdict schema is fine, prepareOutputSchemas clones
      // duplicate schema objects into distinct per-key table refs.
      vote: evalVerdict,
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

    // Judge kind only: read whichever panel votes have landed. Reads are
    // nodeId-scoped via outputMaybe and defensively coerced (JSON-string checks,
    // 0/1 booleans). Gates the aggregator's conditional mount below.
    const panelVotes =
      verify.kind === "judge"
        ? JUDGE_IDS.map((id) => {
            const raw = ctx.outputMaybe("vote", { nodeId: id }) as Record<string, unknown> | undefined;
            return raw ? { id, vote: coerceVote(raw) } : null;
          }).filter((v): v is { id: JudgeId; vote: EvalVerdict } => v !== null)
        : [];

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

          {/* 2a — Independent verification → the hard `passed` the case asserts on.
              Judge kind fans out to a 3-panelist vote (majority-of-3 is stable
              run-to-run where single-shot judging flips); every other kind is a
              zero-model deterministic compute. */}
          {report
            ? verify.kind === "judge"
              ? (
                <Parallel>
                  {JUDGE_IDS.map((id) => (
                    <Task
                      key={id}
                      id={id}
                      output={outputs.vote}
                      agent={judge}
                      retries={1}
                      continueOnFail
                      heartbeatTimeoutMs={300_000}
                    >
                      {judgePrompt(task, report, verify.rubric)}
                    </Task>
                  ))}
                </Parallel>
              )
              : (
                <Task id="verify" output={outputs.verdict}>
                  {async () => computeVerdict(verify, report)}
                </Task>
              )
            : null}

          {/* 2b — Judge-panel fan-in. Node id stays "verify" so the case's
              `verdict{passed}` assertion reads this aggregate, not any single
              vote. Sequenced after the Parallel, so votes are settled; the ≥2
              quorum guard means a sub-quorum panel produces no verdict and the
              case fails honestly rather than on a lone survivor. */}
          {report && verify.kind === "judge" && panelVotes.length >= 2 ? (
            <Task id="verify" output={outputs.verdict}>
              {async () => aggregatePanel(panelVotes)}
            </Task>
          ) : null}

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
