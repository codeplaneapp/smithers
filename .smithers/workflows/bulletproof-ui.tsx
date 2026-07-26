// smithers-display-name: Bulletproof UI Campaign
/** @jsxImportSource smithers-orchestrator */
import { MergeQueue, Parallel, Sequence, Task, UI, Worktree, createSmithers } from "smithers-orchestrator";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// ── Agents ──────────────────────────────────────────────────────────────────
// Sandwich: fable freezes the design and audits at the end; codex does the
// bulk (sol xhigh for foundation components, terra medium for mechanical
// lanes and merges); claude chains are quota fallbacks per codexPaused().
const designAgents = [providers.claude, providers.claudeOpus];
const auditAgents = [providers.claude, providers.claudeOpus];
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const terraChain = codexFirst(
  { model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true },
  [providers.claudeSonnet, providers.claude],
);

// ── Schemas (bpui-prefixed: output tables are shared by name across the
// workspace DB, and required/min-constrained fields make an empty repaired
// `{}` fail validation instead of persisting an all-NULL row) ───────────────
const laneIds = [
  "chat-foundation",
  "agentic-reasoning-tool",
  "agentic-response-code",
  "agentic-plan-sources",
  "node-output-agentic",
  "pack-ui-governance",
  "styleguide-standalone-bundle",
  "pack-burndown-flagships",
] as const;
const laneIdSchema = z.enum(laneIds);

const specSchema = z.object({
  specMarkdown: z.string().min(800),
  componentApis: z.string().min(400),
  risks: z.array(z.string()).default([]),
});
const specReviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string().min(10),
});
const implSchema = z.object({
  laneId: laneIdSchema,
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).min(1),
  testsAddedOrUpdated: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});
const validationSchema = z.object({
  laneId: laneIdSchema,
  allPassed: z.boolean(),
  diffNonEmpty: z.boolean(),
  summary: z.string().min(20),
  commandsRun: z.array(z.string()).min(1),
  failingSummary: z.string().nullable().default(null),
});
const reviewSchema = z.object({
  laneId: laneIdSchema,
  approved: z.boolean(),
  feedback: z.string().min(10),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "major", "minor", "nit"]),
        title: z.string(),
        description: z.string(),
      }),
    )
    .default([]),
});
const laneResultSchema = z.object({
  laneId: laneIdSchema,
  branch: z.string().min(1),
  worktreePath: z.string().min(1),
  lgtm: z.boolean(),
  exhausted: z.boolean(),
  summary: z.string().min(10),
});
const mergeSchema = z.object({
  laneId: laneIdSchema,
  mergedToMain: z.boolean(),
  summary: z.string().min(10),
  commandsRun: z.array(z.string()).default([]),
});
const ciSchema = z.object({
  wave: z.number().int().min(1).max(2),
  allPassed: z.boolean(),
  summary: z.string().min(5),
  commands: z
    .array(
      z.object({
        command: z.string(),
        exitCode: z.number().nullable(),
        stdout: z.string(),
        stderr: z.string(),
      }),
    )
    .default([]),
});
const ciFixSchema = z.object({
  wave: z.number().int().min(1).max(2),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).default([]),
});
const auditSchema = z.object({
  complete: z.boolean(),
  summary: z.string().min(100),
  followUps: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(8).default(4),
  perLaneIterations: z.number().int().min(1).max(6).default(4),
  baseBranch: z.string().trim().min(1).default("main"),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  bpuiSpec: specSchema,
  bpuiSpecReview: specReviewSchema,
  bpuiImpl: implSchema,
  bpuiValidation: validationSchema,
  bpuiReview: reviewSchema,
  bpuiLaneResult: laneResultSchema,
  bpuiMerge: mergeSchema,
  bpuiCi: ciSchema,
  bpuiCiFix: ciFixSchema,
  bpuiAudit: auditSchema,
});

type LaneId = (typeof laneIds)[number];
type RawRow = Record<string, unknown>;

// ── Lane definitions ────────────────────────────────────────────────────────
type Lane = {
  id: LaneId;
  wave: 1 | 2;
  title: string;
  agent: "sol" | "terra";
  spec: string;
};

