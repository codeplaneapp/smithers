/** @jsxImportSource smithers-orchestrator */
/**
 * SWE-EVO benchmark workflow — orchestration variant.
 *
 * This is the "show what Smithers orchestration buys you" version of the
 * benchmark. The baseline (swe-evo.tsx) is a flat two-agent pass: Opus drafts,
 * Codex refines. This variant replaces that middle with two standard-library
 * orchestration components so the SWE-EVO score measures how much real
 * multi-agent structure lifts a weak single-pass loop:
 *
 *   prepare    (compute)   materialize repo@base_commit from the image
 *   plan       (<Panel>)   3 planners draft independent plans in parallel
 *                          (Opus + Codex + Gemini); an Opus moderator
 *                          synthesizes them into one consolidated plan
 *   implement  (<ReviewLoop>) Codex 5.5 implements against the plan; Opus +
 *                          Gemini review against the spec; loop until approved
 *   diff       (compute)   capture the combined edits as a unified patch
 *   score      (compute)   run the hermetic Docker harness -> Resolved + Fix Rate
 *
 * Per the benchmark's intent: durability/resume is NOT the point here, the
 * orchestration is. Tasks carry no retry/heartbeat durability tuning; a transient
 * provider failure surfaces honestly and the runner records it (rerun the
 * instance to retry) rather than being masked by durability machinery.
 *
 * Fairness is unchanged from the baseline: every agent sees ONLY the release
 * spec and the repo, never the hidden tests or the gold patch. The reviewers'
 * spec is injected via the agent systemPrompt because <ReviewLoop> owns the
 * reviewer's user-prompt.
 */

import { createSmithers } from "smithers-orchestrator";
// In-repo, "smithers-orchestrator" resolves to a limited examples entry that does
// not re-export the composite components; import them from the components package
// directly (end-user code can `import { Panel, ReviewLoop } from "smithers-orchestrator"`).
import { Panel, ReviewLoop } from "@smithers-orchestrator/components";
import { AntigravityAgent, ClaudeCodeAgent, CodexAgent } from "@smithers-orchestrator/agents";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod/v4";
import {
  captureDiff,
  loadInstance,
  prepareRepo,
  scoreCandidate,
  workdirFor,
  type Instance,
} from "./harness";

const AGENT_TIMEOUT_MS = Number(process.env.SWEEVO_AGENT_TIMEOUT_MS ?? 1_800_000);
const HEARTBEAT_MS = Number(process.env.SWEEVO_HEARTBEAT_MS ?? 900_000);
const SCORE_TIMEOUT_S = Number(process.env.SWEEVO_SCORE_TIMEOUT_S ?? 1800);
const IMPL_MAX_ITERS = Number(process.env.SWEEVO_REVIEW_ITERS ?? 3);
// Gemini rides the `agy` (Antigravity) CLI. Default it on (the panel/review want
// it), but allow SWEEVO_GEMINI=0 to drop it on boxes without `agy` installed.
const INCLUDE_GEMINI = process.env.SWEEVO_GEMINI !== "0";

const summaryShape = z.object({
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
});

export const schemas = {
  prepare: z.object({
    workdir: z.string(),
    baseCommit: z.string(),
    headLine: z.string(),
  }),
  plan: z.object({
    approach: z.string().default(""),
    steps: z.array(z.string()).default([]),
    filesToChange: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
  }),
  planSynthesis: z.object({
    plan: z.string().default(""),
    steps: z.array(z.string()).default([]),
  }),
  implement: summaryShape,
  review: z.object({
    approved: z.boolean().default(false),
    feedback: z.string().default(""),
    blockingIssues: z.array(z.string()).default([]),
  }),
  diff: z.object({
    patch: z.string(),
    changedFiles: z.number(),
    insertions: z.number(),
    deletions: z.number(),
  }),
  // smithers maps z.number() output fields to INTEGER columns, so every numeric
  // field here is an integer. Fix Rate is a fraction, so its exact components
  // are kept (f2p_passed / f2p_total + all_p2p_pass) plus a rounded pct.
  score: z.object({
    instance_id: z.string(),
    repo: z.string().default(""),
    image: z.string().default(""),
    log_parser: z.string().default(""),
    test_cmds: z.string().default(""),
    resolved: z.number(),
    fix_rate_pct: z.number(),
    f2p_total: z.number(),
    f2p_passed: z.number(),
    p2p_total: z.number(),
    p2p_passed: z.number(),
    all_p2p_pass: z.boolean(),
    candidate_applied: z.boolean(),
    testpatch_applied: z.boolean(),
    timed_out: z.boolean(),
    duration_s: z.number(),
    parsed_test_count: z.number(),
    f2p_status: z.record(z.string(), z.string()).default({}),
    p2p_failures: z.record(z.string(), z.string()).default({}),
  }),
};

