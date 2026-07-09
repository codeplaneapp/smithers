// smithers-display-name: Local UI Feature Swarm
// smithers-source: authored
/** @jsxImportSource smithers-orchestrator */
import {
  ClaudeCodeAgent,
  Parallel,
  Sequence,
  Task,
  Worktree,
  createSmithers,
} from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

const repoRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

const featureSchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: z.number().int().min(1).max(100),
  summary: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
  likelyFiles: z.array(z.string()).default([]),
  suggestedChecks: z.array(z.string()).default([]),
});

const planSchema = z.object({
  featureId: z.string(),
  planner: z.string(),
  summary: z.string(),
  steps: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  checks: z.array(z.string()).default([]),
});

const planSynthesisSchema = z.object({
  featureId: z.string(),
  approved: z.boolean().default(false),
  summary: z.string(),
  selectedApproach: z.array(z.string()).default([]),
  rejectedIdeas: z.array(z.string()).default([]),
  implementationPromptAddendum: z.string().default(""),
  checks: z.array(z.string()).default([]),
});

const implementationSchema = z.object({
  featureId: z.string(),
  status: z.enum(["implemented", "partial", "blocked"]).default("implemented"),
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  remainingRisk: z.string().default(""),
});

const reviewIssueSchema = z.object({
  severity: z.enum(["critical", "major", "minor", "nit"]),
  title: z.string(),
  file: z.string().nullable().default(null),
  description: z.string(),
});

const reviewSchema = z.object({
  featureId: z.string(),
  reviewer: z.string(),
  approved: z.boolean().default(false),
  feedback: z.string(),
  issues: z.array(reviewIssueSchema).default([]),
});

const mergeSchema = z.object({
  featureId: z.string(),
  attempted: z.boolean().default(false),
  mergedToMain: z.boolean().default(false),
  branch: z.string(),
  worktreePath: z.string(),
  summary: z.string(),
  conflicts: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});

const finalSchema = z.object({
  merged: z.array(z.string()).default([]),
  unmerged: z.array(z.string()).default([]),
  summary: z.string(),
});

const inputSchema = z.object({
  features: z.array(z.string()).default([]),
  maxConcurrency: z.number().int().min(1).max(16).default(1),
  maxReviewIterations: z.number().int().min(1).max(6).default(3),
  baseBranch: z.string().min(1).default("main@git"),
  runLabel: z.string().min(1).default("default"),
  mergeGate: z.string().default("pnpm typecheck && pnpm test"),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  feature: featureSchema,
  plan: planSchema,
  planSynthesis: planSynthesisSchema,
  implementation: implementationSchema,
  reviewClaude: reviewSchema,
  reviewCodex: reviewSchema,
  merge: mergeSchema,
  final: finalSchema,
});

const claudeFallback = new ClaudeCodeAgent({
  model: process.env.SMITHERS_LOCAL_UI_CLAUDE_MODEL ?? "claude-sonnet-5",
  permissionMode: "bypassPermissions",
  dangerouslySkipPermissions: true,
});

const solModel = process.env.SMITHERS_LOCAL_UI_SOL_MODEL ?? process.env.SMITHERS_LOCAL_UI_CODEX_MODEL ?? "gpt-5.6-sol";
const lunaModel = process.env.SMITHERS_LOCAL_UI_LUNA_MODEL ?? process.env.SMITHERS_LOCAL_UI_CODEX_MODEL ?? "gpt-5.6-luna";
const solPrimary = codexFirst({ model: solModel, sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true }, [claudeFallback]);
const solSecondary = codexFirst({ model: solModel, sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true }, [claudeFallback]);
const luna = codexFirst({ model: lunaModel, config: { model_reasoning_effort: "medium" }, sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true }, [claudeFallback]);
const mergeLuna = codexFirst(
  { model: lunaModel, config: { model_reasoning_effort: "medium" }, sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true, cwd: repoRoot },
  [new ClaudeCodeAgent({ model: process.env.SMITHERS_LOCAL_UI_CLAUDE_MODEL ?? "claude-sonnet-5", cwd: repoRoot })],
);