const HOUSE_RULES = [
  "House rules for ALL work in this campaign:",
  "- FIRST read packages/ui/src/README.md and packages/ui/tests/css-contract.test.ts end to end; they are the architecture contract (shadcn anatomy: data-slot attributes, CVA variant APIs, asChild via Radix Slot; CSS shipped ONLY as JS strings composed into uiCss.ts; colors ONLY through the tokens.ts var(--house-token, #lightFallback) bridge; every component calls useInjectUiCss(); sui-* class namespace).",
  "- Light AND dark must work with zero per-component dark-mode code: token fallbacks are the light values; dark comes from the styleguide theme. Never hardcode a hex color in component CSS.",
  "- No new runtime dependencies in @smithers-orchestrator/ui base. Heavy widgets go behind adapters/* subpaths only. Tailwind is banned; port anatomy, not code.",
  "- Every ported/new component gets an entry in packages/ui/shadcn-provenance.json naming its upstream registry item URL (ui.shadcn.com or elements.ai-sdk.dev item), per the policy in that file.",
  "- Tests: bun + happy-dom render tests for each component (including a data-theme=dark render), and extend tests/css-contract.test.ts coverage for new CSS blocks. Run pnpm -C packages/ui test until green.",
  "- If you add public exports, run `pnpm check:docs` from the repo root and fix what it flags (update docs/ pages as needed, then run `pnpm docs:llms` and commit the regenerated bundles inside YOUR worktree).",
  "- NEVER edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx (a live run imports them).",
  "- You work in an isolated jj/git worktree. Use jj (not plain git) for VCS operations. Commit your own files with explicit pathspecs.",
  "- Match surrounding code style: one named export per file, filename matches the export, index.ts is a barrel only.",
].join("\n");

