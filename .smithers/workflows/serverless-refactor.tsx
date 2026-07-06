// smithers-source: user
// smithers-display-name: Serverless Refactor (Codex+Opus plan · Opus-synthesized review)
// smithers-description: Drive the serverless (@effect/platform) refactor + provider examples + evals as a task list. For EVERY task: Codex AND Claude Opus both PLAN (Opus synthesizes one plan) → implement → validate → Codex AND Opus both REVIEW (Opus synthesizes ONE verdict) → loop until approved, then open one PR per task in an isolated worktree.
// smithers-tags: refactor, serverless, cloudflare, vercel, effect-platform, plan, implement, review, panel, worktree
/** @jsxImportSource smithers-orchestrator */
//
// The orchestration pattern (what the user asked for)
// ---------------------------------------------------
// Per task, inside its own git worktree (branch serverless/<id> off main):
//   PLAN    → PlanPanel: providers.claudeOpus AND providers.codex each plan in
//             parallel, then Opus (moderator) SYNTHESIZES them into one plan.
//   BUILD   → ValidationLoop: implement (Codex-led) → validate (gate) → review
//             PANEL where Opus AND Codex each review in parallel and Opus
//             SYNTHESIZES their reviews into a single verdict — looping
//             implement→validate→review until the synthesized verdict approves
//             AND validation passes (or maxReviewIterations is hit).
//   SHIP    → open exactly ONE PR for the task (only when approved).
//
// Every role is a failover CHAIN (primary first, then rate-limit backups), so an
// "Opus" panelist stays Opus unless Opus is rate-limited, then falls back.
//
// Run it
// ------
//   # Preview (plan only — Codex+Opus plans + Opus synthesis, no edits, no PRs):
//   smithers up .smithers/workflows/serverless-refactor.tsx --input '{"dryRun":true}'
//
//   # Work specific tasks first, detached:
//   smithers up .smithers/workflows/serverless-refactor.tsx --detach --run-id sr \
//     --input '{"only":["1b-platform-layer","1c-command-seam"]}'
//
//   # Everything (one PR per task), sequential so we don't hammer main / rate limits:
//   smithers up .smithers/workflows/serverless-refactor.tsx --detach --run-id sr-all
//
// Caveats baked in (from plan-implement-review-issues / #297):
//  - Worktree paths are ABSOLUTE (relative paths anchor to the launch root).
//  - No `cwd` on tasks inside <Worktree> (it overrides the worktree + branch).
//  - ctx.input is NOT schema-defaulted at runtime, so every field is defaulted in code.
//  - Dependent refactor tasks (1b→1c→1d→1e→2a…) each open a PR off main; merge a
//    phase's PR before its dependents land, or run them in waves via `only`.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createSmithers, Parallel, Sequence, Task, Worktree, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { PlanPanel, planOutputSchema, planSynthesisSchema } from "../components/PlanPanel";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";

// ----------------------------------------------------------------------------
// Roles. Each is a failover chain: Smithers tries the first agent and, on a
// rate-limit / transient failure, falls through to the next.
//   Opus  = providers.claudeOpus (ClaudeCodeAgent, claude-opus-4-8)
//   Codex = providers.codex / codex1 (CodexAgent, gpt-5.5)
// The two PLAN panelists are Opus and Codex; the two REVIEW panelists are Opus
// and Codex; Opus is the moderator that synthesizes both plans and both reviews.
// ----------------------------------------------------------------------------
// Panelists as explicit failover chains (each panelist keeps its own backups).
const opusPanelist: AgentLike[] = [providers.claudeOpus, providers.claudeSonnet];
const codexPanelist: AgentLike[] = [providers.codex, providers.codex1];
// Review panel: two panelists (Opus, Codex), each a failover chain.
const panel = [opusPanelist, codexPanelist];
// Plan panel: two planners (Opus, Codex) as single agents (PlanPanel types
// panelists as AgentLike[]); the moderator + build loop provide the resilience.
const planPanel: AgentLike[] = [providers.claudeOpus, providers.codex];
// Opus synthesizes (moderator), with Sonnet as its rate-limit backup.
const opusModerator: AgentLike[] = [providers.claudeOpus, providers.claudeSonnet];
// Codex-led implementation middle (the repo's "sandwich"), Opus as backup.
const implementChain: AgentLike[] = [providers.codex, providers.codex1, providers.claudeOpus];
const validateChain: AgentLike[] = [providers.claudeSonnet, providers.codex];
const prChain: AgentLike[] = [providers.claudeSonnet, providers.claudeOpus, providers.codex];

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const taskSchema = z.object({
  id: z.string(), // short, unique, kebab-case (also the branch slug)
  title: z.string(), // PR title (prefer emoji + conventional-commit subject)
  goal: z.string(), // what to accomplish
  files: z.string().default(""), // file:line hints / area to touch
  done: z.string().default(""), // done-criteria (what "green" means)
  isolate: z.boolean().default(true), // run in its own worktree + PR (false = launch root, e.g. cross-repo)
});
type WorkTask = z.infer<typeof taskSchema>;

