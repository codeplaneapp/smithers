// smithers-display-name: Finish Agentic UI Library Program
/** @jsxImportSource smthrs */
import {
  ClaudeCodeAgent,
  MergeQueue,
  OpenCodeAgent,
  Parallel,
  Sequence,
  Task,
  UI,
  Worktree,
  createSmithers,
} from "smthrs";
import { join } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";
import {
  ADOPTION_LANES,
  EXPLICIT_DEFERRALS,
  MULTI_ROOT,
  auditSchema,
  ciFixSchema,
  ciSchema,
  implSchema,
  laneResultSchema,
  laneState,
  manifestSchema,
  resolveRepoRoot,
  reviewSchema,
  runMultiCi,
  runSmithersCi,
  validationSchema,
} from "./build-agentic-ui-library";

// Continuation of run-1784654981789 (build-agentic-ui-library). That run
// integrated all ten component lanes onto local main (5572e7421e) but settled
// incomplete: six lanes' merged code never received its required seat
// approvals, the recorded smithers CI row is red on a happy-dom preload
// defect, ChatTranscript lacks a provenance entry, and the Multi adoption
// phase never ran. This workflow closes exactly those gaps: parallel fix
// lanes seeded with each rejecting reviewer's final findings, seat
// re-reviews, CAS merges, an integration fixup + green CI row + dual review,
// then the three Multi adoption lanes, the Multi CI loop, and fresh dual
// audits.

type Seat = "fable" | "sol";
type FixLane = {
  id: string;
  seats: Seat[];
  findings: string;
};

// Verbatim final findings from the rejecting reviewers of the parent run.
export const FIX_LANES: FixLane[] = [
  {
    id: "conversation-foundation",
    seats: ["fable", "sol"],
    findings: [
      "Sol's final rejection (Fable had approved): (major) the required MessageScroller Provider/Scroller composition is broken; (major) programmatic scroll tracking can remain stuck (follow behavior after jump-to-message/jump-to-latest); (minor) the uncontrolled MessageBranch index is not reconciled with the branch count when branches change.",
      "Fix all three on the integrated code (packages/ui/src/chat/), with tests that go red before the fix and green after (composition contract, follow-state recovery, branch index clamping).",
    ].join("\n"),
  },
  {
    id: "reasoning-tools",
    seats: ["sol"],
    findings: [
      "Sol's final rejection: (major) packages/ui/provenance/reasoning-tools.json gave AgentOutput a null registryItem and declared CodeBlock partial-anatomy with no omissions list (upstream Title/Actions/CopyButton/language-selector/Container/Content are omitted). The integration lane later aggregated provenance — VERIFY the current fragment on main and fix any residual inaccuracy. (minor) ChainOfThoughtStep's expanded detail uses role=\"region\" without aria-label/aria-labelledby: give the trigger a stable id, label the region from it, and add a screen-reader relationship assertion.",
    ].join("\n"),
  },
  {
    id: "agent-identity-context",
    seats: ["sol"],
    findings: [
      "Sol's final rejection: (a) the default ContextUsage disclosure lacks a meaningful screen-reader name — give it an accessible name derived from the usage summary; (b) the ContextUsage hover timer can fire after unmount — clear it on unmount and add a regression test.",
    ].join("\n"),
  },
  {
    id: "approvals-checkpoints",
    seats: ["sol"],
    findings: [
      "The lane branch failed validation mechanically (its round-2 fix was committed to an orphaned bookmark and included forbidden shared-file edits) so its final code was never seat-reviewed. Integration has since landed an approvals layer (packages/ui/src/approvals/ + gateway-ui wrappers) and the architecture guard passes. VERIFY the integrated state: sanctioned layer placement, gateway wrapper files in their contract location, no TS rootDir errors (pnpm -C packages/gateway-ui test + root typecheck), approval-state coverage (synchronizing/requested/approving/denying/approved/denied/expired/unavailable/failed-submission), checkpoint actions (restore/fork/replay/rewind/return-to-live). Fix anything short of the frozen contract.",
    ].join("\n"),
  },
  {
    id: "sandbox-previews",
    seats: ["sol"],
    findings: [
      "Sol's final rejection — SECURITY: (critical) malformed runtime sandbox token values smuggle past the forbidden allow-scripts+allow-same-origin pair check (normalize/parse tokens before comparing; reject unknown or malformed tokens); (major) the root-relative URL check misclassifies backslash network paths (e.g. /\\evil.com, /\\\\evil.com) as same-origin. Fix both in the integrated WebPreview/Sandbox code with adversarial tests covering token-case, whitespace, duplicate and escaped-separator variants.",
    ].join("\n"),
  },
  {
    id: "workflow-canvas",
    seats: ["fable", "sol"],
    findings: [
      "Both seats rejected the final round (their detailed findings were not preserved). Integration subsequently reworked the canvas layer (taught the ui-architecture guard the canvas layer, corrected canvas provenance, honored the integration-owned barrel). Self-audit the integrated packages/ui/src/canvas/ family against the frozen contract: renderer-neutral anatomy (no @xyflow/react in base), WorkflowGraph integration in gateway-ui rather than a competing graph model, status vocabulary via src/status.ts, keyboard/reduced-motion/SR behavior, provenance accuracy. Fix what falls short; the seat reviews are a fresh full-strictness pass.",
    ].join("\n"),
  },
];

