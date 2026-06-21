// smithers-display-name: Context Engineering + Execution Levers
/** @jsxImportSource smithers-orchestrator */
/**
 * Ships the three execution levers from
 * `.smithers/specs/context-engineering-and-execution-levers.md`:
 *
 *   1. DOCS    (Opus 4.8)  fold the quality/cost/speed triad + smart zone +
 *                          context-engineering doctrine into ONE doc, add the
 *                          <Aspects>+<TryCatchFinally>+<ContinueAsNew> handoff
 *                          example, small user docs, agent-doc section.
 *   2. SIDECAR (Codex 5.5) a new <Sidecar> composite (cost lever) + tests + docs.
 *   3. SPEED   (Codex 5.5) event-driven re-render in a <Worktree>, opened as a PR.
 *
 * Each deliverable: PLAN -> human <Approval> (the cheap, high-leverage review)
 * -> build/validate/review <Loop> until Opus approves AND the deterministic gate
 * passes. Opus plans/reviews; Codex implements; the gates are real `pnpm`
 * commands (deterministic backpressure, not the agent's word).
 *
 * Practicing what the spec preaches: plan-the-validation, goal-based tasks,
 * smart-zone-sized work, e2e-as-bread-and-butter, sandwich delegation
 * (smart plans/reviews the ends, the implementer does the middle).
 */
import {
  Approval,
  ClaudeCodeAgent,
  CodexAgent,
  Panel,
  Parallel,
  Sequence,
  Task,
  Worktree,
  createSmithers,
  type AgentLike,
} from "smithers-orchestrator";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod/v4";

const SPEC = ".smithers/specs/context-engineering-and-execution-levers.md";

// ---- schemas ----
const inputSchema = z.object({
  specPath: z.string().default(SPEC),
  maxBuildIterations: z.number().int().min(1).max(6).default(3),
  // Per-deliverable toggles so a fresh run can do just the remaining work
  // (e.g. docs+sidecar already shipped → run speed-only).
  includeDocs: z.boolean().default(true),
  includeSidecar: z.boolean().default(true),
  includeSpeed: z.boolean().default(true),
});

const planSchema = z.object({
  deliverable: z.enum(["docs", "sidecar", "speed"]),
  approach: z.string().default(""),
  steps: z.array(z.string()).default([]),
  filesToChange: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
});

const planSynthesisSchema = z.object({
  deliverable: z.string().default("speed"),
  plan: z.string().default(""),
  steps: z.array(z.string()).default([]),
});

// Mirrors the Approval default decision schema (approved/note/decidedBy/decidedAt).
const approvalSchema = z.object({
  approved: z.boolean().default(false),
  note: z.string().nullable().optional(),
  decidedBy: z.string().nullable().default(null),
  decidedAt: z.string().nullable().default(null),
});

const buildSchema = z.object({
  deliverable: z.enum(["docs", "sidecar", "speed"]),
  status: z.enum(["implemented", "partial", "blocked"]).default("partial"),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});

const validationSchema = z.object({
  deliverable: z.enum(["docs", "sidecar", "speed"]),
  allPassed: z.boolean().default(false),
  summary: z.string().default(""),
  failing: z.string().default(""),
});

const reviewSchema = z.object({
  deliverable: z.enum(["docs", "sidecar", "speed"]),
  approved: z.boolean().default(false),
  feedback: z.string().default(""),
  blockingIssues: z.array(z.string()).default([]),
});

const prSchema = z.object({
  opened: z.boolean().default(false),
  url: z.string().default(""),
  summary: z.string().default(""),
});

const prepareSchema = z.object({
  specFound: z.boolean().default(false),
  summary: z.string().default(""),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  prepare: prepareSchema,
  plan: planSchema,
  planSynthesis: planSynthesisSchema,
  approval: approvalSchema,
  build: buildSchema,
  validation: validationSchema,
  review: reviewSchema,
  pr: prSchema,
});

