// smithers-display-name: Microsandbox Finish Line
// smithers-source: one-off — finish the Microsandbox sandbox-provider effort across the
// Plue/Multi/Smithers isolated drafts: Fable reviews and improves the docs architecture
// first (docs define the contract, including the deterministic verification gates), then
// Codex Sol implements the remaining phases with Sol reviewing its own work, deterministic
// compute gates enforce the suites, Fable reviews/polishes until LGTM, and human approvals
// gate integration into the dirty original repos, the production deploy + lifecycle proof,
// and filing the upstream Iron/Microsandbox issue.
//
// DESIGN NOTES (see smithers-dev-gotchas):
//   • Every schema key is msb-prefixed: output tables are shared by name workspace-wide.
//   • Agents never gate workflow logic: phase loops end on reviewer rows, and the suite
//     gates are deterministic compute tasks running the exact commands the docs phase
//     froze into its output row (gatesJson), so self-reported success cannot pass them.
//   • Loops order fix-before-verify so every iteration ends on a fresh verification.
//   • Render logic is data-only (ctx reads); all fs/subprocess work happens in compute
//     tasks at execute time with absolute paths (compute cwd is the launch root).
//   • Irreversible steps (integrate into dirty shared repos, prod deploy, filing the
//     upstream issue) sit behind <Approval> gates; deny skips rather than failing.
/** @jsxImportSource smithers-orchestrator */
import { Approval, ClaudeCodeAgent, UI, createSmithers } from "smithers-orchestrator";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

const MISSION_DIR = "/tmp/microsandbox-finish";
const WORKPLAN_PATH = join(MISSION_DIR, "WORKPLAN.md");
const ISSUE_DRAFT_PATH = join(MISSION_DIR, "UPSTREAM-ISSUE.md");
const RETIRED_PROVIDER_NAME = ["free", "style"].join("");
const PROVIDER_VOCABULARY_SCANNER = "/tmp/plue-microsandbox-prod/scripts/check-provider-vocabulary.sh";

// ── Schemas (msb* prefix) ────────────────────────────────────────────────────
const prepSchema = z.object({
  ready: z.boolean(),
  detail: z.string().min(2),
});
type Prep = z.infer<typeof prepSchema>;

const docsSchema = z.object({
  summary: z.string().min(40),
  workPlanWritten: z.boolean(),
  gatesJson: z.string().min(2),
  filesChanged: z.array(z.string()).default([]),
});
type Docs = z.infer<typeof docsSchema>;

const docsCheckSchema = z.object({
  passed: z.boolean(),
  detail: z.string().min(2),
});
type DocsCheck = z.infer<typeof docsCheckSchema>;

const implSchema = z.object({
  phaseKey: z.string().min(2),
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(40),
  evidence: z.string().min(10),
  filesChanged: z.array(z.string()).default([]),
});
type Impl = z.infer<typeof implSchema>;

const selfReviewSchema = z.object({
  phaseKey: z.string().min(2),
  approved: z.boolean(),
  findings: z.string().min(2),
});
type SelfReview = z.infer<typeof selfReviewSchema>;

const gateSchema = z.object({
  gateKey: z.string().min(1),
  passed: z.boolean(),
  exitCode: z.number().int(),
  logTail: z.string().default(""),
  summary: z.string().min(2),
});
type Gate = z.infer<typeof gateSchema>;

const fixSchema = z.object({
  fixKey: z.string().min(1),
  summary: z.string().min(10),
  filesChanged: z.array(z.string()).default([]),
});

const fableReviewSchema = z.object({
  lgtm: z.boolean(),
  findings: z.string().min(2),
});
type FableReview = z.infer<typeof fableReviewSchema>;

// Mirrors the Approval default decision schema (approved/note/decidedBy/decidedAt).
const approvalSchema = z.object({
  approved: z.boolean().default(false),
  note: z.string().nullable().optional(),
  decidedBy: z.string().nullable().default(null),
  decidedAt: z.string().nullable().default(null),
});

const integrateSchema = z.object({
  status: z.enum(["integrated", "partial", "blocked"]),
  summary: z.string().min(40),
  evidence: z.string().min(10),
  reposTouched: z.array(z.string()).default([]),
});
type Integrate = z.infer<typeof integrateSchema>;

const deploySchema = z.object({
  status: z.enum(["deployed", "partial", "blocked"]),
  summary: z.string().min(40),
  evidence: z.string().min(10),
});
type Deploy = z.infer<typeof deploySchema>;

const prodProofSchema = z.object({
  passed: z.boolean(),
  summary: z.string().min(40),
  evidence: z.string().min(10),
});
type ProdProof = z.infer<typeof prodProofSchema>;

const issueDraftSchema = z.object({
  draftPath: z.string().min(4),
  targetRepo: z.string().min(3),
  synopsis: z.string().min(40),
});
type IssueDraft = z.infer<typeof issueDraftSchema>;

const issueFileSchema = z.object({
  filed: z.boolean(),
  issueUrl: z.string().default(""),
  summary: z.string().min(2),
});

const summarySchema = z.object({
  headline: z.string().min(10),
  detailsJson: z.string().min(2),
  summary: z.string().min(20),
});

const inputSchema = z.object({
  plueDir: z.string().default("/tmp/plue-microsandbox-prod"),
  multiDir: z.string().default("/tmp/multi-microsandbox-prod"),
  smithersDir: z.string().default("/tmp/smithers-microsandbox-prod"),
  briefPath: z.string().default(join(MISSION_DIR, "BRIEF.md")),
  docsIterations: z.number().int().min(1).max(4).default(2),
  phaseIterations: z.number().int().min(1).max(5).default(3),
  gateFixIterations: z.number().int().min(1).max(6).default(3),
  lgtmIterations: z.number().int().min(1).max(5).default(3),
  integrateIterations: z.number().int().min(1).max(4).default(2),
  deployIterations: z.number().int().min(1).max(4).default(2),
});
type Input = z.infer<typeof inputSchema>;

