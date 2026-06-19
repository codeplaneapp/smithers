// smithers-display-name: Smithers Studio Parity Swarm
/** @jsxImportSource smithers-orchestrator */
import {
  AntigravityAgent,
  ClaudeCodeAgent,
  CodexAgent,
  KimiAgent,
  MergeQueue,
  Parallel,
  Sequence,
  Task,
  Worktree,
  createSmithers,
  type AgentLike,
} from "smithers-orchestrator";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";

const ticketKindSchema = z.enum([
  "feature",
  "ui",
  "terminal",
  "test-only",
  "review-existing",
  "gateway",
  "ci",
  "bugfix",
]);

const difficultySchema = z.enum(["easy", "medium", "hard", "critical"]);

const parityTicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: ticketKindSchema,
  difficulty: difficultySchema,
  priority: z.number().min(0).max(100),
  requiresUi: z.boolean().default(false),
  testsOnly: z.boolean().default(false),
  summary: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
  filesLikely: z.array(z.string()).default([]),
  testPlan: z.array(z.string()).default([]),
});

const discoverySchema = z.object({
  complete: z.boolean().default(false),
  rationale: z.string(),
  tickets: z.array(parityTicketSchema).max(16).default([]),
});

const ticketImplementationSchema = z.object({
  ticketId: z.string(),
  status: z.enum(["implemented", "partial", "blocked"]).default("implemented"),
  summary: z.string(),
  researchNotes: z.array(z.string()).default([]),
  planSummary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  testsAddedOrUpdated: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});

const ticketValidationSchema = z.object({
  ticketId: z.string(),
  allPassed: z.boolean(),
  summary: z.string(),
  commandsRun: z.array(z.string()).default([]),
  failingSummary: z.string().nullable().default(null),
});

const ticketReviewSchema = z.object({
  ticketId: z.string(),
  approved: z.boolean(),
  reviewer: z.string(),
  feedback: z.string(),
  issues: z.array(z.object({
    severity: z.enum(["critical", "major", "minor", "nit"]),
    title: z.string(),
    file: z.string().nullable().default(null),
    description: z.string(),
  })).default([]),
});

const ticketResultSchema = z.object({
  ticketId: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  lgtm: z.boolean(),
  summary: z.string(),
});

const mergeResultSchema = z.object({
  ticketId: z.string(),
  mergedToMain: z.boolean(),
  branch: z.string(),
  summary: z.string(),
  conflicts: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});

const ciResultSchema = z.object({
  allPassed: z.boolean(),
  summary: z.string(),
  commands: z.array(z.object({
    command: z.string(),
    exitCode: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  })).default([]),
});

const finalAuditSchema = z.object({
  complete: z.boolean(),
  summary: z.string(),
  remainingTickets: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
});

function currentJjCommit(): string | null {
  const result = spawnSync("jj", ["log", "-r", "@", "--no-graph", "--template", "commit_id ++ \"\\n\""], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

const defaultWorktreeBase = process.env.SMITHERS_STUDIO_BASE_BRANCH?.trim() || currentJjCommit() || "main";

const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(16).default(16),
  maxBatches: z.number().int().min(1).max(12).default(6),
  perTicketIterations: z.number().int().min(1).max(8).default(5),
  runFullE2E: z.boolean().default(true),
  baseBranch: z.string().min(1).default(defaultWorktreeBase),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  discovery: discoverySchema,
  implementation: ticketImplementationSchema,
  validation: ticketValidationSchema,
  review: ticketReviewSchema,
  ticketResult: ticketResultSchema,
  merge: mergeResultSchema,
  ci: ciResultSchema,
  finalAudit: finalAuditSchema,
});

const codexModel = process.env.SMITHERS_STUDIO_CODEX_MODEL?.trim();
const codex = new CodexAgent({
  ...(codexModel ? { model: codexModel } : {}),
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
});
const claude = new ClaudeCodeAgent({
  model: process.env.SMITHERS_STUDIO_CLAUDE_MODEL ?? "claude-sonnet-4-20250514",
  permissionMode: "bypassPermissions",
  dangerouslySkipPermissions: true,
});
const antigravity = new AntigravityAgent({
  model: process.env.SMITHERS_STUDIO_ANTIGRAVITY_MODEL ?? "gemini-3.1-pro-preview",
  yolo: true,
  dangerouslySkipPermissions: true,
});
const kimi = new KimiAgent({
  finalMessageOnly: true,
  quiet: true,
});