/** Map the harness ScoreResult to the integer-safe output row. */
function toScoreRow(r: import("./harness").ScoreResult) {
  return {
    instance_id: r.instance_id,
    repo: r.repo,
    image: r.image,
    log_parser: r.log_parser,
    test_cmds: r.test_cmds,
    resolved: r.resolved,
    fix_rate_pct: Math.round(r.fix_rate * 100),
    f2p_total: r.f2p_total,
    f2p_passed: r.f2p_passed,
    p2p_total: r.p2p_total,
    p2p_passed: r.p2p_passed,
    all_p2p_pass: r.all_p2p_pass,
    candidate_applied: r.candidate_applied,
    testpatch_applied: r.testpatch_applied,
    timed_out: r.timed_out,
    duration_s: Math.round(r.duration_s),
    parsed_test_count: r.parsed_test_count,
    f2p_status: r.f2p_status,
    p2p_failures: r.p2p_failures,
  };
}

const RULES = `Rules:
- Implement the described behavior with minimal, correct, idiomatic changes that
  match the existing code style and conventions of this project.
- Make the change complete and self-consistent across ALL affected source files.
- Do NOT add, modify, or delete any test files (paths containing tests/ or named
  test_*.py / *_test.py). Work is validated by a hidden test suite; editing tests
  cannot help and will be discarded.
- Do not bump version numbers or edit changelog/release-note files unless the
  behavior described literally requires it.
- Prefer fixing root causes over special-casing. Do not leave TODOs.`;

function specSection(instance: Instance): string {
  return `Repository: \`${instance.repo}\`, checked out at the PREVIOUS release
(\`${instance.start_version ?? instance.base_commit}\`, commit ${instance.base_commit}).

==================== RELEASE SPECIFICATION (${instance.end_version ?? "next release"}) ====================
${instance.problem_statement}
====================================================================================`;
}

/** Children sent to every panelist: produce a plan, do not touch files. */
function planPrompt(instance: Instance): string {
  return `You are producing an IMPLEMENTATION PLAN to evolve this codebase to the
next release. PLANNING ONLY — do not modify, create, or delete any files.

${specSection(instance)}

Explore the repository read-only to ground your plan in the real modules,
functions, and call sites involved. Then produce:
- approach: the overall strategy in a few sentences.
- steps: a concrete ordered list of edits.
- filesToChange: the specific source files you expect to modify.
- risks: edge cases or cross-file consistency hazards to watch for.

Be specific and reference real symbols/paths. ${RULES}`;
}

/** systemPrompt for the Codex implementer — keeps the spec in context every turn. */
function implementSystemPrompt(instance: Instance): string {
  return `You are evolving the \`${instance.repo}\` codebase to its next release.
Apply edits directly to the files in the working directory.

${specSection(instance)}

${RULES}`;
}

/** systemPrompt for reviewers — <ReviewLoop> owns their user prompt, so the spec
 *  and the approval rubric live here. */
function reviewSystemPrompt(instance: Instance): string {
  return `You are an exacting reviewer judging an in-progress implementation in the
\`${instance.repo}\` codebase. Run \`git diff\` to see the current uncommitted
changes in the working directory and judge them against the release spec below.

${specSection(instance)}

Set \`approved: true\` ONLY if the changes fully and correctly realize the spec's
behavior across all affected files, with no missing cases or bugs. Otherwise set
\`approved: false\`, put each must-fix problem in \`blockingIssues\`, and write
actionable \`feedback\` the implementer can act on. Do not edit files yourself —
your job is the verdict. Do not approve partial or speculative work.`;
}

