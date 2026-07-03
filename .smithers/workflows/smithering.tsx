// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Smithering
// smithers-description: Fable routes a request by size — trivial work goes straight to sonnet, complex work to codex /goal, and big builds through the full orchestration: setup interview, brainstorm, grill, PRD, design, eng doc, assumption probes, tickets, then a generated+validated+launched implementation workflow, monitored, reviewed, polished, and delivered with an evidence report.
// smithers-tags: planning, coding, orchestration, meta, routing
//
// ─────────────────────────────────────────────────────────────────────────────
// SMITHERING — the "Fable replaces the human operator" meta-workflow.
//
// The human never runs CLI commands: they ask their operating agent, and the agent runs
// smithers on their behalf — including answering this workflow's HumanTasks and clearing
// its approval gates after talking to the human.
//
// ROUTER: not every request deserves the full pipeline. After setup, the request is
// classified (or forced via setup.route) into one of three tiers:
//   trivial    → direct:trivial   — sonnet just does it (verified, evidenced, reported)
//   complex    → direct:complex   — codex xhigh drives it autonomously via /goal
//   full-build → the entire pipeline below
//
// Source plan: the fable-smithers orchestration plan ("PROMPT.md" in the step
// references below). Step → node map (full-build tier):
//   step -1 setup interview         → setup                  (HumanTask when no prompt input)
//   step -0.5 routing               → route                  (skipped when setup.route forces a tier)
//   step 0  preflight + intake      → preflight, intake
//   step 1  brainstorm              → brainstorm
//   step 2  research + questions    → research:domain, research:prior-art, questions, answers
//   step 3  PRD + interfaces        → prd, gate:prd
//   step 4  design doc              → research:design-art, design:loop{design:draft, design:review}, design:final
//   step 5  eng doc                 → research:eng-deps, research:eng-oss, eng:loop{eng:doc, eng:review}, gate:eng
//   step 5.5 backpressure matrix    → backpressure           (criterion → gate traceability)
//   step 6  3rd-party probes        → probe:<id>…, probe:synthesis, gate:probes (stop rule)
//   step 7  ticket breakdown        → tickets
//   step 8  optional POC            → poc                    (setup.poc)
//   step 9  orchestration script    → orch:design, wf:scaffold
//   step 9.5 validate before launch → wf:verify-loop, wf:review, wf:fix-blocking, wf:reverify, wf:smoke-loop
//   step 10 launch + monitor        → gate:launch, launch, monitor:loop{tick, poll, report, triage}
//   step 11 review                  → review:fable, review:codex, review:fast, review:synthesis
//   step 12 polish & fix            → polish (ScanFixVerify)
//   step 13 report + delivery       → report:gather, report:final, gate:delivery, delivery
//
// Prompts live in ../prompts/smithering-*.mdx (shared fragments: -rules, -over-test,
// -decision-docs). Artifact paths are mirrored between this file's constants and the
// prompt files — change both together.
//
// Division of labor (primary duties; supporting tasks follow the same tiers):
//   fable        — judgment & synthesis: brainstorm, questions, PRD, architecture/eng
//                  doc, backpressure matrix, tickets, orchestration design, triage, review, final report.
//   fableBuilder — same brain, builder leash: authors/fixes the generated workflow, polish fixes, delivery.
//   codexXhigh   — cross-vendor adversarial reviewer (eng doc, generated workflow, final review).
//   codexBuilder — codex xhigh with write access: owns the complex direct tier (/goal).
//                  Rule: the eng doc, the generated workflow, and the final build are never
//                  approved solely by their author's model family. (The design doc reviewer
//                  is deliberately fable — taste judgment stays with the orchestrator, per
//                  PROMPT.md step 4.)
//   sonnet       — cheap tier: routing, the trivial direct tier, research fan-out,
//                  design-doc drafting, probes, progress reports, trivial review.
//
// Human interaction map (every gate is surfaced to the human BY the operating agent;
// all of it is skippable with setup.review=false → fully autonomous):
//   setup           interview when the run starts without a product request
//   answers         clarifying product questions (HumanTask; auto-adopts recommendations when autonomous)
//   gate:prd        PRD + interface mockups            (deny ⇒ graceful cancel)
//   gate:eng        eng doc + architecture             (deny ⇒ graceful cancel)
//   gate:probes     only when a BLOCKING probe failed  (stop rule; deny ⇒ graceful cancel)
//   gate:launch     before the expensive build run     (deny ⇒ graceful cancel)
//   gate:incomplete build ended unhealthy — proceed?   (deny ⇒ report as incomplete)
//   gate:delivery   accept final report → open PR      (deny ⇒ report stands, no PR)
//   This workflow NEVER merges to the base branch. Delivery = branch + PR only.
//   The direct tiers are deliberately gate-free — low ceremony is their point; they still
//   verify, evidence, and write a finalReport row.
//
// Spend control: the router sends small work to cheap paths; every loop has
// maxIterations; the monitor is bounded by setup.maxMonitorHours; validation (graph
// render → cross-model review → smoke) runs before the expensive launch; and gate:launch
// is the human cost checkpoint. There is no automatic run-level cost budget: Aspects
// budgets are unenforced in smithers 0.23.0 (filed as smithersai/smithers#265).
//
// Operating agent runs (the human just asks for the outcome):
//   bunx smithers-orchestrator workflow run smithering --prompt "build X"   # or no prompt → setup interview
//   bunx smithers-orchestrator ps / inspect RUN_ID / why RUN_ID
//   bunx smithers-orchestrator approve RUN_ID --node gate:prd --by <human>   # after asking the human
//   bunx smithers-orchestrator human inbox / human answer <id> --value '<json>'
//
// Known limitations (deliberate v1 tradeoffs):
//   - The generated implementation workflow lands at a fixed path, so one product build
//     per repo at a time.
//   - Review-panel tasks are continueOnFail with a 2-of-3 quorum: if two reviewers die past
//     their retries the run can finish early WITHOUT a final report (a failed-out task
//     leaves no output row) — recover with `smithers retry-task`.
//   - research → questions → answers is a single pass; answers do not trigger a second
//     research round.
//   - In autonomous mode (review=false) a monitor escalation flows straight into review of
//     a possibly-broken build; the escalation reason survives in monitor:triage output.
// ─────────────────────────────────────────────────────────────────────────────
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import {
  ClaudeCodeAgent,
  CodexAgent,
  HumanTask,
  ScanFixVerify,
  createSmithers,
} from "smithers-orchestrator";
import { z } from "zod/v4";

import Rules from "../prompts/smithering-rules.mdx";
import OverTest from "../prompts/smithering-over-test.mdx";
import DecisionDocs from "../prompts/smithering-decision-docs.mdx";
import SetupPrompt from "../prompts/smithering-setup.mdx";
import RoutePrompt from "../prompts/smithering-route.mdx";
import DirectTrivialPrompt from "../prompts/smithering-direct-trivial.mdx";
import DirectComplexPrompt from "../prompts/smithering-direct-complex.mdx";
import IntakePrompt from "../prompts/smithering-intake.mdx";
import BrainstormPrompt from "../prompts/smithering-brainstorm.mdx";
import ResearchDomainPrompt from "../prompts/smithering-research-domain.mdx";
import ResearchPriorArtPrompt from "../prompts/smithering-research-prior-art.mdx";
import QuestionsPrompt from "../prompts/smithering-questions.mdx";
import AnswersPrompt from "../prompts/smithering-answers.mdx";
import PrdPrompt from "../prompts/smithering-prd.mdx";
import ResearchDesignArtPrompt from "../prompts/smithering-research-design-art.mdx";
import DesignDraftPrompt from "../prompts/smithering-design-draft.mdx";
import DesignReviewPrompt from "../prompts/smithering-design-review.mdx";
import DesignFinalPrompt from "../prompts/smithering-design-final.mdx";
import ResearchEngDepsPrompt from "../prompts/smithering-research-eng-deps.mdx";
import ResearchEngOssPrompt from "../prompts/smithering-research-eng-oss.mdx";
import EngDocPrompt from "../prompts/smithering-eng-doc.mdx";
import EngReviewPrompt from "../prompts/smithering-eng-review.mdx";
import BackpressurePrompt from "../prompts/smithering-backpressure.mdx";
import ProbePrompt from "../prompts/smithering-probe.mdx";
import ProbeSynthesisPrompt from "../prompts/smithering-probe-synthesis.mdx";
import TicketsPrompt from "../prompts/smithering-tickets.mdx";
import PocPrompt from "../prompts/smithering-poc.mdx";
import OrchDesignPrompt from "../prompts/smithering-orch-design.mdx";
import ScaffoldPrompt from "../prompts/smithering-scaffold.mdx";
import WfFixPrompt from "../prompts/smithering-wf-fix.mdx";
import WfReviewPrompt from "../prompts/smithering-wf-review.mdx";
import WfFixBlockingPrompt from "../prompts/smithering-wf-fix-blocking.mdx";
import SmokeFixPrompt from "../prompts/smithering-smoke-fix.mdx";
import MonitorReportPrompt from "../prompts/smithering-monitor-report.mdx";
import MonitorTriagePrompt from "../prompts/smithering-monitor-triage.mdx";
import ReviewFablePrompt from "../prompts/smithering-review-fable.mdx";
import ReviewCodexPrompt from "../prompts/smithering-review-codex.mdx";
import ReviewFastPrompt from "../prompts/smithering-review-fast.mdx";
import ReviewSynthesisPrompt from "../prompts/smithering-review-synthesis.mdx";
import PolishScanPrompt from "../prompts/smithering-polish-scan.mdx";
import ReportFinalPrompt from "../prompts/smithering-report-final.mdx";
import DeliveryPrompt from "../prompts/smithering-delivery.mdx";