const LANES: Lane[] = [
  {
    id: "chat-foundation",
    wave: 1,
    agent: "sol",
    title: "Port the shadcn chat set into packages/ui/src/chat",
    spec: [
      "Port the official shadcn/ui June-2026 chat components into packages/ui/src/chat/, adapted to this library's CSS-in-TS anatomy:",
      "- MessageScroller: the conversation scroll container (anchored turns, stick-to-bottom while streaming, jump-to-latest affordance, prepended-history safe).",
      "- Bubble: message surface with variants (user/assistant/system), alignment, and collapsible long content.",
      "- Attachment: file/image chip rendering with metadata and upload state.",
      "- Marker: labeled separators / system notes / streaming-status rows.",
      "- shimmer: a text shimmer effect for live status (CSS block + a small Shimmer component).",
      "- scroll-fade: scroll-aware edge-fade utility CSS block.",
      "Integrate with the EXISTING ChatMessage/ChatTranscript/ChatComposer: ChatTranscript should compose MessageScroller internally without breaking its current props (packages/ui/src/chat/ChatTranscript.tsx). Keep everything transport-neutral (props-driven, no hooks from gateway-react).",
      "Export the new components from packages/ui/src/index.ts and register each in shadcn-provenance.json.",
    ].join("\n"),
  },
  {
    id: "agentic-reasoning-tool",
    wave: 1,
    agent: "sol",
    title: "Reasoning / ChainOfThought / ToolCall components",
    spec: [
      "Create packages/ui/src/agentic/ with agent-native components modeled on the AI Elements taxonomy (elements.ai-sdk.dev), ported to this library's anatomy (NO tailwind, NO ai-sdk dependency; pure props-driven React):",
      "- Reasoning: collapsible thinking/extended-reasoning block. Props: streaming (boolean, shows shimmer on the header while true), defaultOpen, duration (seconds, rendered as 'Thought for Ns'), children (markdown-capable content). Auto-collapse when streaming flips false.",
      "- ChainOfThought: an ordered list of reasoning steps with status per step (pending/active/done), composing Reasoning's visual language.",
      "- ToolCall: a tool invocation row: tool name, status (pending/running/success/error via the shared status vocabulary in src/status.ts), collapsible args (pretty JSON) and result sections. Distinct compact and expanded layouts.",
      "All content colors/spacing through tokens; statuses map through statusClass/normalizeStatus from src/status.ts (extend that vocabulary if needed rather than inventing a parallel one).",
      "Export from index.ts; provenance entries for each ported anatomy.",
    ].join("\n"),
  },
  {
    id: "agentic-response-code",
    wave: 1,
    agent: "sol",
    title: "Response (streaming markdown) + CodeBlock",
    spec: [
      "In packages/ui/src/agentic/:",
      "- Response: the assistant-message content renderer. Renders markdown via the existing primitives/markdown.tsx (extend it if needed; do NOT add a markdown dependency). Must tolerate INCOMPLETE streaming markdown (unterminated code fence or emphasis mid-stream) without layout jumps, and render a subtle streaming caret while props.streaming is true.",
      "- CodeBlock: fenced-code rendering with language label, copy affordance seam (onCopy prop, no clipboard dependency), line wrapping toggle, and --code-bg/--code-text token styling. No syntax-highlighting dependency in the base package: define a highlighter seam prop (tokens-in, spans-out) so adapters can plug shiki later.",
      "Wire primitives/markdown.tsx to route fenced blocks through CodeBlock.",
      "Export from index.ts; provenance entries.",
    ].join("\n"),
  },
  {
    id: "agentic-plan-sources",
    wave: 1,
    agent: "sol",
    title: "Plan / TaskItem / Sources / InlineCitation",
    spec: [
      "In packages/ui/src/agentic/:",
      "- Plan: structured plan display: ordered steps, each with status (pending/active/done/failed/skipped), collapsible detail, and a compact progress summary header. Composes the shared status vocabulary.",
      "- TaskItem: a single unit-of-work row (label, status, optional file badges, optional elapsed time) usable standalone and inside Plan.",
      "- Sources: a collapsible 'Used N sources' block listing source links/labels with favicons omitted (text-only).",
      "- InlineCitation: superscript-style inline citation chip carrying a hoverable source label (tooltip via the existing tooltip.tsx).",
      "Export from index.ts; provenance entries; tests including keyboard interaction for collapsibles.",
    ].join("\n"),
  },
  {
    id: "node-output-agentic",
    wave: 2,
    agent: "sol",
    title: "Render agent output as agentic components in gateway-ui surfaces",
    spec: [
      "Upgrade the run-observation surfaces to render agent output through the new packages/ui agentic components instead of plain text/JSON <pre> dumps:",
      "- packages/gateway-ui/src/NodeOutputView.tsx + NodeOutputCard.tsx: when the unwrapped output row carries recognizable agent-output shape (markdown text, tool-call arrays, thinking/reasoning fields), render via Response / ToolCall / Reasoning; keep the JSON fallback for arbitrary rows. Preserve the exported unwrapNodeOutput/formatOutput contracts (they have external consumers).",
      "- packages/gateway-ui/src/RunEventLog.tsx: render TaskHeartbeat/status rows with Marker and streaming shimmer instead of raw dim text, keeping the existing props contract.",
      "gateway-ui is a legacy facade layer: put any NEW presentational logic in packages/ui (e.g. an AgentOutput composition component) and have gateway-ui compose it, so the burndown direction is preserved.",
      "Update or add focused tests in packages/gateway-ui (happy-dom; assert the parsed model where painting is unreliable).",
    ].join("\n"),
  },
  {
    id: "pack-ui-governance",
    wave: 2,
    agent: "terra",
    title: "Govern .smithers/ui + examples/ui + shipped pack with the ratchet",
    spec: [
      "The workflow-pack UI layer is ungoverned: scripts/check-ui-architecture.mjs lists .smithers in IGNORED_DIRECTORIES and only walks packages/* and apps/*. Fix that:",
      "- Extend scripts/check-ui-architecture.mjs to ALSO walk .smithers/ui/ and examples/ui/ with pack-UI rules: imports restricted to react, smithers-orchestrator/ui (+/adapters/*), smithers-orchestrator/gateway-ui, smithers-orchestrator/gateway-react, and relative pack-local modules; NO <style> jsx blocks; NO style={{}} props; no bespoke theme/token modules. Snapshot every CURRENT violation into scripts/ui-architecture-baseline.json as exact-ratchet allowlist entries (do not fix offenders in this lane; the baseline mode is 'remove stale entries, never add new ones').",
      "- Update scripts/check-ui-architecture.test.mjs to cover the new walk (fixture-based: a compliant pack UI passes, a fresh <style> block fails, a baselined offender passes until edited).",
      "- Wire the same composition check into scripts/generate-workflow-pack.ts so a shipped pack UI that would violate the rules fails generation with an actionable error.",
      "Keep the existing packages/apps governance behavior byte-identical. Run `pnpm check:ui-architecture` and `node --test scripts/check-ui-architecture.test.mjs` until green.",
      "Note: .smithers full typecheck OOMs locally; verify any .smithers file edits with a scoped tsconfig ({extends:'./tsconfig.json',files:[...]} inside .smithers/) instead of the full project typecheck.",
    ].join("\n"),
  },
  {
    id: "styleguide-standalone-bundle",
    wave: 2,
    agent: "terra",
    title: "Standalone theme bundle for generated/served HTML",
    spec: [
      "Agent-generated and server-generated HTML currently invents its own CSS. Give it a design contract:",
      '- In packages/ui-styleguide, export a standaloneThemeCss() (own file, named export) returning ONE self-contained CSS string: the light tokens on :root, dark overrides under BOTH @media (prefers-color-scheme: dark) with :root:not([data-theme="light"]) AND :root[data-theme="dark"], plus a minimal base layer (body font/bg/text, headings, links, code/inline-code, table, hr) written entirely against the tokens. Keep it under ~8KB.',
      "- Rewrite .smithers/prompts/report-slideshow-render.mdx so the agent MUST embed that exact token block (include the literal CSS in the prompt via the export at pack-generation time, or instruct reading it from the package) and build all slide styling on the semantic tokens; forbid off-palette hardcoded hex.",
      "- Refactor apps/review/src/walkthrough/walkthroughCss.ts to import/compose standaloneThemeCss() for its token+base layer and keep only walkthrough-specific rules on top; delete the duplicated token definitions. apps/review/src/server/landingPage.ts likewise.",
      "- Tests: a ui-styleguide test asserting the bundle contains both dark strategies and no rule outside the token vocabulary for colors; an apps/review test asserting the rendered walkthrough HTML embeds the shared tokens.",
      "Run pnpm -C packages/ui-styleguide test, pnpm -C apps/review test, and pnpm check:docs.",
    ].join("\n"),
  },
  {
    id: "pack-burndown-flagships",
    wave: 2,
    agent: "terra",
    title: "Burn down review.tsx and issue-blitz.tsx to composed UIs",
    spec: [
      "Rewrite the two flagship offender pack UIs to compose the shipped libraries (imports only from react, smithers-orchestrator/ui, smithers-orchestrator/gateway-ui, smithers-orchestrator/gateway-react):",
      "- .smithers/ui/review.tsx: currently injects WorkflowUiStyles then rebuilds a ~40-rule bespoke design system (own --bg/--panel/--primary tokens, hand-rolled .button/.badge/.verdict classes). Replace with SmithersUiStyles + Button/Card/Badge/StatusPill/Tabs/SectionHeader/EmptyState + gateway-ui RunTree/RunEventLog/NodeOutputView compositions. Zero <style> blocks, zero style={{}} props, zero custom CSS strings.",
      "- .smithers/ui/issue-blitz.tsx: currently 46 style={{}} props, a hardcoded hex DOT palette, hand-rolled Chip/status dots, and no library imports. Same treatment; status colors via StatusPill/status tokens.",
      "Preserve each UI's information layout and live behavior (same gateway-react hooks, same node ids); this is a visual-layer swap, not a redesign. Verify with the fixture flow the repo uses for pack UI changes (render test or gateway boot + smithers graph for the owning workflows: review, issue-blitz).",
      "Remove the corresponding baseline allowlist entries in scripts/ui-architecture-baseline.json if the governance lane has landed (exact-ratchet: stale entries must be removed); run pnpm check:ui-architecture.",
      "Note: .smithers full typecheck OOMs locally; use a scoped tsconfig inside .smithers/ for these two files.",
    ].join("\n"),
  },
];

