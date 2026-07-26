// smithers-display-name: Smithers UI Parity Swarm
/** @jsxImportSource smithers-orchestrator */
import { MergeQueue, Parallel, Sequence, Task, Worktree, createSmithers } from "smithers-orchestrator";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { agents } from "../agents";

const ticketKindSchema = z.enum(["feature", "ui", "test-only", "review-existing", "gateway", "ci", "bugfix"]);
const difficultySchema = z.enum(["easy", "medium", "hard", "critical"]);

export const parityTicketSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  kind: ticketKindSchema,
  difficulty: difficultySchema,
  priority: z.number().min(0).max(100),
  requiresUi: z.boolean().default(false),
  testsOnly: z.boolean().default(false),
  summary: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
  filesLikely: z.array(z.string()).default([]),
  testPlan: z.array(z.string()).default([]),
});

export const discoverySchema = z
  .object({
    batchKey: z.string().trim().min(1),
    complete: z.boolean().default(false),
    rationale: z.string(),
    tickets: z.array(parityTicketSchema).max(16).default([]),
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
  researchNotes: z.array(z.string()).default([]),
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
  remainingTickets: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
});

export const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(16).default(8),
  maxBatches: z.number().int().min(1).max(12).default(6),
  perTicketIterations: z.number().int().min(1).max(8).default(4),
  runFullE2E: z.boolean().default(false),
  baseBranch: z.string().trim().min(1).default("main"),
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

type ParityTicket = z.infer<typeof parityTicketSchema>;
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