// ─── Paths (mirrored in the prompt files — change both together) ─────────────
const ART = "artifacts/smithering";
const PLANNING = "docs/planning";
const IMPL_WORKFLOW = ".smithers/workflows/smithering-impl.tsx";

// ─── Model roster (the "use fable" part) ─────────────────────────────────────
const FABLE_MODEL = "claude-fable-5";
const FAST_MODEL = "claude-sonnet-5";
const CODEX_MODEL = "gpt-5.5";

// Orchestrator-grade judgment. Default yolo (skip permission prompts) is intentional:
// this workflow runs unattended; blast radius is bounded by gates and the
// no-merge-to-base-branch rule instead.
const fable = new ClaudeCodeAgent({
  model: FABLE_MODEL,
  cwd: process.cwd(),
  timeoutMs: 30 * 60_000,
});

// Same brain, builder duties: writes many files, runs commands, longer leash.
const fableBuilder = new ClaudeCodeAgent({
  model: FABLE_MODEL,
  cwd: process.cwd(),
  timeoutMs: 60 * 60_000,
});

// Cross-vendor adversarial reviewer ("codex xhigh"). Read-only sandbox: it judges, it
// does not touch the tree.
const codexXhigh = new CodexAgent({
  model: CODEX_MODEL,
  config: { model_reasoning_effort: "xhigh" },
  sandbox: "read-only",
  yolo: false,
  skipGitRepoCheck: true,
  cwd: process.cwd(),
  timeoutMs: 30 * 60_000,
});

// Codex xhigh with write access: owns the complex direct tier (/goal).
const codexBuilder = new CodexAgent({
  model: CODEX_MODEL,
  config: { model_reasoning_effort: "xhigh" },
  sandbox: "workspace-write",
  yolo: false,
  skipGitRepoCheck: true,
  cwd: process.cwd(),
  timeoutMs: 90 * 60_000,
});

// Cross-vendor verifier that may run commands (tests) during polish.
const codexVerifier = new CodexAgent({
  model: CODEX_MODEL,
  config: { model_reasoning_effort: "high" },
  sandbox: "workspace-write",
  yolo: false,
  skipGitRepoCheck: true,
  cwd: process.cwd(),
  timeoutMs: 30 * 60_000,
});

// Cheap-fast tier: the trivial direct tier, drafts, research, probes, and reports.
const sonnet = new ClaudeCodeAgent({
  model: FAST_MODEL,
  cwd: process.cwd(),
  timeoutMs: 20 * 60_000,
});

// ─── Compute-task implementations (named, testable, no inline lambdas) ───────

async function runPreflight() {
  const notes: string[] = [];
  const jj = await $`jj --version`.nothrow().quiet();
  const git = await $`git --version`.nothrow().quiet();
  const vcs = jj.exitCode === 0 ? "jj" : git.exitCode === 0 ? "git" : "none";
  if (vcs === "git")
    notes.push(
      "jj not found: attempt-level revert/time-travel will be unavailable (git-only mode).",
    );
  const doctor = await $`bunx smithers-orchestrator workflow doctor`.nothrow().quiet();
  if (doctor.exitCode !== 0)
    notes.push(`workflow doctor failed: ${(doctor.stderr?.toString() ?? "").slice(0, 1500)}`);
  await $`mkdir -p ${ART}/research ${ART}/mockups ${ART}/probes ${ART}/reports ${ART}/decisions ${PLANNING}`
    .nothrow()
    .quiet();
  return { ok: vcs !== "none" && doctor.exitCode === 0, vcs, notes };
}

async function checkImplGraph(passNote: string, failNote: string) {
  const command = `bunx smithers-orchestrator graph ${IMPL_WORKFLOW}`;
  const res = await $`bunx smithers-orchestrator graph ${IMPL_WORKFLOW}`.nothrow().quiet();
  const passed = res.exitCode === 0;
  const errText = `${res.stderr?.toString() ?? ""}\n${res.stdout?.toString() ?? ""}`.trim();
  return {
    passed,
    command,
    errors: passed ? [] : [errText.slice(0, 6000)],
    notes: passed ? passNote : failNote,
  };
}

// A crash-retry of the same attempt can hit RUN_ALREADY_EXISTS for a child it already
// created; falling back to resume --force picks that child back up instead of dead-ending.
async function runSmokeAttempt(smokeRunId: string) {
  let res = await $`bunx smithers-orchestrator up ${IMPL_WORKFLOW} --run-id ${smokeRunId} --input ${JSON.stringify({ smoke: true })}`
    .nothrow()
    .quiet();
  let tail = `${res.stderr?.toString() ?? ""}\n${res.stdout?.toString() ?? ""}`.trim();
  if (res.exitCode !== 0 && /ALREADY[_ ]?EXISTS/i.test(tail)) {
    res = await $`bunx smithers-orchestrator up ${IMPL_WORKFLOW} --run-id ${smokeRunId} --resume true --force`
      .nothrow()
      .quiet();
    tail = `${res.stderr?.toString() ?? ""}\n${res.stdout?.toString() ?? ""}`.trim();
  }
  const passed = res.exitCode === 0;
  return {
    passed,
    childRunId: smokeRunId,
    summary: passed
      ? "Smoke run finished: first ticket implemented + verified end-to-end."
      : `Smoke run failed (exit ${res.exitCode}).`,
    errors: passed ? [] : [tail.slice(-4000)],
  };
}

async function launchImplementationRun(implRunId: string) {
  let res = await $`bunx smithers-orchestrator up ${IMPL_WORKFLOW} --run-id ${implRunId} --input ${JSON.stringify({ smoke: false })} --detach`
    .nothrow()
    .quiet();
  let tail = `${res.stdout?.toString() ?? ""}\n${res.stderr?.toString() ?? ""}`.trim();
  if (res.exitCode !== 0 && /ALREADY[_ ]?EXISTS/i.test(tail)) {
    res = await $`bunx smithers-orchestrator up ${IMPL_WORKFLOW} --run-id ${implRunId} --resume true --force --detach`
      .nothrow()
      .quiet();
    tail = `${res.stdout?.toString() ?? ""}\n${res.stderr?.toString() ?? ""}`.trim();
  }
  return {
    launched: res.exitCode === 0,
    childRunId: res.exitCode === 0 ? implRunId : null,
    detail: tail.slice(-2000),
  };
}