// ---- agents (bypass flags so a detached run never blocks on a permission
//      prompt; NO cwd pinned so <Worktree> controls the dir) ----
const opus = new ClaudeCodeAgent({
  model: "claude-opus-4-8",
  permissionMode: "bypassPermissions",
  dangerouslySkipPermissions: true,
});
const codex = new CodexAgent({
  model: "gpt-5.5",
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
});
// Steered moderator: the bare-opus moderator once discarded the panelists'
// grounded findings (the #271 discovery) and synthesized a generic plan. This
// systemPrompt forces it to preserve concrete findings.
const speedModerator = new ClaudeCodeAgent({
  model: "claude-opus-4-8",
  permissionMode: "bypassPermissions",
  dangerouslySkipPermissions: true,
  systemPrompt:
    "You merge implementation plans into ONE strongest consolidated plan. PRESERVE the panelists' concrete grounded findings verbatim: exact file paths, line numbers, prior-PR references (e.g. #271), and what ALREADY exists in the code. Do NOT generalize, re-scope, or drift to a different layer than the panelists analyzed. Keep the best concrete steps, reconcile disagreements with code evidence. Output the consolidated plan + ordered steps.",
});

// Sandwich delegation: smart model plans/reviews; implementer does the middle.
const planners: { agent: AgentLike; role: string }[] = [
  { agent: opus, role: "panel-opus" },
  { agent: codex, role: "panel-codex" },
];
const docsAgent: AgentLike[] = [opus, codex]; // Opus writes docs (Codex failover)
const codeAgent: AgentLike[] = [codex, opus]; // Codex implements (Opus failover)
const reviewAgent: AgentLike[] = [opus, codex]; // Opus reviews
const RETRIES = 2;
const AGENT_TIMEOUT = 60 * 60_000;
const HEARTBEAT = 12 * 60_000;