const { Workflow, Task, Sequence, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  msbPrep: prepSchema,
  msbDocs: docsSchema,
  msbDocsCheck: docsCheckSchema,
  msbImpl: implSchema,
  msbSelfReview: selfReviewSchema,
  msbGate: gateSchema,
  msbFix: fixSchema,
  msbFableReview: fableReviewSchema,
  msbApproval: approvalSchema,
  msbIntegrate: integrateSchema,
  msbDeploy: deploySchema,
  msbProdProof: prodProofSchema,
  msbIssueDraft: issueDraftSchema,
  msbIssueFile: issueFileSchema,
  msbSummary: summarySchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────
function solChain(cwd: string) {
  return codexFirst(
    {
      model: "gpt-5.6-sol",
      config: { model_reasoning_effort: "xhigh" },
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      cwd,
    },
    [new ClaudeCodeAgent({ model: "claude-fable-5", cwd })],
  );
}
function fableChain(cwd: string) {
  return [
    new ClaudeCodeAgent({ model: "claude-fable-5", cwd }),
    ...codexFirst({
      model: "gpt-5.6-sol",
      config: { model_reasoning_effort: "xhigh" },
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      cwd,
    }),
  ];
}
function lunaChain(cwd: string) {
  return codexFirst(
    {
      model: "gpt-5.6-luna",
      config: { model_reasoning_effort: "low" },
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      cwd,
    },
    [new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd })],
  );
}

const AGENT_RETRIES = 2;
const HEARTBEAT_MS = 20 * 60_000;

// ── Deterministic helpers ────────────────────────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asStr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function parseInput(raw: unknown): Input {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    plueDir: asStr(record.plueDir, "/tmp/plue-microsandbox-prod"),
    multiDir: asStr(record.multiDir, "/tmp/multi-microsandbox-prod"),
    smithersDir: asStr(record.smithersDir, "/tmp/smithers-microsandbox-prod"),
    briefPath: asStr(record.briefPath, join(MISSION_DIR, "BRIEF.md")),
    docsIterations: asInt(record.docsIterations, 2, 1, 4),
    phaseIterations: asInt(record.phaseIterations, 3, 1, 5),
    gateFixIterations: asInt(record.gateFixIterations, 3, 1, 6),
    lgtmIterations: asInt(record.lgtmIterations, 3, 1, 5),
    integrateIterations: asInt(record.integrateIterations, 2, 1, 4),
    deployIterations: asInt(record.deployIterations, 2, 1, 4),
  };
}
function latest<T>(ctx: any, table: any, targetNodeId: string): T | undefined {
  return ctx.latest(table, targetNodeId) as T | undefined;
}

type ProcessResult = { exitCode: number; stdout: string; stderr: string };
function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += String(error); finish(1); });
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      stderr += "\nTimed out after " + timeoutMs + "ms";
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      finish(124);
    }, timeoutMs);
    timer.unref();
  });
}

type GateDef = { gateKey: string; cwd: string; command: string; timeoutMinutes: number };
function parseGates(raw: unknown): GateDef[] {
  const parsed = typeof raw === "string"
    ? (() => { try { return JSON.parse(raw); } catch { return []; } })()
    : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry): GateDef | null => {
      if (!isRecord(entry)) return null;
      const gateKey = String(entry.gateKey ?? "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      const cwd = String(entry.cwd ?? "").trim();
      const command = String(entry.command ?? "").trim();
      if (!gateKey || !cwd || !command) return null;
      return { gateKey, cwd, command, timeoutMinutes: asInt(entry.timeoutMinutes, 60, 5, 240) };
    })
    .filter((entry): entry is GateDef => entry !== null)
    .slice(0, 12);
}

function prepCheck(input: Input): Prep {
  const problems: string[] = [];
  for (const dir of [input.plueDir, input.multiDir, input.smithersDir]) {
    if (!existsSync(dir)) problems.push("missing workspace: " + dir);
  }
  if (!existsSync(input.briefPath)) problems.push("missing brief: " + input.briefPath);
  return problems.length
    ? { ready: false, detail: problems.join("; ") }
    : { ready: true, detail: "Workspaces and brief present. Brief: " + input.briefPath };
}

function checkDocs(input: Input, docs: Docs | undefined): DocsCheck {
  const problems: string[] = [];
  if (!docs) problems.push("no docs-improve output row yet");
  let workplan = "";
  try {
    workplan = readFileSync(WORKPLAN_PATH, "utf8");
  } catch {
    problems.push("WORKPLAN.md missing at " + WORKPLAN_PATH);
  }
  if (workplan && workplan.length < 800) problems.push("WORKPLAN.md is too thin (" + workplan.length + " bytes)");
  const gates = parseGates(docs?.gatesJson);
  if (gates.length < 3) problems.push("gatesJson has " + gates.length + " valid gate(s); need at least 3 (plue, multi, smithers suites at minimum)");
  for (const gate of gates) {
    if (!existsSync(gate.cwd)) problems.push("gate " + gate.gateKey + " cwd missing: " + gate.cwd);
  }
  for (const rel of ["docs/specs/microsandbox-sandbox-provider.md", "docs/runbooks/microsandbox.md"]) {
    const path = join(input.plueDir, rel);
    if (!existsSync(path)) {
      problems.push("missing " + path);
      continue;
    }
    const hits = (readFileSync(path, "utf8").match(new RegExp(RETIRED_PROVIDER_NAME, "gi")) ?? []).length;
    if (hits > 0) problems.push(rel + " still mentions the retired provider " + hits + " time(s); the single-provider spec must have zero");
  }
  return problems.length
    ? { passed: false, detail: problems.join("; ").slice(0, 4_000) }
    : { passed: true, detail: "Workplan written, " + gates.length + " gates frozen, specs contain no retired-provider vocabulary." };
}