const INTEGRATION_FIXUPS = [
  "1. happy-dom preload: packages/ui/tests/happy-dom-preload.ts currently calls GlobalRegistrator.register({ settings: { disableIframePageLoading: true } }), which REPLACES happy-dom's default settings and makes tests/terminal.test.tsx ('default palette follows root data-theme toggles') time out. Verified fix: register() plainly, then mutate the live settings object (globalThis.happyDOM.settings.disableIframePageLoading = true) so defaults merge. Both properties must hold afterwards: the terminal suite passes deterministically AND the WebPreview iframe tests stay network-independent.",
  "2. Provenance: add the missing ChatTranscript entry to packages/ui/provenance/conversation-foundation.json and re-aggregate packages/ui/shadcn-provenance.json; run node scripts/check-docs.mjs and node scripts/check-llms.mjs (regenerate bundles only if `jj st` shows no foreign uncommitted docs changes).",
  "3. Naming reconciliation: the program records planned names Task/TaskTrigger/TaskContent/TaskGroup and Agent/Test that shipped as AgentTask*/AgentDefinition/TestRow per the frozen collision policy; make sure docs/reference/ui/agentic-ui.mdx (and the gallery) state the shipped names and the mapping.",
  "4. If any fix lane's merge row reports mergedToMain=false, land it yourself from its worktree/branch with the same CAS recipe before finishing.",
].join("\n");

const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(6).default(3),
  perLaneIterations: z.number().int().min(1).max(3).default(3),
  baseBranch: z.string().trim().min(1).default("main"),
});

const mergeSchema = z.object({
  laneId: z.string().min(1),
  mergedToMain: z.boolean(),
  summary: z.string().min(10),
  commandsRun: z.array(z.string()).default([]),
});
const finalReportSchema = z.object({
  success: z.boolean(),
  fixLanesLgtm: z.number().int().min(0),
  fixLanesTotal: z.number().int().min(0),
  integrationDone: z.boolean(),
  adoptionDone: z.boolean(),
  smithersCiGreen: z.boolean(),
  multiCiGreen: z.boolean(),
  auditsComplete: z.boolean(),
  summary: z.string().min(20),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  aguiImpl: implSchema,
  aguiValidation: validationSchema,
  aguiReview: reviewSchema,
  aguiLaneResult: laneResultSchema,
  aguiFinMerge: mergeSchema,
  aguiCi: ciSchema,
  aguiCiFix: ciFixSchema,
  aguiAudit: auditSchema,
  aguiManifest: manifestSchema,
  aguiFinReport: finalReportSchema,
});

// Agents: same seats as the parent program.
const kimiImplement = [new OpenCodeAgent({ model: "kimi-for-coding/k3" }), providers.claudeSonnet];
const kimiImplementMulti = [
  new OpenCodeAgent({ model: "kimi-for-coding/k3", cwd: MULTI_ROOT }),
  new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: MULTI_ROOT }),
];
const fableChain = [providers.claude, providers.claudeOpus];
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const fableChainMulti = [new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT })];
const solChainMulti = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true, cwd: MULTI_ROOT },
  [new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT })],
);
const validateChain = [providers.claudeSonnet, providers.claude];
const validateChainMulti = [
  new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: MULTI_ROOT }),
  new ClaudeCodeAgent({ model: "claude-fable-5", cwd: MULTI_ROOT }),
];
const mergeChain = [providers.claudeSonnet, providers.claude];

