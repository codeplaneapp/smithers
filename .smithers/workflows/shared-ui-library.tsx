// smithers-display-name: Shared UI Library Extraction Swarm
/** @jsxImportSource smithers-orchestrator */
import { MergeQueue, Parallel, Sequence, Task, UI, Worktree, createSmithers } from "smithers-orchestrator";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";

// Every reusable UI component across the smithers repo and the Multi app must be
// importable from the shared libraries (packages/ui → smithers-orchestrator/ui,
// packages/gateway-ui → smithers-orchestrator/gateway-ui). This swarm inventories
// both codebases once, then loops discovery → parallel worktree extraction lanes
// → serialized merges → CI gate → audit, until no meaningful gap remains.

const inventoryAreaSchema = z.enum(["shared-packages", "smithers-surfaces", "multi-app"]);

export const inventorySchema = z.object({
  area: inventoryAreaSchema,
  summary: z.string().trim().min(1),
  components: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        kind: z.enum(["primitive", "composite", "run-aware", "view", "utility"]),
        sourcePaths: z.array(z.string()).default([]),
        description: z.string(),
        alreadyShared: z.boolean().default(false),
        shareWorthiness: z.enum(["must-share", "should-share", "maybe", "skip"]),
        notes: z.string().nullable().default(null),
      }),
    )
    .max(80)
    .default([]),
});

export const extractionTicketSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  componentName: z.string().trim().min(1),
  targetPackage: z.enum(["ui", "gateway-ui"]),
  kind: z.enum([
    "port-from-multi",
    "promote-from-smithers-ui",
    "new-component",
    "consumer-migration",
    "styleguide-docs",
  ]),
  priority: z.number().min(0).max(100),
  summary: z.string().trim().min(1),
  sourcePaths: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  testPlan: z.array(z.string()).default([]),
  filesLikely: z.array(z.string()).default([]),
});

export const discoverySchema = z
  .object({
    batchKey: z.string().trim().min(1),
    complete: z.boolean().default(false),
    rationale: z.string(),
    tickets: z.array(extractionTicketSchema).max(12).default([]),
  })
  .superRefine((value, issue) => {
    const ids = value.tickets.map((ticket) => ticket.id);
    if (new Set(ids).size !== ids.length)
      issue.addIssue({ code: "custom", path: ["tickets"], message: "ticket ids must be unique within a batch" });
  });

const correlated = {
  ticketId: z.string().trim().min(1),
  batchKey: z.string().trim().min(1),
  candidateId: z.string().trim().min(1),
};

export const ticketImplementationSchema = z.object({
  ...correlated,
  status: z.enum(["implemented", "partial", "blocked"]).default("implemented"),
  summary: z.string(),
  planSummary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  testsAddedOrUpdated: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});

export const ticketValidationSchema = z.object({
  ...correlated,
  allPassed: z.boolean(),
  summary: z.string(),
  commandsRun: z.array(z.string()).default([]),
  failingSummary: z.string().nullable().default(null),
});

export const ticketReviewSchema = z.object({
  ...correlated,
  approved: z.boolean(),
  reviewer: z.string(),
  feedback: z.string(),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "major", "minor", "nit"]),
        title: z.string(),
        file: z.string().nullable().default(null),
        description: z.string(),
      }),
    )
    .default([]),
});

export const ticketResultSchema = z.object({
  ...correlated,
  branch: z.string(),
  worktreePath: z.string(),
  lgtm: z.boolean(),
  exhausted: z.boolean(),
  summary: z.string(),
});

export const mergeResultSchema = z.object({
  ...correlated,
  mergedToMain: z.boolean(),
  branch: z.string(),
  summary: z.string(),
  conflicts: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});