function commandExists(command: string): boolean {
  const probe = process.platform === "win32"
    ? spawnSync("where", [command], { stdio: "ignore" })
    : spawnSync("which", [command], { stdio: "ignore" });
  return probe.status === 0;
}

const availableAgents = {
  antigravity: commandExists("agy"),
  claude: commandExists("claude"),
  codex: commandExists("codex"),
  kimi: process.env.SMITHERS_STUDIO_ENABLE_KIMI === "1" && commandExists("kimi"),
};

function availableChain(entries: Array<[keyof typeof availableAgents, AgentLike]>): AgentLike[] {
  const chain = entries
    .filter(([name]) => availableAgents[name])
    .map(([, agent]) => agent);
  return chain.length > 0 ? chain : [codex];
}

const codexChain: AgentLike[] = availableChain([["codex", codex], ["claude", claude], ["kimi", kimi]]);
const claudeChain: AgentLike[] = availableChain([["claude", claude], ["codex", codex], ["kimi", kimi]]);
const antigravityChain: AgentLike[] = availableChain([["antigravity", antigravity], ["claude", claude], ["codex", codex], ["kimi", kimi]]);
const reviewChain: AgentLike[] = availableChain([["codex", codex], ["claude", claude], ["kimi", kimi]]);
const discoveryChain: AgentLike[] = availableChain([["codex", codex], ["claude", claude], ["kimi", kimi]]);
const agentTaskRetries = 3;
const repoRootProbe = spawnSync("jj", ["root"], { encoding: "utf8" });
const repoRoot = repoRootProbe.status === 0 ? repoRootProbe.stdout.trim() : process.cwd();

type ParityTicket = z.infer<typeof parityTicketSchema>;
type TicketImplementation = z.infer<typeof ticketImplementationSchema>;
type TicketValidation = z.infer<typeof ticketValidationSchema>;
type TicketReview = z.infer<typeof ticketReviewSchema>;

function latestForTicket<T extends { ticketId: string }>(rows: T[] | undefined, ticketId: string): T | undefined {
  return [...(rows ?? [])].reverse().find((row) => row.ticketId === ticketId);
}

function latest<T>(rows: T[] | undefined): T | undefined {
  return rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
}

function latestLgtmResults(results: Array<z.infer<typeof ticketResultSchema>>) {
  const byTicket = new Map<string, z.infer<typeof ticketResultSchema>>();
  for (const result of results) {
    if (result.lgtm) {
      byTicket.set(result.ticketId, result);
    }
  }
  return [...byTicket.values()];
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "ticket";
}

function worktreeForTicket(ticketId: string) {
  return join(repoRoot, ".smithers", "workflows", ".worktrees", `studio-parity-${slug(ticketId)}`);
}

function worktreeBase(ctx: any) {
  return process.env.SMITHERS_STUDIO_BASE_BRANCH?.trim() || currentJjCommit() || ctx.input.baseBranch;
}

function ticketScopedPorts(ticketId: string) {
  const suffix = Number(ticketId.match(/(\d+)$/)?.[1] ?? "0");
  const offset = Number.isFinite(suffix) ? suffix : Math.abs(hashString(ticketId) % 400);
  return {
    appPort: 5500 + offset,
    gatewayPort: 7400 + offset,
  };
}

function hashString(value: string) {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return hash;
}

function agentForTicket(ticket: ParityTicket, index: number): AgentLike[] {
  if (ticket.requiresUi || ticket.kind === "ui" || ticket.kind === "terminal") {
    return antigravityChain;
  }
  if (ticket.testsOnly || ticket.kind === "test-only" || ticket.difficulty === "easy") {
    return claudeChain;
  }
  if (ticket.difficulty === "hard" || ticket.difficulty === "critical" || ticket.kind === "gateway") {
    return codexChain;
  }
  return index % 2 === 0 ? codexChain : claudeChain;
}