// ---- vcs helpers (jj-colocated repo) ----
function jjCommit(): string {
  const r = spawnSync("jj", ["log", "-r", "@", "--no-graph", "--template", "commit_id"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || "main" : "main";
}
function repoRoot(): string {
  const r = spawnSync("jj", ["root"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : process.cwd();
}
const SPEED_BRANCH = "feat/rerender-trigger-observability";
const SPEED_WORKTREE = `${repoRoot()}/.smithers/workflows/.worktrees/rerender-trigger-observability`;

// ---- deterministic gate runner ----
function runGate(cwd: string, cmds: string[][], timeoutMs = 30 * 60_000) {
  const results = cmds.map((parts) => {
    const r = spawnSync(parts[0], parts.slice(1), { cwd, encoding: "utf8", env: { ...process.env }, timeout: timeoutMs });
    return {
      command: parts.join(" "),
      exitCode: r.status,
      tail: ((r.stderr || "") + "\n" + (r.stdout || "")).slice(-4000),
    };
  });
  const failed = results.filter((r) => r.exitCode !== 0);
  return {
    allPassed: failed.length === 0,
    summary: failed.length === 0 ? `All ${results.length} gate command(s) passed.` : `${failed.length}/${results.length} gate command(s) failed.`,
    failing: failed.map((r) => `$ ${r.command}\n${r.tail}`).join("\n\n---\n").slice(0, 12_000),
  };
}

// ---- prompt builders (point agents at the spec; keep them in the smart zone) ----
function planPrompt(deliverable: "docs" | "sidecar" | "speed"): string {
  return [
    `Read the spec first: ${SPEC} (the section "Deliverable ${deliverable === "docs" ? "1 — Docs" : deliverable === "sidecar" ? "2 — <Sidecar>" : "3 — Re-render trigger: explicit + observable contract"}", plus "The philosophy to encode", "Decisions already made", and "Ground-truth API facts").`,
    `Produce a PLAN for the "${deliverable}" deliverable ONLY. Planning only — do not edit, create, or delete any files.`,
    "Ground the plan in the real codebase: read the modules/files involved before proposing edits.",
    "Return: approach (a few sentences), steps (ordered, concrete edits), filesToChange (real paths), tests (the e2e + unit tests that will prove it works — name them and the assertion), risks (cross-file hazards, observability gaps).",
    `Set deliverable="${deliverable}" exactly. Plans must have teeth: name machine-checkable "done".`,
  ].join("\n\n");
}

function buildPrompt(deliverable: "docs" | "sidecar" | "speed", plan: string, feedback: string, inWorktree: boolean): string {
  const base = [
    `Read the spec: ${SPEC}. Implement the "${deliverable}" deliverable to its acceptance criteria.`,
    plan ? `Approved plan to follow:\n${plan}` : "",
    inWorktree ? "You are in an isolated worktree. Make ALL edits here; do not touch the main checkout." : "",
    deliverable === "docs"
      ? "Write the docs (Opus). House style: no em-dashes, no \"not X but Y\", no padding triads, no hedging. Fold the triad + smart zone + the full context-engineering doctrine into the SINGLE docs/guides/context-engineering.mdx. Add the runnable <Aspects>+<TryCatchFinally catchErrors={[\"ASPECT_BUDGET_EXCEEDED\"]}>+<ContinueAsNew> handoff example (a real file that `smithers graph` renders) and embed it. Add small user docs and a concise skills/smithers/SKILL.md section. FIX the stale '<Aspects> ... not implemented yet' line. Run `pnpm docs:llms` and commit the bundles."
      : deliverable === "sidecar"
        ? "Implement the <Sidecar> composite (Codex): packages/components/src/components/Sidecar.js + SidecarProps.ts, exported like the other composites, one export per file, colocated props, composing existing primitives + scorers. The sidecar (cheap model) runs continueOnFail and never affects the primary result; record the primary-vs-sidecar score delta. Add docs/components/sidecar.mdx + catalog entry. Run `pnpm docs:llms`."
        : "Per-completion re-render ALREADY ships (#271): the engine re-renders on every task completion and dispatches ready work without waiting for the slowest sibling. Do NOT re-implement dispatch. Make it an EXPLICIT, OBSERVABLE contract per the corrected Deliverable 3: (1) add a `trigger: { reason: 'task-finished' | ... }` to the scheduler render context and thread it makeWorkflowSession -> WorkflowDriver.renderAndSubmit -> engine.js driverRenderer.render -> persistDriverFrame; (2) record trigger.reason in the existing frame/commit event payload so a future agent can see WHY a frame rendered (do not add a breaking new event); (3) make engine.js requireRerenderOnOutputChange an opts-driven value defaulting true; (4) regenerate packages/components/src/index.d.ts so the stale 'Aspects enforcement not implemented' claim is gone. Default behavior stays identical.",
    "TESTING BAR: the feature is not done without an e2e test (no mocks) that proves it. Add unit tests too. CI runs with NO agent CLIs and NO browsers, so seed a fake agent / skip browser-only paths.",
    "Before returning status=implemented: run the real gates yourself (`pnpm typecheck` plus the deliverable's tests) and fix every prior feedback item. List exact commands in commandsRun. If a gate fails or was not run, return status=partial/blocked with the failure.",
    `Set deliverable="${deliverable}". Report summary + filesChanged.`,
    feedback ? `Fix this feedback from the previous iteration:\n${feedback}` : "",
  ];
  return base.filter(Boolean).join("\n\n");
}

function reviewPrompt(deliverable: "docs" | "sidecar" | "speed", validation: string): string {
  return [
    `You are the exacting reviewer for the "${deliverable}" deliverable. Read the spec: ${SPEC}. Run "git diff" (and "jj diff") to see the changes. Do not edit files.`,
    `Deterministic gate result:\n${validation || "(not yet run)"}`,
    "Judge against the acceptance criteria. Approve ONLY if: the work fully realizes the spec, the e2e test exists and genuinely proves the behavior, observability is adequate for a future agent to debug, and the deterministic gate passed. For docs, also confirm no em-dashes were added and the stale <Aspects> line is gone.",
    "Do not approve partial, speculative, or test-deleting work. Put every must-fix in blockingIssues with actionable feedback.",
    `Set deliverable="${deliverable}" and approved (boolean).`,
  ].join("\n\n");
}

// ---- per-deliverable state helpers ----
type Del = "docs" | "sidecar" | "speed";
function lastFor<T extends { deliverable: string }>(rows: T[] | undefined, d: Del): T | undefined {
  return [...(rows ?? [])].reverse().find((r) => r.deliverable === d);
}
function approvedGate(ctx: any, nodeId: string): boolean {
  return ctx.outputMaybe(outputs.approval, { nodeId })?.approved === true;
}
function buildDone(ctx: any, d: Del): boolean {
  const v = lastFor(ctx.outputs.validation, d);
  const r = lastFor(ctx.outputs.review, d);
  return Boolean(v?.allPassed && r?.approved);
}
function buildFeedback(ctx: any, d: Del): string {
  const v = lastFor(ctx.outputs.validation, d);
  const r = lastFor(ctx.outputs.review, d);
  const parts: string[] = [];
  if (v && !v.allPassed) parts.push(`GATE FAILED:\n${v.failing || v.summary}`);
  if (r && !r.approved) {
    parts.push(`REVIEW NOT APPROVED:\n${r.feedback}`);
    for (const b of r.blockingIssues ?? []) parts.push(`- ${b}`);
  }
  return parts.join("\n\n");
}
function planText(ctx: any, d: Del): string {
  if (d === "speed") {
    const s = lastFor(ctx.outputs.planSynthesis as any, "speed") ?? (ctx.outputs.planSynthesis ?? []).slice(-1)[0];
    if (s) return `${s.plan}\n\nSteps:\n${(s.steps ?? []).map((x: string, i: number) => `${i + 1}. ${x}`).join("\n")}`;
  }
  const p = lastFor(ctx.outputs.plan, d);
  return p ? `${p.approach}\n\nSteps:\n${(p.steps ?? []).map((x: string, i: number) => `${i + 1}. ${x}`).join("\n")}\n\nTests:\n${(p.tests ?? []).join("\n")}` : "";
}
function planSummary(ctx: any, d: Del): string {
  const t = planText(ctx, d);
  return t ? t.slice(0, 1800) : `(no plan captured for ${d})`;
}

// A build/validate/review loop for one deliverable. cwd is "main" or the worktree.
function BuildLoop({ ctx, d, cwd, inWorktree, gateCmds }: { ctx: any; d: Del; cwd: string; inWorktree: boolean; gateCmds: string[][] }) {
  return (
    <Loop id={`${d}-loop`} until={buildDone(ctx, d)} maxIterations={ctx.input?.maxBuildIterations ?? 3} onMaxReached="return-last">
      <Sequence>
        <Task id={`${d}-build`} output={outputs.build} agent={d === "docs" ? docsAgent : codeAgent} retries={RETRIES} timeoutMs={AGENT_TIMEOUT} heartbeatTimeoutMs={HEARTBEAT}>
          {buildPrompt(d, planText(ctx, d), buildFeedback(ctx, d), inWorktree)}
        </Task>
        <Task id={`${d}-validate`} output={outputs.validation}>
          {() => ({ deliverable: d, ...runGate(cwd, gateCmds) })}
        </Task>
        <Task id={`${d}-review`} output={outputs.review} agent={reviewAgent} retries={RETRIES} timeoutMs={AGENT_TIMEOUT} heartbeatTimeoutMs={HEARTBEAT}>
          {reviewPrompt(d, JSON.stringify(lastFor(ctx.outputs.validation, d) ?? {}, null, 2))}
        </Task>
      </Sequence>
    </Loop>
  );
}

export default smithers((ctx: any) => {
  const includeDocs = ctx.input?.includeDocs ?? true;
  const includeSidecar = ctx.input?.includeSidecar ?? true;
  const includeSpeed = ctx.input?.includeSpeed ?? true;
  const docsCwd = repoRoot();

  return (
    <Workflow name="context-engineering-levers">
      <Sequence>
        <Task id="prepare" output={outputs.prepare}>
          {() => ({
            specFound: existsSync(ctx.input?.specPath ?? SPEC),
            summary: `spec ${existsSync(ctx.input?.specPath ?? SPEC) ? "found" : "MISSING"} at ${ctx.input?.specPath ?? SPEC}`,
          })}
        </Task>

        {/* ============ DELIVERABLE 1: DOCS ============ */}
        {includeDocs ? (
          <Sequence>
            <Task id="plan-docs" output={outputs.plan} agent={docsAgent} retries={RETRIES} timeoutMs={AGENT_TIMEOUT} heartbeatTimeoutMs={HEARTBEAT}>
              {planPrompt("docs")}
            </Task>
            <Approval id="approve-docs" output={outputs.approval} onDeny="skip" request={{ title: "Approve the DOCS plan?", summary: planSummary(ctx, "docs") }} />
            {approvedGate(ctx, "approve-docs") ? (
              <BuildLoop ctx={ctx} d="docs" cwd={docsCwd} inWorktree={false} gateCmds={[["pnpm", "typecheck"], ["pnpm", "docs:llms"]]} />
            ) : null}
          </Sequence>
        ) : null}

        {/* ============ DELIVERABLE 2: SIDECAR ============ */}
        {includeSidecar ? (
          <Sequence>
            <Task id="plan-sidecar" output={outputs.plan} agent={planners.map((p) => p.agent)} retries={RETRIES} timeoutMs={AGENT_TIMEOUT} heartbeatTimeoutMs={HEARTBEAT}>
              {planPrompt("sidecar")}
            </Task>
            <Approval id="approve-sidecar" output={outputs.approval} onDeny="skip" request={{ title: "Approve the <Sidecar> plan?", summary: planSummary(ctx, "sidecar") }} />
            {approvedGate(ctx, "approve-sidecar") ? (
              <BuildLoop ctx={ctx} d="sidecar" cwd={docsCwd} inWorktree={false} gateCmds={[["pnpm", "typecheck"], ["pnpm", "-C", "packages/components", "test"]]} />
            ) : null}
          </Sequence>
        ) : null}

        {/* ============ DELIVERABLE 3: SPEED (worktree + PR) ============ */}
        {includeSpeed ? (
          <Sequence>
            <Panel
              id="plan-speed-obs"
              panelists={planners}
              moderator={speedModerator}
              panelistOutput={outputs.plan}
              moderatorOutput={outputs.planSynthesis}
              strategy="synthesize"
              maxConcurrency={2}
            >
              {planPrompt("speed")}
            </Panel>
            <Approval id="approve-speed-obs" output={outputs.approval} onDeny="skip" request={{ title: "Approve the RE-RENDER OBSERVABILITY plan? (opens a PR)", summary: planSummary(ctx, "speed") }} />
            {approvedGate(ctx, "approve-speed-obs") ? (
              <Worktree path={SPEED_WORKTREE} branch={SPEED_BRANCH} baseBranch={jjCommit()}>
                <Sequence>
                  <BuildLoop ctx={ctx} d="speed" cwd={SPEED_WORKTREE} inWorktree={true} gateCmds={[["pnpm", "typecheck"], ["pnpm", "-C", "packages/scheduler", "test"], ["pnpm", "-C", "packages/engine", "test"]]} />
                  {buildDone(ctx, "speed") ? (
                    <Task id="speed-pr" output={outputs.pr} timeoutMs={10 * 60_000}>
                      {() => {
                        const opts = { cwd: SPEED_WORKTREE, encoding: "utf8" as const, env: { ...process.env } };
                        spawnSync("jj", ["describe", "-m", "feat(engine): make per-completion re-render an explicit, observable contract"], opts);
                        spawnSync("jj", ["bookmark", "set", SPEED_BRANCH, "-r", "@"], opts);
                        const push = spawnSync("jj", ["git", "push", "--bookmark", SPEED_BRANCH, "--allow-new", "--remote", "origin"], opts);
                        const pr = spawnSync("gh", ["pr", "create", "--head", SPEED_BRANCH, "--base", "main", "--title", "feat(engine): re-render trigger reason + observability", "--body", "Per-completion re-render already ships (#271). This makes it an explicit, observable contract: a trigger reason threaded through the render context, recorded in the frame event so a future agent can see why a frame rendered, and requireRerenderOnOutputChange as a reversible option. Also regenerates the stale Aspects .d.ts. See .smithers/specs/context-engineering-and-execution-levers.md (Deliverable 3). Authored by a Smithers run.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"], opts);
                        const url = (pr.stdout || "").trim();
                        return {
                          opened: pr.status === 0,
                          url,
                          summary: pr.status === 0 ? `PR opened: ${url}` : `PR not opened. push=${push.status} pr=${pr.status}: ${(pr.stderr || "").slice(-1500)}`,
                        };
                      }}
                    </Task>
                  ) : null}
                </Sequence>
              </Worktree>
            ) : null}
          </Sequence>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