const prSchema = z.object({
  branch: z.string(),
  created: z.boolean().default(false),
  prNumber: z.number().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  landed: z.boolean().default(false),
  summary: z.string().default(""),
});

// ----------------------------------------------------------------------------
// Default task list = the serverless program (see the serverless-refactor-scope
// memory / docs/concepts/execution-model.mdx). Dependency order; run in waves.
// ----------------------------------------------------------------------------
const DEFAULT_TASKS: WorkTask[] = [
  {
    id: "1b-platform-layer",
    title: "♻️ refactor(engine): swap Bun globals + make platform layer injectable",
    goal:
      "Unblock the FULL engine on Node-based serverless (Vercel-Node/AWS/GCP/k8s). Replace Bun-only globals on the run loop with runtime-agnostic equivalents and make the @effect/platform layer swappable (Bun today, Node/Worker injectable) so the engine no longer hard-binds BunContext.",
    files:
      "packages/engine/src/engine.js (Bun.sleep at ~:2001,:2744,:4995,:5217; @effect/platform-bun BunContext at ~:32 provided at :730,:731,:767,:775,:1730,:2905,:4269; Bun.which guards ~:80-81), packages/engine/src/effect/compute-task-bridge.js (~:345 Bun.sleep), packages/engine/src/workflow-hash.js (Bun.Transpiler, already guarded).",
    done:
      "Replace Bun.sleep with Effect.sleep/setTimeout; guard/replace Bun.which. Introduce an injectable platform layer (default BunContext preserved; a NodeContext path selectable) instead of a hard BunContext import. `pnpm typecheck` green; `pnpm -C packages/engine test` green; no behavior change on Bun.",
  },
  {
    id: "1c-command-seam",
    title: "♻️ refactor(engine,driver): route subprocess spawning through @effect/platform Command",
    goal:
      "Move node:child_process spawning behind @effect/platform CommandExecutor so it can be provided per runtime (absent on isolates → dispatch to a remote SandboxProvider). Copy the existing precedent.",
    files:
      "precedent: packages/vcs/src/jj.js:16 (@effect/platform Command + CommandExecutor). Migrate: packages/engine/src/engine.js runGitCommand(~:584) + caffeinate(~:959), packages/driver/src/child-process.js:1 (spawnCaptureEffect), packages/server/src/gatewayRoutes/getNodeDiff.js:1, packages/agents/src/BaseCliAgent/runRpcCommandEffect.js:1.",
    done:
      "Engine hot path no longer statically imports node:child_process (goes through CommandExecutor). `pnpm typecheck` + `pnpm -C packages/engine test` + `pnpm -C packages/driver test` green. No behavior change on Bun/Node.",
  },
  {
    id: "1d-filesystem-seam",
    title: "♻️ refactor(engine,sandbox): route node:fs through @effect/platform FileSystem",
    goal:
      "Extract the static node:fs coupling behind @effect/platform FileSystem so the engine + sandbox-host modules LOAD on a V8 isolate (features that truly need a fs degrade rather than crash at import).",
    files:
      "packages/engine/src/engine.js:39 (node:fs) + worktree writes (~:604-714) + ~15 engine helpers (createDocWatcher, workspaceWatcher, durabilityGapSpool, snapshotServer, hot/*, AgentTraceCollector, syncDocsFromDisk, optimization-artifact), packages/sandbox/src/execute.js:2 + bundle.js:1 (node:fs/promises), packages/server/src/gateway.js:12 (static-file serving).",
    done:
      "Engine + sandbox-host modules import without a top-level node:fs value import (FileSystem service instead). `pnpm typecheck` + engine/sandbox/server tests green. Worktree/durability features unchanged on Bun/Node.",
  },
  {
    id: "1e-gateway-fetch-adapter",
    title: "✨ feat(server): fetch-handler adapter for the gateway (Workers/Edge)",
    goal:
      "Add a Web `fetch(request)`-handler adapter over the gateway RPC/WS surface so it can serve on Cloudflare Workers / Vercel Edge, keeping the existing node:http createServer path for Node hosts.",
    files:
      "packages/server/src/gateway.js:10 (node:http createServer at ~:3497), packages/server/src/light-gateway.js (node:http), packages/server/src/index.js. Reuse the existing route/registry logic; wrap it in a fetch handler.",
    done:
      "A `fetch`-handler entry serves the same gateway RPC methods as the node:http server (proven by a request-level test). `pnpm typecheck` + `pnpm -C packages/server test` green.",
  },
  {
    id: "2a-cf-worker-driver",
    title: "✨ feat(cloudflare): Worker entry + Durable Object class + alarm-driven run driver",
    goal:
      "Ship the missing pieces so a run can be DRIVEN on Cloudflare Workers: a reference Worker entry, a Durable Object class backing createSmithersCloudflare over DO-SQLite, and an alarm-driven driver that advances the run without a long-lived host.",
    files:
      "packages/cloudflare/src/index.js (createSmithersCloudflare, createCloudflareDurableObjectSqliteDescriptor). Depends on 1b-1e (engine must load on a Worker).",
    done:
      "A Durable Object advances a small SDK-agent workflow to completion on DO-SQLite under Miniflare (@cloudflare/vitest-pool-workers), no mocks. `pnpm typecheck` + `pnpm -C packages/cloudflare test` green.",
  },
  {
    id: "2b-cf-sandbox-provider-fix",
    title: "🐛 fix(cloudflare): sandbox provider result reconciliation + per-turn lifecycle",
    goal:
      "Make createCloudflareSandboxProvider actually usable: collect results in execution:'process' mode (currently fire-and-forget, returns a pid with no result bundle), ship a reference in-container harness (default cmd `node /workspace/run-smithers-sandbox.js` ships nowhere), and thread setSleepAfter/keepAlive so a container can spin up per turn and be paused/stopped.",
    files:
      "packages/cloudflare/src/index.js:182-296 (createCloudflareSandboxProvider; execution 'process' ~:233-250; cleanup ~:288-296; keepAlive ~:199-203), packages/sandbox/src/SandboxProvider.ts.",
    done:
      "process-mode round-trips a real result bundle; a shipped harness reconstructs+runs a child workflow from input/config; setSleepAfter/stop are exercised. Provider test (real @cloudflare/sandbox mock env is fine for unit, but add an integration path). `pnpm typecheck` + tests green.",
  },
  {
    id: "2c-graceful-degrade",
    title: "✨ feat(engine): capability flags so non-serverless features degrade on isolates",
    goal:
      "Where worktrees / Tier-1 fs durability snapshots are impossible (isolates), surface them as DISABLED capabilities rather than crashing, and route worktree-backed execution to a remote SandboxProvider. Document which harnesses can and cannot run on Workers.",
    files:
      "packages/engine/src/engine.js (ensureWorktree ~:724, snapshotServer node:net), packages/sandbox/src/execute.js:34 (provider registry), docs/concepts/execution-model.mdx, docs/integrations/cloudflare.mdx.",
    done:
      "Isolate runtime reports worktree/fs-snapshot as unavailable capabilities (no import-time crash); docs state the per-harness serverless limits. `pnpm typecheck` + `pnpm test` gate green (check-docs/check-llms).",
  },
  {
    id: "4a-dual-surface-e2e",
    title: "✅ test(cloudflare): dual-surface e2e — Workers isolate AND sandbox container",
    goal:
      "Prove BOTH Cloudflare surfaces independently (a setup can pass in one and fail in the other): (1) Workers ISOLATE — createSmithersCloudflare + a workflow on DO-SQLite under Miniflare, asserting no bun:sqlite/node:fs/child_process leaks into the isolate; (2) sandbox CONTAINER — createCloudflareSandboxProvider running a real harness to a diff bundle. No mocks.",
    files:
      "packages/cloudflare/tests/, e2e/. Use @cloudflare/vitest-pool-workers / Miniflare for the isolate lane. Same isolate-vs-Node split noted for Vercel (Edge vs Node fn).",
    done:
      "CI runs both lanes green on a clean box (seed a fake agent; skip browser-only). `pnpm -C packages/cloudflare test` + the new e2e lane pass.",
  },
  {
    id: "4b-fluency-evals",
    title: "✅ eval(providers): Haiku one-shot deploy-setup fluency evals + harness matrix",
    goal:
      "Extend the agent-fluency harness so a WEAK model (Haiku) can one-shot each provider's deploy setup from the docs, and publish a per-harness serverless compatibility matrix (ideally capability flags on agents: inProcess / requiresOs / sessionState).",
    files:
      "evals/ (haiku is wired 'weak' in evals/agents.ts; per-feature one-shot scorecard), packages/agents/src (capability flags), docs/agents/overview.mdx or a new docs/agents/serverless.mdx.",
    done:
      "A per-provider fluency eval case runs and reports a one-shot rate; the harness matrix doc lands and passes check-docs/check-llms. `pnpm typecheck` green.",
  },
];