function ticketDone(ticketId: string, ctx: any) {
  const implementation = latestForTicket<TicketImplementation>(ctx.outputs.implementation, ticketId);
  const validation = latestForTicket<TicketValidation>(ctx.outputs.validation, ticketId);
  const review = latestForTicket<TicketReview>(ctx.outputs.review, ticketId);
  return Boolean(implementation?.status === "implemented" && validation?.allPassed && review?.approved);
}

function ticketFeedback(ticketId: string, ctx: any) {
  const implementation = latestForTicket<TicketImplementation>(ctx.outputs.implementation, ticketId);
  const validation = latestForTicket<TicketValidation>(ctx.outputs.validation, ticketId);
  const review = latestForTicket<TicketReview>(ctx.outputs.review, ticketId);
  const parts: string[] = [];
  if (implementation && implementation.status !== "implemented") {
    parts.push([
      `IMPLEMENTATION SELF-CHECK ${implementation.status.toUpperCase()}:`,
      implementation.summary,
      implementation.commandsRun?.length ? `Commands run:\n${implementation.commandsRun.map((command) => `- ${command}`).join("\n")}` : "",
    ].filter(Boolean).join("\n"));
  }
  if (validation && !validation.allPassed) {
    parts.push(`VALIDATION FAILED:\n${validation.failingSummary ?? validation.summary}`);
  }
  if (review && !review.approved) {
    parts.push(`REVIEW NOT LGTM:\n${review.feedback}`);
    for (const issue of review.issues ?? []) {
      parts.push(`- [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
    }
  }
  return parts.join("\n\n");
}

function parityBacklogBrief() {
  return [
    "Active app: apps/smithers-studio-2 is the new Studio UI being built. Preserve it and move parity work into it when the ticket touches the new UI shell.",
    "Runtime: no UI-only mock data; Vite and Electrobun must hit the same workspace backend and Smithers Gateway contracts.",
    "Fixture realism: Playwright fixtures are fine only when data flows through Gateway RPC/SSE, filesystem, SQLite, CLI, and workspace routes.",
    "Terminal: replace generic terminal rendering with a libghostty-backed React/web terminal. Research @wterm/ghostty and @wterm/react first.",
    "Chat: provider/model selection, supervised/full-access runtime mode, branching/regeneration, transcript search, markdown/syntax highlighting, real attachments, web-search toggle, structured /diff, streaming auto-scroll.",
    "Slash commands: full inventory, route side effects, robust key-value parser, dynamic conflicts, real fuzzy matching or explicit substring contract.",
    "Workflows/prompts/approvals: unsaved prompt preview, dynamic inputs, launch validation, iteration-aware approvals, adaptive layouts.",
    "Runs/dashboard/inspection: iteration-safe approve/deny, progress for approval runs, active elapsed timer, cancelled/failed semantics, source error surfacing, snapshots/fork/replay.",
    "Landings/issues/workspaces: JJHub state filters, unified diffs, complete issue CRUD, workspace restore naming/selection.",
    "Scores/memory/search: scoped metrics, stale async protection, discontiguous line numbers, recall metadata.",
    "Transport/platform: production SSE parser tests, CLI timeout kill path, unknown status preservation, explicit approval decoding.",
    "All accepted work needs tests: Playwright for visible behavior, backend/unit tests for transport/parser/model invariants.",
  ].join("\n- ");
}

function discoveryPrompt(previousResults: unknown[], previousAudit: unknown) {
  return [
    "You are the primary Codex discovery agent for Smithers Studio parity. Use the configured Codex model; if SMITHERS_STUDIO_CODEX_MODEL is set, it is expected to point at the user's requested Codex 5.5-class model.",
    "Pick the 16 best next tickets to run in parallel. Do not plan a separate phase; each ticket assignee must research, plan, implement, and test in one task.",
    "Include past unreviewed Studio features in the backlog: existing work must be code-reviewed and updated until LGTM.",
    "Important: apps/smithers-studio-2 is active user work for the new Studio version. Never delete it, remove its package references, or treat it as a disposable static sibling app.",
    "Prioritize high-leverage work that moves the active Studio UI, apps/smithers-studio-2, toward the user's exact goal: real data, Gateway, .smithers detection, GUI parity, and Playwright coverage. Use apps/smithers-studio as existing implementation context when useful, but do not erase the v2 app.",
    "Use realistic E2E fixtures. Do not ask agents to add static React mocks or fake UI state.",
    "Classify UI and terminal work as requiresUi. Classify tests-only work as testsOnly.",
    "",
    "Known backlog:",
    `- ${parityBacklogBrief()}`,
    "",
    "Previous ticket results:",
    JSON.stringify(previousResults, null, 2),
    "",
    "Previous final audit:",
    JSON.stringify(previousAudit ?? null, null, 2),
    "",
    "Return complete=true only if there are no meaningful parity, test, review, fixture-realism, merge, or CI gaps left.",
  ].join("\n");
}

function implementationPrompt(ticket: ParityTicket, feedback: string) {
  const ports = ticketScopedPorts(ticket.id);
  return [
    `Ticket ${ticket.id}: ${ticket.title}`,
    ticket.summary,
    "",
    "Research, plan, implement, and test this ticket in one pass. Do not stop after a plan.",
    `Return ticketId exactly "${ticket.id}". If you cannot do that, return status=blocked with the reason.`,
    "You are working toward Smithers Studio parity for the active new Studio UI in apps/smithers-studio-2. Existing apps/smithers-studio code may be used as implementation context, but do not erase or bypass the v2 app.",
    "Respect current code style. Avoid unrelated refactors. Do not remove user work.",
    "Protect apps/smithers-studio-2. It is active user work for the new Studio version, not reference code and not a mock. Do not delete it, remove it from the workspace, remove root scripts that point at it, or satisfy gates by making it disappear.",
    "Runtime code must use real workspace/Gateway/CLI/filesystem/SQLite paths. Tests may use realistic fixtures, but not UI-only mock data.",
    "If this touches terminal UI, use the Ghostty/libghostty React path: research @wterm/ghostty plus @wterm/react and wire the app toward that rather than xterm.js or plain text.",
    "If this is UI work, use Playwright screenshots/assertions where relevant.",
    "If this is tests-only work, add/repair tests that prove existing real behavior through backend or E2E contracts.",
    "",
    "Before returning status=implemented, run your own review/CI gate:",
    "- Re-read the acceptance criteria and any previous validation/review feedback.",
    "- Explicitly fix every previous review issue or explain why the issue is no longer applicable in summary.",
    "- Inspect package.json and run real package-owned scripts; do not invent missing commands.",
    "- Run typecheck/build plus focused backend or Playwright checks for touched behavior.",
    "- Treat validation, review, merge, and final CI as predictable gates: your work must pass the validationPrompt checks, survive strict code review, merge cleanly, and not break shared CI.",
    `- For Playwright or Gateway fixture checks in this ticket, avoid shared ports: use SMITHERS_STUDIO_TEST_PORT=${ports.appPort} SMITHERS_STUDIO_GATEWAY_TEST_PORT=${ports.gatewayPort}.`,
    "- Post-merge CI currently runs Studio 2 preservation/typecheck/build, plus legacy Studio parity checks: pnpm --dir apps/smithers-studio-2 run typecheck; pnpm --dir apps/smithers-studio-2 run build; pnpm --dir apps/smithers-studio run typecheck; pnpm --dir apps/smithers-studio run build:web; pnpm --dir apps/smithers-studio run test:backend; and, when full E2E is enabled, pnpm --dir apps/smithers-studio exec playwright test tests/connected-gateway.spec.ts --reporter=line.",
    "- At minimum for apps/smithers-studio-2 or apps/smithers-studio changes, run the relevant subset of those CI commands plus any focused package tests for the files you touched.",
    "- If package.json has test or test:mock-data-guard and your change touches runtime, fixtures, tests, or app routing, run those scripts too.",
    "- If you changed Gateway/client/server packages, also run their package-owned focused tests after inspecting package.json.",
    "- Before finishing, inspect your diff for unresolved TODO shortcuts, TypeScript scope errors, fixture paths missing from the worktree, static mock data, and UI behavior that is only hard-coded for tests.",
    "- If Playwright depends on fixture workflow frontends, verify required files such as tests/fixtures/workspace/.smithers/workflows/*/manifest.json and frontend dist/index.html exist in your worktree.",
    "- Include the exact commands you ran and what remains unverified in commandsRun/summary.",
    "- If a relevant check fails, a required script is missing in your worktree, or a check was not run, return status=partial or blocked with the exact command and failure.",
    "- Do not add hard-coded route mocks, runtime mock data, or UI-only shortcuts. Do not delete or hide apps/smithers-studio-2.",
    "- Fixtures are allowed only when they exercise realistic filesystem, SQLite, Gateway, SSE, CLI, or browser behavior.",
    "",
    "Acceptance criteria:",
    ticket.acceptanceCriteria.map((item) => `- ${item}`).join("\n"),
    "",
    "Likely files:",
    ticket.filesLikely.map((item) => `- ${item}`).join("\n"),
    "",
    "Test plan:",
    ticket.testPlan.map((item) => `- ${item}`).join("\n"),
    feedback ? `\nPrevious loop feedback to fix:\n${feedback}` : "",
  ].join("\n");
}

function validationPrompt(ticket: ParityTicket, implementation?: z.infer<typeof ticketImplementationSchema>) {
  const ports = ticketScopedPorts(ticket.id);
  return [
    `Validate ticket ${ticket.id}: ${ticket.title}`,
    `Return ticketId exactly "${ticket.id}". Never substitute an inferred id such as "unknown" or a package name.`,
    implementation
      ? `Implementation self-report:\n${JSON.stringify({
        status: implementation.status,
        summary: implementation.summary,
        commandsRun: implementation.commandsRun,
      }, null, 2)}`
      : "No implementation self-report is available yet; inspect the worktree directly.",
    "Run the most relevant commands. Prefer real backend/unit tests plus focused Playwright for visible behavior.",
    "Do not approve by inspection only. Return allPassed=false with failingSummary if anything relevant fails or was not run.",
    "If the implementation self-report is partial or blocked, return allPassed=false unless you independently verify the named gap is now resolved.",
    `Use ticket-scoped ports for Playwright/Gateway fixture commands: SMITHERS_STUDIO_TEST_PORT=${ports.appPort} SMITHERS_STUDIO_GATEWAY_TEST_PORT=${ports.gatewayPort}. Do not use shared default ports in parallel validation.`,
    "If those ticket-scoped ports are busy, rerun once with another unused SMITHERS_STUDIO_TEST_PORT and SMITHERS_STUDIO_GATEWAY_TEST_PORT pair before failing on a port conflict.",
    "Do not set allPassed=true unless acceptance-relevant behavior was exercised through production code and package-owned scripts, including test:mock-data-guard when present.",
    "For apps/smithers-studio, inspect package.json first. Common commands currently include:",
    "- pnpm --dir apps/smithers-studio-2 run typecheck",
    "- pnpm --dir apps/smithers-studio-2 run build",
    "- pnpm --dir apps/smithers-studio run typecheck",
    "- pnpm --dir apps/smithers-studio run build:web",
    "- pnpm --dir apps/smithers-studio run test:backend",
    `- SMITHERS_STUDIO_TEST_PORT=${ports.appPort} SMITHERS_STUDIO_GATEWAY_TEST_PORT=${ports.gatewayPort} pnpm --dir apps/smithers-studio exec playwright test tests/connected-gateway.spec.ts --reporter=line`,
  ].join("\n");
}

function reviewPrompt(
  ticket: ParityTicket,
  implementation?: z.infer<typeof ticketImplementationSchema>,
  validation?: z.infer<typeof ticketValidationSchema>,
) {
  return [
    `Review ticket ${ticket.id}: ${ticket.title}`,
    `Return ticketId exactly "${ticket.id}".`,
    implementation
      ? `Implementation self-report:\n${JSON.stringify({
        status: implementation.status,
        summary: implementation.summary,
        commandsRun: implementation.commandsRun,
      }, null, 2)}`
      : "No implementation self-report is available yet; inspect the worktree directly.",
    validation
      ? `Validation result:\n${JSON.stringify({
        allPassed: validation.allPassed,
        summary: validation.summary,
        failingSummary: validation.failingSummary,
        commandsRun: validation.commandsRun,
      }, null, 2)}`
      : "No validation result is available yet; inspect the worktree directly.",
    "You are the mandatory reviewer. Do not edit files.",
    "Review the current worktree against the user goal and the ticket acceptance criteria.",
    "Reject any change that deletes apps/smithers-studio-2, removes its package/workspace references, or treats it as a forbidden static sibling app.",
    "Reject if implementation status is partial/blocked, validation failed, validation was too shallow, used the wrong ticketId, skipped relevant package-owned tests, or only asserted local test copies/static shortcuts.",
    "Return approved=true only when the code is LGTM, tests are meaningful, fixture data remains realistic E2E data, and no static UI mock shortcuts were added.",
    "For terminal work, reject unless the implementation clearly uses or is intentionally staged toward @wterm/ghostty/@wterm/react/libghostty.",
    "Findings should include severity, title, file, and description.",
  ].join("\n");
}

function mergePrompt(result: z.infer<typeof ticketResultSchema>) {
  return [
    `Merge ticket ${result.ticketId} back into the main working tree.`,
    `Source worktree: ${result.worktreePath}`,
    `Source branch: ${result.branch}`,
    "",
    "Use the repo's VCS safely. Prefer jj/git merge mechanics when possible; otherwise carefully apply the source worktree diff.",
    "Do not discard unrelated current working-tree changes.",
    "Never merge deletions of apps/smithers-studio-2 or package/lockfile changes whose purpose is to remove that app. It is active user work.",
    "Resolve conflicts if possible. If not possible, report mergedToMain=false and list conflicts.",
    "After merging, run focused checks relevant to the ticket. Full CI runs later.",
  ].join("\n");
}

function runCommand(command: string, args: string[], timeoutMs: number) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env },
    timeout: timeoutMs,
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status,
    stdout: (result.stdout ?? "").slice(-20_000),
    stderr: (result.stderr ?? result.error?.message ?? "").slice(-20_000),
  };
}

function runCi(runFullE2E: boolean) {
  const commands = [
    ["pnpm", ["--dir", "apps/smithers-studio-2", "run", "typecheck"]],
    ["pnpm", ["--dir", "apps/smithers-studio-2", "run", "build"]],
    ["pnpm", ["--dir", "apps/smithers-studio", "run", "typecheck"]],
    ["pnpm", ["--dir", "apps/smithers-studio", "run", "build:web"]],
    ["pnpm", ["--dir", "apps/smithers-studio", "run", "test:backend"]],
  ] as const;
  const results = commands.map(([command, args]) => runCommand(command, [...args], 20 * 60_000));
  if (runFullE2E) {
    results.push(runCommand(
      "pnpm",
      ["--dir", "apps/smithers-studio", "exec", "playwright", "test", "tests/connected-gateway.spec.ts", "--reporter=line"],
      6 * 60_000,
    ));
  }
  const failed = results.filter((result) => result.exitCode !== 0);
  return {
    allPassed: failed.length === 0,
    summary: failed.length === 0
      ? "All configured Smithers Studio CI commands passed."
      : `${failed.length} configured CI command(s) failed.`,
    commands: results,
  };
}

function finalAuditPrompt(ci: unknown, merges: unknown[], results: unknown[]) {
  return [
    "Audit Smithers Studio against the full user goal. Be strict.",
    "Goal: no runtime mock data; real Smithers Gateway/data; .smithers detection; Vite and Electrobun modes; 100% parity with attempted ../gui features; Playwright tests for all features.",
    "Do not mark complete unless every requirement is proven by current code and verification.",
    "",
    "Known backlog:",
    `- ${parityBacklogBrief()}`,
    "",
    "Ticket results:",
    JSON.stringify(results, null, 2),
    "",
    "Merge results:",
    JSON.stringify(merges, null, 2),
    "",
    "CI result:",
    JSON.stringify(ci, null, 2),
    "",
    "Return complete=false with remainingTickets unless the app is genuinely at the requested end state.",
  ].join("\n");
}

export default smithers((ctx) => {
  const discovered = latest(ctx.outputs.discovery);
  const finalAudit = latest(ctx.outputs.finalAudit);
  const ticketResults = ctx.outputs.ticketResult ?? [];
  const mergeResults = ctx.outputs.merge ?? [];
  const latestCi = latest(ctx.outputs.ci);
  const done = finalAudit?.complete === true;
  const tickets = discovered?.tickets ?? [];

  return (
    <Workflow name="studio-parity-swarm">
      <Loop id="studio-parity-batches" until={done} maxIterations={ctx.input.maxBatches} onMaxReached="return-last">
        <Sequence>
          <Task id="discover-next-16" output={outputs.discovery} agent={discoveryChain} retries={agentTaskRetries} timeoutMs={45 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
            {discoveryPrompt(ticketResults, finalAudit)}
          </Task>

          {tickets.length > 0 ? (
            <Parallel maxConcurrency={ctx.input.maxConcurrency}>
              {tickets.map((ticket, index) => {
                const ticketSlug = slug(ticket.id);
                const worktreePath = worktreeForTicket(ticket.id);
                const branch = `studio-parity/${ticketSlug}`;
                const feedback = ticketFeedback(ticket.id, ctx);
                const lgtm = ticketDone(ticket.id, ctx);
                const implementation = latestForTicket(ctx.outputs.implementation, ticket.id);
                const validation = latestForTicket(ctx.outputs.validation, ticket.id);
                return (
                  <Worktree key={ticket.id} path={worktreePath} branch={branch} baseBranch={worktreeBase(ctx)}>
                    <Sequence>
                      <Loop id={`ticket-${ticketSlug}-review-loop`} until={lgtm} maxIterations={ctx.input.perTicketIterations} onMaxReached="return-last">
                        <Sequence>
                          <Task
                            id={`ticket-${ticketSlug}-implement`}
                            output={outputs.implementation}
                            agent={agentForTicket(ticket, index)}
                            retries={agentTaskRetries}
                            timeoutMs={60 * 60_000}
                            heartbeatTimeoutMs={10 * 60_000}
                          >
                            {implementationPrompt(ticket, feedback)}
                          </Task>
                          <Task
                            id={`ticket-${ticketSlug}-validate`}
                            output={outputs.validation}
                            agent={claudeChain}
                            retries={agentTaskRetries}
                            timeoutMs={35 * 60_000}
                            heartbeatTimeoutMs={10 * 60_000}
                          >
                            {validationPrompt(ticket, implementation)}
                          </Task>
                          <Task
                            id={`ticket-${ticketSlug}-review`}
                            output={outputs.review}
                            agent={reviewChain}
                            retries={agentTaskRetries}
                            timeoutMs={35 * 60_000}
                            heartbeatTimeoutMs={10 * 60_000}
                          >
                            {reviewPrompt(ticket, implementation, validation)}
                          </Task>
                          {ticketDone(ticket.id, ctx) ? (
                            <Task id={`ticket-${ticketSlug}-result`} output={outputs.ticketResult}>
                              {{
                                ticketId: ticket.id,
                                branch,
                                worktreePath,
                                lgtm: true,
                                summary: `Ticket ${ticket.id} reached validation + review LGTM.`,
                              }}
                            </Task>
                          ) : null}
                        </Sequence>
                      </Loop>
                    </Sequence>
                  </Worktree>
                );
              })}
            </Parallel>
          ) : null}

          <MergeQueue id="studio-parity-merge-queue" maxConcurrency={1}>
            {latestLgtmResults(ticketResults).map((result) => (
              <Task
                key={result.ticketId}
                id={`merge-${slug(result.ticketId)}`}
                output={outputs.merge}
                agent={reviewChain}
                retries={agentTaskRetries}
                timeoutMs={45 * 60_000}
                heartbeatTimeoutMs={10 * 60_000}
              >
                {mergePrompt(result)}
              </Task>
            ))}
          </MergeQueue>

          <Task id="studio-parity-ci" output={outputs.ci} timeoutMs={90 * 60_000}>
            {() => runCi(ctx.input.runFullE2E)}
          </Task>

          <Task
            id="studio-parity-final-audit"
            output={outputs.finalAudit}
            agent={reviewChain}
            retries={agentTaskRetries}
            timeoutMs={45 * 60_000}
            heartbeatTimeoutMs={10 * 60_000}
          >
            {finalAuditPrompt(latestCi, mergeResults, ticketResults)}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