const AGENT_RETRIES = 2;
const PLAN_TIMEOUT_MS = 25 * 60_000;
const IMPLEMENT_TIMEOUT_MS = 70 * 60_000;
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const MERGE_TIMEOUT_MS = 90 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;

type Feature = z.infer<typeof featureSchema>;
type Plan = z.infer<typeof planSchema>;
type PlanSynthesis = z.infer<typeof planSynthesisSchema>;
type Implementation = z.infer<typeof implementationSchema>;
type Review = z.infer<typeof reviewSchema>;
type MergeResult = z.infer<typeof mergeSchema>;

const FEATURES: Feature[] = [
  {
    id: "workspace-picker",
    title: "Local workspace and project picker",
    priority: 100,
    summary:
      "Add local-only workspace selection, recent workspaces, and gateway readiness so the UI can open a user project instead of assuming one ambient gateway.",
    acceptanceCriteria: [
      "No JJHub, cloud auth, or multiplayer concepts are introduced.",
      "The UI can select or display a local workspace root and keep recent local workspaces.",
      "Gateway/server wiring clearly scopes to the selected local workspace or reports what is missing.",
      "Tests cover route/state behavior and at least one local workspace readiness path.",
    ],
    likelyFiles: ["apps/smithers/src/app", "apps/smithers/src/store", "apps/cli/src/localUiServer.js"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "terminal",
    title: "Local terminal surface",
    priority: 98,
    summary:
      "Port the terminal surface to local PTY execution with resize, reconnect/error states, and loopback-only access.",
    acceptanceCriteria: [
      "Adds /terminal routing/nav/dock integration for the local app.",
      "Uses a real local terminal/PTY backend instead of cloud workspace sessions.",
      "Terminal access is scoped to the selected/local workspace and protected from remote exposure.",
      "Includes focused tests for client state and server connection behavior.",
    ],
    likelyFiles: ["apps/smithers/src/terminal", "apps/smithers/src/app/router.ts", "apps/cli/src/localUiServer.js"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "files",
    title: "Local file browser and editor",
    priority: 96,
    summary:
      "Add a local workspace-root file tree, file viewer/editor, and safe path handling adapted from ../multi without cloud repo APIs.",
    acceptanceCriteria: [
      "Adds /files routing/nav/dock integration.",
      "Reads and writes files through a local workspace-root API with traversal protection.",
      "Large/binary files have safe preview behavior.",
      "Tests cover path safety, tree loading, and basic edit/save behavior.",
    ],
    likelyFiles: ["apps/smithers/src/files", "apps/cli/src/localUiServer.js", "apps/smithers/src/app/router.ts"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "vcs",
    title: "Local VCS surface",
    priority: 94,
    summary:
      "Add a local git/jj status surface using the user's machine and workspace, not JJHub APIs.",
    acceptanceCriteria: [
      "Adds /vcs routing/nav/dock integration.",
      "Detects git and jj working-tree state locally and presents status/bookmarks/changes.",
      "No cloud repo, JJHub, or multiplayer dependencies are introduced.",
      "Tests cover parser/domain behavior and at least one local command adapter path.",
    ],
    likelyFiles: ["apps/smithers/src/vcs", "apps/smithers/src/app/router.ts", "apps/smithers/src/navMenu.ts"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "run-logs",
    title: "Real gateway run logs",
    priority: 92,
    summary:
      "Replace fixture-backed run logs with real gateway/event-log data while preserving follow, noise filtering, and redaction behavior.",
    acceptanceCriteria: [
      "Logs no longer render AUTH_REFACTOR_LOG for real run routes.",
      "The logs surface reads local gateway or event-log data for the selected run.",
      "Follow, hide-noise, and redact behavior still works.",
      "Tests prove a seeded gateway/event log appears in the UI without UI-only mock data.",
    ],
    likelyFiles: ["apps/smithers/src/logs", "apps/smithers/src/runs", "packages/gateway"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "run-diffs",
    title: "Real run and node diffs",
    priority: 90,
    summary:
      "Wire the diff canvas to real gateway node diff data instead of AUTH_REFACTOR_DIFF.",
    acceptanceCriteria: [
      "Diff routes fetch real diff data for the selected run/node/diff id.",
      "The existing large diff, binary, rename, collapse, and pagination UI still works.",
      "The fixture diff is removed from production paths or kept only for tests/story data.",
      "Tests cover successful diff rendering and empty/unavailable diff states.",
    ],
    likelyFiles: ["apps/smithers/src/diff", "apps/smithers/src/gateway", "packages/gateway-client"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "time-travel",
    title: "Gateway-backed time travel",
    priority: 88,
    summary:
      "Replace the legacy runsStore timeline with gateway-backed snapshots, fork, replay, and rewind operations.",
    acceptanceCriteria: [
      "Timeline routes work for real gateway run ids.",
      "Snapshots are sourced from gateway/time-travel data, not authRefactorFrames.",
      "Fork/replay/rewind call real local Smithers APIs or clearly gated local commands.",
      "Tests cover snapshot rendering and at least one action path.",
    ],
    likelyFiles: ["apps/smithers/src/timeline", "apps/smithers/src/runs", "packages/time-travel", "packages/gateway"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "unified-run-routes",
    title: "Unified gateway-backed run routes",
    priority: 86,
    summary:
      "Remove or convert dead legacy /runs/$id paths so inspector, logs, diff, tickets, and timeline are consistently gateway-backed.",
    acceptanceCriteria: [
      "Routes opened from the live runs list never land on a fixture-backed or dead local run store.",
      "Deep links for inspector/logs/diff/timeline resolve consistently for real run ids.",
      "Navigation and deriveRoute tests cover the chosen route shape.",
    ],
    likelyFiles: ["apps/smithers/src/app/deriveRoute.ts", "apps/smithers/src/app/router.ts", "apps/smithers/src/runs"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "agent-mutations",
    title: "Persistent local agent account mutations",
    priority: 84,
    summary:
      "Replace client-only register/remove/test echoes with real local gateway/CLI account mutations.",
    acceptanceCriteria: [
      "Register, remove, and test account actions persist through the same registry used by smithers agents.",
      "Raw API keys are never echoed into logs, UI, or tests.",
      "The UI reconciles with listAccounts after each mutation.",
      "Tests cover success and failure paths with deterministic local registry fixtures.",
    ],
    likelyFiles: ["apps/smithers/src/agents", "packages/gateway/src/rpc", "apps/cli/src/agent-commands"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "prompt-editing",
    title: "Persistent local prompt editing",
    priority: 82,
    summary:
      "Make prompt edits save to the local .smithers prompt files or a gateway-backed prompt store instead of only local UI state.",
    acceptanceCriteria: [
      "Prompt save persists and survives refresh/reload.",
      "Unsaved-change guards still work across prompt switching.",
      "Preview remains deterministic and uses the saved/draft source correctly.",
      "Tests cover save, discard, and reload behavior.",
    ],
    likelyFiles: ["apps/smithers/src/prompts", "packages/gateway/src/rpc", "packages/engine/src/startDocFileSync.js"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "approval-history",
    title: "Persistent approval history",
    priority: 80,
    summary:
      "Persist approved/denied approval decisions so the History tab is not only optimistic client state.",
    acceptanceCriteria: [
      "Approval decisions survive reload and are queryable from the gateway/local DB.",
      "Pending approvals remain live and decisions reconcile without duplicate history rows.",
      "History UI differentiates approved and denied decisions with notes.",
      "Tests cover approving, denying, and reloading history.",
    ],
    likelyFiles: ["apps/smithers/src/approvals", "packages/gateway/src/rpc", "packages/db"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "memory-recall",
    title: "Gateway-backed memory recall",
    priority: 78,
    summary:
      "Move memory recall/write/delete beyond client-side search over fetched facts and onto real Smithers memory APIs.",
    acceptanceCriteria: [
      "Recall calls a real local backend path where available and reports unavailable capabilities honestly.",
      "Fact metadata and namespace filtering remain intact.",
      "No UI-only mock memory data is introduced.",
      "Tests cover recall success, empty results, and failure states.",
    ],
    likelyFiles: ["apps/smithers/src/memory", "packages/memory", "packages/gateway/src/rpc"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "onboarding",
    title: "Local setup and onboarding",
    priority: 76,
    summary:
      "Add local-only setup guidance for workspace, workflow pack, gateway readiness, and agent accounts without auth/waitlist gates.",
    acceptanceCriteria: [
      "First-run setup is local-only and does not mention sign-in, waitlists, Pair, or JJHub.",
      "The UI checks workflow pack, gateway, workspace, and agent readiness.",
      "Users can recover from missing setup with actionable local commands.",
      "Tests cover first-run and ready states.",
    ],
    likelyFiles: ["apps/smithers/src/onboarding", "apps/smithers/src/app/homeRoute.tsx", "apps/smithers/src/agents"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "askme",
    title: "Ask-me workflow explanation route",
    priority: 72,
    summary:
      "Restore a local ask-me/grill-me route that explains workflows and local runtime state without cloud dependencies.",
    acceptanceCriteria: [
      "Adds /askme routing or a clear local command/menu entry.",
      "Uses local workflow registry and gateway state.",
      "No JJHub or auth dependencies are introduced.",
      "Tests cover routing and a minimal explanation flow.",
    ],
    likelyFiles: ["apps/smithers/src/askme", "apps/smithers/src/app/router.ts", "apps/smithers/src/commands.ts"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
  {
    id: "dock-nav",
    title: "Dock and nav for local surfaces",
    priority: 70,
    summary:
      "Update dock, nav, command menu, and app catalog for the new local surfaces with consistent icons and routes.",
    acceptanceCriteria: [
      "Files, terminal, VCS, setup/onboarding, and ask-me appear where appropriate.",
      "Command menu and dock route to the same surfaces as deep links.",
      "No cloud-only surfaces are added.",
      "Tests cover nav menu and route derivation.",
    ],
    likelyFiles: ["apps/smithers/src/navMenu.ts", "apps/smithers/src/apps/appCatalog.ts", "apps/smithers/src/CommandMenu.tsx"],
    suggestedChecks: ["pnpm -C apps/smithers test", "pnpm typecheck"],
  },
];

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "feature";
}

function featureById(id: string): Feature | undefined {
  return FEATURES.find((feature) => feature.id === id);
}

function selectedFeatures(ids: string[]): Feature[] {
  if (!ids.length) return [...FEATURES].sort((a, b) => b.priority - a.priority);
  const selected = ids.map(featureById).filter((feature): feature is Feature => feature !== undefined);
  return selected.sort((a, b) => b.priority - a.priority);
}

function branchForFeature(feature: Feature, runLabel: string): string {
  return `local-ui/${slug(runLabel)}/${slug(feature.id)}`;
}

function worktreeForFeature(feature: Feature, runLabel: string): string {
  return join(repoRoot, ".smithers", "workflows", ".worktrees", `local-ui-${slug(runLabel)}-${slug(feature.id)}`);
}

function latestForFeature<T extends { featureId: string }>(rows: T[] | undefined, featureId: string): T | undefined {
  return [...(rows ?? [])].reverse().find((row) => row.featureId === featureId);
}

function plansForFeature(rows: Plan[] | undefined, featureId: string): Plan[] {
  return (rows ?? []).filter((row) => row.featureId === featureId).slice(-2);
}

function featureDone(ctx: any, featureId: string): boolean {
  const implementation = latestForFeature<Implementation>(ctx.outputs.implementation, featureId);
  const claudeReview = latestForFeature<Review>(ctx.outputs.reviewClaude, featureId);
  const codexReview = latestForFeature<Review>(ctx.outputs.reviewCodex, featureId);
  return (
    implementation?.status === "implemented" &&
    claudeReview?.approved === true &&
    codexReview?.approved === true
  );
}

function featureMerged(ctx: any, featureId: string): boolean {
  const merge = latestForFeature<MergeResult>(ctx.outputs.merge, featureId);
  return merge?.mergedToMain === true;
}

function loopFeedback(ctx: any, featureId: string): string {
  const implementation = latestForFeature<Implementation>(ctx.outputs.implementation, featureId);
  const claudeReview = latestForFeature<Review>(ctx.outputs.reviewClaude, featureId);
  const codexReview = latestForFeature<Review>(ctx.outputs.reviewCodex, featureId);
  const parts: string[] = [];
  if (implementation && implementation.status !== "implemented") {
    parts.push(`IMPLEMENTATION SELF-REPORTED ${implementation.status.toUpperCase()}:\n${implementation.summary}`);
    if (implementation.remainingRisk) parts.push(`Remaining risk:\n${implementation.remainingRisk}`);
  }
  for (const [label, review] of [
    ["CLAUDE REVIEW", claudeReview],
    ["CODEX REVIEW", codexReview],
  ] as const) {
    if (review && !review.approved) {
      parts.push(`${label} REJECTED:\n${review.feedback}`);
      for (const issue of review.issues ?? []) {
        parts.push(`- [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
      }
    }
  }
  return parts.join("\n\n");
}

function featureBrief(feature: Feature): string {
  return [
    `Feature ${feature.id}: ${feature.title}`,
    "",
    feature.summary,
    "",
    "Acceptance criteria:",
    feature.acceptanceCriteria.map((item) => `- ${item}`).join("\n"),
    "",
    "Likely files:",
    feature.likelyFiles.map((item) => `- ${item}`).join("\n"),
    "",
    "Suggested checks:",
    feature.suggestedChecks.map((item) => `- ${item}`).join("\n"),
  ].join("\n");
}

function planPrompt(feature: Feature): string {
  return [
    "Plan this local-only Smithers UI feature. Do not edit files.",
    "Do not call tools, spawn subagents, use the Task tool, run shell commands, browse the web, or wait for other agents.",
    "Use only the feature brief and context below; return the JSON plan directly.",
    "",
    featureBrief(feature),
    "",
    "Context:",
    "- The local UI is apps/smithers in this repo.",
    "- ../multi is reference context only; do not introduce JJHub, auth/waitlist, Pair, multiplayer, cloud repos, or cloud workspaces.",
    "- Use real local gateway/filesystem/CLI/data paths. No UI-only mocks for product behavior.",
    "- Keep the plan small enough for one feature worktree and include concrete files and tests.",
    "",
    `Return JSON with featureId exactly "${feature.id}", planner, summary, steps, risks, and checks.`,
  ].join("\n");
}

function planSynthesisPrompt(feature: Feature, plans: Plan[]): string {
  return [
    "Synthesize the Claude and Codex planning panel outputs for this local-only Smithers UI feature.",
    "Do not call tools or inspect files. Use only the plan rows below.",
    "",
    featureBrief(feature),
    "",
    "Panel plan rows:",
    plans.length ? JSON.stringify(plans, null, 2) : "No plan rows are visible yet; return approved=false and explain that the implementation must follow the feature brief only.",
    "",
    "Return JSON with featureId exactly the feature id, approved, summary, selectedApproach, rejectedIdeas, implementationPromptAddendum, and checks.",
  ].join("\n");
}

function implementPrompt(feature: Feature, synthesis: PlanSynthesis | undefined, feedback: string): string {
  return [
    "Implement this local-only Smithers UI feature in the current isolated worktree.",
    "",
    featureBrief(feature),
    "",
    "Plan panel synthesis:",
    synthesis
      ? JSON.stringify(
          {
            approved: synthesis.approved,
            summary: synthesis.summary,
            selectedApproach: synthesis.selectedApproach,
            rejectedIdeas: synthesis.rejectedIdeas,
            implementationPromptAddendum: synthesis.implementationPromptAddendum,
            checks: synthesis.checks,
          },
          null,
          2,
        )
      : "No synthesis row is visible yet. Inspect both panelist plan outputs in the run if needed and proceed conservatively.",
    "",
    "Hard constraints:",
    "- Codex implements. Do not stop at planning.",
    "- Do not add JJHub, cloud auth, waitlist, Pair, multiplayer, cloud repos, or cloud workspaces.",
    "- Use production/local Smithers paths: gateway RPC, CLI, filesystem, SQLite, or workspace-local APIs as appropriate.",
    "- Tests may use deterministic local fixtures, but product code and E2E claims must not rely on UI-only mock data.",
    "- Respect current dirty work; do not revert unrelated changes.",
    "- Keep the change scoped to this feature.",
    "",
    feedback ? `Previous review feedback to fix:\n${feedback}\n` : "",
    "Before returning implemented, run the most relevant checks from the plan and package scripts.",
    `Return JSON with featureId exactly "${feature.id}", status, summary, filesChanged, commandsRun, and remainingRisk.`,
  ].join("\n");
}

function reviewPrompt(
  feature: Feature,
  reviewer: "claude" | "codex",
  implementation: Implementation | undefined,
): string {
  return [
    `You are the ${reviewer === "claude" ? "Claude" : "Codex"} reviewer. Review only; do not edit files.`,
    "",
    featureBrief(feature),
    "",
    "Implementation self-report:",
    implementation ? JSON.stringify(implementation, null, 2) : "No implementation report is visible yet; inspect the worktree directly.",
    "",
    "Review requirements:",
    "- Inspect git/jj diff and changed files in full.",
    "- Reject if the feature is partial, untested, fixture-only, or introduces JJHub/auth/Pair/multiplayer/cloud-only concepts.",
    "- Reject if it deletes or hides existing local UI functionality to pass tests.",
    "- Reject if relevant package-owned checks were skipped without a defensible reason.",
    "- Approve only when this feature is shippable on its own.",
    "",
    `Return JSON with featureId exactly "${feature.id}", reviewer="${reviewer}", approved, feedback, and issues.`,
  ].join("\n");
}

function mergePrompt(feature: Feature, worktreePath: string, branch: string, gate: string): string {
  const lockPath = join(repoRoot, ".smithers", "workflows", ".locks", "local-ui-main-merge.lock");
  return [
    `Merge approved feature ${feature.id}: ${feature.title} back into main.`,
    `Source worktree: ${worktreePath}`,
    `Source branch/bookmark: ${branch}`,
    "",
    "You MUST serialize against other merge agents with this atomic filesystem lock before touching main:",
    `  mkdir -p ${join(repoRoot, ".smithers", "workflows", ".locks")}`,
    `  while ! mkdir ${lockPath}; do sleep 10; done`,
    `  trap 'rmdir ${lockPath}' EXIT`,
    "",
    "After acquiring the lock:",
    "1. Re-check that the source worktree contains only this feature's scoped changes.",
    "2. Update main to the latest local main/bookmark state without discarding unrelated user changes.",
    "3. Merge or apply the source worktree changes into main. Prefer VCS-native merge from the feature branch/bookmark when safe.",
    "4. Resolve conflicts if possible; if not, leave main safe and report mergedToMain=false with conflicts.",
    `5. Run this merge gate from main: ${gate}`,
    "6. If the gate passes, leave the merged changes on main. Follow repo commit conventions if a commit is needed.",
    "7. Do not push unless the surrounding repo instructions and current operator policy require it.",
    "",
    "Never merge JJHub, auth/waitlist, Pair, multiplayer, or cloud-only behavior for this local UI.",
    `Return JSON with featureId exactly "${feature.id}", attempted=true, mergedToMain, branch, worktreePath, summary, conflicts, and commandsRun.`,
  ].join("\n");
}

function finalResult(features: Feature[], merges: MergeResult[] | undefined): z.infer<typeof finalSchema> {
  const merged = features.filter((feature) => latestForFeature(merges, feature.id)?.mergedToMain === true).map((feature) => feature.id);
  const unmerged = features.filter((feature) => !merged.includes(feature.id)).map((feature) => feature.id);
  return {
    merged,
    unmerged,
    summary: `Merged ${merged.length}/${features.length} local UI feature worktrees. Unmerged: ${unmerged.join(", ") || "none"}.`,
  };
}

export default smithers((ctx) => {
  const input = ctx.input ?? ({} as z.infer<typeof inputSchema>);
  const features = selectedFeatures(input.features ?? []);
  const maxReviewIterations = input.maxReviewIterations ?? 3;
  const baseBranch = input.baseBranch ?? "main@git";
  const runLabel = slug(input.runLabel ?? "default");
  const mergeGate = input.mergeGate ?? "pnpm typecheck && pnpm test";

  return (
    <Workflow name="local-ui-feature-swarm">
      <Sequence>
        <Sequence>
          {features.map((feature) => {
            const worktreePath = worktreeForFeature(feature, runLabel);
            const branch = branchForFeature(feature, runLabel);
            const done = featureDone(ctx, feature.id);
            const merged = featureMerged(ctx, feature.id);
            const feedback = loopFeedback(ctx, feature.id);
            const synthesis = ctx.outputMaybe(outputs.planSynthesis, {
              nodeId: `${feature.id}:plan-synthesis`,
            });
            const plans = plansForFeature(ctx.outputs.plan, feature.id);
            const implementation = latestForFeature<Implementation>(ctx.outputs.implementation, feature.id);
            return (
              <Sequence key={feature.id}>
                <Worktree id={`${feature.id}:worktree`} path={worktreePath} branch={branch} baseBranch={baseBranch}>
                  <Sequence>
                    <Parallel maxConcurrency={1}>
                      <Task
                        id={`${feature.id}:plan-panel-claude-plan`}
                        label="Claude planner"
                        output={outputs.plan}
                        agent={solPrimary}
                      >
                        {planPrompt(feature)}
                      </Task>
                      <Task
                        id={`${feature.id}:plan-panel-codex-plan`}
                        label="Codex planner"
                        output={outputs.plan}
                        agent={solSecondary}
                      >
                        {planPrompt(feature)}
                      </Task>
                    </Parallel>

                    <Task id={`${feature.id}:plan-synthesis`} output={outputs.planSynthesis} agent={solPrimary}>
                      {planSynthesisPrompt(feature, plans)}
                    </Task>

                    <Loop id={`${feature.id}:review-loop`} until={done} maxIterations={maxReviewIterations} onMaxReached="return-last">
                      <Sequence>
                        <Task
                          id={`${feature.id}:implement`}
                          output={outputs.implementation}
                          agent={luna}
                          retries={AGENT_RETRIES}
                          timeoutMs={IMPLEMENT_TIMEOUT_MS}
                          heartbeatTimeoutMs={HEARTBEAT_MS}
                          continueOnFail
                        >
                          {implementPrompt(feature, synthesis, feedback)}
                        </Task>
                        <Parallel maxConcurrency={2}>
                          <Task
                            id={`${feature.id}:review-claude`}
                            output={outputs.reviewClaude}
                            agent={solPrimary}
                            retries={AGENT_RETRIES}
                            timeoutMs={REVIEW_TIMEOUT_MS}
                            heartbeatTimeoutMs={HEARTBEAT_MS}
                            continueOnFail
                          >
                            {reviewPrompt(feature, "claude", implementation)}
                          </Task>
                          <Task
                            id={`${feature.id}:review-codex`}
                            output={outputs.reviewCodex}
                            agent={solSecondary}
                            retries={AGENT_RETRIES}
                            timeoutMs={REVIEW_TIMEOUT_MS}
                            heartbeatTimeoutMs={HEARTBEAT_MS}
                            continueOnFail
                          >
                            {reviewPrompt(feature, "codex", implementation)}
                          </Task>
                        </Parallel>
                      </Sequence>
                    </Loop>
                  </Sequence>
                </Worktree>

                <Task
                  id={`${feature.id}:merge`}
                  output={outputs.merge}
                  agent={mergeLuna}
                  retries={1}
                  timeoutMs={MERGE_TIMEOUT_MS}
                  heartbeatTimeoutMs={HEARTBEAT_MS}
                  skipIf={!done || merged}
                  continueOnFail
                >
                  {mergePrompt(feature, worktreePath, branch, mergeGate)}
                </Task>
              </Sequence>
            );
          })}
        </Sequence>

        <Task id="final" output={outputs.final}>
          {() => finalResult(features, ctx.outputs.merge)}
        </Task>
      </Sequence>
    </Workflow>
  );
});