export const ciResultSchema = z.object({
  batchKey: z.string().trim().min(1),
  allPassed: z.boolean(),
  summary: z.string(),
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

export const finalAuditSchema = z.object({
  batchKey: z.string().trim().min(1),
  complete: z.boolean(),
  summary: z.string(),
  remainingGaps: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
});

export const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(8).default(4),
  maxBatches: z.number().int().min(1).max(10).default(4),
  perTicketIterations: z.number().int().min(1).max(6).default(3),
  maxTicketsPerBatch: z.number().int().min(1).max(12).default(10),
  baseBranch: z.string().trim().min(1).default("main"),
  multiRoot: z.string().trim().min(1).default("/Users/williamcory/multi"),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  inventory: inventorySchema,
  discovery: discoverySchema,
  implementation: ticketImplementationSchema,
  validation: ticketValidationSchema,
  review: ticketReviewSchema,
  ticketResult: ticketResultSchema,
  merge: mergeResultSchema,
  ci: ciResultSchema,
  finalAudit: finalAuditSchema,
});

type ExtractionTicket = z.infer<typeof extractionTicketSchema>;
type RawRow = Record<string, unknown>;

// The user directive for this swarm: dispatch Opus agents. Opus leads every
// seat; Sonnet/Fable are failure fallbacks only.
const opusImplement = [providers.claudeOpus, providers.claudeSonnet];
const opusReview = [providers.claudeOpus, providers.claude];
const validatorChain = [providers.claudeSonnet, providers.claudeOpus];

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

function matches(row: RawRow | undefined, ticketId: string, batchKey: string, candidateId: string): boolean {
  return row?.ticketId === ticketId && row.batchKey === batchKey && row.candidateId === candidateId;
}

export function ticketState(
  ctx: any,
  ticketId: string,
  ticketSlug: string,
  batchKey: string,
  candidateId: string,
  maxIterations: number,
) {
  const implementationRows = rawRows(ctx, "implementation").filter(
    (row) => baseNodeId(row) === `ticket-${ticketSlug}-implement` && matches(row, ticketId, batchKey, candidateId),
  );
  const implementation = latestRaw(implementationRows, `ticket-${ticketSlug}-implement`);
  const validation = latestRaw(
    rawRows(ctx, "validation").filter((row) => matches(row, ticketId, batchKey, candidateId)),
    `ticket-${ticketSlug}-validate`,
  );
  const review = latestRaw(
    rawRows(ctx, "review").filter((row) => matches(row, ticketId, batchKey, candidateId)),
    `ticket-${ticketSlug}-review`,
  );
  const validationCurrent = sameVersion(implementation, validation);
  const reviewCurrent = validationCurrent && sameVersion(validation, review);
  const done =
    implementation?.status === "implemented" &&
    validationCurrent &&
    validation?.allPassed === true &&
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
    attempts: implementationRows.length,
    exhausted: !done && implementationRows.length >= maxIterations && finalAttemptComplete,
  };
}

function ticketFeedback(state: ReturnType<typeof ticketState>): string {
  const parts: string[] = [];
  if (state.implementation && state.implementation.status !== "implemented")
    parts.push(
      `IMPLEMENTATION ${String(state.implementation.status).toUpperCase()}:\n${String(state.implementation.summary ?? "")}`,
    );
  if (state.validationCurrent && state.validation?.allPassed === false)
    parts.push(`VALIDATION FAILED:\n${String(state.validation.failingSummary ?? state.validation.summary ?? "")}`);
  if (state.reviewCurrent && state.review?.approved === false)
    parts.push(`REVIEW NOT LGTM:\n${String(state.review.feedback ?? "")}`);
  return parts.join("\n\n");
}

const SHARED_TARGETS = [
  "- packages/ui (subpath smithers-orchestrator/ui): generic browser primitives and widgets — Button, Card, Tabs, StatusPill, EmptyState, chat/*, tokens/theme. New generic components land here.",
  "- packages/gateway-ui (subpath smithers-orchestrator/gateway-ui): run/workflow-aware components composed over smithers-orchestrator/gateway-react hooks — RunTree, RunEventLog, ApprovalPanel, SimpleWorkflowDashboard. New run-aware components land here.",
  "- packages/smithers: the published facade; subpath exports must stay wired for anything new.",
].join("\n");