const inputSchema = z.object({
  tasks: z.array(taskSchema).default([]),
  only: z.array(z.string()).default([]),
  baseBranch: z.string().default("main"),
  maxReviewIterations: z.number().int().min(1).max(6).default(3),
  maxConcurrency: z.number().int().min(1).max(6).default(2),
  sequential: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  planPanelist: planOutputSchema,
  planSynthesis: planSynthesisSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
  pr: prSchema,
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function repoRootDir(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}
const repoRoot = repoRootDir();

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "task";
}

const REPO_RULES = `Repo rules (see CLAUDE.md / AGENTS.md):
- No mocks: product + e2e use real backends/data.
- Atomic, focused change scoped to THIS task only; do not refactor unrelated code.
- Keep root \`pnpm typecheck\` green and the touched package's tests green (\`pnpm -C <pkg> test\`).
- If you touch docs/, regenerate bundles (\`pnpm docs:llms\`); no em-dashes (house style uses \`--\`).
- Commit on THIS branch with explicit pathspecs (never a blanket \`git add -A\`); emoji + conventional-commit subject.`;

function taskCard(t: WorkTask): string {
  return `Task: ${t.title}  [id: ${t.id}]
Goal: ${t.goal}
Area / file hints: ${t.files || "(discover)"}
Done criteria: ${t.done || "typecheck + touched-package tests green"}`;
}

function buildImplementPrompt(t: WorkTask, plan: z.infer<typeof planSynthesisSchema> | undefined, branch: string): string {
  const planText = plan
    ? `Synthesized plan (Opus merged Codex's + Opus's plans):\n${plan.summary}\n${(plan.steps ?? []).map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`
    : "Plan: (pending — follow the goal + done criteria below.)";
  return `Implement this task inside the isolated git worktree on branch ${branch}. Do NOT open a PR (a later step does that).

${taskCard(t)}

${planText}

Read the named files FIRST and verify the current state before editing (line numbers may have drifted). Make the change AND its tests. Commit your work on THIS branch as you go.

${REPO_RULES}
Report exactly which files changed and whether the gate (\`pnpm typecheck\` + touched-package tests) is green.`;
}

function buildPrPrompt(t: WorkTask, branch: string, baseBranch: string): string {
  return `Open EXACTLY ONE GitHub PR for this task in smithersai/smithers. You are in the worktree on branch ${branch} (base ${baseBranch}).

${taskCard(t)}

Steps:
1. Ensure work is committed (git status --porcelain). Commit remaining changes with explicit pathspecs + an emoji conventional-commit message.
2. If there are NO commits beyond ${baseBranch} (git rev-list --count ${baseBranch}..HEAD is 0): nothing to ship — set created=false, landed=false, explain in summary, STOP (no empty PR).
3. Push: git push -u origin ${branch}
4. Reuse an existing open PR for this branch if present (gh pr view ${branch} --json number,url,state); else:
   gh pr create --repo smithersai/smithers --head ${branch} --base ${baseBranch} --title "${t.title}" --body "<what changed, why, done-criteria status, and the review verdict>"
Report branch, created, prNumber, prUrl, landed(false unless merged), and a one-line summary.`;
}

// ----------------------------------------------------------------------------
// Per-task pipeline: worktree → dual-plan(+Opus synth) → implement/validate/
// dual-review(+Opus synth) loop → PR
// ----------------------------------------------------------------------------
function renderTask(opts: { ctx: any; task: WorkTask; index: number; baseBranch: string; maxReviewIterations: number; dryRun: boolean }) {
  const { ctx, task, index, baseBranch, maxReviewIterations, dryRun } = opts;
  const key = `t${index}-${slugify(task.id)}`;
  const branch = `serverless/${slugify(task.id)}`;
  const worktreePath = join(repoRoot, ".smithers", "workflows", ".worktrees", `sr-${key}`);

  const plan = ctx.outputMaybe("planSynthesis", { nodeId: `${key}:plan-moderator` }) as
    | z.infer<typeof planSynthesisSchema>
    | undefined;
  const validate = ctx.outputMaybe("validate", { nodeId: `${key}:validate` }) as
    | z.infer<typeof validateOutputSchema>
    | undefined;
  const gate = reviewGate(ctx, `${key}:review-moderator`);
  const validationPassed = validate !== undefined && validate.allPassed !== false;
  const done = validationPassed && gate.approved;
  const feedback = gate.feedback;

  const pipeline = (
    <Sequence>
      <PlanPanel
        idPrefix={`${key}:plan`}
        prompt={`${taskCard(task)}\n\nProduce a concrete, minimal implementation plan (summary + steps). Read the named files first. Do NOT write code in this step.\n\n${REPO_RULES}`}
        panelists={planPanel}
        moderator={opusModerator}
        panelistOutput={planOutputSchema}
        synthesisOutput={planSynthesisSchema}
      />
      {dryRun ? null : (
        <ValidationLoop
          idPrefix={key}
          prompt={buildImplementPrompt(task, plan, branch)}
          implementAgents={implementChain}
          validateAgents={validateChain}
          reviewAgents={panel}
          synthesizeReview
          reviewModerator={opusModerator}
          feedback={feedback}
          done={done}
          maxIterations={maxReviewIterations}
        />
      )}
      {dryRun || !done ? null : (
        <Task id={`${key}:pr`} output={prSchema} agent={prChain} timeoutMs={1_200_000} heartbeatTimeoutMs={600_000} continueOnFail>
          {buildPrPrompt(task, branch, baseBranch)}
        </Task>
      )}
    </Sequence>
  );

  // Isolated tasks run in their own worktree/branch; non-isolated (e.g. cross-repo
  // example builds) run in the launch root.
  return task.isolate === false ? (
    <Sequence key={key}>{pipeline}</Sequence>
  ) : (
    <Worktree key={key} path={worktreePath} branch={branch} baseBranch={baseBranch}>
      {pipeline}
    </Worktree>
  );
}

// ----------------------------------------------------------------------------
// Workflow
// ----------------------------------------------------------------------------
export default smithers((ctx) => {
  const input = (ctx.input ?? {}) as {
    tasks?: WorkTask[];
    only?: string[];
    baseBranch?: string;
    maxReviewIterations?: number;
    maxConcurrency?: number;
    sequential?: boolean;
    dryRun?: boolean;
  };
  const baseBranch = typeof input.baseBranch === "string" ? input.baseBranch : "main";
  const maxReviewIterations = typeof input.maxReviewIterations === "number" ? input.maxReviewIterations : 3;
  const maxConcurrency = typeof input.maxConcurrency === "number" ? input.maxConcurrency : 2;
  const sequential = input.sequential !== false; // default: one task at a time (dependent refactor)
  const dryRun = input.dryRun === true;

  let tasks: WorkTask[] = Array.isArray(input.tasks) && input.tasks.length > 0
    ? input.tasks.map((t) => taskSchema.parse(t))
    : DEFAULT_TASKS;
  if (Array.isArray(input.only) && input.only.length > 0) {
    const want = new Set(input.only);
    tasks = tasks.filter((t) => want.has(t.id));
  }

  const cards = tasks.map((task, index) => renderTask({ ctx, task, index, baseBranch, maxReviewIterations, dryRun }));

  return (
    <Workflow name="serverless-refactor">
      {sequential ? <Sequence>{cards}</Sequence> : <Parallel maxConcurrency={maxConcurrency}>{cards}</Parallel>}
    </Workflow>
  );
});