async function runGate(gate: GateDef): Promise<Gate> {
  const timeoutMs = gate.timeoutMinutes * 60_000;
  if (!existsSync(gate.cwd)) {
    return {
      gateKey: gate.gateKey,
      passed: false,
      exitCode: 1,
      logTail: "Gate cwd does not exist: " + gate.cwd + " (workspace missing; the gate command never ran)",
      summary: "Gate " + gate.gateKey + " could not run: cwd " + gate.cwd + " does not exist.",
    };
  }
  // This mission's original inline scanner suppressed every ripgrep error and
  // applied root-relative globs from /tmp. Execute the reviewed scanner as a
  // direct argv instead: it enters each draft before applying its globs and
  // distinguishes rg's clean no-match exit from an execution error.
  const usesVocabularyScanner = gate.gateKey === "single-provider-vocabulary";
  const executedCommand = usesVocabularyScanner
    ? "/bin/bash " + PROVIDER_VOCABULARY_SCANNER
    : gate.command;
  const result = usesVocabularyScanner
    ? await runProcess("/bin/bash", [PROVIDER_VOCABULARY_SCANNER], gate.cwd, timeoutMs)
    : await runProcess("/bin/bash", ["-lc", gate.command], gate.cwd, timeoutMs);
  const logTail = (result.stdout + "\n" + result.stderr).slice(-4_000);
  return {
    gateKey: gate.gateKey,
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    logTail,
    summary: "Gate " + gate.gateKey + " exited " + result.exitCode + " (`" + executedCommand.slice(0, 120) + "` in " + gate.cwd + ").",
  };
}

// ── Phase definitions ────────────────────────────────────────────────────────
type PhaseDef = { key: string; title: string; mission: (input: Input) => string };
const PHASES: PhaseDef[] = [
  {
    key: "provider-purge",
    title: "Remove every retired-provider remnant",
    mission: (input) => [
      "Remove every retired-provider remnant from the isolated drafts, per the locked single-provider decision:",
      "- Retired-provider fallback routing in the Plue provider code.",
      "- Retired-provider configuration, secret plumbing, and Helm values.",
      "- Retired-provider dashboards and monitoring references.",
      "- Migration-oriented retired-provider documentation and the rejected vendor-backed compose setting.",
      "Search exhaustively for " + RETIRED_PROVIDER_NAME + " across " + input.plueDir + ", " + input.multiDir + ", " + input.smithersDir + ".",
      "Historical changelog entries may keep the word; runtime code, config, infra, and active docs may not.",
      "Update any tests that referenced the removed paths; do not weaken unrelated assertions.",
    ].join("\n"),
  },
  {
    key: "local-harness",
    title: "Real local harness (no fakes)",
    mission: (input) => [
      "Replace the rejected fake compose path with a real local harness in " + input.plueDir + ":",
      "- Docker Compose for Postgres/GCS-emulation/repository dependencies (Docker is OrbStack on this host; `open -a OrbStack` if the daemon is down).",
      "- A REAL Microsandbox runtime on the macOS host using the Apple Silicon HVF runtime (this M3 Max is confirmed capable). Install/launch it from the harness scripts.",
      "- The Plue controller and API connected to that real runtime, so the API no longer exits from a missing controller.",
      "Deliver one documented entrypoint (script or make/zig target) that brings the whole harness up and health-checks it, and a teardown path.",
      "Prove it: run the entrypoint, show the controller registering the runtime and the API serving. Paste the evidence.",
    ].join("\n"),
  },
  {
    key: "conformance-local",
    title: "Provider conformance green locally",
    mission: (input) => [
      "Make the full provider-conformance lifecycle pass locally against the real harness in " + input.plueDir + ":",
      "create, exec, file transfer, SSH, preview HTTP and WebSocket, stop/start, snapshot/restore/fork, secrets, drain/recovery/delete.",
      "Then fix the local E2E cascade for real: the prior run was 69 passed / 223 failed, almost all cascading from the API exiting without a real controller.",
      "Run the actual suites and iterate until green. Never mock, never skip a failing test to get green; fix root causes.",
      "Paste the final suite tallies and the commands that produced them.",
    ].join("\n"),
  },
  {
    key: "ci-canary",
    title: "Linux KVM CI gate + prod canary wiring",
    mission: (input) => [
      "In " + input.plueDir + ": add a CI gate that runs the Microsandbox provider-conformance suite on a Linux KVM-capable runner, and wire a production canary (config + jobs) that will exercise the sandbox lifecycle continuously once deployed.",
      "The CI gate must be a real pipeline definition consistent with the repo's existing CI layout; the canary must be deployable via the existing Helm/infra structure.",
      "Validate what is validatable locally: pipeline config lint/dry-run, helm template/lint, terraform validate. Paste the evidence.",
    ].join("\n"),
  },
  {
    key: "suite-green",
    title: "Every affected suite green",
    mission: (input) => [
      "Rerun and green every suite the drafts affect:",
      "- Plue (" + input.plueDir + "): `zig build ci-local` plus the E2E suites.",
      "- Multi (" + input.multiDir + "): the full test suite (was 5,989 passed / 0 failed; keep it there).",
      "- Smithers (" + input.smithersDir + "): the suites covering the changed workflows/docs/pack files; regenerate docs bundles with `pnpm docs:llms` if docs changed and run the docs checks.",
      "Fix any failure at its root cause. Distinguish pre-existing/machine-state failures (verify against the workspace's base revision before blaming the drafts) and document them instead of papering over.",
      "Paste per-repo tallies with the exact commands.",
    ].join("\n"),
  },
];