function inventoryPrompt(area: z.infer<typeof inventoryAreaSchema>, multiRoot: string): string {
  const scope = {
    "shared-packages":
      "Catalog the CURRENT shared surface: every exported component in packages/ui and packages/gateway-ui (and how packages/smithers re-exports them), plus the styleguide surfaces (packages/gateway-ui/src/styleguide.tsx, packages/ui-styleguide). Mark all of these alreadyShared=true. These are the dedupe baseline for extraction tickets.",
    "smithers-surfaces":
      "Catalog every hand-rolled reusable component in this repo's custom workflow UIs (.smithers/ui/*.tsx — 40+ files) and any browser UI under apps/ that is product surface (skip apps/smithers* POC demo apps). Look for repeated shapes: panels, stage/status chips, tree views, markdown editors/renderers, ticket modals, diff or terminal-ish renderings, tab layouts, log views.",
    "multi-app": `Catalog reusable browser UI in the Multi product app at ${multiRoot}/src (READ-ONLY — do not modify that repo). Priority directories: terminal/ (TerminalCanvas, TerminalSession render layer), diff/ (DiffHunks, DiffCanvas), files/ (PierreDiffView, FilesCanvas tree), chat/, cards/, landings/, plus markdown, kanban-ish, and log/stream views. Note per component which parts are generic render layer vs app-coupled state, and any third-party deps it drags in.`,
  }[area];
  return [
    `Inventory pass (area=${area}) for the shared UI library extraction swarm. Return area=${area} exactly.`,
    "Mission context: every reusable UI component in the smithers repo and the Multi app must become importable from the shared libraries so agents building custom workflow UIs stop hand-rolling them.",
    scope,
    "READ-ONLY task: do not edit any files. Return the component catalog with honest shareWorthiness ratings (must-share = clearly reusable and missing from the shared surface; skip = app-specific or trivial). Cap at the 80 most valuable entries.",
  ].join("\n\n");
}

function discoveryPrompt(
  inventories: RawRow[],
  previousResults: RawRow[],
  previousDiscoveries: RawRow[],
  previousAudit: RawRow | undefined,
  batchKey: string,
  maxTickets: number,
  multiRoot: string,
): string {
  return [
    "Discover the next highest-value extraction tickets for the shared UI component library.",
    "Mission: every reusable UI component across this repo and the Multi app must be importable from the shared packages so custom workflow UIs never hand-roll them. Today the shared surface is a fraction of what exists app-side.",
    `Shared targets (the ONLY packages tickets may modify, plus their tests, styleguides, docs, and facade re-exports):\n${SHARED_TARGETS}`,
    `Sources to mine (read-only references): ${multiRoot}/src (the Multi app), .smithers/ui/*.tsx (hand-rolled duplicates in 40+ workflow UIs), and the inventories below.`,
    `HARD REQUIREMENT for the first batch (skip only if history shows them already merged): (1) a Terminal/ANSI output component ported from ${multiRoot}/src/terminal, generic props (lines/stream in, no app stores); (2) a Diff viewer family ported from ${multiRoot}/src/diff (DiffHunks) and ${multiRoot}/src/files/PierreDiffView.tsx. These are the two components users most recently reached for and did not find.`,
    "Ticket kinds: port-from-multi | promote-from-smithers-ui | new-component | consumer-migration | styleguide-docs. consumer-migration tickets (rewiring .smithers/ui consumers onto shared components) are only valid for components merged in a PRIOR batch.",
    "Rules: tickets must be independent (disjoint files where possible; shared touchpoints like package index exports are resolved at merge time). Dedupe against alreadyShared inventory entries and previously merged tickets. Set complete=true only when no meaningful reusable-component gap remains across BOTH repos and the shipped consumers have been migrated.",
    "RE-TICKET RULE: any ticket issued in a previous batch that does NOT appear in the previous ticket results with lgtm=true AND a successful merge is UNFINISHED — you MUST issue a fresh ticket for it in this batch (same or new id) instead of silently dropping it. Never return zero tickets with complete=false while unfinished or unlanded work remains; re-issue the unfinished tickets.",
    `Return batchKey=${batchKey} exactly and at most ${maxTickets} tickets.`,
    `Inventories:\n${JSON.stringify(inventories, null, 2)}`,
    `Previous ticket results:\n${JSON.stringify(previousResults, null, 2)}`,
    `Previous batch discoveries (tickets issued earlier — cross-check these against the results above for the re-ticket rule):\n${JSON.stringify(previousDiscoveries, null, 2)}`,
    `Previous audit:\n${JSON.stringify(previousAudit ?? null, null, 2)}`,
  ].join("\n\n");
}