// ── Helpers (proven shapes from studio-parity-swarm) ────────────────────────
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "item"
  );
}

export function resolveRepoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : process.cwd();
}

function rawRows(ctx: any, channel: string): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}

function rowVersion(row: RawRow): [number, number] {
  const iteration = Number.isFinite(Number(row.iteration)) ? Number(row.iteration) : 0;
  const iterationCount = Number.isFinite(Number(row.iterationCount)) ? Number(row.iterationCount) : iteration;
  return [iterationCount, iteration];
}

function baseNodeId(row: RawRow): string {
  return String(row.nodeId ?? "").split("@@", 1)[0] ?? "";
}

function latestRaw(rows: RawRow[], nodeId: string): RawRow | undefined {
  return rows
    .filter((row) => baseNodeId(row) === nodeId)
    .reduce<RawRow | undefined>((best, row) => {
      if (!best) return row;
      const current = rowVersion(row);
      const previous = rowVersion(best);
      return current[0] > previous[0] || (current[0] === previous[0] && current[1] >= previous[1]) ? row : best;
    }, undefined);
}

function sameVersion(left: RawRow | undefined, right: RawRow | undefined): boolean {
  if (!left || !right) return false;
  const a = rowVersion(left);
  const b = rowVersion(right);
  return a[0] === b[0] && a[1] === b[1];
}

export function laneState(ctx: any, lane: Lane, maxIterations: number) {
  const implRows = rawRows(ctx, "bpuiImpl").filter(
    (row) => baseNodeId(row) === `lane-${lane.id}-implement` && row.laneId === lane.id,
  );
  const implementation = latestRaw(implRows, `lane-${lane.id}-implement`);
  const validation = latestRaw(
    rawRows(ctx, "bpuiValidation").filter((row) => row.laneId === lane.id),
    `lane-${lane.id}-validate`,
  );
  const review = latestRaw(
    rawRows(ctx, "bpuiReview").filter((row) => row.laneId === lane.id),
    `lane-${lane.id}-review`,
  );
  const validationCurrent = sameVersion(implementation, validation);
  const reviewCurrent = validationCurrent && sameVersion(validation, review);
  const done =
    implementation?.status === "implemented" &&
    validationCurrent &&
    validation?.allPassed === true &&
    validation?.diffNonEmpty === true &&
    reviewCurrent &&
    review?.approved === true;
  const finalAttemptComplete = validationCurrent && (validation?.allPassed === false || reviewCurrent);
  return {
    implementation,
    validation,
    review,
    validationCurrent,
    reviewCurrent,
    done,
    attempts: implRows.length,
    exhausted: !done && implRows.length >= maxIterations && finalAttemptComplete,
  };
}