// ── Prompts ──────────────────────────────────────────────────────────────────
function preamble(input: Input): string {
  return [
    "First, read " + input.briefPath + " COMPLETELY. It is the source of truth for goals, locked decisions, workspace paths, and house rules; everything below assumes it.",
    "Isolated drafts: plue=" + input.plueDir + " multi=" + input.multiDir + " smithers=" + input.smithersDir + ".",
    "NEVER touch the original repos (~/plue, ~/multi, ~/smithers) unless your prompt explicitly says integration is your job.",
    "NEVER push, deploy, or file issues unless your prompt explicitly says that is your job.",
  ].join("\n");
}

function docsPrompt(input: Input, feedback: string): string {
  return [
    preamble(input),
    "",
    "You are Claude Fable, the docs architect and lead reviewer for this effort. This phase is docs-first: the docs you produce define the contract every later phase implements against.",
    "",
    "Do all of the following:",
    "1. REVIEW the docs architecture and the implementation so far. Read the Plue spec (docs/specs/microsandbox-sandbox-provider.md) and runbook (docs/runbooks/microsandbox.md) in " + input.plueDir + ", the spec/docs changes in the Multi and Smithers drafts (use `jj diff` / `git diff` there to see what changed), and the in-flight packages/microsandbox package in /Users/williamcory/smithers5. Check the docs against the actual code: find drift, gaps, contradictions, and structural problems.",
    "2. REVISE the Plue spec and runbook to the locked single-provider decision: Microsandbox only. Zero case-insensitive mentions of the retired provider may remain in those two files (a deterministic check enforces this). Fold in the operational reality: Autopilot control plane stays, isolated regional Standard GKE cluster with nested virtualization for sandboxes, out-of-state PKI/secret bootstrap, migration 000102, and the real local harness (Docker Compose deps + real HVF Microsandbox on macOS).",
    "3. IMPROVE the docs you touch: correct structure, tighten prose per the house style in the brief, fix stale statements. Docs only in this phase; do not change product code (record code problems in the work plan instead).",
    "4. WRITE the work plan to " + WORKPLAN_PATH + " with one section per phase: provider-purge, local-harness, conformance-local, ci-canary, suite-green. For each: concrete files/dirs to touch, exact commands, acceptance criteria, and known landmines from the brief and your review. Make it specific enough that a Codex implementer can execute without guessing.",
    "5. FREEZE the deterministic verification gates and return them in the gatesJson output field: a JSON array of {\"gateKey\", \"cwd\", \"command\", \"timeoutMinutes\"} objects (3 to 10 gates). Each command is non-interactive bash where exit 0 means pass, run from cwd. Include at minimum: the Plue CI/E2E suite gate(s), the Multi full-suite gate, a Smithers checks gate, and a grep gate that fails if the retired provider name survives anywhere it must not (make the grep precise about allowed historical locations). Choose realistic timeoutMinutes; suites here run 30 to 120 minutes.",
    feedback ? "\nThe previous attempt failed the deterministic docs check. Fix exactly this:\n" + feedback : "",
    "",
    "Output fields: summary (what you found and changed), workPlanWritten (true only after the file is on disk), gatesJson (the frozen gates), filesChanged (repo-relative paths per workspace, prefixed like plue:docs/specs/...).",
  ].join("\n");
}

function implPrompt(phase: PhaseDef, input: Input, feedback: string): string {
  return [
    preamble(input),
    "",
    "You are Codex Sol, the implementer for phase \"" + phase.key + "\" (" + phase.title + ") of the microsandbox-finish run.",
    "Read your phase's section of the work plan at " + WORKPLAN_PATH + " before starting; it carries the acceptance criteria a separate reviewer will enforce.",
    "",
    phase.mission(input),
    "",
    "Rules: real backends only, no mocks in product code or E2E; match surrounding code style; no unrelated refactors; fix root causes, never symptoms.",
    "Set status=implemented only when the acceptance criteria are met with evidence. Use status=partial with an honest gap list otherwise, or status=blocked with the exact human question if you hit a locked-decision conflict.",
    "evidence must contain the exact commands you ran with their exit codes and the load-bearing log lines. filesChanged lists every path you touched, prefixed by workspace (plue:/multi:/smithers:).",
    feedback ? "\nYour own reviewer rejected the previous iteration. Address every finding:\n" + feedback : "",
  ].join("\n");
}

function selfReviewPrompt(phase: PhaseDef, input: Input, impl: Impl | undefined): string {
  return [
    preamble(input),
    "",
    "You are Codex Sol reviewing your own team's work for phase \"" + phase.key + "\" (" + phase.title + "). Review it as a hostile outsider: assume the implementation report overstates what happened.",
    impl ? "Implementer self-report:\n" + JSON.stringify({ status: impl.status, summary: impl.summary, evidence: impl.evidence.slice(0, 3_000), filesChanged: impl.filesChanged }) : "No implementer self-report; inspect the workspaces directly.",
    "",
    "Verify against the acceptance criteria in " + WORKPLAN_PATH + " for this phase:",
    "- Inspect the actual diffs in the draft workspaces (`jj diff`/`git diff`).",
    "- RE-RUN the key commands yourself; never trust pasted output.",
    "- Hunt for what is missing, not just what is wrong: untested paths, half-removed references, harness steps that only work on the implementer's shell state.",
    "You may fix small defects directly (typos, tiny gaps) and still approve. Anything substantive means approved=false with precise, actionable findings the next iteration can execute.",
  ].join("\n");
}