async function pollImplementationRun(implRunId: string) {
  const res = await $`bunx smithers-orchestrator inspect ${implRunId} --format json --full-output`
    .nothrow()
    .quiet();
  const raw = res.stdout?.toString() ?? "";
  let status = "unknown";
  let runState = "unknown";
  try {
    const j: any = JSON.parse(raw);
    status = j?.run?.status ?? j?.status ?? "unknown";
    // runState is the derived liveness view ("stale"/"orphaned" when the owner's
    // heartbeat expired) — inspect emits NO raw heartbeat field.
    runState = j?.runState?.state ?? status;
  } catch {
    const m = raw.match(/status[":\s]+([a-z-]+)/i);
    if (m) status = m[1];
  }
  const terminal = ["finished", "failed", "cancelled", "continued"].includes(status);
  const stale = runState === "stale" || runState === "orphaned";
  let resumed = false;
  if (stale) {
    // supervise-in-miniature: the owner process died; pick the run back up.
    const r = await $`bunx smithers-orchestrator up ${IMPL_WORKFLOW} --run-id ${implRunId} --resume true --force --detach`
      .nothrow()
      .quiet();
    resumed = r.exitCode === 0;
  }
  const needsAttention =
    (stale && !resumed) || status === "waiting-approval" || status === "failed";
  return { status, terminal, needsAttention, resumed, detail: raw.slice(0, 4000) };
}

async function gatherReportInputs(implRunId: string) {
  const run = await $`bunx smithers-orchestrator inspect ${implRunId} --format json`
    .nothrow()
    .quiet();
  const files = await $`find ${ART} ${PLANNING} -type f | sort`.nothrow().quiet();
  const fileList = (files.stdout?.toString() ?? "").split("\n").filter(Boolean);
  return {
    runInfo: (run.stdout?.toString() ?? "").slice(0, 50_000),
    artifactIndex: fileList.slice(0, 500),
    summary: `Gathered run state for ${implRunId} and ${fileList.length} artifacts.`,
  };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────
// House style: looseObject + defaults so a slightly-off agent reply degrades instead of
// hard-failing, and every schema stays minimal — a summary plus the fields downstream
// steps actually read. Artifacts on disk are the full record; outputs are the index.

// Every input is optional: when `prompt` is missing the setup HumanTask collects the
// configuration interactively (via the operating agent) before anything else runs.
const inputSchema = z.looseObject({
  prompt: z.string().nullable().default(null),
  repo: z.string().nullable().default(null),
  route: z.enum(["auto", "trivial", "complex", "full-build"]).nullable().default(null),
  review: z.boolean().nullable().default(null),
  poc: z.boolean().nullable().default(null),
  smokeTest: z.boolean().nullable().default(null),
  baseBranch: z.string().nullable().default(null),
  maxMonitorHours: z.number().nullable().default(null),
});

const setupSchema = z.looseObject({
  prompt: z.string().default(""),
  repo: z.string().nullable().default(null),
  route: z.enum(["auto", "trivial", "complex", "full-build"]).default("auto"),
  review: z.boolean().default(true), // false ⇒ fully autonomous: gates auto-pass, questions auto-answer
  poc: z.boolean().default(false),
  smokeTest: z.boolean().default(true),
  baseBranch: z.string().default("main"),
  maxMonitorHours: z.number().default(24),
});

const routeSchema = z.looseObject({
  tier: z.enum(["trivial", "complex", "full-build"]).default("full-build"),
  reasoning: z.string().default(""),
  summary: z.string().default(""),
});

const directResultSchema = z.looseObject({
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  verificationEvidence: z.array(z.string()).default([]),
  artifactPath: z.string().nullable().default(null),
});

const preflightSchema = z.looseObject({
  ok: z.boolean().default(false),
  vcs: z.string().default("none"),
  notes: z.array(z.string()).default([]),
});

const intakeSchema = z.looseObject({
  summary: z.string().default(""),
  classification: z.enum(["greenfield", "existing-codebase"]).default("greenfield"),
  productType: z
    .enum(["webapp", "mobile-app", "library", "api", "cli", "service", "other"])
    .default("other"),
  targetRepo: z.string().default("."),
  constraints: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
});

const brainstormSchema = z.looseObject({
  summary: z.string().default(""),
  problemStatement: z.string().default(""),
  coreCapabilities: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  openQuestions: z
    .array(
      z.looseObject({
        id: z.string().default("q"),
        question: z.string().default(""),
        recommendedAnswer: z.string().default(""),
        whyItMatters: z.string().default(""),
      }),
    )
    .default([]),
  artifactPath: z.string().default(""),
});

const researchSchema = z.looseObject({
  topic: z.string().default(""),
  summary: z.string().default(""),
  findings: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  artifactPath: z.string().default(""),
});

const questionsSchema = z.looseObject({
  questions: z
    .array(
      z.looseObject({
        id: z.string().default("q"),
        question: z.string().default(""),
        recommendedAnswer: z.string().default(""),
        whyItMatters: z.string().default(""),
      }),
    )
    .default([]),
  notes: z.string().default(""),
});

const humanAnswersSchema = z.looseObject({
  answers: z
    .array(z.looseObject({ id: z.string().default("q"), answer: z.string().default("") }))
    .default([]),
  additionalContext: z.string().nullable().default(null),
  autoAnswered: z.boolean().default(false),
});

const prdSchema = z.looseObject({
  summary: z.string().default(""),
  artifactPath: z.string().default(""),
  interfaceArtifacts: z.array(z.string()).default([]),
  requirements: z
    .array(
      z.looseObject({
        id: z.string().default("REQ-0"),
        title: z.string().default(""),
        acceptanceCriteria: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  nonGoals: z.array(z.string()).default([]),
});

// One shared decision table for every human gate; rows are keyed by node id.
const gateSchema = z.looseObject({
  approved: z.boolean().default(false),
  note: z.string().nullable().default(null),
  decidedBy: z.string().nullable().default(null),
  decidedAt: z.string().nullable().default(null),
});

// Shared doc-review table (design loop reviewer = fable, eng loop reviewer = codex).
const docReviewSchema = z.looseObject({
  approved: z.boolean().default(false),
  feedback: z.string().default(""),
  issues: z
    .array(
      z.looseObject({
        severity: z.enum(["critical", "major", "minor", "nit"]).default("minor"),
        title: z.string().default(""),
        description: z.string().default(""),
      }),
    )
    .default([]),
});

const designDocSchema = z.looseObject({
  summary: z.string().default(""),
  artifactPath: z.string().default(""),
  decisions: z
    .array(
      z.looseObject({
        topic: z.string().default(""),
        decision: z.string().default(""),
        rationale: z.string().default(""),
      }),
    )
    .default([]),
});

const engDocSchema = z.looseObject({
  summary: z.string().default(""),
  artifactPath: z.string().default(""),
  architecture: z.string().default(""),
  dependencies: z
    .array(
      z.looseObject({
        name: z.string().default(""),
        purpose: z.string().default(""),
        risk: z.string().default(""),
      }),
    )
    .default([]),
  assumptionsToProbe: z
    .array(
      z.looseObject({
        id: z.string().default("assumption"),
        assumption: z.string().default(""),
        probe: z.string().default(""),
        blocking: z.boolean().default(true),
      }),
    )
    .default([]),
  requirementsTraceability: z
    .array(
      z.looseObject({
        requirementId: z.string().default(""),
        engSection: z.string().default(""),
      }),
    )
    .default([]),
});

const backpressureSchema = z.looseObject({
  summary: z.string().default(""),
  artifactPath: z.string().default(""),
  gates: z
    .array(
      z.looseObject({
        criterionId: z.string().default(""),
        criterion: z.string().default(""),
        verificationMethod: z
          .enum(["schema", "unit_test", "integration_test", "e2e_test", "eval", "agent_review", "approval", "manual_check"])
          .default("unit_test"),
        gateType: z.enum(["blocking", "warning", "informational"]).default("blocking"),
        checkedBy: z.string().default(""),
        failureAction: z.string().default(""),
        evidenceRequired: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const probeSchema = z.looseObject({
  assumptionId: z.string().default(""),
  passed: z.boolean().default(false),
  summary: z.string().default(""),
  evidence: z.array(z.string()).default([]),
  artifactPath: z.string().default(""),
  planImpact: z.string().nullable().default(null),
});

const probeSynthesisSchema = z.looseObject({
  allPassed: z.boolean().default(false),
  blockingFailure: z.boolean().default(false),
  failedIds: z.array(z.string()).default([]),
  planChanges: z.string().nullable().default(null),
  summary: z.string().default(""),
});

const ticketsSchema = z.looseObject({
  summary: z.string().default(""),
  artifactPath: z.string().default(""),
  tickets: z
    .array(
      z.looseObject({
        id: z.string().default("ticket"),
        title: z.string().default(""),
        instructions: z.string().default(""),
        requirementIds: z.array(z.string()).default([]),
        verification: z
          .array(
            z.looseObject({
              kind: z.enum(["command", "e2e", "agent-review"]).default("command"),
              details: z.string().default(""),
            }),
          )
          .default([]),
        dependsOn: z.array(z.string()).default([]),
        complexity: z.enum(["trivial", "small", "medium", "large"]).default("medium"),
      }),
    )
    .default([]),
});

const pocSchema = z.looseObject({
  summary: z.string().default(""),
  learnings: z.array(z.string()).default([]),
  engDocAmendments: z.string().nullable().default(null),
  artifactPath: z.string().default(""),
});

const orchDesignSchema = z.looseObject({
  summary: z.string().default(""),
  artifactPath: z.string().default(""),
  worktreeLayout: z.string().default(""),
  mergePolicy: z.string().default(""),
  testTiers: z.string().default(""),
  modelAssignment: z.string().default(""),
  concurrency: z.string().default(""),
  observability: z.string().default(""),
  contextManagement: z.string().default(""),
});

const scaffoldSchema = z.looseObject({
  summary: z.string().default(""),
  workflowFile: z.string().default(IMPL_WORKFLOW),
  filesWritten: z.array(z.string()).default([]),
});

const verifySchema = z.looseObject({
  passed: z.boolean().default(false),
  command: z.string().default(""),
  errors: z.array(z.string()).default([]),
  notes: z.string().default(""),
});

const wfReviewSchema = z.looseObject({
  approved: z.boolean().default(false),
  blockingIssues: z
    .array(z.looseObject({ title: z.string().default(""), detail: z.string().default("") }))
    .default([]),
  advisories: z.array(z.string()).default([]),
});

const smokeSchema = z.looseObject({
  passed: z.boolean().default(false),
  childRunId: z.string().nullable().default(null), // not `runId` — that column is reserved per-table
  summary: z.string().default(""),
  errors: z.array(z.string()).default([]),
});

const launchSchema = z.looseObject({
  launched: z.boolean().default(false),
  childRunId: z.string().nullable().default(null), // not `runId` — that column is reserved per-table
  detail: z.string().default(""),
});

const monitorPollSchema = z.looseObject({
  status: z.string().default("unknown"),
  terminal: z.boolean().default(false),
  needsAttention: z.boolean().default(false),
  resumed: z.boolean().default(false),
  detail: z.string().default(""),
});

const monitorReportSchema = z.looseObject({
  artifactPath: z.string().default(""),
  summary: z.string().default(""),
});

const monitorTriageSchema = z.looseObject({
  summary: z.string().default(""),
  actionsTaken: z.array(z.string()).default([]),
  escalate: z.boolean().default(false),
  reason: z.string().nullable().default(null),
});

const reviewFindingSchema = z.looseObject({
  reviewer: z.string().default(""),
  approved: z.boolean().default(false),
  summary: z.string().default(""),
  issues: z
    .array(
      z.looseObject({
        severity: z.enum(["critical", "major", "minor", "nit"]).default("minor"),
        title: z.string().default(""),
        file: z.string().nullable().default(null),
        description: z.string().default(""),
      }),
    )
    .default([]),
});

const reviewSynthesisSchema = z.looseObject({
  approved: z.boolean().default(false),
  summary: z.string().default(""),
  mustFix: z
    .array(
      z.looseObject({
        severity: z.enum(["critical", "major"]).default("major"),
        title: z.string().default(""),
        file: z.string().nullable().default(null),
        description: z.string().default(""),
      }),
    )
    .default([]),
  niceToHave: z.array(z.string()).default([]),
});

const polishScanSchema = z.looseObject({
  summary: z.string().default(""),
  issues: z
    .array(
      z.looseObject({
        title: z.string().default(""),
        file: z.string().nullable().default(null),
        description: z.string().default(""),
      }),
    )
    .default([]),
});

const polishFixSchema = z.looseObject({
  summary: z.string().default(""),
  fixed: z.array(z.string()).default([]),
});

const polishVerifySchema = z.looseObject({
  passed: z.boolean().default(false),
  summary: z.string().default(""),
});

const polishReportSchema = z.looseObject({
  summary: z.string().default(""),
});

const reportGatherSchema = z.looseObject({
  runInfo: z.string().default(""),
  artifactIndex: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const finalReportSchema = z.looseObject({
  status: z.enum(["delivered", "cancelled", "incomplete"]).default("incomplete"),
  artifactPath: z.string().nullable().default(null),
  summary: z.string().default(""),
});

const deliverySchema = z.looseObject({
  summary: z.string().default(""),
  branch: z.string().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  mergedToMain: z.boolean().default(false), // invariant: stays false; merging is the human's act
});

// Terminal run summary — the LAST task's output, so `smithers output`/the run's
// printed result surfaces something human-meaningful instead of nothing. Pure
// aggregation of rows the workflow already wrote (finalReport + delivery + route);
// no new work, no invented data.
const outputSchema = z.looseObject({
  route: z.string().default("unknown"), // trivial | complex | full-build
  status: z.string().default("incomplete"), // delivered | cancelled | incomplete
  summary: z.string().default(""),
  reportPath: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  filesChanged: z.array(z.string()).default([]), // direct tiers only; full builds report via implRunId
  ticketCount: z.number().default(0),
  mustFixCount: z.number().default(0),
  implRunId: z.string().nullable().default(null), // child build run to inspect
});

const { Workflow, Task, Sequence, Parallel, Branch, Loop, Approval, Timer, smithers, outputs } =
  createSmithers({
    input: inputSchema,
    setup: setupSchema,
    route: routeSchema,
    directResult: directResultSchema,
    preflight: preflightSchema,
    intake: intakeSchema,
    brainstorm: brainstormSchema,
    research: researchSchema,
    questions: questionsSchema,
    humanAnswers: humanAnswersSchema,
    prd: prdSchema,
    gate: gateSchema,
    docReview: docReviewSchema,
    designDoc: designDocSchema,
    engDoc: engDocSchema,
    backpressure: backpressureSchema,
    probe: probeSchema,
    probeSynthesis: probeSynthesisSchema,
    tickets: ticketsSchema,
    poc: pocSchema,
    orchDesign: orchDesignSchema,
    scaffold: scaffoldSchema,
    verify: verifySchema,
    wfReview: wfReviewSchema,
    smoke: smokeSchema,
    launch: launchSchema,
    monitorPoll: monitorPollSchema,
    monitorReport: monitorReportSchema,
    monitorTriage: monitorTriageSchema,
    reviewFinding: reviewFindingSchema,
    reviewSynthesis: reviewSynthesisSchema,
    polishScan: polishScanSchema,
    polishFix: polishFixSchema,
    polishVerify: polishVerifySchema,
    polishReport: polishReportSchema,
    reportGather: reportGatherSchema,
    finalReport: finalReportSchema,
    delivery: deliverySchema,
    output: outputSchema,
  });

// ─── Workflow ────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const input = ctx.input;

  // Stable, data-derived child run id (Footguns rule): survives resume of this run.
  const implRunId = `impl-${ctx.runId}`;

  // ── Resolved configuration (the setup step is the single source of truth) ──
  const hasProvidedPrompt =
    typeof input.prompt === "string" && input.prompt.trim().length > 0;
  const cfg = (ctx as any).outputMaybe("setup", { nodeId: "setup", iteration: 0 });
  const review = cfg?.review ?? true;
  const wantPoc = cfg?.poc ?? false;
  const wantSmoke = cfg?.smokeTest ?? true;
  const baseBranch = cfg?.baseBranch ?? "main";
  const productPrompt = cfg?.prompt ?? "";
  const monitorMaxIterations = Math.max(4, Math.round((cfg?.maxMonitorHours ?? 24) * 4));

  // ── Routing: forced via setup.route, otherwise classified by fable ──
  const routeOut = (ctx as any).outputMaybe("route", { nodeId: "route", iteration: 0 });
  const forcedRoute = cfg?.route && cfg.route !== "auto" ? cfg.route : null;
  const routeTier: "trivial" | "complex" | "full-build" | null =
    forcedRoute ?? routeOut?.tier ?? null;
  const directTrivial = (ctx as any).outputMaybe("directResult", { nodeId: "direct:trivial", iteration: 0 });
  const directComplex = (ctx as any).outputMaybe("directResult", { nodeId: "direct:complex", iteration: 0 });
  const directResult = directTrivial ?? directComplex;

  // ── Phase state (the whole plan is a pure function of these; iteration pinned to 0
  //    because ctx's default iteration tracks the active loop in single-loop phases) ──
  const preflight = (ctx as any).outputMaybe("preflight", { nodeId: "preflight", iteration: 0 });
  const intake = (ctx as any).outputMaybe("intake", { nodeId: "intake", iteration: 0 });
  const brainstorm = (ctx as any).outputMaybe("brainstorm", { nodeId: "brainstorm", iteration: 0 });
  const researchDomain = (ctx as any).outputMaybe("research", { nodeId: "research:domain", iteration: 0 });
  const researchPriorArt = (ctx as any).outputMaybe("research", { nodeId: "research:prior-art", iteration: 0 });
  const questions = (ctx as any).outputMaybe("questions", { nodeId: "questions", iteration: 0 });
  const answers = (ctx as any).outputMaybe("humanAnswers", { nodeId: "answers", iteration: 0 });
  const prd = (ctx as any).outputMaybe("prd", { nodeId: "prd", iteration: 0 });

  const gateRow = (nodeId: string) =>
    (ctx as any).outputMaybe("gate", { nodeId, iteration: 0 });
  const gatePassed = (nodeId: string) => !review || gateRow(nodeId)?.approved === true;
  const gateDenied = (nodeId: string) => review && gateRow(nodeId)?.approved === false;

  const prdApproved = !!prd && gatePassed("gate:prd");

  const designArt = (ctx as any).outputMaybe("research", { nodeId: "research:design-art", iteration: 0 });
  const designReviewLatest = (ctx as any).latest("docReview", "design:review");
  const designLoopDone =
    designReviewLatest?.approved === true ||
    (ctx as any).iterationCount("docReview", "design:review") >= 3;
  const designFinal = (ctx as any).outputMaybe("designDoc", { nodeId: "design:final", iteration: 0 });

  const engDepsResearch = (ctx as any).outputMaybe("research", { nodeId: "research:eng-deps", iteration: 0 });
  const engOssResearch = (ctx as any).outputMaybe("research", { nodeId: "research:eng-oss", iteration: 0 });
  const engReviewLatest = (ctx as any).latest("docReview", "eng:review");
  const engReviewRounds = (ctx as any).iterationCount("docReview", "eng:review");
  const engLoopDone = engReviewLatest?.approved === true || engReviewRounds >= 3;
  const engDoc = (ctx as any).latest("engDoc", "eng:doc");
  const engApproved = engLoopDone && !!engDoc && gatePassed("gate:eng");

  const backpressure = (ctx as any).outputMaybe("backpressure", { nodeId: "backpressure", iteration: 0 });
  const probesNeeded: any[] = engDoc?.assumptionsToProbe ?? [];
  const probeRow = (id: string) =>
    (ctx as any).outputMaybe("probe", { nodeId: `probe:${id}`, iteration: 0 });
  const allProbesDone = !!backpressure && probesNeeded.every((a: any) => probeRow(a.id));
  const probeSynth = (ctx as any).outputMaybe("probeSynthesis", { nodeId: "probe:synthesis", iteration: 0 });
  const probeBlocked = probeSynth?.blockingFailure === true;
  const probesCleared =
    !!backpressure &&
    (probesNeeded.length === 0 ||
      (!!probeSynth && (!probeBlocked || gatePassed("gate:probes"))));

  const tickets = (ctx as any).outputMaybe("tickets", { nodeId: "tickets", iteration: 0 });
  const poc = (ctx as any).outputMaybe("poc", { nodeId: "poc", iteration: 0 });
  const pocDone = !wantPoc || !!poc;

  const orchDesign = (ctx as any).outputMaybe("orchDesign", { nodeId: "orch:design", iteration: 0 });
  const scaffold = (ctx as any).outputMaybe("scaffold", { nodeId: "wf:scaffold", iteration: 0 });
  const lastVerify = (ctx as any).latest("verify", "wf:verify");
  const verifyPassed = lastVerify?.passed === true;
  const verifyFailed = lastVerify !== undefined && lastVerify.passed === false;
  const verifyAttempts = (ctx as any).iterationCount("verify", "wf:verify");
  const wfReview = (ctx as any).outputMaybe("wfReview", { nodeId: "wf:review", iteration: 0 });
  const wfFix = (ctx as any).outputMaybe("scaffold", { nodeId: "wf:fix-blocking", iteration: 0 });
  const reverify = (ctx as any).outputMaybe("verify", { nodeId: "wf:reverify", iteration: 0 });
  const wfReady =
    verifyPassed &&
    (wfReview?.approved === true ||
      (wfReview?.approved === false && !!wfFix && reverify?.passed === true));
  const wfDeadEnd =
    (!!scaffold && !verifyPassed && verifyAttempts >= 3) ||
    (wfReview?.approved === false && !!wfFix && reverify?.passed === false);

  const smokeLatest = (ctx as any).latest("smoke", "wf:smoke");
  const smokeAttempts = (ctx as any).iterationCount("smoke", "wf:smoke");
  const smokeCleared = !wantSmoke || smokeLatest?.passed === true;
  const smokeFailedOut = wantSmoke && !smokeCleared && smokeAttempts >= 2;

  const launchApproved = wfReady && smokeCleared && gatePassed("gate:launch");
  const launch = (ctx as any).outputMaybe("launch", { nodeId: "launch", iteration: 0 });
  const launched = launch?.launched === true;

  const lastPoll = (ctx as any).latest("monitorPoll", "monitor:poll");
  const lastTriage = (ctx as any).latest("monitorTriage", "monitor:triage");
  const buildEnded = lastPoll?.terminal === true;
  const buildFinished = buildEnded && lastPoll?.status === "finished";
  const monitorPolls = (ctx as any).iterationCount("monitorPoll", "monitor:poll");
  const monitorExhausted = launched && !buildEnded && monitorPolls >= monitorMaxIterations;
  const monitorStopped = buildEnded || lastTriage?.escalate === true || monitorExhausted;

  const reviewReady =
    launched && monitorStopped && (buildFinished || gatePassed("gate:incomplete"));
  const panelFindings = [
    (ctx as any).outputMaybe("reviewFinding", { nodeId: "review:fable", iteration: 0 }),
    (ctx as any).outputMaybe("reviewFinding", { nodeId: "review:codex", iteration: 0 }),
    (ctx as any).outputMaybe("reviewFinding", { nodeId: "review:fast", iteration: 0 }),
  ].filter(Boolean);
  const reviewSynth = (ctx as any).outputMaybe("reviewSynthesis", { nodeId: "review:synthesis", iteration: 0 });
  const mustFix: any[] = reviewSynth?.mustFix ?? [];
  const polishDone =
    !!reviewSynth &&
    (mustFix.length === 0 || ((ctx as any).outputs("polishReport") ?? []).length > 0);

  const gather = (ctx as any).outputMaybe("reportGather", { nodeId: "report:gather", iteration: 0 });
  const finalReport = (ctx as any).outputMaybe("finalReport", { nodeId: "report:final", iteration: 0 });
  const deliveryApproved = !!finalReport && gatePassed("gate:delivery");
  const deliveryOut = (ctx as any).outputMaybe("delivery", { nodeId: "delivery", iteration: 0 });

  // Every terminal path (direct tiers, each cancelled:* task, and report:final) writes
  // exactly one finalReport row; grab whichever ran so the final output task can run
  // last regardless of which branch the router took.
  const terminalReports: any[] = (ctx as any).outputs("finalReport") ?? [];
  const terminalReport = terminalReports.length > 0 ? terminalReports[terminalReports.length - 1] : null;

  const targetRepo = intake?.targetRepo ?? cfg?.repo ?? ".";

  const questionsBlock = (questions?.questions ?? [])
    .map(
      (q: any) =>
        `[${q.id}] ${q.question}\n    recommended: ${q.recommendedAnswer}\n    why it matters: ${q.whyItMatters}`,
    )
    .join("\n\n");

  return (
    <Workflow name="smithering">
      <Sequence>
        {/* ── -1. Setup: interview the human (via the operating agent) when no prompt
               was provided; otherwise resolve config deterministically from inputs ── */}
        {!hasProvidedPrompt ? (
          <HumanTask
            id="setup"
            output={outputs.setup}
            maxAttempts={5}
            prompt={<SetupPrompt given={JSON.stringify(input ?? {}, null, 2)} />}
          />
        ) : (
          <Task id="setup" output={outputs.setup}>
            {{
              prompt: input.prompt ?? "",
              repo: input.repo ?? null,
              route: input.route ?? "auto",
              review: input.review ?? true,
              poc: input.poc ?? false,
              smokeTest: input.smokeTest ?? true,
              baseBranch: input.baseBranch ?? "main",
              maxMonitorHours: input.maxMonitorHours ?? 24,
            }}
          </Task>
        )}

        {/* ── -0.5 Router: cheapest tier that can deliver verified quality ── */}
        {cfg && !forcedRoute ? (
          <Task id="route" output={outputs.route} agent={sonnet}>
            <RoutePrompt prompt={productPrompt} repo={cfg?.repo ?? null} />
            <Rules />
          </Task>
        ) : null}

        {/* trivial → sonnet just does it; complex → codex xhigh drives it via /goal.
            Both verify + evidence their work and end in a finalReport row; no gates. */}
        {routeTier === "trivial" ? (
          <Task id="direct:trivial" output={outputs.directResult} agent={sonnet} heartbeatTimeoutMs={900_000}>
            <DirectTrivialPrompt prompt={productPrompt} repo={cfg?.repo ?? null} />
            <Rules />
          </Task>
        ) : null}
        {routeTier === "complex" ? (
          <Task id="direct:complex" output={outputs.directResult} agent={codexBuilder} heartbeatTimeoutMs={900_000}>
            <DirectComplexPrompt prompt={productPrompt} repo={cfg?.repo ?? null} />
            <OverTest />
            <Rules />
          </Task>
        ) : null}
        {directResult ? (
          <Task id="report:direct" output={outputs.finalReport}>
            {{
              status: "delivered" as const,
              artifactPath: directResult.artifactPath ?? null,
              summary: `[${routeTier}-tier direct execution] ${directResult.summary} Files: ${(directResult.filesChanged ?? []).join(", ") || "none"}. Evidence: ${(directResult.verificationEvidence ?? []).join("; ") || "none recorded"}.`,
            }}
          </Task>
        ) : null}

        {/* ── 0. Preflight (full-build tier only): toolchain must resolve before
               anything spends money ── */}
        {routeTier === "full-build" ? (
          <Task id="preflight" output={outputs.preflight}>
            {runPreflight}
          </Task>
        ) : null}

        {preflight && !preflight.ok ? (
          <Task id="cancelled:preflight" output={outputs.finalReport}>
            {{
              status: "cancelled" as const,
              artifactPath: null,
              summary: `Preflight failed — fix the toolchain and start a new run. ${preflight.notes.join(" | ")}`,
            }}
          </Task>
        ) : null}

        {/* ── 0b. Intake: classify the request before planning ── */}
        {preflight?.ok ? (
          <Task id="intake" output={outputs.intake} agent={fable}>
            <IntakePrompt prompt={productPrompt} repo={cfg?.repo ?? null} />
            <Rules />
          </Task>
        ) : null}

        {/* ── 1. Brainstorm (PROMPT.md step 1) ── */}
        {intake ? (
          <Task id="brainstorm" output={outputs.brainstorm} agent={fable}>
            <BrainstormPrompt
              prompt={productPrompt}
              intakeSummary={intake.summary}
              productType={intake.productType}
              classification={intake.classification}
              targetRepo={targetRepo}
              constraints={(intake.constraints ?? []).join("; ") || "none recorded"}
            />
            <Rules />
          </Task>
        ) : null}

        {/* ── 2a. Research fan-out (research BEFORE questions) ── */}
        {brainstorm ? (
          <Parallel maxConcurrency={2}>
            <Task id="research:domain" output={outputs.research} agent={sonnet} retries={2}>
              <ResearchDomainPrompt
                problemStatement={brainstorm.problemStatement}
                openQuestions={JSON.stringify(
                  (brainstorm.openQuestions ?? []).map((q: any) => q.question),
                )}
              />
              <Rules />
            </Task>
            <Task id="research:prior-art" output={outputs.research} agent={sonnet} retries={2}>
              <ResearchPriorArtPrompt problemStatement={brainstorm.problemStatement} />
              <Rules />
            </Task>
          </Parallel>
        ) : null}

        {/* ── 2b. Clarifying questions: only what research could not answer ── */}
        {brainstorm && researchDomain && researchPriorArt ? (
          <Task id="questions" output={outputs.questions} agent={fable}>
            <QuestionsPrompt />
            <Rules />
          </Task>
        ) : null}

        {/* ── 2c. Ask the human (durable HumanTask, relayed by the operating agent) —
               or auto-adopt the recommendations ── */}
        {questions && review && (questions.questions?.length ?? 0) > 0 ? (
          <HumanTask
            id="answers"
            output={outputs.humanAnswers}
            maxAttempts={5}
            prompt={<AnswersPrompt request={productPrompt} questionsBlock={questionsBlock} />}
          />
        ) : null}
        {questions && (!review || (questions.questions?.length ?? 0) === 0) ? (
          <Task id="answers" output={outputs.humanAnswers}>
            {{
              answers: (questions.questions ?? []).map((q: any) => ({
                id: q.id,
                answer: q.recommendedAnswer,
              })),
              additionalContext: null,
              autoAnswered: true,
            }}
          </Task>
        ) : null}

        {/* ── 3. PRD + end-user interface artifacts (PROMPT.md step 3) ── */}
        {answers ? (
          <Task id="prd" output={outputs.prd} agent={fable} heartbeatTimeoutMs={900_000}>
            <PrdPrompt
              answers={JSON.stringify(answers.answers ?? [])}
              additionalContext={answers.additionalContext}
              productType={intake?.productType ?? "other"}
            />
            <Rules />
          </Task>
        ) : null}

        {prd && review && !gateRow("gate:prd") ? (
          <Approval
            id="gate:prd"
            output={outputs.gate}
            request={{
              title: "Approve PRD + interface mockups?",
              summary: `${prd.summary}\n\nPRD: ${prd.artifactPath}\nInterfaces: ${(prd.interfaceArtifacts ?? []).join(", ") || "none"}\nRequirements: ${(prd.requirements ?? []).length}, non-goals: ${(prd.nonGoals ?? []).length}`,
              metadata: { artifactPath: prd.artifactPath },
            }}
            onDeny="continue"
          />
        ) : null}
        {gateDenied("gate:prd") ? (
          <Task id="cancelled:prd" output={outputs.finalReport}>
            {{
              status: "cancelled" as const,
              artifactPath: prd?.artifactPath ?? null,
              summary: `PRD was not approved. Note: ${gateRow("gate:prd")?.note ?? "(none)"}`,
            }}
          </Task>
        ) : null}

        {/* ── 4. Design doc: delegated draft → fable review loop → fable final pass ── */}
        {prdApproved ? (
          <Task id="research:design-art" output={outputs.research} agent={sonnet} retries={2}>
            <ResearchDesignArtPrompt productType={intake?.productType ?? "other"} />
            <Rules />
          </Task>
        ) : null}

        {prdApproved && designArt ? (
          <Loop id="design:loop" until={designReviewLatest?.approved === true} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task id="design:draft" output={outputs.designDoc} agent={sonnet} heartbeatTimeoutMs={900_000}>
                <DesignDraftPrompt
                  feedback={designReviewLatest?.feedback ?? null}
                  issues={designReviewLatest ? JSON.stringify(designReviewLatest.issues ?? []) : null}
                />
                <Rules />
              </Task>
              <Task id="design:review" output={outputs.docReview} agent={fable}>
                <DesignReviewPrompt />
                <Rules />
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {prdApproved && designArt && designLoopDone ? (
          <Task id="design:final" output={outputs.designDoc} agent={fable}>
            <DesignFinalPrompt
              reviewOutcome={
                designReviewLatest?.approved === true
                  ? "approved"
                  : "loop cap reached — note unresolved concerns explicitly"
              }
            />
            <DecisionDocs />
            <Rules />
          </Task>
        ) : null}

        {/* ── 5. Eng doc: research fan-out → fable architecture ⇄ codex adversarial review ── */}
        {designFinal ? (
          <Parallel maxConcurrency={2}>
            <Task id="research:eng-deps" output={outputs.research} agent={sonnet} retries={2}>
              <ResearchEngDepsPrompt />
              <Rules />
            </Task>
            <Task id="research:eng-oss" output={outputs.research} agent={sonnet} retries={2}>
              <ResearchEngOssPrompt />
              <Rules />
            </Task>
          </Parallel>
        ) : null}

        {designFinal && engDepsResearch && engOssResearch ? (
          <Loop id="eng:loop" until={engReviewLatest?.approved === true} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task id="eng:doc" output={outputs.engDoc} agent={fable} heartbeatTimeoutMs={900_000}>
                <EngDocPrompt
                  feedback={engReviewLatest?.feedback ?? null}
                  issues={engReviewLatest ? JSON.stringify(engReviewLatest.issues ?? []) : null}
                />
                <OverTest />
                <DecisionDocs />
                <Rules />
              </Task>
              <Task id="eng:review" output={outputs.docReview} agent={codexXhigh}>
                <EngReviewPrompt />
                <Rules />
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {engLoopDone && engDoc && review && !gateRow("gate:eng") ? (
          <Approval
            id="gate:eng"
            output={outputs.gate}
            request={{
              title: "Approve engineering doc + architecture?",
              summary: `${engDoc.summary}\n\nDoc: ${engDoc.artifactPath}\nCross-model review: ${engReviewLatest?.approved === true ? "codex approved" : `codex did NOT approve after ${engReviewRounds} rounds — last feedback: ${engReviewLatest?.feedback ?? "n/a"}`}\nDependencies: ${(engDoc.dependencies ?? []).map((d: any) => d.name).join(", ") || "none"}\nAssumptions to probe: ${(engDoc.assumptionsToProbe ?? []).length}`,
              metadata: { artifactPath: engDoc.artifactPath },
            }}
            onDeny="continue"
          />
        ) : null}
        {gateDenied("gate:eng") ? (
          <Task id="cancelled:eng" output={outputs.finalReport}>
            {{
              status: "cancelled" as const,
              artifactPath: engDoc?.artifactPath ?? null,
              summary: `Engineering doc was not approved. Note: ${gateRow("gate:eng")?.note ?? "(none)"}`,
            }}
          </Task>
        ) : null}

        {/* ── 5.5 Backpressure matrix: criterion → gate traceability ── */}
        {engApproved ? (
          <Task id="backpressure" output={outputs.backpressure} agent={fable}>
            <BackpressurePrompt />
            <OverTest />
            <Rules />
          </Task>
        ) : null}

        {/* ── 6. Assumption probes (PROMPT.md step 6) with the stop rule ── */}
        {backpressure && probesNeeded.length > 0 ? (
          <Parallel maxConcurrency={3}>
            {probesNeeded.map((a: any) => (
              <Task
                key={a.id}
                id={`probe:${a.id}`}
                output={outputs.probe}
                agent={sonnet}
                retries={2}
                timeoutMs={30 * 60_000}
              >
                <ProbePrompt id={a.id} assumption={a.assumption} probe={a.probe} />
                <Rules />
              </Task>
            ))}
          </Parallel>
        ) : null}

        {allProbesDone && probesNeeded.length > 0 ? (
          <Task id="probe:synthesis" output={outputs.probeSynthesis} agent={fable}>
            <ProbeSynthesisPrompt
              results={JSON.stringify(
                probesNeeded.map((a: any) => ({
                  id: a.id,
                  blocking: a.blocking,
                  result: probeRow(a.id),
                })),
                null,
                2,
              )}
            />
            <Rules />
          </Task>
        ) : null}

        {probeBlocked && review && !gateRow("gate:probes") ? (
          <Approval
            id="gate:probes"
            output={outputs.gate}
            request={{
              title: "Blocking assumption probe failed — approve amended plan?",
              summary: `${probeSynth?.summary}\n\nFailed: ${(probeSynth?.failedIds ?? []).join(", ")}\nPlan changes: ${probeSynth?.planChanges ?? "(none recorded)"}`,
            }}
            onDeny="continue"
          />
        ) : null}
        {gateDenied("gate:probes") ? (
          <Task id="cancelled:probes" output={outputs.finalReport}>
            {{
              status: "cancelled" as const,
              artifactPath: engDoc?.artifactPath ?? null,
              summary: `A blocking assumption probe failed and the amended plan was not approved. Failed: ${(probeSynth?.failedIds ?? []).join(", ")}. Note: ${gateRow("gate:probes")?.note ?? "(none)"}`,
            }}
          </Task>
        ) : null}

        {/* ── 7. Ticket breakdown: the contract the implementation workflow consumes ── */}
        {engApproved && probesCleared ? (
          <Task id="tickets" output={outputs.tickets} agent={fable} heartbeatTimeoutMs={900_000}>
            <TicketsPrompt probeSummary={probeSynth?.summary ?? null} />
            <Rules />
          </Task>
        ) : null}

        {/* ── 8. Optional POC (PROMPT.md step 8 — feeds the eng doc + ticket contract) ── */}
        {tickets && wantPoc ? (
          <Task id="poc" output={outputs.poc} agent={sonnet} timeoutMs={45 * 60_000} retries={1}>
            <PocPrompt />
            <Rules />
          </Task>
        ) : null}

        {/* ── 9. Orchestration design: decisions recorded, then the workflow authored ── */}
        {tickets && pocDone ? (
          <Task id="orch:design" output={outputs.orchDesign} agent={fable}>
            <OrchDesignPrompt
              targetRepo={targetRepo}
              baseBranch={baseBranch}
              pocSummary={poc?.summary ?? null}
            />
            <DecisionDocs />
            <Rules />
          </Task>
        ) : null}

        {orchDesign ? (
          <Task id="wf:scaffold" output={outputs.scaffold} agent={fableBuilder} heartbeatTimeoutMs={900_000}>
            <ScaffoldPrompt baseBranch={baseBranch} />
            <Rules />
          </Task>
        ) : null}

        {/* ── 9.5a Deterministic verify → fix loop (create-workflow pattern) ── */}
        {scaffold ? (
          <Loop id="wf:verify-loop" until={verifyPassed} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task id="wf:verify" output={outputs.verify}>
                {() =>
                  checkImplGraph(
                    "Implementation workflow loads and its graph renders without executing.",
                    "graph render failed — see errors.",
                  )
                }
              </Task>
              <Branch
                if={verifyFailed}
                then={
                  <Task id="wf:fix" output={outputs.scaffold} agent={fableBuilder} heartbeatTimeoutMs={900_000}>
                    <WfFixPrompt errors={(lastVerify?.errors ?? []).join("\n\n")} />
                    <Rules />
                  </Task>
                }
                else={null}
              />
            </Sequence>
          </Loop>
        ) : null}

        {/* ── 9.5b Cross-model footgun review of the generated workflow ── */}
        {scaffold && verifyPassed && !wfReview ? (
          <Task id="wf:review" output={outputs.wfReview} agent={codexXhigh}>
            <WfReviewPrompt baseBranch={baseBranch} />
            <Rules />
          </Task>
        ) : null}

        {wfReview && wfReview.approved === false && !wfFix ? (
          <Task id="wf:fix-blocking" output={outputs.scaffold} agent={fableBuilder} heartbeatTimeoutMs={900_000}>
            <WfFixBlockingPrompt blockingIssues={JSON.stringify(wfReview.blockingIssues ?? [], null, 2)} />
            <Rules />
          </Task>
        ) : null}
        {wfFix ? (
          <Task id="wf:reverify" output={outputs.verify}>
            {() =>
              checkImplGraph(
                "Re-render after blocking-issue fixes passed.",
                "Re-render after blocking-issue fixes failed.",
              )
            }
          </Task>
        ) : null}

        {wfDeadEnd ? (
          <Task id="cancelled:wf" output={outputs.finalReport}>
            {{
              status: "incomplete" as const,
              artifactPath: orchDesign?.artifactPath ?? null,
              summary: `The generated implementation workflow could not be validated (graph render failing after ${verifyAttempts} attempts, or blocking-issue fixes failed re-render). Last errors: ${((reverify?.passed === false ? reverify?.errors : lastVerify?.errors) ?? []).join(" | ").slice(0, 1500)}`,
            }}
          </Task>
        ) : null}

        {/* ── 9.5c Smoke: cheapest ticket end-to-end before real money is spent ── */}
        {wfReady && wantSmoke && !smokeCleared && !smokeFailedOut ? (
          <Loop id="wf:smoke-loop" until={smokeLatest?.passed === true} maxIterations={2} onMaxReached="return-last">
            <Sequence>
              <Task id="wf:smoke" output={outputs.smoke} timeoutMs={60 * 60_000}>
                {() => runSmokeAttempt(`smoke-${ctx.runId}-${smokeAttempts}`)}
              </Task>
              <Branch
                if={smokeLatest !== undefined && smokeLatest.passed === false}
                then={
                  <Task id="wf:smoke-fix" output={outputs.scaffold} agent={fableBuilder} heartbeatTimeoutMs={900_000}>
                    <SmokeFixPrompt
                      childRunId={smokeLatest?.childRunId ?? ""}
                      errors={(smokeLatest?.errors ?? []).join("\n").slice(0, 5000)}
                    />
                    <Rules />
                  </Task>
                }
                else={null}
              />
            </Sequence>
          </Loop>
        ) : null}
        {smokeFailedOut ? (
          <Task id="cancelled:smoke" output={outputs.finalReport}>
            {{
              status: "incomplete" as const,
              artifactPath: orchDesign?.artifactPath ?? null,
              summary: `Smoke run failed ${smokeAttempts} times; not launching the full build. Last errors: ${(smokeLatest?.errors ?? []).join(" | ").slice(0, 1500)}`,
            }}
          </Task>
        ) : null}

        {/* ── 10. Launch gate (cost checkpoint) → detached launch → bounded monitor ── */}
        {wfReady && smokeCleared && review && !gateRow("gate:launch") ? (
          <Approval
            id="gate:launch"
            output={outputs.gate}
            request={{
              title: "Launch the full implementation run?",
              summary: `Orchestration: ${orchDesign?.summary}\nTickets: ${(tickets?.tickets ?? []).length} (${PLANNING}/05-tickets.md)\nValidation: graph ✓, cross-model review ${wfReview?.approved === true ? "✓" : "✓ (after fixes)"}, smoke ${wantSmoke ? (smokeLatest?.passed ? "✓ " + (smokeLatest?.childRunId ?? "") : "—") : "skipped"}\nMonitor bound: ${cfg?.maxMonitorHours ?? 24}h`,
              metadata: { workflowFile: IMPL_WORKFLOW, implRunId },
            }}
            onDeny="continue"
          />
        ) : null}
        {gateDenied("gate:launch") ? (
          <Task id="cancelled:launch" output={outputs.finalReport}>
            {{
              status: "cancelled" as const,
              artifactPath: orchDesign?.artifactPath ?? null,
              summary: `Launch was not approved. Note: ${gateRow("gate:launch")?.note ?? "(none)"}`,
            }}
          </Task>
        ) : null}

        {launchApproved && !launch ? (
          <Task id="launch" output={outputs.launch}>
            {() => launchImplementationRun(implRunId)}
          </Task>
        ) : null}

        {launched ? (
          <Loop
            id="monitor:loop"
            until={lastPoll?.terminal === true || lastTriage?.escalate === true}
            maxIterations={monitorMaxIterations}
            onMaxReached="return-last"
          >
            <Sequence>
              <Timer id="monitor:tick" duration="15m" />
              <Task id="monitor:poll" output={outputs.monitorPoll}>
                {() => pollImplementationRun(implRunId)}
              </Task>
              <Task id="monitor:report" output={outputs.monitorReport} agent={sonnet} continueOnFail retries={1}>
                <MonitorReportPrompt implRunId={implRunId} />
                <Rules />
              </Task>
              <Branch
                if={
                  (ctx as any).latest("monitorPoll", "monitor:poll")?.needsAttention === true &&
                  (ctx as any).latest("monitorPoll", "monitor:poll")?.terminal !== true
                }
                then={
                  <Task id="monitor:triage" output={outputs.monitorTriage} agent={fable}>
                    <MonitorTriagePrompt
                      implRunId={implRunId}
                      poll={JSON.stringify((ctx as any).latest("monitorPoll", "monitor:poll") ?? {}, null, 2)}
                    />
                    <Rules />
                  </Task>
                }
                else={null}
              />
            </Sequence>
          </Loop>
        ) : null}

        {/* escalation / unhealthy ending: human decides whether to proceed to review */}
        {launched && monitorStopped && !buildFinished && review && !gateRow("gate:incomplete") ? (
          <Approval
            id="gate:incomplete"
            output={outputs.gate}
            request={{
              title: "Build run did not finish cleanly — proceed to review anyway?",
              summary: `Last status: ${lastPoll?.status ?? "unknown"}${monitorExhausted ? `\nMonitor window exhausted (${monitorMaxIterations} polls / ~${cfg?.maxMonitorHours ?? 24}h) with the build still not terminal.` : ""}${lastTriage?.escalate ? `\nMonitor escalation: ${lastTriage?.reason ?? ""}` : ""}\nApprove to review/polish what exists; deny to stop here (a report of record is still written).`,
            }}
            onDeny="continue"
          />
        ) : null}
        {gateDenied("gate:incomplete") ? (
          <Task id="cancelled:incomplete" output={outputs.finalReport}>
            {{
              status: "incomplete" as const,
              artifactPath: null,
              summary: `Build ended unhealthy (status: ${lastPoll?.status ?? "unknown"}) and the human chose not to proceed. ${gateRow("gate:incomplete")?.note ?? ""}`,
            }}
          </Task>
        ) : null}

        {/* ── 11. Review panel: three lenses, cross-model, then orchestrator synthesis ── */}
        {reviewReady ? (
          <Parallel maxConcurrency={3}>
            <Task id="review:fable" output={outputs.reviewFinding} agent={fable} continueOnFail retries={1} heartbeatTimeoutMs={900_000}>
              <ReviewFablePrompt targetRepo={targetRepo} />
              <Rules />
            </Task>
            <Task id="review:codex" output={outputs.reviewFinding} agent={codexXhigh} continueOnFail retries={1}>
              <ReviewCodexPrompt targetRepo={targetRepo} />
              <Rules />
            </Task>
            <Task id="review:fast" output={outputs.reviewFinding} agent={sonnet} continueOnFail retries={1}>
              <ReviewFastPrompt targetRepo={targetRepo} />
              <Rules />
            </Task>
          </Parallel>
        ) : null}

        {reviewReady && panelFindings.length >= 2 && !reviewSynth ? (
          <Task id="review:synthesis" output={outputs.reviewSynthesis} agent={fable}>
            <ReviewSynthesisPrompt findings={JSON.stringify(panelFindings, null, 2)} />
            <Rules />
          </Task>
        ) : null}

        {/* ── 12. Polish: scan → fix → verify, seeded with the panel's mustFix list ── */}
        {reviewSynth && mustFix.length > 0 ? (
          <ScanFixVerify
            id="polish"
            scanner={sonnet}
            fixer={fableBuilder}
            verifier={codexVerifier}
            scanOutput={outputs.polishScan}
            fixOutput={outputs.polishFix}
            verifyOutput={outputs.polishVerify}
            reportOutput={outputs.polishReport}
            maxRetries={2} // ScanFixVerify runs ALL iterations (no early exit) — sized deliberately; its fixer is a single task, not per-issue fan-out
          >
            <PolishScanPrompt targetRepo={targetRepo} mustFix={JSON.stringify(mustFix, null, 2)} />
          </ScanFixVerify>
        ) : null}

        {/* ── 13. Report of record + delivery gate ── */}
        {reviewSynth && polishDone ? (
          <Task id="report:gather" output={outputs.reportGather}>
            {() => gatherReportInputs(implRunId)}
          </Task>
        ) : null}

        {gather ? (
          <Task id="report:final" output={outputs.finalReport} agent={fable} heartbeatTimeoutMs={900_000}>
            <ReportFinalPrompt
              reviewSynth={JSON.stringify(reviewSynth ?? {}, null, 2)}
              implRunId={implRunId}
              parentRunId={ctx.runId}
            />
            <Rules />
          </Task>
        ) : null}

        {finalReport && review && !gateRow("gate:delivery") ? (
          <Approval
            id="gate:delivery"
            output={outputs.gate}
            request={{
              title: "Accept delivery? (opens a PR — never merges)",
              summary: `${finalReport.summary}\n\nReport: ${finalReport.artifactPath}\nApprove to push the integration branch and open a PR against ${baseBranch}. Merging remains a human act.`,
            }}
            onDeny="continue"
          />
        ) : null}

        {finalReport && deliveryApproved && finalReport.status !== "cancelled" ? (
          <Task id="delivery" output={outputs.delivery} agent={fableBuilder}>
            <DeliveryPrompt
              targetRepo={targetRepo}
              baseBranch={baseBranch}
              reportPath={finalReport.artifactPath ?? ""}
            />
            <Rules />
          </Task>
        ) : null}

        {/* ── Terminal output: the run's printed result. Gated on a finalReport row
               (written by every terminal path) so it runs LAST — after delivery when
               that happened — and surfaces a concise, human-meaningful summary instead
               of an empty output. Pure aggregation; no new work. ── */}
        {terminalReport ? (
          <Task id="output" output={outputs.output}>
            {{
              route: routeTier ?? "unknown",
              status: terminalReport.status ?? "incomplete",
              summary: terminalReport.summary ?? "",
              reportPath: terminalReport.artifactPath ?? null,
              branch: deliveryOut?.branch ?? null,
              prUrl: deliveryOut?.prUrl ?? null,
              filesChanged: directResult?.filesChanged ?? [],
              ticketCount: (tickets?.tickets ?? []).length,
              mustFixCount: (reviewSynth?.mustFix ?? []).length,
              implRunId: launched ? implRunId : null,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