function laneFeedback(state: ReturnType<typeof laneState>): string {
  const parts: string[] = [];
  if (state.implementation && state.implementation.status !== "implemented")
    parts.push(
      `IMPLEMENTATION ${String(state.implementation.status).toUpperCase()}:\n${String(state.implementation.summary ?? "")}`,
    );
  if (state.validationCurrent && state.validation?.allPassed === false)
    parts.push(`VALIDATION FAILED:\n${String(state.validation.failingSummary ?? state.validation.summary ?? "")}`);
  if (state.validationCurrent && state.validation?.diffNonEmpty === false)
    parts.push(
      "VALIDATION FAILED: the worktree diff against the base branch is EMPTY. Your changes did not land in this worktree; re-apply them here.",
    );
  if (state.reviewCurrent && state.review?.approved === false)
    parts.push(`REVIEW NOT LGTM:\n${String(state.review.feedback ?? "")}`);
  return parts.join("\n\n");
}

function runCommand(cwd: string, command: string, args: string[], timeoutMs: number) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env }, timeout: timeoutMs });
  return {
    command: [command, ...args].join(" "),
    exitCode: typeof result.status === "number" ? result.status : null,
    stdout: (result.stdout ?? "").slice(-20_000),
    stderr: (result.stderr ?? result.error?.message ?? "").slice(-20_000),
  };
}

export function runWaveCi(wave: 1 | 2, cwd: string) {
  const commands: Array<[string, string[], number]> = [
    ["pnpm", ["typecheck"], 30 * 60_000],
    ["pnpm", ["-C", "packages/ui", "test"], 20 * 60_000],
    ["pnpm", ["-C", "packages/ui-styleguide", "test"], 10 * 60_000],
    ["pnpm", ["-C", "packages/gateway-ui", "test"], 20 * 60_000],
    ["pnpm", ["check:ui-architecture"], 10 * 60_000],
    ["pnpm", ["check:docs"], 10 * 60_000],
    ["pnpm", ["check:llms"], 10 * 60_000],
  ];
  const results = commands.map(([command, args, timeout]) => runCommand(cwd, command, args, timeout));
  const failed = results.filter((result) => result.exitCode !== 0);
  return {
    wave,
    allPassed: failed.length === 0,
    summary:
      failed.length === 0
        ? `Wave ${wave} gates green.`
        : `Wave ${wave}: ${failed.length} gate(s) failed: ${failed.map((f) => f.command).join("; ")}`,
    commands: results,
  };
}

// ── Prompts ─────────────────────────────────────────────────────────────────
const INVESTIGATION_CONTEXT = [
  "Campaign context (from the maintainer's audit, 2026-07-20):",
  "- packages/ui (@smithers-orchestrator/ui) is the ONE design system for every Smithers UI surface. gateway-ui + ui-styleguide are legacy facades mid-burndown.",
  "- The chat layer is only ChatMessage/ChatTranscript/ChatComposer; there are NO agent-native components (reasoning/thinking, tool calls, streaming markdown response, plans, sources). NodeOutputView renders agent output as a JSON <pre>.",
  "- shadcn-provenance.json declares approved collections (chat/shadcn, primitives/shadcn) but has zero entries; every port must register there.",
  "- shadcn/ui shipped an official chat set in June 2026 (MessageScroller, Message, Bubble, Attachment, Marker, shimmer, scroll-fade). Vercel AI Elements (elements.ai-sdk.dev) defines the agent taxonomy (Reasoning, Chain of Thought, Tool, Plan, Task, Sources, Inline Citation, Code Block...). Both are Tailwind-based, so we port ANATOMY (structure, states, interactions), never code.",
  "- The ratchet scripts/check-ui-architecture.mjs keeps packages/* and apps/* clean but ignores .smithers/, which is where hand-rolling concentrates (79 pack UI files, only 8 import the ui package).",
].join("\n");

function designPrompt(): string {
  return [
    "Freeze the component-API design for the Bulletproof UI campaign. You are writing the spec that four parallel implementation lanes will build against, so exactness beats prose.",
    INVESTIGATION_CONTEXT,
    "The lanes and their scopes:",
    ...LANES.filter((lane) => lane.wave === 1).map((lane) => `## ${lane.id}\n${lane.spec}`),
    HOUSE_RULES,
    "Read packages/ui/src/README.md, packages/ui/src/index.ts, packages/ui/src/chat/*.tsx, packages/ui/src/primitives/markdown.tsx, packages/ui/src/status.ts, packages/ui/src/tokens.ts, and packages/ui/tests/css-contract.test.ts BEFORE writing the spec.",
    "Return specMarkdown: for EVERY new component: exact file path, exported names, full TypeScript props signature, data-slot names, sui-* class names, CSS-block name in uiCss.ts, interaction/keyboard behavior, and its provenance registry URL. Also specify the ChatTranscript/MessageScroller integration and the primitives/markdown.tsx -> CodeBlock wiring so the two lanes touching markdown cannot diverge.",
    "Return componentApis: a compact TypeScript declaration block (just the exported types/signatures) that lanes can paste against.",
    "Design for merge-cleanliness: index.ts exports, uiCss.ts composition, and provenance entries will be edited by four lanes concurrently; specify EXACT append points and per-lane ordering so merges stay trivial.",
  ].join("\n\n");
}

