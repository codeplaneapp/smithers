// smithers-display-name: Bulletproof UI Design Fixes
/** @jsxImportSource smithers-orchestrator */
import { MergeQueue, OpenCodeAgent as SmithersOpenCodeAgent, Parallel, Sequence, Task, UI, Worktree, createSmithers } from "smithers-orchestrator";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// Fixes every finding from the kimi-3 design pass
// (.smithers/specs/bulletproof-ui-design-pass.md). Lanes verify each claim
// against the CURRENT tree first: some findings were made against a stale
// checkout, so a lane fixes what is real and reports what is not.
// Ends with the isolated full gate and a kimi re-verification of the list.
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const terraChain = codexFirst(
  { model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true },
  [providers.claudeSonnet, providers.claude],
);
const kimiDesigner = new SmithersOpenCodeAgent({ model: "kimi-for-coding/k3" });

const laneIds = [
  "tokens-contrast",
  "focus-ring",
  "keyboard-a11y",
  "adapter-theming",
  "status-unification",
  "generated-html-residuals",
  "pack-ui-residuals",
  "motion-and-scale",
] as const;
const laneIdSchema = z.enum(laneIds);

const implSchema = z.object({
  laneId: laneIdSchema,
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(20),
  fixedFindings: z.array(z.string()).default([]),
  notRealFindings: z.array(z.string()).default([]),
  filesChanged: z.array(z.string()).min(1),
});
const validationSchema = z.object({
  laneId: laneIdSchema,
  allPassed: z.boolean(),
  branchDiffNonEmpty: z.boolean(),
  inheritedFailuresOnly: z.boolean().default(false),
  summary: z.string().min(20),
  commandsRun: z.array(z.string()).min(1),
  failingSummary: z.string().nullable().default(null),
});
const reviewSchema = z.object({
  laneId: laneIdSchema,
  approved: z.boolean(),
  feedback: z.string().min(10),
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
});
const gateSchema = z.object({
  allPassed: z.boolean(),
  mainCommit: z.string().min(6),
  summary: z.string().min(20),
  results: z.array(z.object({
    command: z.string(),
    passed: z.boolean(),
    detail: z.string(),
  })).min(5),
});
const gateFixSchema = z.object({
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).default([]),
});
const reverifySchema = z.object({
  verdict: z.string().min(50),
  fixedConfirmed: z.array(z.string()).default([]),
  residuals: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(8).default(4),
  perLaneIterations: z.number().int().min(1).max(6).default(3),
  baseBranch: z.string().trim().min(1).default("main"),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  bpuiDfImpl: implSchema,
  bpuiDfValidation: validationSchema,
  bpuiDfReview: reviewSchema,
  bpuiDfLaneResult: laneResultSchema,
  bpuiDfMerge: mergeSchema,
  bpuiDfGate: gateSchema,
  bpuiDfGateFix: gateFixSchema,
  bpuiDfReverify: reverifySchema,
});

type RawRow = Record<string, unknown>;
type LaneId = (typeof laneIds)[number];

type Lane = { id: LaneId; title: string; spec: string };