function implementationPrompt(
  ticket: ExtractionTicket,
  batchKey: string,
  candidateId: string,
  feedback: string,
  multiRoot: string,
): string {
  return [
    `Implement extraction ticket ${ticket.id}: ${ticket.title} — component ${ticket.componentName} → packages/${ticket.targetPackage}.`,
    ticket.summary,
    `Return ticketId=${ticket.id}, batchKey=${batchKey}, and candidateId=${candidateId} exactly.`,
    `Source material: ${ticket.sourcePaths.join(", ") || "see ticket summary"}.`,
    [
      "Hard constraints:",
      `- Work ONLY inside this worktree checkout of the smithers repo. ${multiRoot} is a READ-ONLY reference — never modify it; port code into this repo instead.`,
      "- This is a jj-colocated checkout: use `jj` for any VCS operation, never plain `git` mutations.",
      "- The component must be genuinely generic: props-driven, zero imports from app state/stores/routers, styling through the target package's existing tokens/theme/cn conventions, naming and file layout matching neighboring components.",
      "- Wire the FULL export path: the package's src/index barrel and the packages/smithers facade subpath if new entry points are needed. Keep the public surface synchronized (d.ts/docs) — the validation commands below enforce it.",
      "- Prefer ZERO new dependencies. If one is truly unavoidable, refresh BOTH pnpm-lock.yaml and bun.lock in this same change (repo invariant).",
      `- Colocated bun tests in the owning package's tests/ directory; the focused suite must pass: pnpm -C packages/${ticket.targetPackage} test.`,
      "- Register the component in the package's styleguide surface so it is discoverable.",
      "- Run and satisfy: node scripts/check-ui-architecture.mjs and node scripts/check-docs.mjs. If check-docs flags the new public surface, add the docs entries and run pnpm docs:llms.",
    ].join("\n"),
    `Acceptance criteria:\n${ticket.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- The component renders real data via its public props and is importable from the shared subpath."}`,
    `Suggested tests:\n${ticket.testPlan.map((item) => `- ${item}`).join("\n") || "- Focused bun tests in the owning package."}`,
    feedback ? `Current same-candidate feedback:\n${feedback}` : "",
    "Return implemented only when the focused checks pass; otherwise return partial or blocked truthfully.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function validationPrompt(
  ticket: ExtractionTicket,
  batchKey: string,
  candidateId: string,
  implementation: RawRow | undefined,
): string {
  return [
    `Validate extraction ticket ${ticket.id} (${ticket.componentName} → packages/${ticket.targetPackage}) against the real code in this worktree.`,
    `Return ticketId=${ticket.id}, batchKey=${batchKey}, and candidateId=${candidateId} exactly.`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `Run: pnpm -C packages/${ticket.targetPackage} test; node scripts/check-ui-architecture.mjs; node scripts/check-docs.mjs. Also verify the component is actually importable from the shared subpath (a quick bun script or test import), that no app-coupled imports leaked in, and that any new dependency updated BOTH lockfiles.`,
    "Set allPassed=false if the report is partial/blocked, a relevant check is missing or fails, or the export wiring is incomplete.",
  ].join("\n\n");
}

function reviewPrompt(
  ticket: ExtractionTicket,
  batchKey: string,
  candidateId: string,
  implementation: RawRow | undefined,
  validation: RawRow | undefined,
): string {
  return [
    `Strictly review the green candidate for extraction ticket ${ticket.id} (${ticket.componentName}). Do not edit files.`,
    `Return ticketId=${ticket.id}, batchKey=${batchKey}, and candidateId=${candidateId} exactly.`,
    `Implementation:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `Validation:\n${JSON.stringify(validation ?? null, null, 2)}`,
    "Review as the shared-library API owner: approve only if the component is genuinely generic (no app coupling), idiomatic with its package's existing exports (naming, tokens, file layout), exported end-to-end (package barrel + facade subpath), covered by meaningful focused tests, registered in the styleguide, and minimal (no speculative props, no dead code carried over from the source app).",
  ].join("\n\n");
}

function mergePrompt(result: z.infer<typeof ticketResultSchema>, baseBranch: string, repoRoot: string): string {
  return [
    `Merge ticket ${result.ticketId} candidate ${result.candidateId} from batch ${result.batchKey} into ${baseBranch} in the primary checkout at ${repoRoot}.`,
    `Source worktree: ${result.worktreePath}`,
    `Source branch: ${result.branch}`,
    "The primary checkout carries unrelated uncommitted work — preserve it. Stage by explicit path only, and after committing verify with `git show --name-only` that ONLY in-scope files landed (a colocated jj checkout can sweep stale index entries into a commit).",
    "Resolve conflicts only within scope; expect the common touchpoints to be package index barrels and styleguide files. Run the owning package's focused tests after merging.",
    [
      "Main moves are CAS-only and must re-verify prior landings:",
      `- Record the current ${baseBranch} sha BEFORE you start (git rev-parse ${baseBranch}). Commit your landing, then move main with \`git update-ref refs/heads/${baseBranch} <new-sha> <expected-old-sha>\`. If the CAS fails, a concurrent lane moved main: re-read it, rebase/resolve, and retry the CAS — never force-move main blindly.`,
      `- After every successful main move, re-verify EVERY prior landing of this campaign is still an ancestor: \`git merge-base --is-ancestor <prior-landing-sha> ${baseBranch}\`. If a concurrent move orphaned one, recover it first (linear-chain cherry-pick of the orphaned commits in a scratch worktree, then CAS update-ref, then \`jj git import\`) before doing anything else.`,
    ].join("\n"),
    `Return ticketId=${result.ticketId}, batchKey=${result.batchKey}, candidateId=${result.candidateId}, and branch=${result.branch} exactly.`,
  ].join("\n");
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

export function runCi(batchKey: string, cwd = process.cwd()) {
  const commands: Array<[string, string[], number]> = [
    ["pnpm", ["typecheck"], 30 * 60_000],
    ["pnpm", ["-C", "packages/ui", "test"], 15 * 60_000],
    ["pnpm", ["-C", "packages/gateway-ui", "test"], 15 * 60_000],
    ["node", ["scripts/check-ui-architecture.mjs"], 5 * 60_000],
    ["node", ["scripts/check-docs.mjs"], 5 * 60_000],
    ["node", ["scripts/check-llms.mjs"], 5 * 60_000],
  ];
  const results = commands.map(([command, args, timeout]) => runCommand(cwd, command, args, timeout));
  const failed = results.filter((result) => result.exitCode !== 0);
  return {
    batchKey,
    allPassed: failed.length === 0,
    summary:
      failed.length === 0 ? "All shared-library checks passed." : `${failed.length} shared-library check(s) failed.`,
    commands: results,
  };
}

function finalAuditPrompt(
  batchKey: string,
  ci: RawRow | undefined,
  merges: RawRow[],
  results: RawRow[],
  multiRoot: string,
) {
  return [
    `Audit the shared UI library surface: packages/ui, packages/gateway-ui, their smithers facade exports, styleguides, and the remaining hand-rolled components in .smithers/ui/*.tsx and ${multiRoot}/src.`,
    `Return batchKey=${batchKey} exactly. complete=true only when this batch's tickets are LGTM and merged, the current CI row is green, AND no meaningful reusable-component gap remains (name concrete remainingGaps otherwise — they seed the next batch).`,
    `Ticket results:\n${JSON.stringify(results, null, 2)}`,
    `Merge results:\n${JSON.stringify(merges, null, 2)}`,
    `CI:\n${JSON.stringify(ci ?? null, null, 2)}`,
  ].join("\n\n");
}

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxConcurrency: ctx.input.maxConcurrency ?? 4,
    maxBatches: ctx.input.maxBatches ?? 4,
    perTicketIterations: ctx.input.perTicketIterations ?? 3,
    maxTicketsPerBatch: ctx.input.maxTicketsPerBatch ?? 10,
    baseBranch: ctx.input.baseBranch ?? "main",
    multiRoot: ctx.input.multiRoot ?? "/Users/williamcory/multi",
  });
  const repoRoot = resolveRepoRoot();
  const runSlug = slug(String((ctx as any).runId ?? "shared-ui"));
  const batchKey = `${runSlug}:${ctx.iteration}`;
  const inventoryRows = rawRows(ctx, "inventory");
  const inventoryAreas = new Set(inventoryRows.map((row) => String(row.area ?? "")));
  const inventoriesComplete = inventoryAreaSchema.options.every((area) => inventoryAreas.has(area));
  const discovered = rawRows(ctx, "discovery")
    .filter((row) => baseNodeId(row) === "discover-batch" && row.batchKey === batchKey)
    .at(-1);
  const previousDiscoveries = rawRows(ctx, "discovery").filter(
    (row) => baseNodeId(row) === "discover-batch" && row.batchKey !== batchKey,
  );
  const tickets = Array.isArray(discovered?.tickets) ? (discovered.tickets as ExtractionTicket[]) : [];
  const previousAudit = rawRows(ctx, "finalAudit").at(-1);
  const historicalResults = rawRows(ctx, "ticketResult");
  const currentResultsByTicket = new Map<string, RawRow>();
  for (const row of historicalResults)
    if (row.batchKey === batchKey && typeof row.ticketId === "string") currentResultsByTicket.set(row.ticketId, row);
  const currentResults = [...currentResultsByTicket.values()];
  const currentMerges = rawRows(ctx, "merge").filter((row) => row.batchKey === batchKey);
  const currentCi = rawRows(ctx, "ci")
    .filter((row) => baseNodeId(row) === "ci-gate" && row.batchKey === batchKey)
    .at(-1);
  const currentAudit = rawRows(ctx, "finalAudit")
    .filter((row) => baseNodeId(row) === "final-audit" && row.batchKey === batchKey)
    .at(-1);
  const allTicketsSettled =
    tickets.length === currentResults.length && tickets.every((ticket) => currentResultsByTicket.has(ticket.id));
  const allTicketsLgtm =
    allTicketsSettled && currentResults.every((result) => result.lgtm === true && result.exhausted === false);
  const allMerged = currentResults
    .filter((result) => result.lgtm === true)
    .every((result) =>
      currentMerges.some(
        (merge) =>
          merge.ticketId === result.ticketId && merge.candidateId === result.candidateId && merge.mergedToMain === true,
      ),
    );
  const lanesSettled = tickets.length > 0 && allTicketsSettled;
  const mergesComplete = lanesSettled && allMerged;
  const done =
    discovered?.complete === true &&
    (tickets.length === 0 ||
      (currentAudit?.complete === true && currentCi?.allPassed === true && allTicketsLgtm && allMerged));

  return (
    <Workflow name="shared-ui-library">
      <UI entry="../ui/shared-ui-library.tsx" title={"Shared UI Library Swarm"} />
      <Loop id="shared-ui-batches" until={done} maxIterations={input.maxBatches} onMaxReached="return-last">
        <Sequence>
          {!inventoriesComplete ? (
            <Parallel maxConcurrency={3}>
              {inventoryAreaSchema.options
                .filter((area) => !inventoryAreas.has(area))
                .map((area) => (
                  <Task
                    key={area}
                    id={`inventory-${area}`}
                    output={outputs.inventory}
                    agent={opusReview}
                    retries={2}
                    timeoutMs={40 * 60_000}
                    heartbeatTimeoutMs={10 * 60_000}
                  >
                    {inventoryPrompt(area, input.multiRoot)}
                  </Task>
                ))}
            </Parallel>
          ) : null}

          <Task
            id="discover-batch"
            output={outputs.discovery}
            agent={opusReview}
            retries={2}
            timeoutMs={45 * 60_000}
            heartbeatTimeoutMs={10 * 60_000}
          >
            {discoveryPrompt(
              inventoryRows,
              historicalResults,
              previousDiscoveries,
              previousAudit,
              batchKey,
              input.maxTicketsPerBatch,
              input.multiRoot,
            )}
          </Task>

          {tickets.length > 0 ? (
            <Parallel maxConcurrency={input.maxConcurrency}>
              {tickets.map((ticket) => {
                const ticketSlug = slug(ticket.id);
                const candidateId = `${batchKey}:${ticketSlug}`;
                const branch = `shared-ui/${runSlug}/${ctx.iteration}/${ticketSlug}`;
                const worktreePath = join(
                  repoRoot,
                  ".smithers",
                  "workflows",
                  ".worktrees",
                  "shared-ui",
                  runSlug,
                  `batch-${ctx.iteration}`,
                  ticketSlug,
                );
                const state = ticketState(ctx, ticket.id, ticketSlug, batchKey, candidateId, input.perTicketIterations);
                return (
                  <Worktree key={ticket.id} path={worktreePath} branch={branch} baseBranch={input.baseBranch}>
                    <Sequence>
                      <Loop
                        id={`ticket-${ticketSlug}-loop`}
                        until={state.done}
                        maxIterations={input.perTicketIterations}
                        onMaxReached="return-last"
                      >
                        <Sequence>
                          <Task
                            id={`ticket-${ticketSlug}-implement`}
                            output={outputs.implementation}
                            agent={opusImplement}
                            retries={2}
                            timeoutMs={60 * 60_000}
                            heartbeatTimeoutMs={10 * 60_000}
                          >
                            {implementationPrompt(
                              ticket,
                              batchKey,
                              candidateId,
                              ticketFeedback(state),
                              input.multiRoot,
                            )}
                          </Task>
                          <Task
                            id={`ticket-${ticketSlug}-validate`}
                            output={outputs.validation}
                            agent={validatorChain}
                            retries={2}
                            timeoutMs={35 * 60_000}
                            heartbeatTimeoutMs={10 * 60_000}
                          >
                            {validationPrompt(ticket, batchKey, candidateId, state.implementation)}
                          </Task>
                          {state.validationCurrent && state.validation?.allPassed === true ? (
                            <Task
                              id={`ticket-${ticketSlug}-review`}
                              output={outputs.review}
                              agent={opusReview}
                              retries={2}
                              timeoutMs={35 * 60_000}
                              heartbeatTimeoutMs={10 * 60_000}
                            >
                              {reviewPrompt(ticket, batchKey, candidateId, state.implementation, state.validation)}
                            </Task>
                          ) : null}
                        </Sequence>
                      </Loop>
                      <Task id={`ticket-${ticketSlug}-result`} output={outputs.ticketResult}>
                        {{
                          ticketId: ticket.id,
                          batchKey,
                          candidateId,
                          branch,
                          worktreePath,
                          lgtm: state.done,
                          exhausted: state.exhausted,
                          summary: state.done
                            ? `Ticket ${ticket.id} is current-candidate LGTM.`
                            : `Ticket ${ticket.id} settled without LGTM after ${state.attempts} attempt(s).`,
                        }}
                      </Task>
                    </Sequence>
                  </Worktree>
                );
              })}
            </Parallel>
          ) : null}

          <MergeQueue id="shared-ui-merge-queue" maxConcurrency={1}>
            {(lanesSettled
              ? currentResults.filter(
                  (result) =>
                    result.lgtm === true &&
                    !currentMerges.some(
                      (merge) =>
                        merge.ticketId === result.ticketId &&
                        merge.candidateId === result.candidateId &&
                        merge.mergedToMain === true,
                    ),
                )
              : []
            ).map((result) => (
              <Task
                key={String(result.ticketId)}
                id={`merge-${slug(String(result.ticketId))}`}
                output={outputs.merge}
                agent={opusImplement}
                retries={2}
                timeoutMs={45 * 60_000}
                heartbeatTimeoutMs={10 * 60_000}
              >
                {mergePrompt(result as z.infer<typeof ticketResultSchema>, input.baseBranch, repoRoot)}
              </Task>
            ))}
          </MergeQueue>

          {mergesComplete ? (
            <Task id="ci-gate" output={outputs.ci} timeoutMs={90 * 60_000}>
              {() => runCi(batchKey, repoRoot)}
            </Task>
          ) : null}

          {mergesComplete && currentCi !== undefined ? (
            <Task
              id="final-audit"
              output={outputs.finalAudit}
              agent={opusReview}
              retries={2}
              timeoutMs={45 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {finalAuditPrompt(batchKey, currentCi, currentMerges, currentResults, input.multiRoot)}
            </Task>
          ) : null}
        </Sequence>
      </Loop>
    </Workflow>
  );
});