export function createSweEvoPanel(opts: { dbPath?: string } = {}) {
  const dbPath = opts.dbPath ?? "./swe-evo-panel.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  const api = createSmithers(schemas, { dbPath });
  const { smithers, Workflow, Task, Sequence, outputs } = api as any;

  const claudeModel = process.env.SWEEVO_CLAUDE_MODEL ?? "opus";
  const codexModel = process.env.SWEEVO_CODEX_MODEL ?? "gpt-5.5";
  const geminiModel = process.env.SWEEVO_GEMINI_MODEL ?? "gemini-3.1-pro-preview";

  const workflow = smithers((ctx: any) => {
    const instance = ctx.input as Instance;
    const workdir = workdirFor(instance.instance_id);

    // --- agents (distinct instances: planners are read-only, implementer and
    //     reviewers carry their role's systemPrompt) ---
    const planSys =
      "You produce implementation plans only. Never modify, create, or delete files.";

    const opusPlanner = new ClaudeCodeAgent({
      cwd: workdir,
      model: claudeModel,
      systemPrompt: planSys,
      dangerouslySkipPermissions: true,
      timeoutMs: AGENT_TIMEOUT_MS,
      maxOutputBytes: 8_000_000,
    });
    const codexPlanner = new CodexAgent({
      cwd: workdir,
      model: codexModel,
      systemPrompt: planSys,
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      timeoutMs: AGENT_TIMEOUT_MS,
      maxOutputBytes: 8_000_000,
    });
    const geminiPlanner = new AntigravityAgent({
      cwd: workdir,
      model: geminiModel,
      systemPrompt: planSys,
      dangerouslySkipPermissions: true,
      timeoutMs: AGENT_TIMEOUT_MS,
      maxOutputBytes: 8_000_000,
    });

    const moderator = new ClaudeCodeAgent({
      cwd: workdir,
      model: claudeModel,
      systemPrompt:
        "You merge several implementation plans into one strongest consolidated plan. " +
        "Reconcile disagreements, keep the best concrete steps, drop redundancy. Output plan + ordered steps.",
      dangerouslySkipPermissions: true,
      timeoutMs: AGENT_TIMEOUT_MS,
      maxOutputBytes: 8_000_000,
    });

    // Codex 5.5 implements (user requirement).
    const codexImplementer = new CodexAgent({
      cwd: workdir,
      model: codexModel,
      systemPrompt: implementSystemPrompt(instance),
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      timeoutMs: AGENT_TIMEOUT_MS,
      maxOutputBytes: 8_000_000,
    });

    const opusReviewer = new ClaudeCodeAgent({
      cwd: workdir,
      model: claudeModel,
      systemPrompt: reviewSystemPrompt(instance),
      dangerouslySkipPermissions: true,
      timeoutMs: AGENT_TIMEOUT_MS,
      maxOutputBytes: 8_000_000,
    });
    const geminiReviewer = new AntigravityAgent({
      cwd: workdir,
      model: geminiModel,
      systemPrompt: reviewSystemPrompt(instance),
      dangerouslySkipPermissions: true,
      timeoutMs: AGENT_TIMEOUT_MS,
      maxOutputBytes: 8_000_000,
    });

    // Every panelist gets the IDENTICAL plan prompt + system prompt; the only
    // thing that varies is the model. `role` is a task-id / display label that
    // never reaches the model, so it names the model, not a fake specialty.
    const panelists = [
      { agent: opusPlanner, role: "panel-opus" },
      { agent: codexPlanner, role: "panel-codex" },
      ...(INCLUDE_GEMINI ? [{ agent: geminiPlanner, role: "panel-gemini" }] : []),
    ];
    const reviewers = INCLUDE_GEMINI ? [opusReviewer, geminiReviewer] : [opusReviewer];

    // --- wire the synthesized plan + latest review feedback into the implementer
    //     prompt each render (ReviewLoop re-runs produce with the current prompt) ---
    const synth = ctx.outputMaybe("planSynthesis", { nodeId: "plan-moderator" });
    const reviews: any[] = ctx.outputs.review ?? [];
    const lastReview = reviews[reviews.length - 1];
    const feedback =
      lastReview && lastReview.approved === false
        ? `A reviewer REJECTED the previous attempt. Address every point:\n${lastReview.feedback}${
            lastReview.blockingIssues?.length
              ? "\n\nBlocking issues:\n" +
                lastReview.blockingIssues.map((b: string) => `- ${b}`).join("\n")
              : ""
          }`
        : null;

    const producerPrompt = [
      "Implement the release specification (in your system prompt) by following this consolidated plan.",
      synth
        ? `CONSOLIDATED PLAN:\n${synth.plan}\n\nSteps:\n${(synth.steps ?? [])
            .map((s: string, i: number) => `${i + 1}. ${s}`)
            .join("\n")}`
        : "No synthesized plan is available yet; implement the spec directly.",
      feedback,
      "Apply your edits directly to the files in the working directory. When finished, report a short summary and the list of source files you changed.",
    ]
      .filter(Boolean)
      .join("\n\n---\n");

    return (
      <Workflow name="swe-evo-panel">
        <Sequence>
          <Task id="prepare" output={outputs.prepare}>
            {() => prepareRepo(instance)}
          </Task>

          <Panel
            id="plan"
            panelists={panelists}
            moderator={moderator}
            panelistOutput={outputs.plan}
            moderatorOutput={outputs.planSynthesis}
            strategy="synthesize"
            maxConcurrency={3}
          >
            {planPrompt(instance)}
          </Panel>

          <ReviewLoop
            id="impl"
            producer={codexImplementer}
            reviewer={reviewers}
            produceOutput={outputs.implement}
            reviewOutput={outputs.review}
            maxIterations={IMPL_MAX_ITERS}
            onMaxReached="return-last"
          >
            {producerPrompt}
          </ReviewLoop>

          <Task id="diff" output={outputs.diff}>
            {() => captureDiff(instance)}
          </Task>
          <Task id="score" output={outputs.score}>
            {() => {
              // The run input carries no gold fields (see run.ts:toRunInput), so
              // reload the full instance (gold patch + hidden tests) from disk for
              // the authoritative score. captureDiff only needs the workdir.
              const inst = loadInstance(instance.instance_id);
              const patch = captureDiff(instance).patch;
              try {
                return toScoreRow(scoreCandidate(inst, patch, SCORE_TIMEOUT_S));
              } catch (e) {
                // Scoring can fail when the instance's Docker image is not
                // reproducible under emulation on this host (arch / host-network
                // dependence). The candidate diff is already captured by the diff
                // node, so don't crash the run: record a zero sentinel and re-score
                // this instance on native x86 (see score-x86.ts). The showcase
                // treats x86 scores as authoritative for the x86 set.
                process.stderr.write(
                  `[score] ${inst.instance_id} not scoreable on this host (${String((e as Error)?.message ?? e).slice(0, 120)}); diff captured for x86 re-score\n`,
                );
                return toScoreRow({
                  instance_id: inst.instance_id,
                  repo: (inst as any).repo ?? "",
                  image: (inst as any).image ?? "",
                  log_parser: (inst as any).log_parser ?? "",
                  test_cmds: (inst as any).test_cmds ?? "",
                  resolved: 0,
                  fix_rate: 0,
                  f2p_total: 0,
                  f2p_passed: 0,
                  p2p_total: 0,
                  p2p_passed: 0,
                  all_p2p_pass: false,
                  candidate_applied: false,
                  testpatch_applied: false,
                  timed_out: false,
                  duration_s: 0,
                  parsed_test_count: 0,
                  f2p_status: {},
                  p2p_failures: {},
                } as import("./harness").ScoreResult);
              }
            }}
          </Task>
        </Sequence>
      </Workflow>
    );
  });

  return { ...api, workflow };
}