type RawRow = Record<string, unknown>;
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "item"
  );
}
function rawRows(ctx: any, channel: string): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}
function baseNodeId(row: RawRow): string {
  return String(row.nodeId ?? "").split("@@", 1)[0] ?? "";
}
function rowVersion(row: RawRow): [number, number] {
  const iteration = Number.isFinite(Number(row.iteration)) ? Number(row.iteration) : 0;
  const iterationCount = Number.isFinite(Number(row.iterationCount)) ? Number(row.iterationCount) : iteration;
  return [iterationCount, iteration];
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
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

const SHARED_TREE_RULES = [
  "Shared-tree rules: the primary checkout is jj-colocated and shared with concurrent agents; unrelated uncommitted work must be preserved. Use jj st / jj diff as truth; commit ONLY your own files with explicit pathspecs (`jj commit <paths> -m ...`); NEVER git add -A / git commit -a / git stash / git rebase / --amend; never blanket-stage. NEVER edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/*agentic-ui-library*.tsx (a live run imports them).",
].join("\n");

function fixImplementPrompt(lane: FixLane, feedback: string): string {
  return [
    `Fix lane ${lane.id} of the agentic UI library program. The lane's components are ALREADY INTEGRATED on this branch's base (local main); your job is to close the rejecting reviewer's final findings on that integrated code.`,
    `Return laneId=${lane.id} exactly.`,
    `Final findings to close (verify each on disk first — integration may have already fixed some; report any already-fixed item in summary rather than re-fixing):\n${lane.findings}`,
    "House rules: packages/ui architecture contract applies (read packages/ui/src/README.md; data-slot anatomy, sui-* classes, tokens-only colors, CSS as TS strings, self-injected stylesheets; light/dark/reduced-motion/keyboard/SR mandatory). Real red-to-green tests for every fix; run `pnpm -C packages/ui test` (and `pnpm -C packages/gateway-ui test` if touched) until green in THIS worktree.",
    "You work in an isolated jj/git worktree; use jj, commit only your own files with explicit pathspecs. Do NOT edit shared integration files (packages/ui/src/index.ts, uiCss.ts, shadcn-provenance.json, package manifests, lockfiles, docs/**) — if a finding requires a provenance/docs change, note it in summary for the integration step instead.",
    feedback ? `Feedback on your previous attempt (fix ALL of it):\n${feedback}` : "",
    "Return componentsImplemented with the exported names you touched, and status=implemented only when the focused checks pass here.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function fixValidatePrompt(lane: FixLane, branch: string, implementation: RawRow | undefined): string {
  return [
    `Validate fix lane ${lane.id} in this worktree. Return laneId=${lane.id} exactly.`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `Findings that must be closed:\n${lane.findings}`,
    "Steps (run them, do not trust the report):",
    `1. Diff the BRANCH: \`jj diff --from "fork_point(main | ${branch})" --to ${branch} --stat\`. diffNonEmpty=false if the branch carries no changes — UNLESS the implementation report claims every finding was already fixed by integration; in that case verify each claim on disk and treat a verified all-already-fixed lane as diffNonEmpty=true with a note in summary.`,
    "2. Run `pnpm -C packages/ui test` (plus gateway-ui if touched). 3. Open the new/changed tests and confirm they assert the specific findings (red-to-green). 4. Confirm no shared integration files were edited. 5. Distinguish inherited breakage (failures outside the branch diff) in summary.",
    "Set allPassed=false if any finding remains open, a check fails, or a claimed test does not exist.",
  ].join("\n");
}

function fixReviewPrompt(
  lane: FixLane,
  seat: Seat,
  implementation: RawRow | undefined,
  validation: RawRow | undefined,
): string {
  return [
    `Independent ${seat}-seat re-review of lane ${lane.id} (its parent-run final round was rejected; this branch closes those findings on the integrated code). Do NOT edit files. Return laneId=${lane.id}, seat=${seat}, reviewer=<the model identity you actually are>.`,
    `The findings that had blocked approval:\n${lane.findings}`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `Validation report:\n${JSON.stringify(validation ?? null, null, 2)}`,
    "Review BOTH the fix diff on this branch AND the lane's integrated code as a whole at full strictness: every blocking finding genuinely closed with meaningful tests, API/naming conformance, accessibility (keyboard, SR names, live regions, reduced motion), streaming/partial states, controlled/uncontrolled correctness, token compliance, security (URLs, markdown, iframes, secrets), bundle boundaries, provenance accuracy, no fake/mock behavior, no private chain-of-thought exposure.",
    "Approve only if you would sign off the lane for production. Set deferralsEndorsed per any componentsDeferred honesty.",
  ].join("\n\n");
}

function mergePrompt(result: RawRow, baseBranch: string, repoRoot: string): string {
  return [
    `Land fix lane ${String(result.laneId)} onto local ${baseBranch} in the primary checkout at ${repoRoot}. Source worktree: ${String(result.worktreePath)}; source branch/bookmark: ${String(result.branch)}.`,
    `Return laneId=${String(result.laneId)} exactly.`,
    SHARED_TREE_RULES,
    "Recipe:",
    `1. Verify non-empty: \`jj diff --from "fork_point(${baseBranch} | ${String(result.branch)})" --to ${String(result.branch)} --stat\`. An EMPTY branch is only acceptable if the lane result summary says every finding was verified already-fixed; in that case return mergedToMain=true with that explanation and land nothing.`,
    `2. \`jj rebase -b ${String(result.branch)} -d ${baseBranch}\`; resolve conflicts only inside this lane's files. 3. Run the owning packages' focused tests in the rebased tree.`,
    `4. CAS-move ${baseBranch}: record \`git rev-parse ${baseBranch}\` first, then \`git update-ref refs/heads/${baseBranch} <rebased-tip> <expected-old>\`; on CAS failure re-read, re-rebase, retry. Then \`jj git import\`.`,
    `5. Verify \`git show --name-only <new-tip>\` shows only this lane's files and every prior landing is still an ancestor (\`git merge-base --is-ancestor\`). Do NOT push to origin.`,
  ].join("\n");
}

function integrationPrompt(laneResults: RawRow[], merges: RawRow[], feedback: string): string {
  return [
    "Integration fixup for the agentic UI library continuation. Work in the PRIMARY checkout on local main.",
    "Return laneId=integration exactly.",
    SHARED_TREE_RULES,
    `Fixups to complete:\n${INTEGRATION_FIXUPS}`,
    `Fix-lane results:\n${JSON.stringify(laneResults, null, 2)}`,
    `Merge results:\n${JSON.stringify(merges, null, 2)}`,
    "Afterwards run and get green: pnpm -C packages/ui test; pnpm -C packages/gateway-ui test; node scripts/check-ui-architecture.mjs; node scripts/check-docs.mjs; node scripts/check-llms.mjs. Commit your files with explicit pathspecs.",
    feedback ? `Feedback on your previous attempt (fix ALL of it):\n${feedback}` : "",
    "Return status=implemented only when those checks pass; otherwise partial/blocked truthfully.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function integrationReviewPrompt(seat: Seat, implementation: RawRow | undefined, ci: RawRow | undefined): string {
  return [
    `Independent ${seat}-seat review of the integrated shared surface (critical: both seats must approve). Do NOT edit files. Return laneId=integration, seat=${seat}, reviewer=<your model identity>.`,
    `Fixup report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `CI gate:\n${JSON.stringify(ci ?? null, null, 2)}`,
    "Verify ON DISK at local main tip: barrels export the full surface with nothing heavy leaked into the base barrel; uiCss composition deduplicated; shadcn-provenance.json aggregates every lane fragment (including ChatTranscript); adapter subpath exports + facade files + ratchet baseline entries consistent; lockfiles consistent; docs match the shipped names; the gallery covers the new families; the happy-dom preload keeps BOTH the terminal suite and the WebPreview iframe tests deterministic; and no unrelated working-copy changes were swept into the commits (`git show --name-only`).",
    "Approve only if the shared surface is production-ready and the CI row is genuinely green.",
  ].join("\n\n");
}

const MULTI_RULES = [
  `House rules for Multi adoption lanes (repo: ${MULTI_ROOT}):`,
  `- ALL work happens in ${MULTI_ROOT} (jj-colocated, carries UNRELATED uncommitted changes that MUST be preserved — never revert or commit files you did not change). jj st / jj diff are truth; commit ONLY your files with explicit pathspecs; NEVER git add -A / stash / rebase / --amend.`,
  "- Multi must NOT add an AI Elements dependency, must NOT add @smthrs/gateway-ui, and must NOT create duplicate local wrappers. It links @smthrs/ui via pnpm override (link:../smithers/packages/ui); import shared components directly (adapters via @smthrs/ui/adapters/*).",
  "- Zustand-only state in product code; stores own behavior. Real behavior in tests; honest pending/error states; retain raw/source fallbacks where structured renderers take over.",
  "- Known pre-existing Multi main failures (inherited, NOT caused by this program): AdvancedCanvas.coverage.render.test.tsx and TicketsCard.coverage.render.test.tsx navigation tests. Fixing them belongs to the CI-closure step, not your lane; do not let them block your lane's focused checks.",
].join("\n");

function adoptionImplementPrompt(lane: (typeof ADOPTION_LANES)[number], feedback: string): string {
  return [
    `Implement Multi adoption lane ${lane.id}: ${lane.title}`,
    `Return laneId=${lane.id} exactly. Shared components to consume:\n${lane.components.join(", ")}`,
    lane.spec,
    MULTI_RULES,
    "The shared library is integrated on smithers local main; the pnpm link makes it live in Multi. Definition of done: refactored surfaces render through the shared components with behavior preserved (existing tests stay green; add focused tests for the new rendering paths), pnpm check:ui-architecture + pnpm typecheck green, work committed via jj with explicit pathspecs, unrelated changes untouched.",
    feedback ? `Feedback on your previous attempt (fix ALL of it):\n${feedback}` : "",
    "Return componentsImplemented with the shared components actually adopted; status=implemented only when the focused checks pass.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function adoptionValidatePrompt(lane: (typeof ADOPTION_LANES)[number], implementation: RawRow | undefined): string {
  return [
    `Validate Multi adoption lane ${lane.id} in ${MULTI_ROOT}. Return laneId=${lane.id} exactly.`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    "Steps (run in the Multi repo): 1. `jj st` + `jj log`: lane commits exist, contain ONLY lane-relevant files, unrelated dirty work untouched (diffNonEmpty=false if no lane commits). 2. pnpm check:ui-architecture, pnpm test:ui-architecture, pnpm typecheck, plus focused tests for touched surfaces. 3. No duplicate wrappers, no AI Elements dep, no gateway-ui dep (check package.json). 4. Spot-check preserved behaviors named in the lane spec. 5. Distinguish inherited breakage (the known AdvancedCanvas/TicketsCard failures and anything else outside the lane's commits) in summary without failing the lane for it.",
    "Set allPassed=false if the report is partial/blocked, a lane-owned check fails, or a claimed test does not exist.",
  ].join("\n");
}

function adoptionReviewPrompt(
  lane: (typeof ADOPTION_LANES)[number],
  seat: Seat,
  implementation: RawRow | undefined,
  validation: RawRow | undefined,
): string {
  return [
    `Independent ${seat}-seat review of Multi adoption lane ${lane.id}. Do NOT edit files. Return laneId=${lane.id}, seat=${seat}, reviewer=<your model identity>.`,
    `Lane scope:\n${lane.spec}`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `Validation report:\n${JSON.stringify(validation ?? null, null, 2)}`,
    "Review the lane's commits in the Multi repo: shared-component consumption without duplicate wrappers or new heavy deps, preserved store/imperative/persistence/streaming behavior, honest pending/error states, raw fallbacks retained, accessibility of the adopted surfaces, test quality, and that unrelated in-flight Multi work was untouched.",
    "Approve only production-ready adoption.",
  ].join("\n\n");
}

function ciFixPrompt(ci: RawRow | undefined): string {
  return [
    `The Multi CI gate is red in ${MULTI_ROOT}. Fix it so all gates pass. Return scope=multi exactly.`,
    `Gate output:\n${JSON.stringify(ci ?? null, null, 2)}`,
    "You are in a SHARED checkout with unrelated uncommitted work. Touch only files implicated by the failures; commit with explicit pathspecs via jj. The known pre-existing failures (AdvancedCanvas.coverage.render.test.tsx, TicketsCard.coverage.render.test.tsx navigation tests) predate this program: fix them properly as CI closure (they are real Multi main defects), keeping the fixes minimal and behavior-true. Re-run the exact failed commands until green.",
  ].join("\n\n");
}

function auditPrompt(seat: Seat, ctx: any): string {
  const laneResults = rawRows(ctx, "aguiLaneResult");
  const ciRows = rawRows(ctx, "aguiCi");
  return [
    `Final ${seat}-seat audit of the agentic UI library program CONTINUATION (both seats must independently return complete=true). Verify ON DISK on smithers local main and in ${MULTI_ROOT} — never trust reports alone.`,
    `Return seat=${seat} exactly.`,
    "complete=true ONLY if: every fix lane's blocking findings are closed and seat-approved; the shared surface (barrels/CSS/provenance incl. ChatTranscript/docs/gallery) is synchronized; the smithers CI row in this run is genuinely green and current; the three Multi adoption lanes are seat-approved with behavior preserved; the Multi CI row is genuinely green and current; and no unrelated working-copy changes were overwritten in either repo (spot-check jj st in both).",
    `Standing deferrals to endorse or reject (deferralsEndorsed=true endorses ALL, including per-lane componentsDeferred):\n${EXPLICIT_DEFERRALS.join(", ")}`,
    "Build coverageMatrix rows ONLY for components whose state CHANGED in this continuation (fixed lanes → integrated; adopted components → adopted); name deferred adoption work separately in followUps.",
    `Fix/adoption lane results:\n${JSON.stringify(laneResults, null, 2)}`,
    `CI rows:\n${JSON.stringify(
      ciRows.map((row) => ({ nodeId: row.nodeId, scope: row.scope, allPassed: row.allPassed, summary: row.summary })),
      null,
      2,
    )}`,
  ].join("\n\n");
}

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxConcurrency: ctx.input.maxConcurrency ?? 3,
    perLaneIterations: ctx.input.perLaneIterations ?? 3,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const repoRoot = resolveRepoRoot();
  const runSlug = slug(String((ctx as any).runId ?? "agui-fin"));

  const laneResults = rawRows(ctx, "aguiLaneResult");
  const merges = rawRows(ctx, "aguiFinMerge");
  const fixSettled = FIX_LANES.every((lane) => laneResults.some((row) => row.laneId === lane.id));
  const fixLgtm = laneResults.filter((row) => FIX_LANES.some((lane) => lane.id === row.laneId) && row.lgtm === true);
  const mergesSettled = fixSettled && fixLgtm.every((row) => merges.some((merge) => merge.laneId === row.laneId));

  const integrationImplRows = rawRows(ctx, "aguiImpl").filter(
    (row) => baseNodeId(row) === "integration-implement" && row.laneId === "integration",
  );
  const integrationImpl = latestRaw(integrationImplRows, "integration-implement");
  const smithersCi = latestRaw(
    rawRows(ctx, "aguiCi").filter((row) => row.scope === "smithers"),
    "integration-ci",
  );
  const smithersCiCurrent = sameVersion(integrationImpl, smithersCi);
  const integrationReviews = (["fable", "sol"] as Seat[]).map((seat) => {
    const review = latestRaw(
      rawRows(ctx, "aguiReview").filter((row) => row.laneId === "integration" && row.seat === seat),
      `integration-review-${seat}`,
    );
    return { seat, review, current: smithersCiCurrent && sameVersion(smithersCi, review) };
  });
  const integrationDone =
    integrationImpl?.status === "implemented" &&
    smithersCiCurrent &&
    smithersCi?.allPassed === true &&
    integrationReviews.every((entry) => entry.current && entry.review?.approved === true);
  const integrationSettled =
    integrationDone ||
    (integrationImplRows.length >= 3 &&
      smithersCiCurrent &&
      (smithersCi?.allPassed === false || integrationReviews.every((entry) => entry.current)));
  const integrationFeedback = [
    smithersCiCurrent && smithersCi?.allPassed === false
      ? `SMITHERS CI GATE FAILED:\n${String(smithersCi.summary ?? "")}`
      : "",
    ...integrationReviews.map((entry) =>
      entry.current && entry.review?.approved === false
        ? `REVIEW (${entry.seat} seat) NOT LGTM:\n${String(entry.review.feedback ?? "")}`
        : "",
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  const adoptionSettled = ADOPTION_LANES.every((lane) => laneResults.some((row) => row.laneId === lane.id));
  const multiCi = latestRaw(
    rawRows(ctx, "aguiCi").filter((row) => row.scope === "multi"),
    "multi-ci",
  );
  const multiCiGreen = multiCi?.allPassed === true;
  const multiCiSettled = multiCiGreen || rawRows(ctx, "aguiCi").filter((row) => row.scope === "multi").length >= 3;

  const audits = rawRows(ctx, "aguiAudit");
  const auditFable = latestRaw(
    audits.filter((row) => row.seat === "fable"),
    "final-audit-fable",
  );
  const auditSol = latestRaw(
    audits.filter((row) => row.seat === "sol"),
    "final-audit-sol",
  );
  const auditsComplete =
    auditFable?.complete === true &&
    auditSol?.complete === true &&
    auditFable?.deferralsEndorsed === true &&
    auditSol?.deferralsEndorsed === true;

  const readyForAudit =
    fixSettled && mergesSettled && integrationSettled && (integrationDone ? adoptionSettled && multiCiSettled : true);

  return (
    <Workflow name="finish-agentic-ui-library">
      <UI entry="../ui/finish-agentic-ui-library.tsx" title="Finish Agentic UI Library" />
      <Sequence>
        <Task id="agui-fin-manifest" output={outputs.aguiManifest}>
          {{
            programTitle: "Agentic UI program continuation (fix + adopt)",
            plannedComponents: FIX_LANES.length + ADOPTION_LANES.length,
            lanes: [
              ...FIX_LANES.map((lane) => ({
                laneId: lane.id as any,
                title: `Fix + re-review: ${lane.id}`,
                kind: "component" as const,
                implementModel: "opencode/kimi-for-coding-k3 (fallback claude-sonnet-5)",
                reviewSeats: lane.seats as string[],
                components: [],
              })),
              ...ADOPTION_LANES.map((lane) => ({
                laneId: lane.id,
                title: lane.title,
                kind: "adoption" as const,
                implementModel: "opencode/kimi-for-coding-k3 (fallback claude-sonnet-5)",
                reviewSeats: lane.seats as string[],
                components: lane.components,
              })),
            ],
          }}
        </Task>

        <Parallel maxConcurrency={input.maxConcurrency}>
          {FIX_LANES.map((lane) => {
            const branch = `agui-fin/${runSlug}/${lane.id}`;
            const worktreePath = join(repoRoot, ".smithers", "workflows", ".worktrees", "agui-fin", runSlug, lane.id);
            const state = laneState(ctx, lane as any, input.perLaneIterations, `fix-${lane.id}`);
            return (
              <Worktree key={lane.id} path={worktreePath} branch={branch} baseBranch={input.baseBranch}>
                <Sequence>
                  <Loop
                    id={`fix-${lane.id}-loop`}
                    until={state.done}
                    maxIterations={input.perLaneIterations}
                    onMaxReached="return-last"
                  >
                    <Sequence>
                      <Task
                        id={`fix-${lane.id}-implement`}
                        output={outputs.aguiImpl}
                        agent={kimiImplement}
                        retries={2}
                        timeoutMs={90 * 60_000}
                        heartbeatTimeoutMs={15 * 60_000}
                      >
                        {fixImplementPrompt(
                          lane,
                          (() => {
                            const parts: string[] = [];
                            if (state.implementation && state.implementation.status !== "implemented")
                              parts.push(
                                `IMPLEMENTATION ${String(state.implementation.status).toUpperCase()}:\n${String(state.implementation.summary ?? "")}`,
                              );
                            if (state.validationCurrent && state.validation?.allPassed === false)
                              parts.push(
                                `VALIDATION FAILED:\n${String(state.validation.failingSummary ?? state.validation.summary ?? "")}`,
                              );
                            for (const entry of state.reviews)
                              if (entry.current && entry.review?.approved === false)
                                parts.push(`REVIEW (${entry.seat}) NOT LGTM:\n${String(entry.review.feedback ?? "")}`);
                            return parts.join("\n\n");
                          })(),
                        )}
                      </Task>
                      <Task
                        id={`fix-${lane.id}-validate`}
                        output={outputs.aguiValidation}
                        agent={validateChain}
                        retries={2}
                        timeoutMs={40 * 60_000}
                        heartbeatTimeoutMs={10 * 60_000}
                      >
                        {fixValidatePrompt(lane, branch, state.implementation)}
                      </Task>
                      {state.validationCurrent &&
                      state.validation?.allPassed === true &&
                      state.validation?.diffNonEmpty === true ? (
                        <Parallel>
                          {lane.seats.map((seat) => (
                            <Task
                              key={seat}
                              id={`fix-${lane.id}-review-${seat}`}
                              output={outputs.aguiReview}
                              agent={seat === "fable" ? fableChain : solChain}
                              retries={2}
                              timeoutMs={40 * 60_000}
                              heartbeatTimeoutMs={10 * 60_000}
                            >
                              {fixReviewPrompt(lane, seat, state.implementation, state.validation)}
                            </Task>
                          ))}
                        </Parallel>
                      ) : null}
                    </Sequence>
                  </Loop>
                  <Task id={`fix-${lane.id}-result`} output={outputs.aguiLaneResult}>
                    {{
                      laneId: lane.id as any,
                      branch,
                      worktreePath,
                      lgtm: state.done,
                      exhausted: state.exhausted,
                      attempts: state.attempts,
                      summary: state.done
                        ? `Fix lane ${lane.id} LGTM after ${state.attempts} attempt(s).`
                        : `Fix lane ${lane.id} settled without LGTM after ${state.attempts} attempt(s).`,
                      filesChanged: asArray(state.implementation?.filesChanged) as string[],
                      componentsImplemented: asArray(state.implementation?.componentsImplemented) as string[],
                      componentsDeferred: asArray(state.implementation?.componentsDeferred) as {
                        name: string;
                        reason: string;
                      }[],
                      seatVerdicts: state.reviews.map((entry) => ({
                        seat: entry.seat,
                        approved: entry.current && entry.review?.approved === true,
                        reviewer: String(entry.review?.reviewer ?? "(none)"),
                      })),
                    }}
                  </Task>
                </Sequence>
              </Worktree>
            );
          })}
        </Parallel>

        <MergeQueue id="agui-fin-merge-queue" maxConcurrency={1}>
          {(fixSettled
            ? fixLgtm.filter(
                (row) => !merges.some((merge) => merge.laneId === row.laneId && merge.mergedToMain === true),
              )
            : []
          ).map((row) => (
            <Task
              key={String(row.laneId)}
              id={`merge-${slug(String(row.laneId))}`}
              output={outputs.aguiFinMerge}
              agent={mergeChain}
              retries={2}
              timeoutMs={45 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {mergePrompt(row, input.baseBranch, repoRoot)}
            </Task>
          ))}
        </MergeQueue>

        {fixSettled && mergesSettled ? (
          <Loop id="integration-loop" until={integrationDone} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task
                id="integration-implement"
                output={outputs.aguiImpl}
                agent={kimiImplement}
                retries={2}
                timeoutMs={90 * 60_000}
                heartbeatTimeoutMs={15 * 60_000}
              >
                {integrationPrompt(laneResults, merges, integrationFeedback)}
              </Task>
              <Task id="integration-ci" output={outputs.aguiCi} timeoutMs={150 * 60_000}>
                {() => runSmithersCi(repoRoot)}
              </Task>
              {smithersCiCurrent && smithersCi?.allPassed === true ? (
                <Parallel>
                  {(["fable", "sol"] as Seat[]).map((seat) => (
                    <Task
                      key={seat}
                      id={`integration-review-${seat}`}
                      output={outputs.aguiReview}
                      agent={seat === "fable" ? fableChain : solChain}
                      retries={2}
                      timeoutMs={45 * 60_000}
                      heartbeatTimeoutMs={10 * 60_000}
                    >
                      {integrationReviewPrompt(seat, integrationImpl, smithersCi)}
                    </Task>
                  ))}
                </Parallel>
              ) : null}
            </Sequence>
          </Loop>
        ) : null}

        {integrationDone ? (
          <Sequence>
            {ADOPTION_LANES.map((lane) => {
              const prefix = lane.id;
              const state = laneState(ctx, lane, input.perLaneIterations, prefix);
              return (
                <Sequence key={lane.id}>
                  <Loop
                    id={`${prefix}-loop`}
                    until={state.done}
                    maxIterations={input.perLaneIterations}
                    onMaxReached="return-last"
                  >
                    <Sequence>
                      <Task
                        id={`${prefix}-implement`}
                        output={outputs.aguiImpl}
                        agent={kimiImplementMulti}
                        retries={2}
                        timeoutMs={100 * 60_000}
                        heartbeatTimeoutMs={15 * 60_000}
                      >
                        {adoptionImplementPrompt(
                          lane,
                          (() => {
                            const parts: string[] = [];
                            if (state.implementation && state.implementation.status !== "implemented")
                              parts.push(
                                `IMPLEMENTATION ${String(state.implementation.status).toUpperCase()}:\n${String(state.implementation.summary ?? "")}`,
                              );
                            if (state.validationCurrent && state.validation?.allPassed === false)
                              parts.push(
                                `VALIDATION FAILED:\n${String(state.validation.failingSummary ?? state.validation.summary ?? "")}`,
                              );
                            for (const entry of state.reviews)
                              if (entry.current && entry.review?.approved === false)
                                parts.push(`REVIEW (${entry.seat}) NOT LGTM:\n${String(entry.review.feedback ?? "")}`);
                            return parts.join("\n\n");
                          })(),
                        )}
                      </Task>
                      <Task
                        id={`${prefix}-validate`}
                        output={outputs.aguiValidation}
                        agent={validateChainMulti}
                        retries={2}
                        timeoutMs={45 * 60_000}
                        heartbeatTimeoutMs={10 * 60_000}
                      >
                        {adoptionValidatePrompt(lane, state.implementation)}
                      </Task>
                      {state.validationCurrent &&
                      state.validation?.allPassed === true &&
                      state.validation?.diffNonEmpty === true ? (
                        <Parallel>
                          {lane.seats.map((seat) => (
                            <Task
                              key={seat}
                              id={`${prefix}-review-${seat}`}
                              output={outputs.aguiReview}
                              agent={seat === "fable" ? fableChainMulti : solChainMulti}
                              retries={2}
                              timeoutMs={40 * 60_000}
                              heartbeatTimeoutMs={10 * 60_000}
                            >
                              {adoptionReviewPrompt(lane, seat, state.implementation, state.validation)}
                            </Task>
                          ))}
                        </Parallel>
                      ) : null}
                    </Sequence>
                  </Loop>
                  <Task id={`${prefix}-result`} output={outputs.aguiLaneResult}>
                    {{
                      laneId: lane.id,
                      branch: "(multi working copy)",
                      worktreePath: MULTI_ROOT,
                      lgtm: state.done,
                      exhausted: state.exhausted,
                      attempts: state.attempts,
                      summary: state.done
                        ? `Adoption lane ${lane.id} LGTM after ${state.attempts} attempt(s).`
                        : `Adoption lane ${lane.id} settled without LGTM after ${state.attempts} attempt(s).`,
                      filesChanged: asArray(state.implementation?.filesChanged) as string[],
                      componentsImplemented: asArray(state.implementation?.componentsImplemented) as string[],
                      componentsDeferred: asArray(state.implementation?.componentsDeferred) as {
                        name: string;
                        reason: string;
                      }[],
                      seatVerdicts: state.reviews.map((entry) => ({
                        seat: entry.seat,
                        approved: entry.current && entry.review?.approved === true,
                        reviewer: String(entry.review?.reviewer ?? "(none)"),
                      })),
                    }}
                  </Task>
                </Sequence>
              );
            })}

            {adoptionSettled ? (
              <Loop id="multi-ci-loop" until={multiCiGreen} maxIterations={3} onMaxReached="return-last">
                <Sequence>
                  <Task id="multi-ci" output={outputs.aguiCi} timeoutMs={130 * 60_000}>
                    {() => runMultiCi(MULTI_ROOT)}
                  </Task>
                  {multiCi && multiCi.allPassed === false ? (
                    <Task
                      id="multi-ci-fix"
                      output={outputs.aguiCiFix}
                      agent={kimiImplementMulti}
                      retries={2}
                      timeoutMs={60 * 60_000}
                      heartbeatTimeoutMs={15 * 60_000}
                    >
                      {ciFixPrompt(multiCi)}
                    </Task>
                  ) : null}
                </Sequence>
              </Loop>
            ) : null}
          </Sequence>
        ) : null}

        {readyForAudit ? (
          <Parallel>
            <Task
              id="final-audit-fable"
              output={outputs.aguiAudit}
              agent={fableChain}
              retries={2}
              timeoutMs={60 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {auditPrompt("fable", ctx)}
            </Task>
            <Task
              id="final-audit-sol"
              output={outputs.aguiAudit}
              agent={solChain}
              retries={2}
              timeoutMs={60 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {auditPrompt("sol", ctx)}
            </Task>
          </Parallel>
        ) : null}

        {readyForAudit && auditFable !== undefined && auditSol !== undefined ? (
          <Task id="agui-fin-report" output={outputs.aguiFinReport}>
            {{
              success: auditsComplete && integrationDone && multiCiGreen,
              fixLanesLgtm: fixLgtm.length,
              fixLanesTotal: FIX_LANES.length,
              integrationDone,
              adoptionDone:
                adoptionSettled &&
                ADOPTION_LANES.every((lane) => laneResults.some((row) => row.laneId === lane.id && row.lgtm === true)),
              smithersCiGreen: smithersCi?.allPassed === true,
              multiCiGreen,
              auditsComplete,
              summary:
                auditsComplete && integrationDone && multiCiGreen
                  ? `Continuation complete: ${fixLgtm.length}/${FIX_LANES.length} fix lanes LGTM, integration dual-approved with green CI, adoption landed, both audits complete.`
                  : `Continuation settled incomplete: ${fixLgtm.length}/${FIX_LANES.length} fix lanes LGTM; integrationDone=${integrationDone}; multiCiGreen=${multiCiGreen}; audits fable=${auditFable?.complete === true} sol=${auditSol?.complete === true}.`,
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