function hashString(value: string): number {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function ticketScopedPorts(ticketId: string) {
  const offset = hashString(ticketId) % 1000;
  return { appPort: 45_000 + offset, gatewayPort: 47_000 + offset };
}

function discoveryPrompt(previousResults: RawRow[], previousAudit: RawRow | undefined, batchKey: string): string {
  return [
    "Discover the next highest-value parity tickets for Smithers' shipped custom workflow UI surface.",
    "The only UI targets in this repository are `.smithers/ui/*.tsx`, `packages/gateway-react`, and `packages/components`.",
    "Inspect real Gateway-backed behavior, loading/error/stale-data handling, accessibility, and focused browser or component coverage. Do not fabricate Gateway responses.",
    `Return batchKey=${batchKey} exactly. Return at most 16 independent tickets; complete=true only when no meaningful shipped-surface gap remains.`,
    `Previous results:\n${JSON.stringify(previousResults, null, 2)}`,
    `Previous audit:\n${JSON.stringify(previousAudit ?? null, null, 2)}`,
  ].join("\n\n");
}

function implementationPrompt(ticket: ParityTicket, batchKey: string, candidateId: string, feedback: string): string {
  const ports = ticketScopedPorts(ticket.id);
  return [
    `Implement ticket ${ticket.id}: ${ticket.title}`,
    ticket.summary,
    `Return ticketId=${ticket.id}, batchKey=${batchKey}, and candidateId=${candidateId} exactly.`,
    "Research, plan, implement, and test the smallest complete change. The shipped targets are `.smithers/ui/*.tsx`, `packages/gateway-react`, and `packages/components`.",
    "Use real Gateway/client/component behavior and deterministic fixtures at process boundaries; do not fabricate the behavior under test.",
    `Parallel browser/process checks may use app port ${ports.appPort} and gateway port ${ports.gatewayPort}; both are ticket-scoped and valid TCP ports.`,
    `Acceptance criteria:\n${ticket.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- Prove the ticket's stated behavior."}`,
    `Suggested tests:\n${ticket.testPlan.map((item) => `- ${item}`).join("\n") || "- Run the owning package's focused test command."}`,
    feedback ? `Current same-candidate feedback:\n${feedback}` : "",
    "Return implemented only when focused checks pass; otherwise return partial or blocked truthfully.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function validationPrompt(
  ticket: ParityTicket,
  batchKey: string,
  candidateId: string,
  implementation: RawRow | undefined,
): string {
  return [
    `Validate ticket ${ticket.id} against the real shipped UI code and acceptance criteria.`,
    `Return ticketId=${ticket.id}, batchKey=${batchKey}, and candidateId=${candidateId} exactly.`,
    `Implementation report:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    "Run the owning package's focused tests. Set allPassed=false if the report is partial/blocked, a relevant check is missing, or any check fails.",
  ].join("\n\n");
}

function reviewPrompt(
  ticket: ParityTicket,
  batchKey: string,
  candidateId: string,
  implementation: RawRow | undefined,
  validation: RawRow | undefined,
): string {
  return [
    `Strictly review the current green candidate for ticket ${ticket.id}. Do not edit files.`,
    `Return ticketId=${ticket.id}, batchKey=${batchKey}, and candidateId=${candidateId} exactly.`,
    `Implementation:\n${JSON.stringify(implementation ?? null, null, 2)}`,
    `Validation:\n${JSON.stringify(validation ?? null, null, 2)}`,
    "Approve only if the current candidate is complete, minimal, exercises real production behavior, and has meaningful focused coverage.",
  ].join("\n\n");
}

function mergePrompt(result: z.infer<typeof ticketResultSchema>, baseBranch: string): string {
  return [
    `Merge ticket ${result.ticketId} candidate ${result.candidateId} from batch ${result.batchKey} into ${baseBranch}.`,
    `Source worktree: ${result.worktreePath}`,
    `Source branch: ${result.branch}`,
    "Preserve unrelated shared changes, use explicit path staging, resolve conflicts only within scope, and run focused checks after merging.",
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

export function runCi(batchKey: string, runFullE2E: boolean, cwd = process.cwd()) {
  const commands: Array<[string, string[], number]> = [
    ["pnpm", ["--dir", ".smithers", "typecheck"], 20 * 60_000],
    ["pnpm", ["-C", "packages/gateway-react", "test"], 20 * 60_000],
    ["pnpm", ["-C", "packages/components", "test"], 20 * 60_000],
  ];
  if (runFullE2E) commands.push(["pnpm", ["-C", "e2e", "test"], 60 * 60_000]);
  const results = commands.map(([command, args, timeout]) => runCommand(cwd, command, args, timeout));
  const failed = results.filter((result) => result.exitCode !== 0);
  return {
    batchKey,
    allPassed: failed.length === 0,
    summary: failed.length === 0 ? "All shipped UI checks passed." : `${failed.length} shipped UI check(s) failed.`,
    commands: results,
  };
}

function finalAuditPrompt(batchKey: string, ci: RawRow | undefined, merges: RawRow[], results: RawRow[]) {
  return [
    "Audit the shipped Smithers custom workflow UI surface only: `.smithers/ui/*.tsx`, `packages/gateway-react`, and `packages/components`.",
    `Return batchKey=${batchKey} exactly. complete=true only when this batch's tickets are LGTM, merged, and the current CI row is green, with no remaining shipped-surface gaps.`,
    `Ticket results:\n${JSON.stringify(results, null, 2)}`,
    `Merge results:\n${JSON.stringify(merges, null, 2)}`,
    `CI:\n${JSON.stringify(ci ?? null, null, 2)}`,
  ].join("\n\n");
}

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxConcurrency: ctx.input.maxConcurrency ?? 8,
    maxBatches: ctx.input.maxBatches ?? 6,
    perTicketIterations: ctx.input.perTicketIterations ?? 4,
    runFullE2E: ctx.input.runFullE2E ?? false,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const repoRoot = resolveRepoRoot();
  const runSlug = slug(String((ctx as any).runId ?? "studio-parity"));
  const batchKey = `${runSlug}:${ctx.iteration}`;
  const discoveryRows = rawRows(ctx, "discovery");
  const discovered = discoveryRows
    .filter((row) => row.nodeId === "discover-next-16" && row.batchKey === batchKey)
    .at(-1);
  const tickets = Array.isArray(discovered?.tickets) ? (discovered.tickets as ParityTicket[]) : [];
  const previousAudit = rawRows(ctx, "finalAudit").at(-1);
  const historicalResults = rawRows(ctx, "ticketResult");
  const currentResultsByTicket = new Map<string, RawRow>();
  for (const row of historicalResults)
    if (row.batchKey === batchKey && typeof row.ticketId === "string") currentResultsByTicket.set(row.ticketId, row);
  const currentResults = [...currentResultsByTicket.values()];
  const currentMerges = rawRows(ctx, "merge").filter((row) => row.batchKey === batchKey);
  const currentCi = rawRows(ctx, "ci")
    .filter((row) => row.nodeId === "studio-parity-ci" && row.batchKey === batchKey)
    .at(-1);
  const currentAudit = rawRows(ctx, "finalAudit")
    .filter((row) => row.nodeId === "studio-parity-final-audit" && row.batchKey === batchKey)
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
  const done =
    discovered?.complete === true &&
    currentAudit?.complete === true &&
    currentCi?.allPassed === true &&
    allTicketsLgtm &&
    allMerged;

  return (
    <Workflow name="studio-parity-swarm">
      <Loop id="studio-parity-batches" until={done} maxIterations={input.maxBatches} onMaxReached="return-last">
        <Sequence>
          <Task
            id="discover-next-16"
            output={outputs.discovery}
            agent={agents.research}
            retries={2}
            timeoutMs={45 * 60_000}
            heartbeatTimeoutMs={10 * 60_000}
          >
            {discoveryPrompt(historicalResults, previousAudit, batchKey)}
          </Task>

          {tickets.length > 0 ? (
            <Parallel maxConcurrency={input.maxConcurrency}>
              {tickets.map((ticket) => {
                const ticketSlug = slug(ticket.id);
                const candidateId = `${batchKey}:${ticketSlug}`;
                const branch = `studio-parity/${runSlug}/${ctx.iteration}/${ticketSlug}`;
                const worktreePath = join(
                  repoRoot,
                  ".smithers",
                  "workflows",
                  ".worktrees",
                  runSlug,
                  `batch-${ctx.iteration}`,
                  ticketSlug,
                );
                const state = ticketState(ctx, ticket.id, ticketSlug, batchKey, candidateId, input.perTicketIterations);
                return (
                  <Worktree key={ticket.id} path={worktreePath} branch={branch} baseBranch={input.baseBranch}>
                    <Sequence>
                      <Loop
                        id={`ticket-${ticketSlug}-review-loop`}
                        until={state.done}
                        maxIterations={input.perTicketIterations}
                        onMaxReached="return-last"
                      >
                        <Sequence>
                          <Task
                            id={`ticket-${ticketSlug}-implement`}
                            output={outputs.implementation}
                            agent={agents.implement}
                            retries={2}
                            timeoutMs={60 * 60_000}
                            heartbeatTimeoutMs={10 * 60_000}
                          >
                            {implementationPrompt(ticket, batchKey, candidateId, ticketFeedback(state))}
                          </Task>
                          <Task
                            id={`ticket-${ticketSlug}-validate`}
                            output={outputs.validation}
                            agent={agents.midTier}
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
                              agent={agents.review}
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

          <MergeQueue id="studio-parity-merge-queue" maxConcurrency={1}>
            {currentResults
              .filter(
                (result) =>
                  result.lgtm === true &&
                  !currentMerges.some(
                    (merge) =>
                      merge.ticketId === result.ticketId &&
                      merge.candidateId === result.candidateId &&
                      merge.mergedToMain === true,
                  ),
              )
              .map((result) => (
                <Task
                  key={String(result.ticketId)}
                  id={`merge-${slug(String(result.ticketId))}`}
                  output={outputs.merge}
                  agent={agents.implement}
                  retries={2}
                  timeoutMs={45 * 60_000}
                  heartbeatTimeoutMs={10 * 60_000}
                >
                  {mergePrompt(result as z.infer<typeof ticketResultSchema>, input.baseBranch)}
                </Task>
              ))}
          </MergeQueue>

          <Task id="studio-parity-ci" output={outputs.ci} timeoutMs={90 * 60_000}>
            {() => runCi(batchKey, input.runFullE2E, repoRoot)}
          </Task>

          <Task
            id="studio-parity-final-audit"
            output={outputs.finalAudit}
            agent={agents.review}
            retries={2}
            timeoutMs={45 * 60_000}
            heartbeatTimeoutMs={10 * 60_000}
          >
            {finalAuditPrompt(batchKey, currentCi, currentMerges, currentResults)}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