const LANES: Lane[] = [
  {
    id: "tokens-contrast",
    title: "Token-layer contrast ramp + soft-tint tokens",
    spec: [
      "Report fix #1 and #7 (token side). In packages/ui-styleguide: darken the LIGHT-theme success/danger/warning hexes and lighten dark --text-faint so every documented token pairing used for text meets WCAG AA (verify with a real contrast computation, not eyeballing; add a test that computes contrast ratios for the token pairs and pins AA).",
      "Add shared soft-tint tokens (per-semantic *-soft backgrounds and *-border variants) to the styleguide, then replace the hand-rolled color-mix percentage recipes that reimplement the same concept in packages/ui (uiCss badge/pill blocks) and the styleguide's own .pill rules with the new tokens. Replace solid semantic fills flagged by the report (gateway-ui ApprovalPanel primary, pack review.tsx primary) with the house tinted treatment where those claims verify against the current tree.",
      "packages/ui token FALLBACK values must stay byte-equal to the styleguide light values (css-contract test enforces this) — update both sides together.",
    ].join("\n"),
  },
  {
    id: "focus-ring",
    title: "Visible keyboard focus everywhere",
    spec: [
      "Report fix #2. Extend the shared focus-ring recipe so every interactive on every surface shows a visible focus-visible ring: monitor .mon-* interactives (apps/cli/src/monitor-ui), gateway-ui components still using inline-styled interactive elements (convert them to class-based rules in their CSS strings; do not add a CSS framework), and the Milkdown Crepe adapter (its theme sets outline:none; restore a house-token outline).",
      "Add render tests asserting the ring class/rule applies on focus-visible for at least one interactive per surface touched.",
    ].join("\n"),
  },
  {
    id: "keyboard-a11y",
    title: "Keyboard operability and announcements",
    spec: [
      "Report fix #10. Verify each claim first, then fix the real ones: keyboard-operable rows in the monitor RunsTable and pack review.tsx lanes (real button/link semantics or key handlers + tabindex, not clickable divs); focusable scrollable regions (tabindex=0 + role/aria-label on overflow containers); FileTree/ExecutionTree either implement the ARIA tree pattern (roving tabindex, arrow keys) or drop the tree role claim honestly; chat typing/streaming indicator announces via role=status/aria-live=polite.",
      "Add keyboard-interaction tests (happy-dom KeyboardEvent dispatch) for what you change.",
    ].join("\n"),
  },
  {
    id: "adapter-theming",
    title: "data-theme-wins in adapters",
    spec: [
      "Report fix #3. Ship one shared resolveTheme() helper (own file in packages/ui, exported) implementing the house contract: explicit data-theme on :root wins, else prefers-color-scheme. Then make the adapters obey it: the Crepe markdown-editor theme must respond to data-theme (not media-query-only) and map onto house tokens/fonts; gateway-ui WorkflowGraph's colorMode must derive from resolveTheme() instead of its current source. Fix any adapter that can disagree with the app shell about the active theme.",
      "Tests: toggling data-theme on the root flips each touched adapter's resolved mode.",
    ].join("\n"),
  },
  {
    id: "status-unification",
    title: "One status vocabulary everywhere",
    spec: [
      "Report fix #6 + cross-surface #1. 'running' must render ONE color system-wide (the brand mapping in packages/ui/src/status.ts). Fix the agentic components (Plan/ChainOfThought/TaskItem active dots use info-blue) to route through statusClass/statusColors; make the pack UIs (.smithers/ui/review.tsx, issue-blitz.tsx) import normalizeStatus/statusClass instead of any local mapping that survives; sweep packages/gateway-ui and the monitor for stray literal status colors.",
      "Extend the status.ts vocabulary only if a surface has a genuinely missing state; never fork it.",
    ].join("\n"),
  },
  {
    id: "generated-html-residuals",
    title: "Generated-HTML token contract residuals",
    spec: [
      "Report fix #4 — much of this landed already (standaloneThemeCss exists; walkthrough/prompt rewired). VERIFY against the current tree and close only the residuals the report names that are still true: the report-slideshow prompt must require the token block AND `color-scheme: light dark`; apps/review landingPage.ts must build on the shared bundle; the walkthrough must not bake a light-only Pierre diff theme (respect resolved theme). Skip with evidence anything already done.",
    ].join("\n"),
  },
  {
    id: "pack-ui-residuals",
    title: "Pack UI residual defects",
    spec: [
      "Report fix #5 — issue-blitz.tsx and review.tsx were rewritten AFTER some reviewers read the old tree. VERIFY against current .smithers/ui/review.tsx and issue-blitz.tsx and fix only what is still true: colliding styleguide class names in review.tsx, a dead dark :root block, any remaining WorkflowUiStyles-bypassing markup. Verify with the scoped-tsconfig typecheck inside .smithers/ and smithers graph for both owning workflows.",
    ].join("\n"),
  },
  {
    id: "motion-and-scale",
    title: "Reduced motion + type-scale drift",
    spec: [
      "Report fix #9 + cross-surface #6. Move the prefers-reduced-motion guard into the shared CSS layer (packages/ui uiCss + styleguide) so spinner, skeleton shimmer, transitions, monitor .run-row animation, and the terminal cursorBlink all honor it once, centrally; remove per-component one-off guards it obsoletes.",
      "Type-scale drift: the documented scale is contradicted by de facto 12.5px usage across uiCss, walkthroughCss, and agentic components. Pick the honest resolution: either admit 12.5px into the documented scale (styleguide + docs updated together) or migrate the drifted sites onto the nearest documented step. Apply ONE resolution consistently; do not leave both.",
      "The two-diff-color-languages item (sui-diff tints vs Shiki themes in PierreDiffView): fix only if a tokens-level alignment is cheap; if it needs invasive Shiki theme authoring, report it as a deliberate deferral in your summary instead.",
    ].join("\n"),
  },
];