function specReviewPrompt(spec: RawRow | undefined): string {
  return [
    "Adversarially review this frozen component-API spec before implementation begins. Try to refute it: naming collisions with existing exports, props that cannot express streaming states, CSS blocks that violate the tokens-only rule, merge hazards between the four lanes, anatomy that diverges from the upstream shadcn/AI-Elements items it claims to port, missing keyboard/a11y behavior.",
    "Approve only if an implementer could build every component from the spec alone without inventing API surface.",
    `Spec:\n${String(spec?.specMarkdown ?? "(missing)")}`,
    `APIs:\n${String(spec?.componentApis ?? "(missing)")}`,
  ].join("\n\n");
}

function implementPrompt(lane: Lane, spec: RawRow | undefined, feedback: string): string {
  return [
    `Implement lane ${lane.id}: ${lane.title}`,
    `Return laneId=${lane.id} exactly.`,
    lane.spec,
    lane.wave === 1
      ? `Frozen API spec (build EXACTLY this surface):\n${String(spec?.componentApis ?? "")}\n\nSpec detail for your lane (search for your components):\n${String(spec?.specMarkdown ?? "")}`
      : "",
    HOUSE_RULES,
    "Definition of done: new behavior covered by tests that went red before your change and green after; the owning package's focused test command passes; your worktree diff is non-empty and scoped to your lane.",
    feedback ? `Feedback on your previous attempt (fix ALL of it):\n${feedback}` : "",
    "Return implemented only when focused checks pass in THIS worktree; otherwise return partial or blocked truthfully with the failing output in summary.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function validatePrompt(lane: Lane, implementation: RawRow | undefined): string {
  return [
    `Validate lane ${lane.id} in this worktree. Return laneId=${lane.id} exactly.`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    "Steps (run them, do not trust the report):",
    "1. `jj diff --stat` (fall back to `git diff <baseBranch>... --stat`): diffNonEmpty=false if the worktree carries no changes.",
    "2. Run the owning packages' focused tests (pnpm -C packages/ui test, plus any package the diff touches).",
    "3. Spot-check the new tests actually assert the NEW behavior (open them; a test file that never imports the new component is a false pass).",
    "4. For packages/ui changes: run `pnpm check:ui-architecture` and `pnpm check:docs` from the repo root of this worktree.",
    "Set allPassed=false if the report says partial/blocked, any check fails, or a claimed test does not exist.",
  ].join("\n");
}

function reviewPrompt(
  lane: Lane,
  spec: RawRow | undefined,
  implementation: RawRow | undefined,
  validation: RawRow | undefined,
): string {
  return [
    `Strictly review the green candidate for lane ${lane.id}. Do not edit files. Return laneId=${lane.id} exactly.`,
    lane.wave === 1
      ? `The frozen API spec it must match:\n${String(spec?.componentApis ?? "")}`
      : `Lane scope:\n${lane.spec}`,
    `Implementation:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `Validation:\n${JSON.stringify(validation ?? null, null, 2)}`,
    "Review the DIFF in this worktree against: spec conformance (exact exported surface), the house architecture contract (tokens-only colors, CSS-as-string, data-slot anatomy, useInjectUiCss, no new deps), dark-mode correctness, test quality (red-to-green, meaningful assertions), and merge cleanliness (append-point discipline in index.ts/uiCss.ts/provenance).",
    "Approve only a complete, minimal, spec-conformant candidate.",
  ].join("\n\n");
}

function mergePrompt(result: RawRow, baseBranch: string): string {
  return [
    `Land lane ${String(result.laneId)} onto local ${baseBranch}. Source worktree: ${String(result.worktreePath)}; source branch/bookmark: ${String(result.branch)}.`,
    `Return laneId=${String(result.laneId)} exactly.`,
    "This repo is jj-colocated and SHARED with concurrent agents. Hard rules: use jj, never plain git for tree operations; NEVER git add -A / git commit -a / git stash / git commit --amend / git rebase; never blanket-stage; touch only this lane's files.",
    "Recipe:",
    `1. Verify the lane is non-empty: \`jj diff --stat -r ${String(result.branch)}\` (or from its merge-base with ${baseBranch}). If EMPTY, return mergedToMain=false and explain; do NOT report success for an empty lane.`,
    `2. \`jj rebase -b ${String(result.branch)} -d ${baseBranch}\`; resolve conflicts ONLY inside this lane's files (index.ts/uiCss.ts/provenance append points: keep both sides, this lane's entries at its designated append point).`,
    "3. Run the focused tests for the packages this lane touches, in the rebased tree.",
    `4. Fast-forward the local ${baseBranch} bookmark to the rebased tip: verify \`jj log -r ${baseBranch}\` still points where you rebased onto (if it moved, re-rebase and retry), then \`jj bookmark set ${baseBranch} -r <rebased-tip>\`.`,
    `5. Verify: \`jj diff --from <previous-${baseBranch}> --to ${baseBranch} --stat\` shows ONLY this lane's files, and \`git log --oneline -3 ${baseBranch}\` shows the lane commits. If foreign files appear, STOP and undo the bookmark move.`,
    "6. Do NOT push to origin. Local landing only.",
  ].join("\n");
}

function ciFixPrompt(wave: 1 | 2, ci: RawRow | undefined): string {
  return [
    `The wave ${wave} CI gate is red on local main. Fix it minimally so all gates pass. Return wave=${wave} exactly.`,
    `Gate output:\n${JSON.stringify(ci ?? null, null, 2)}`,
    "You are in the SHARED main checkout. Hard rules: touch only files implicated by the failures; commit with explicit pathspecs via jj (`jj commit <paths> -m ...`); NEVER git add -A / stash / amend / rebase; never edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx.",
    "check:llms failures mean regenerating bundles: run `pnpm docs:llms` ONLY if `jj st` shows no foreign uncommitted docs changes; otherwise report the conflict instead of baking foreign WIP into bundles.",
    "Re-run the exact failed commands until green.",
  ].join("\n\n");
}

function auditPrompt(ctx: any): string {
  const results = rawRows(ctx, "bpuiLaneResult");
  const merges = rawRows(ctx, "bpuiMerge");
  const ci = rawRows(ctx, "bpuiCi");
  return [
    "Final audit of the Bulletproof UI campaign. Verify ON DISK (read the actual files on local main), not from the reports:",
    "1. Every lgtm lane's components exist, are exported from packages/ui/src/index.ts, and have provenance entries.",
    "2. The wave CI rows are genuinely green and current.",
    "3. List what the campaign deliberately deferred as followUps (known: the ddd pack-UI family (~7.5k hand-rolled lines), delegation-chain/create-workflow bespoke theme stack, remaining gateway-ui legacy-facade burndown (~66 baseline refs), the concierge smithers:page prompt + theme handoff in the multi repo, multi's adoption of @smithers-orchestrator/ui, apps/smithers POC disposition, marketing *-site pages). Add anything the lane results show was skipped or exhausted.",
    "complete=true only if every wave-1 lane landed and gates are green.",
    `Lane results:\n${JSON.stringify(results, null, 2)}`,
    `Merges:\n${JSON.stringify(merges, null, 2)}`,
    `CI:\n${JSON.stringify(ci, null, 2)}`,
  ].join("\n\n");
}

// ── Workflow ────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxConcurrency: ctx.input.maxConcurrency ?? 4,
    perLaneIterations: ctx.input.perLaneIterations ?? 4,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const repoRoot = resolveRepoRoot();
  const runSlug = slug(String((ctx as any).runId ?? "bulletproof-ui"));

  const spec = latestRaw(rawRows(ctx, "bpuiSpec"), "design-freeze");
  const specReview = latestRaw(rawRows(ctx, "bpuiSpecReview"), "design-review");
  const specApproved = sameVersion(spec, specReview) && specReview?.approved === true;
  const specSettled = specApproved || rawRows(ctx, "bpuiSpec").length >= 2;

  const laneResults = rawRows(ctx, "bpuiLaneResult");
  const merges = rawRows(ctx, "bpuiMerge");
  const ciRows = rawRows(ctx, "bpuiCi").filter((row) => baseNodeId(row).startsWith("bpui-ci-wave"));

  const waveLanes = (wave: 1 | 2) => LANES.filter((lane) => lane.wave === wave);
  const waveSettled = (wave: 1 | 2) =>
    waveLanes(wave).every((lane) => laneResults.some((row) => row.laneId === lane.id));
  const waveMerged = (wave: 1 | 2) =>
    waveLanes(wave)
      .filter((lane) => laneResults.some((row) => row.laneId === lane.id && row.lgtm === true))
      .every((lane) => merges.some((row) => row.laneId === lane.id && row.mergedToMain === true));
  const waveCi = (wave: 1 | 2) =>
    latestRaw(
      ciRows.filter((row) => row.wave === wave),
      `bpui-ci-wave${wave}`,
    );
  const waveGreen = (wave: 1 | 2) => waveCi(wave)?.allPassed === true;
  const waveDone = (wave: 1 | 2) => waveSettled(wave) && waveMerged(wave) && waveGreen(wave);

  const renderWave = (wave: 1 | 2) => (
    <Sequence>
      <Parallel maxConcurrency={input.maxConcurrency}>
        {waveLanes(wave).map((lane) => {
          const branch = `bpui/${runSlug}/${lane.id}`;
          const worktreePath = join(repoRoot, ".smithers", "workflows", ".worktrees", runSlug, lane.id);
          const state = laneState(ctx, lane, input.perLaneIterations);
          const implementAgents = lane.agent === "sol" ? solChain : terraChain;
          return (
            <Worktree key={lane.id} path={worktreePath} branch={branch} baseBranch={input.baseBranch}>
              <Sequence>
                <Loop
                  id={`lane-${lane.id}-loop`}
                  until={state.done}
                  maxIterations={input.perLaneIterations}
                  onMaxReached="return-last"
                >
                  <Sequence>
                    <Task
                      id={`lane-${lane.id}-implement`}
                      output={outputs.bpuiImpl}
                      agent={implementAgents}
                      retries={2}
                      timeoutMs={90 * 60_000}
                      heartbeatTimeoutMs={10 * 60_000}
                    >
                      {implementPrompt(lane, spec, laneFeedback(state))}
                    </Task>
                    <Task
                      id={`lane-${lane.id}-validate`}
                      output={outputs.bpuiValidation}
                      agent={terraChain}
                      retries={2}
                      timeoutMs={35 * 60_000}
                      heartbeatTimeoutMs={10 * 60_000}
                    >
                      {validatePrompt(lane, state.implementation)}
                    </Task>
                    {state.validationCurrent &&
                    state.validation?.allPassed === true &&
                    state.validation?.diffNonEmpty === true ? (
                      <Task
                        id={`lane-${lane.id}-review`}
                        output={outputs.bpuiReview}
                        agent={solChain}
                        retries={2}
                        timeoutMs={35 * 60_000}
                        heartbeatTimeoutMs={10 * 60_000}
                      >
                        {reviewPrompt(lane, spec, state.implementation, state.validation)}
                      </Task>
                    ) : null}
                  </Sequence>
                </Loop>
                <Task id={`lane-${lane.id}-result`} output={outputs.bpuiLaneResult}>
                  {{
                    laneId: lane.id,
                    branch,
                    worktreePath,
                    lgtm: state.done,
                    exhausted: state.exhausted,
                    summary: state.done
                      ? `Lane ${lane.id} LGTM after ${state.attempts} attempt(s).`
                      : `Lane ${lane.id} settled without LGTM after ${state.attempts} attempt(s).`,
                  }}
                </Task>
              </Sequence>
            </Worktree>
          );
        })}
      </Parallel>

      <MergeQueue id={`bpui-merge-queue-wave${wave}`} maxConcurrency={1}>
        {laneResults
          .filter(
            (row) =>
              waveLanes(wave).some((lane) => lane.id === row.laneId) &&
              row.lgtm === true &&
              !merges.some((merge) => merge.laneId === row.laneId && merge.mergedToMain === true),
          )
          .map((row) => (
            <Task
              key={String(row.laneId)}
              id={`merge-${slug(String(row.laneId))}`}
              output={outputs.bpuiMerge}
              agent={terraChain}
              retries={2}
              timeoutMs={45 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {mergePrompt(row, input.baseBranch)}
            </Task>
          ))}
      </MergeQueue>

      {waveSettled(wave) && waveMerged(wave) ? (
        <Loop id={`bpui-ci-loop-wave${wave}`} until={waveGreen(wave)} maxIterations={3} onMaxReached="return-last">
          <Sequence>
            <Task id={`bpui-ci-wave${wave}`} output={outputs.bpuiCi} timeoutMs={120 * 60_000}>
              {() => runWaveCi(wave, repoRoot)}
            </Task>
            {waveCi(wave) && waveCi(wave)?.allPassed === false ? (
              <Task
                id={`bpui-ci-fix-wave${wave}`}
                output={outputs.bpuiCiFix}
                agent={solChain}
                retries={2}
                timeoutMs={60 * 60_000}
                heartbeatTimeoutMs={10 * 60_000}
              >
                {ciFixPrompt(wave, waveCi(wave))}
              </Task>
            ) : null}
          </Sequence>
        </Loop>
      ) : null}
    </Sequence>
  );

  return (
    <Workflow name="bulletproof-ui">
      <UI entry="../ui/bulletproof-ui.tsx" title="Bulletproof UI Campaign" />
      <Sequence>
        <Loop id="bpui-design-loop" until={specApproved} maxIterations={2} onMaxReached="return-last">
          <Sequence>
            <Task
              id="design-freeze"
              output={outputs.bpuiSpec}
              agent={designAgents}
              retries={2}
              timeoutMs={60 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {designPrompt() +
                (specReview && specReview.approved === false
                  ? `\n\nPrevious spec review feedback (address ALL of it):\n${String(specReview.feedback ?? "")}`
                  : "")}
            </Task>
            <Task
              id="design-review"
              output={outputs.bpuiSpecReview}
              agent={solChain}
              retries={2}
              timeoutMs={30 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {specReviewPrompt(spec)}
            </Task>
          </Sequence>
        </Loop>

        {specSettled ? renderWave(1) : null}
        {specSettled && waveDone(1) ? renderWave(2) : null}

        {specSettled && waveDone(1) && waveDone(2) ? (
          <Task
            id="final-audit"
            output={outputs.bpuiAudit}
            agent={auditAgents}
            retries={2}
            timeoutMs={45 * 60_000}
            heartbeatTimeoutMs={10 * 60_000}
          >
            {auditPrompt(ctx)}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