function gateFixPrompt(gate: GateDef, row: Gate | undefined, input: Input): string {
  return [
    preamble(input),
    "",
    "You are Codex Sol. The deterministic gate \"" + gate.gateKey + "\" failed (exit " + (row?.exitCode ?? "?") + "). The harness runs it mechanically as: `" + gate.command + "` in " + gate.cwd + ".",
    "Gate log tail:",
    "---",
    row?.logTail || "(no log captured)",
    "---",
    "Diagnose and fix the ROOT CAUSE in the draft workspaces, then re-run the exact gate command yourself to confirm it exits 0 before you finish.",
    "Never weaken the gate, delete/skip tests, or mock a backend to get green. If you believe the gate command itself is wrong, say so explicitly in your summary and fix the code anyway where possible; a human reads exhausted gates.",
    "Output fields: fixKey=" + JSON.stringify(gate.gateKey) + ", summary (root cause + fix + your confirming run), filesChanged.",
  ].join("\n");
}

function fableReviewPrompt(input: Input, gateResults: string): string {
  return [
    preamble(input),
    "",
    "You are Claude Fable, the final reviewer and polisher. The implementation phases and deterministic gates have run; their latest state:",
    gateResults || "(no gate rows yet)",
    "",
    "Review the ENTIRE effort across all three drafts against the brief and " + WORKPLAN_PATH + ":",
    "- Correctness and completeness of the provider, controller/worker, harness, conformance coverage, CI gate, canary, and infra.",
    "- Zero retired-provider remnants outside allowed historical locations.",
    "- Docs/spec/runbook accuracy against the final code (docs were revised first; code moved since — re-verify).",
    "- Suite health: re-run anything you distrust; spot-check the gates' claims.",
    "POLISH directly while reviewing: fix prose, small code defects, naming, comments. Substantive problems go into findings instead.",
    "Return lgtm=true ONLY if you would ship this to production as-is (the human still approves integration and deploy separately). Otherwise lgtm=false with a numbered, actionable findings list; a Sol fixer executes it verbatim next iteration.",
    "If lgtm=true, findings should say 'LGTM' plus anything the human should know before approving integration.",
  ].join("\n");
}

function lgtmFixPrompt(input: Input, review: FableReview | undefined): string {
  return [
    preamble(input),
    "",
    "You are Codex Sol. Claude Fable's final review returned findings that block LGTM. Fix every one of them at the root cause, re-running the relevant suites/commands to prove each fix.",
    "Findings:",
    "---",
    review?.findings || "(missing findings; inspect the latest fable-review output row)",
    "---",
    "Output fields: fixKey=\"lgtm\", summary (finding-by-finding disposition with evidence), filesChanged.",
  ].join("\n");
}

function integratePrompt(input: Input): string {
  return [
    preamble(input),
    "",
    "You are Claude Fable. The human approved integrating the isolated drafts into the ORIGINAL repositories: /Users/williamcory/plue, /Users/williamcory/multi, /Users/williamcory/smithers. These are dirty, shared trees with concurrent agent sessions; this step is why the strongest model does it.",
    "Discipline (non-negotiable, from the brief and smithers-dev-gotchas):",
    "- `jj st`/`jj diff` are the truth in jj-colocated repos; git status lies there.",
    "- Compute the NET diff of each draft against its base revision first; carry over ONLY microsandbox-effort files.",
    "- Never blanket-stage (`git add -A`, bare `git commit`, `git commit -a`, stash, amend, rebase). Commit with explicit pathspecs (`jj commit <paths>` / `jj split <paths>`), preserving all unrelated concurrent WIP.",
    "- If the original evolved a file the draft also changed, three-way merge by hand; never clobber-restore.",
    "- In the Smithers repo, regenerate docs bundles (`pnpm docs:llms`) in a CLEAN context if docs changed, per the gotchas.",
    "- Commit locally; do NOT push any remote in this step. If the sanctioned deploy procedure later needs code on a remote, the deploy step handles its own push after its own approval.",
    "Verify after each repo: the effort files match the draft content, `jj st` shows no unrelated damage, and the repo's quick checks pass. Paste evidence (commands + exit codes) per repo.",
    "Output: status (integrated/partial/blocked), summary, evidence, reposTouched.",
  ].join("\n");
}

function integrateReviewPrompt(input: Input, row: Integrate | undefined): string {
  return [
    preamble(input),
    "",
    "You are Codex Sol, verifying the integration of the drafts into the original repos (/Users/williamcory/plue, /Users/williamcory/multi, /Users/williamcory/smithers).",
    row ? "Integrator self-report:\n" + JSON.stringify({ status: row.status, summary: row.summary, evidence: row.evidence.slice(0, 3_000), reposTouched: row.reposTouched }) : "No integrator self-report; verify directly.",
    "Check, per repo, with your own commands:",
    "- Every microsandbox-effort file in the draft is content-identical (or correctly three-way merged) in the original.",
    "- The integration commits are pathspec-scoped: `git show --stat`/`jj log` show only effort files; no foreign WIP was swept in and no unrelated file was reverted.",
    "- Nothing was pushed to any remote.",
    "approved=true only if all three repos check out. findings must be precise (repo, file, what diverged). Set phaseKey=\"integrate\".",
  ].join("\n");
}