const VERIFY_FIRST = "IMPORTANT: the design-pass report was partly produced against a STALE tree. For every claim in your lane: verify it against the CURRENT tree first (read the actual file). Fix what is real; list what is not in notRealFindings with one line of evidence each. Never 'fix' something already correct.";

const HOUSE_RULES = [
  "Read packages/ui/src/README.md and the report .smithers/specs/bulletproof-ui-design-pass.md (your lane's findings) before editing.",
  "Architecture contract: tokens-only colors, CSS as strings (sui-* namespace, uiCss.ts composition), light fallbacks byte-equal to styleguide light values, no new dependencies, heavy deps stay behind adapters.",
  "Definition of done: red-to-green tests for new behavior; owning packages' focused tests pass; pnpm check:ui-architecture and pnpm check:docs green from the worktree root (failures ONLY in files outside your diff are inherited: note them, do not chase them).",
  "Use jj; explicit pathspec commits; never git add -A / stash / amend. NEVER edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx.",
  'Diff contract: your lane diff is the BRANCH against its fork point with main (jj diff --from "fork_point(main | <branch>)" --to <branch>), never the bare working copy.',
].join("\n");

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "item";
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
  return rows.filter((row) => baseNodeId(row) === nodeId).reduce<RawRow | undefined>((best, row) => {
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
  const implRows = rawRows(ctx, "bpuiDfImpl").filter((row) => baseNodeId(row) === `df-${lane.id}-implement` && row.laneId === lane.id);
  const implementation = latestRaw(implRows, `df-${lane.id}-implement`);
  const validation = latestRaw(rawRows(ctx, "bpuiDfValidation").filter((row) => row.laneId === lane.id), `df-${lane.id}-validate`);
  const review = latestRaw(rawRows(ctx, "bpuiDfReview").filter((row) => row.laneId === lane.id), `df-${lane.id}-review`);
  const validationCurrent = sameVersion(implementation, validation);
  const reviewCurrent = validationCurrent && sameVersion(validation, review);
  const done = implementation?.status === "implemented"
    && validationCurrent && validation?.allPassed === true && validation?.branchDiffNonEmpty === true
    && reviewCurrent && review?.approved === true;
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
  if (state.implementation && state.implementation.status !== "implemented") parts.push(`IMPLEMENTATION ${String(state.implementation.status).toUpperCase()}:\n${String(state.implementation.summary ?? "")}`);
  if (state.validationCurrent && state.validation?.allPassed === false) parts.push(`VALIDATION FAILED:\n${String(state.validation.failingSummary ?? state.validation.summary ?? "")}`);
  if (state.validationCurrent && state.validation?.branchDiffNonEmpty === false) parts.push("VALIDATION: the BRANCH fork-point diff is empty. Commit your work in this worktree so it lands on the lane branch.");
  if (state.reviewCurrent && state.review?.approved === false) parts.push(`REVIEW NOT LGTM:\n${String(state.review.feedback ?? "")}`);
  return parts.join("\n\n");
}

const GATE_COMMANDS = [
  "pnpm typecheck",
  "pnpm -C packages/ui test",
  "pnpm -C packages/ui-styleguide test",
  "pnpm -C packages/gateway-ui test",
  "pnpm check:ui-architecture",
  "pnpm check:docs",
  "pnpm check:llms",
].join("; ");

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxConcurrency: ctx.input.maxConcurrency ?? 4,
    perLaneIterations: ctx.input.perLaneIterations ?? 3,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const repoRoot = resolveRepoRoot();
  const runSlug = slug(String((ctx as any).runId ?? "bpui-design-fixes"));

  const laneResults = rawRows(ctx, "bpuiDfLaneResult");
  const merges = rawRows(ctx, "bpuiDfMerge");
  const lanesSettled = LANES.every((lane) => laneResults.some((row) => row.laneId === lane.id));
  const allLgtmMerged = LANES
    .filter((lane) => laneResults.some((row) => row.laneId === lane.id && row.lgtm === true))
    .every((lane) => merges.some((row) => row.laneId === lane.id && row.mergedToMain === true));
  const gate = latestRaw(rawRows(ctx, "bpuiDfGate"), "df-gate");

  return (
    <Workflow name="bulletproof-ui-design-fixes">
      <UI entry="../ui/bulletproof-ui-design-fixes.tsx" title="Bulletproof UI Design Fixes" />
      <Sequence>
        <Parallel maxConcurrency={input.maxConcurrency}>
          {LANES.map((lane) => {
            const branch = `bpui-df/${runSlug}/${lane.id}`;
            const worktreePath = join(repoRoot, ".smithers", "workflows", ".worktrees", runSlug, lane.id);
            const state = laneState(ctx, lane, input.perLaneIterations);
            return (
              <Worktree key={lane.id} path={worktreePath} branch={branch} baseBranch={input.baseBranch}>
                <Sequence>
                  <Loop id={`df-${lane.id}-loop`} until={state.done} maxIterations={input.perLaneIterations} onMaxReached="return-last">
                    <Sequence>
                      <Task id={`df-${lane.id}-implement`} output={outputs.bpuiDfImpl} agent={solChain} retries={2} timeoutMs={75 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                        {[
                          `Implement design-fix lane ${lane.id}: ${lane.title}. Return laneId=${lane.id} exactly.`,
                          VERIFY_FIRST,
                          lane.spec,
                          HOUSE_RULES,
                          laneFeedback(state) ? `Feedback on your previous attempt (fix ALL of it):\n${laneFeedback(state)}` : "",
                          "Return implemented only when focused checks pass in THIS worktree; report fixedFindings and notRealFindings honestly.",
                        ].filter(Boolean).join("\n\n")}
                      </Task>
                      <Task id={`df-${lane.id}-validate`} output={outputs.bpuiDfValidation} agent={terraChain} retries={2} timeoutMs={35 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                        {[
                          `Validate lane ${lane.id} in its worktree. Return laneId=${lane.id} exactly.`,
                          `Implementation report:\n${JSON.stringify(state.implementation ?? null, null, 2)}`,
                          `Run, do not trust: 1) the BRANCH fork-point diff (jj diff --from "fork_point(main | ${branch})" --to ${branch} --stat; a clean working copy is expected, branchDiffNonEmpty comes from THIS); 2) focused tests for every package the diff touches; 3) pnpm check:ui-architecture and pnpm check:docs from the worktree root; 4) spot-check claimed notRealFindings: read the file and confirm the claim is genuinely already satisfied.`,
                          "Failures ONLY in files outside the branch diff are inherited: set inheritedFailuresOnly=true, name them, do not count against allPassed.",
                        ].join("\n\n")}
                      </Task>
                      {state.validationCurrent && state.validation?.allPassed === true && state.validation?.branchDiffNonEmpty === true ? (
                        <Task id={`df-${lane.id}-review`} output={outputs.bpuiDfReview} agent={solChain} retries={2} timeoutMs={35 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                          {[
                            `Strictly review the candidate for lane ${lane.id}. Do not edit files. Return laneId=${lane.id} exactly.`,
                            `Lane scope:\n${lane.spec}`,
                            `Implementation:\n${JSON.stringify(state.implementation ?? null, null, 2)}`,
                            `Validation:\n${JSON.stringify(state.validation ?? null, null, 2)}`,
                            "Review the fork-point diff: every real finding in scope genuinely closed (not papered over), notRealFindings claims each verified with evidence, house contract held (tokens-only, fallback byte-equality, no new deps), tests meaningful. Approve a complete, minimal candidate.",
                          ].join("\n\n")}
                        </Task>
                      ) : null}
                    </Sequence>
                  </Loop>
                  <Task id={`df-${lane.id}-result`} output={outputs.bpuiDfLaneResult}>
                    {{
                      laneId: lane.id,
                      branch,
                      worktreePath,
                      lgtm: state.done,
                      exhausted: state.exhausted,
                      summary: state.done ? `Lane ${lane.id} LGTM after ${state.attempts} attempt(s).` : `Lane ${lane.id} settled without LGTM after ${state.attempts} attempt(s).`,
                    }}
                  </Task>
                </Sequence>
              </Worktree>
            );
          })}
        </Parallel>

        <MergeQueue id="df-merge-queue" maxConcurrency={1}>
          {laneResults
            .filter((row) => row.lgtm === true && !merges.some((merge) => merge.laneId === row.laneId && merge.mergedToMain === true))
            .map((row) => (
              <Task key={String(row.laneId)} id={`df-merge-${slug(String(row.laneId))}`} output={outputs.bpuiDfMerge} agent={terraChain} retries={2} timeoutMs={45 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                {[
                  `Land lane ${String(row.laneId)} onto local ${input.baseBranch}. Worktree: ${String(row.worktreePath)}; bookmark: ${String(row.branch)}. Return laneId=${String(row.laneId)} exactly.`,
                  "jj only; never git add -A / stash / amend / rebase; touch only lane files.",
                  `Recipe: verify the fork-point diff is NON-EMPTY (jj diff --from "fork_point(main | ${String(row.branch)})" --to ${String(row.branch)} --stat); jj rebase -b ${String(row.branch)} -d ${input.baseBranch}; conflicts only in lane files (several lanes touch uiCss.ts/styleguide tokens: keep both sides and re-run the css-contract test); run the focused tests in the rebased tree; CAS the bookmark (confirm ${input.baseBranch} unmoved, else re-rebase); jj bookmark set ${input.baseBranch} -r <rebased-tip>; verify the delta contains ONLY lane files; do NOT push to origin.`,
                ].join("\n\n")}
              </Task>
            ))}
        </MergeQueue>

        {lanesSettled && allLgtmMerged ? (
          <Loop id="df-gate-loop" until={gate?.allPassed === true} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task id="df-gate" output={outputs.bpuiDfGate} agent={terraChain} retries={2} timeoutMs={100 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                {[
                  "Run the full gate suite against ACTUAL local main in a pristine isolated worktree (the engine checkout may be stale; never run gates there).",
                  `Steps: 1) MAIN=$(jj log -r ${input.baseBranch} -T commit_id --no-graph | head -c 12); 2) git worktree add --detach /tmp/bpui-df-gate $MAIN; 3) cd there, pnpm install --frozen-lockfile (a failure here IS a gate failure: report it); 4) run: ${GATE_COMMANDS}; 5) report mainCommit=$MAIN with one result per command; 6) ALWAYS clean up: git worktree remove --force /tmp/bpui-df-gate.`,
                  "Report honestly; do not fix anything in this task.",
                ].join("\n\n")}
              </Task>
              {gate && gate.allPassed === false ? (
                <Task id="df-gate-fix" output={outputs.bpuiDfGateFix} agent={solChain} retries={2} timeoutMs={60 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                  {[
                    "The full gate suite is red on local main. Fix it minimally so every gate passes.",
                    `Gate report:\n${JSON.stringify(gate, null, 2)}`,
                    "Make fixes as commits ON TOP OF the main bookmark (jj new main; edit; jj commit <paths>; CAS-move main), never by editing a stale working tree in place. Explicit pathspecs; never blanket-stage; never edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx. Regenerate llms bundles only in a CLEAN scratch worktree of main.",
                  ].join("\n\n")}
                </Task>
              ) : null}
            </Sequence>
          </Loop>
        ) : null}

        {lanesSettled && allLgtmMerged && gate?.allPassed === true ? (
          <Task id="df-reverify" output={outputs.bpuiDfReverify} agent={kimiDesigner} retries={2} timeoutMs={40 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
            {[
              "You are the design reviewer re-verifying the fix campaign. READ-ONLY: edit nothing.",
              "Read .smithers/specs/bulletproof-ui-design-pass.md (the original findings) and the lane results below, then verify ON THE CURRENT TREE that each prioritized fix and cross-surface inconsistency is genuinely resolved: recompute the flagged contrast pairs, check focus-visible rules reach the surfaces named, toggle-check the data-theme contract in the adapters' code, grep for surviving literal status colors / color-mix recipes / 12.5px drift.",
              `Lane results:\n${JSON.stringify(rawRows(ctx, "bpuiDfLaneResult"), null, 2)}`,
              `Deliberate skips (claimed not-real or deferred):\n${JSON.stringify(rawRows(ctx, "bpuiDfImpl").map((r) => ({ laneId: r.laneId, notReal: r.notRealFindings })), null, 2)}`,
              "Report fixedConfirmed (finding: evidence), residuals (anything NOT genuinely fixed, with file evidence), and an overall verdict.",
            ].join("\n\n")}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