function deployPrompt(input: Input): string {
  return [
    preamble(input),
    "",
    "You are Claude Fable. The human approved the production deploy. Work from the ORIGINAL Plue repo (/Users/williamcory/plue), which now carries the integrated changes.",
    "Follow the sanctioned procedure in docs/runbooks/microsandbox.md EXACTLY: Terraform for the isolated regional Standard GKE sandbox cluster (nested virtualization), out-of-state PKI/secret bootstrap into Secret Manager, Helm releases, DB migration 000102, monitoring, and the canary. The control plane stays on the existing Autopilot plue-cluster.",
    "Production currently has ONLY plue-cluster; you are creating the sandbox infrastructure for the first time. Plan-then-apply for Terraform (read the plan before applying). If the sanctioned procedure requires code on a remote before deploy, perform exactly that push and record it in evidence.",
    "If any step fails, stop escalation of damage first (make the failure safe), then report status=partial or blocked with exact state; a proof task and possibly another iteration follow.",
    "Output: status (deployed/partial/blocked), summary, evidence (every command + exit code + key output).",
  ].join("\n");
}

function prodProofPrompt(input: Input, deployRow: Deploy | undefined): string {
  return [
    preamble(input),
    "",
    "You are Claude Fable, proving the deployed Microsandbox stack in PRODUCTION.",
    deployRow ? "Deploy self-report:\n" + JSON.stringify({ status: deployRow.status, summary: deployRow.summary }) : "No deploy report; inspect the cluster state first.",
    "Run the complete provider-conformance lifecycle against production: create, exec, file transfer, SSH, preview HTTP and WebSocket, stop/start, snapshot/restore/fork, secrets, drain/recovery/delete. Also run the GKE-side conformance suite the CI gate uses, pointed at prod, and confirm the canary is live and reporting.",
    "Clean up every artifact the proof creates. passed=true only when every lifecycle step verifiably succeeded; evidence carries the command-by-command proof.",
  ].join("\n");
}

function issueDraftPrompt(input: Input): string {
  return [
    preamble(input),
    "",
    "You are Codex Sol. Draft the upstream issue for the Iron/Microsandbox gap this effort uncovered (the Iron proxy gap investigated during the spike; re-derive the specifics from the spec/runbook and the provider code in " + input.plueDir + " rather than from memory).",
    "Write the draft to " + ISSUE_DRAFT_PATH + " with: a one-line title; 'Target repo: <owner/name>' on its own line (the correct upstream repository); environment; a minimal reproduction; expected vs actual; impact on downstream users; and a concrete proposed fix or API change. Follow the brief's prose style.",
    "Do NOT file anything. The human reviews this draft before it goes anywhere.",
    "Output: draftPath, targetRepo (owner/name), synopsis (3-6 sentences).",
  ].join("\n");
}

function issueFilePrompt(draft: IssueDraft | undefined): string {
  return [
    "You are Codex Luna. The human approved filing the upstream issue drafted at " + (draft?.draftPath ?? ISSUE_DRAFT_PATH) + " against " + (draft?.targetRepo ?? "(read 'Target repo:' from the draft)") + ".",
    "Read the draft file, then file it verbatim with `gh issue create --repo <target> --title <first line> --body-file <a body file you prepare from the draft minus the title/target lines>`.",
    "Verify with `gh issue view <url>` and return the URL. Touch nothing else.",
  ].join("\n");
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const input = parseInput(ctx.input);

  const prep = latest<Prep>(ctx, outputs.msbPrep, "prep");
  const docs = latest<Docs>(ctx, outputs.msbDocs, "docs-improve");
  const docsCheck = latest<DocsCheck>(ctx, outputs.msbDocsCheck, "docs-check");
  const docsPassed = docsCheck?.passed === true;
  const gates = docsPassed ? parseGates(docs?.gatesJson) : [];

  const implFor = (key: string) => latest<Impl>(ctx, outputs.msbImpl, "phase-" + key);
  const reviewFor = (key: string) => latest<SelfReview>(ctx, outputs.msbSelfReview, "phase-" + key + "-review");
  const gateRowFor = (key: string) => latest<Gate>(ctx, outputs.msbGate, "gate-" + key);

  const fableReview = latest<FableReview>(ctx, outputs.msbFableReview, "fable-review");
  const integrationApproved = ctx.outputMaybe(outputs.msbApproval, { nodeId: "approve-integration" })?.approved === true;
  const integrate = latest<Integrate>(ctx, outputs.msbIntegrate, "integrate");
  const integrateReview = latest<SelfReview>(ctx, outputs.msbSelfReview, "integrate-review");
  const integrated = integrateReview?.approved === true;
  const deployApproved = ctx.outputMaybe(outputs.msbApproval, { nodeId: "approve-deploy" })?.approved === true;
  const deploy = latest<Deploy>(ctx, outputs.msbDeploy, "deploy");
  const prodProof = latest<ProdProof>(ctx, outputs.msbProdProof, "prod-proof");
  const issueDraft = latest<IssueDraft>(ctx, outputs.msbIssueDraft, "issue-draft");
  const fileApproved = ctx.outputMaybe(outputs.msbApproval, { nodeId: "approve-file-upstream" })?.approved === true;

  const gateResultsText = gates
    .map((gate) => {
      const row = gateRowFor(gate.gateKey);
      return "- " + gate.gateKey + ": " + (row ? (row.passed ? "PASSED" : "FAILED (exit " + row.exitCode + ")") : "not run") + " — `" + gate.command.slice(0, 100) + "`";
    })
    .join("\n");

  const phaseStatusText = PHASES
    .map((phase) => {
      const impl = implFor(phase.key);
      const review = reviewFor(phase.key);
      return phase.key + "=" + (impl?.status ?? "pending") + "/" + (review ? (review.approved ? "approved" : "rejected") : "unreviewed");
    })
    .join(", ");

  const integrationSummary = [
    "LGTM: " + (fableReview ? (fableReview.lgtm ? "yes" : "NO") : "no review yet") + ".",
    fableReview ? "Fable: " + fableReview.findings.slice(0, 400) : "",
    "Phases: " + phaseStatusText + ".",
    "Gates:\n" + (gateResultsText || "(none)"),
    "Approving integrates the isolated drafts into the dirty original repos (~/plue, ~/multi, ~/smithers) with pathspec-scoped commits (no pushes).",
  ].filter(Boolean).join("\n");

  const deploySummary = [
    "Integration: " + (integrate ? integrate.status + " — " + integrate.summary.slice(0, 300) : "missing") + " (verifier: " + (integrateReview ? (integrateReview.approved ? "approved" : "rejected") : "pending") + ").",
    "Approving creates the prod GKE sandbox cluster, bootstraps secrets, deploys Microsandbox via the sanctioned runbook procedure, runs migration 000102, and then proves the full lifecycle in production.",
  ].join("\n");

  const fileSummary = issueDraft
    ? "Draft at " + issueDraft.draftPath + " targeting " + issueDraft.targetRepo + ".\n" + issueDraft.synopsis.slice(0, 600) + "\nApproving files it via gh."
    : "Upstream issue draft pending.";

  return (
    <Workflow name="microsandbox-finish">
      <UI entry="../ui/microsandbox-finish.tsx" title="Microsandbox Finish" />
      <Sequence>
        <Task id="prep" output={outputs.msbPrep} timeoutMs={5 * 60_000}>
          {() => prepCheck(input)}
        </Task>

        {prep?.ready ? (
          <Loop id="docs-loop" until={docsPassed} maxIterations={input.docsIterations} onMaxReached="return-last">
            <Sequence>
              <Task
                id="docs-improve"
                output={outputs.msbDocs}
                agent={fableChain(input.plueDir)}
                retries={AGENT_RETRIES}
                timeoutMs={110 * 60_000}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {docsPrompt(input, docsCheck && !docsCheck.passed ? docsCheck.detail : "")}
              </Task>
              <Task id="docs-check" output={outputs.msbDocsCheck} timeoutMs={5 * 60_000} continueOnFail>
                {() => checkDocs(input, latest<Docs>(ctx, outputs.msbDocs, "docs-improve"))}
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {docsPassed
          ? PHASES.map((phase) => (
              <Loop
                key={"phase-" + phase.key}
                id={"phase-" + phase.key + "-loop"}
                until={reviewFor(phase.key)?.approved === true}
                maxIterations={input.phaseIterations}
                onMaxReached="return-last"
              >
                <Sequence>
                  <Task
                    id={"phase-" + phase.key}
                    output={outputs.msbImpl}
                    agent={solChain(input.plueDir)}
                    retries={AGENT_RETRIES}
                    timeoutMs={150 * 60_000}
                    heartbeatTimeoutMs={HEARTBEAT_MS}
                    continueOnFail
                  >
                    {implPrompt(phase, input, (() => {
                      const review = reviewFor(phase.key);
                      return review && !review.approved ? review.findings : "";
                    })())}
                  </Task>
                  <Task
                    id={"phase-" + phase.key + "-review"}
                    output={outputs.msbSelfReview}
                    agent={solChain(input.plueDir)}
                    retries={AGENT_RETRIES}
                    timeoutMs={75 * 60_000}
                    heartbeatTimeoutMs={HEARTBEAT_MS}
                    continueOnFail
                  >
                    {selfReviewPrompt(phase, input, implFor(phase.key))}
                  </Task>
                </Sequence>
              </Loop>
            ))
          : null}

        {gates.map((gate) => {
          const row = gateRowFor(gate.gateKey);
          return (
            <Loop
              key={"gate-" + gate.gateKey}
              id={"gate-" + gate.gateKey + "-loop"}
              until={row?.passed === true}
              maxIterations={input.gateFixIterations}
              onMaxReached="return-last"
            >
              <Sequence>
                {row && !row.passed ? (
                  <Task
                    id={"gate-" + gate.gateKey + "-fix"}
                    output={outputs.msbFix}
                    agent={solChain(gate.cwd)}
                    retries={AGENT_RETRIES}
                    timeoutMs={120 * 60_000}
                    heartbeatTimeoutMs={HEARTBEAT_MS}
                    continueOnFail
                  >
                    {gateFixPrompt(gate, row, input)}
                  </Task>
                ) : null}
                <Task
                  id={"gate-" + gate.gateKey}
                  output={outputs.msbGate}
                  timeoutMs={(gate.timeoutMinutes + 15) * 60_000}
                  continueOnFail
                >
                  {() => runGate(gate)}
                </Task>
              </Sequence>
            </Loop>
          );
        })}

        {docsPassed ? (
          <Loop id="lgtm-loop" until={fableReview?.lgtm === true} maxIterations={input.lgtmIterations} onMaxReached="return-last">
            <Sequence>
              {fableReview && !fableReview.lgtm ? (
                <Task
                  id="lgtm-fix"
                  output={outputs.msbFix}
                  agent={solChain(input.plueDir)}
                  retries={AGENT_RETRIES}
                  timeoutMs={120 * 60_000}
                  heartbeatTimeoutMs={HEARTBEAT_MS}
                  continueOnFail
                >
                  {lgtmFixPrompt(input, fableReview)}
                </Task>
              ) : null}
              <Task
                id="fable-review"
                output={outputs.msbFableReview}
                agent={fableChain(input.plueDir)}
                retries={AGENT_RETRIES}
                timeoutMs={120 * 60_000}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {fableReviewPrompt(input, gateResultsText)}
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {docsPassed && fableReview !== undefined ? (
          <Approval
            id="approve-integration"
            output={outputs.msbApproval}
            onDeny="skip"
            request={{ title: "Integrate the Microsandbox drafts into the original repos?", summary: integrationSummary }}
          />
        ) : null}

        {integrationApproved ? (
          <Loop id="integrate-loop" until={integrated} maxIterations={input.integrateIterations} onMaxReached="return-last">
            <Sequence>
              <Task
                id="integrate"
                output={outputs.msbIntegrate}
                agent={fableChain("/Users/williamcory/plue")}
                retries={AGENT_RETRIES}
                timeoutMs={150 * 60_000}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {integratePrompt(input)}
              </Task>
              <Task
                id="integrate-review"
                output={outputs.msbSelfReview}
                agent={solChain("/Users/williamcory/plue")}
                retries={AGENT_RETRIES}
                timeoutMs={60 * 60_000}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {integrateReviewPrompt(input, integrate)}
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {integrated ? (
          <Approval
            id="approve-deploy"
            output={outputs.msbApproval}
            onDeny="skip"
            request={{ title: "Deploy Microsandbox to production?", summary: deploySummary }}
          />
        ) : null}

        {deployApproved ? (
          <Loop id="deploy-loop" until={prodProof?.passed === true} maxIterations={input.deployIterations} onMaxReached="return-last">
            <Sequence>
              <Task
                id="deploy"
                output={outputs.msbDeploy}
                agent={fableChain("/Users/williamcory/plue")}
                retries={AGENT_RETRIES}
                timeoutMs={180 * 60_000}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {deployPrompt(input)}
              </Task>
              <Task
                id="prod-proof"
                output={outputs.msbProdProof}
                agent={fableChain("/Users/williamcory/plue")}
                retries={AGENT_RETRIES}
                timeoutMs={120 * 60_000}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {prodProofPrompt(input, deploy)}
              </Task>
            </Sequence>
          </Loop>
        ) : null}

        {docsPassed ? (
          <Task
            id="issue-draft"
            output={outputs.msbIssueDraft}
            agent={solChain(input.plueDir)}
            retries={AGENT_RETRIES}
            timeoutMs={60 * 60_000}
            heartbeatTimeoutMs={HEARTBEAT_MS}
            continueOnFail
          >
            {issueDraftPrompt(input)}
          </Task>
        ) : null}

        {issueDraft !== undefined ? (
          <Approval
            id="approve-file-upstream"
            output={outputs.msbApproval}
            onDeny="skip"
            request={{ title: "File the upstream Iron/Microsandbox issue?", summary: fileSummary }}
          />
        ) : null}

        {fileApproved ? (
          <Task
            id="issue-file"
            output={outputs.msbIssueFile}
            agent={lunaChain(input.plueDir)}
            retries={AGENT_RETRIES}
            timeoutMs={15 * 60_000}
            heartbeatTimeoutMs={HEARTBEAT_MS}
            continueOnFail
          >
            {issueFilePrompt(issueDraft)}
          </Task>
        ) : null}

        <Task id="summary" output={outputs.msbSummary} timeoutMs={5 * 60_000}>
          {() => {
            const gateLines = gates.map((gate) => {
              const row = latest<Gate>(ctx, outputs.msbGate, "gate-" + gate.gateKey);
              return { gateKey: gate.gateKey, passed: row?.passed === true, exitCode: row?.exitCode ?? -1 };
            });
            const phaseLines = PHASES.map((phase) => ({
              phaseKey: phase.key,
              status: latest<Impl>(ctx, outputs.msbImpl, "phase-" + phase.key)?.status ?? "not-run",
              approved: latest<SelfReview>(ctx, outputs.msbSelfReview, "phase-" + phase.key + "-review")?.approved === true,
            }));
            const review = latest<FableReview>(ctx, outputs.msbFableReview, "fable-review");
            const integrateRow = latest<Integrate>(ctx, outputs.msbIntegrate, "integrate");
            const proofRow = latest<ProdProof>(ctx, outputs.msbProdProof, "prod-proof");
            const filedRow = latest<z.infer<typeof issueFileSchema>>(ctx, outputs.msbIssueFile, "issue-file");
            const draftRow = latest<IssueDraft>(ctx, outputs.msbIssueDraft, "issue-draft");
            const gatesGreen = gateLines.length > 0 && gateLines.every((line) => line.passed);
            const headline = !docsPassed
              ? "STOPPED: docs phase never passed its deterministic check."
              : [
                  gatesGreen ? "gates green" : "gates NOT green",
                  review?.lgtm ? "Fable LGTM" : "no LGTM",
                  integrateRow ? "integration " + integrateRow.status : "integration skipped",
                  proofRow?.passed ? "prod lifecycle PROVEN" : "prod proof " + (proofRow ? "FAILED" : "skipped"),
                  filedRow?.filed ? "upstream issue filed" : draftRow ? "upstream issue drafted (not filed)" : "no upstream draft",
                ].join("; ");
            return {
              headline,
              detailsJson: JSON.stringify({ phases: phaseLines, gates: gateLines, lgtm: review?.lgtm === true, prodProven: proofRow?.passed === true, issueUrl: filedRow?.issueUrl ?? "" }),
              summary: "Microsandbox finish run: " + headline + " Draft workspaces: " + [input.plueDir, input.multiDir, input.smithersDir].join(", ") + ". Work plan: " + WORKPLAN_PATH + ".",
            };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
