// smithers-source: authored
// smithers-display-name: Validated Implement
/** @jsxImportSource smthrs */
import { createSmithers, Sequence, Loop } from "smthrs";
import { spawnSync } from "node:child_process";
import { z } from "zod/v4";
import { agents } from "../agents";
import { implementer, panelists } from "../components/roles";
import {
  ValidationLoop,
  implementOutputSchema,
  validateOutputSchema,
  validationLoopState,
} from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema } from "../components/Review";
import { PlanPanel } from "../components/PlanPanel";

/**
 * Validated Implement — one ticket, driven through:
 *
 *   research → dependency gate → (assumption-validation loop, ask-a-human) →
 *   plan → implement+validate+review loop → escalation gate
 *
 * The dependency gate is conditional. An agent reads the research, decides whether
 * the ticket leans on a third-party dependency or external infra (Docker, Plue,
 * the gateway, GitHub App, Cerebras, Cloudflare), and if so AUTHORS real
 * assumption-validation tests into the project's own suite (no mocks). A compute
 * task then RUNS those tests for real. If they fail, an <Approval> blocks the run
 * and asks a human to fix the environment (start Docker, clone Plue, provide a
 * token) and approve to retry — or deny to abort. The passing tests are a durable
 * artifact that keeps proving the dependency over time.
 *
 * Research, plan, AND the validated assumption tests are passed forward into
 * implementation as first-class inputs; implementation must keep them green. The
 * review loop is bounded; if it cannot converge it escalates to a human gate.
 */

const researchSchema = z.looseObject({
  summary: z.string(),
  findings: z.array(z.string()).default([]),
  fileRefs: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
});

export const depgateSchema = z
  .looseObject({
    needsValidation: z.boolean().default(false),
    rationale: z.string().default(""),
    assumptions: z.array(z.string()).default([]),
    testFiles: z.array(z.string()).default([]),
    testCommand: z.string().default(""),
  })
  .superRefine((value, issue) => {
    if (value.needsValidation && !value.testCommand.trim()) {
      issue.addIssue({
        code: "custom",
        path: ["testCommand"],
        message: "testCommand is required when needsValidation is true",
      });
    }
  });

const depvalidateSchema = z.object({
  ran: z.boolean().default(false),
  passed: z.boolean().default(false),
  command: z.string().default(""),
  exitCode: z.number().nullable().default(null),
  output: z.string().default(""),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

const planSchema = z.looseObject({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
});

// Synthesized plan from the plan panel's moderator — distinct schema object so
// it resolves to its own output channel (channels are keyed by schema identity).
const planSynthesisSchema = z.looseObject({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
});

export const inputSchema = z.object({
  ticketId: z.string().trim().min(1).default("ticket"),
  title: z.string().trim().min(1).default("Untitled ticket"),
  brief: z.string().trim().min(1).default("Implement the requested change."),
  context: z.string().default(""),
  tdd: z.boolean().default(false),
  maxReviewIterations: z.number().int().min(1).max(10).default(3),
  maxValidationAttempts: z.number().int().min(1).max(10).default(4),
});

const { Workflow, Task, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  research: researchSchema,
  depgate: depgateSchema,
  depvalidate: depvalidateSchema,
  approval: approvalSchema,
  plan: planSchema,
  planSynthesis: planSynthesisSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
});

type DepValidate = z.infer<typeof depvalidateSchema>;

function rawRows(ctx: any, channel: string): Array<Record<string, unknown>> {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    : [];
}

export function runDependencyCommand(command: string): DepValidate {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("dependency validation requires a non-blank test command");
  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", trimmed] : ["-lc", trimmed];
  const res = spawnSync(shell, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SMITHERS_DEV_E2E: "1" },
  });
  const combined = `${res.stdout ?? ""}\n${res.stderr ?? res.error?.message ?? ""}`.trim();
  const exitCode = typeof res.status === "number" ? res.status : null;
  return { ran: true, passed: exitCode === 0, command: trimmed, exitCode, output: combined.slice(-12000) };
}

const bullets = (items: string[]): string => (items.length ? items.map((s) => `- ${s}`).join("\n") : "- (none)");
const numbered = (items: string[]): string => items.map((s, i) => `${i + 1}. ${s}`).join("\n");

function researchBlock(r: z.infer<typeof researchSchema> | undefined): string | null {
  if (!r) return null;
  return [
    `RESEARCH SUMMARY:\n${r.summary}`,
    `Key findings:\n${bullets(r.findings)}`,
    `File references:\n${bullets(r.fileRefs)}`,
    `Open unknowns:\n${bullets(r.unknowns)}`,
    `Suspected external dependencies / infra:\n${bullets(r.dependencies)}`,
  ].join("\n\n");
}

export default smithers((ctx) => {
  const ticketId = ctx.input.ticketId ?? "ticket";
  const title = ctx.input.title ?? "Untitled ticket";
  const brief = ctx.input.brief ?? "Implement the requested change.";
  const extraContext = ctx.input.context ?? "";
  const tdd = ctx.input.tdd ?? false;
  const maxReviewIterations = ctx.input.maxReviewIterations ?? 3;
  const maxValidationAttempts = ctx.input.maxValidationAttempts ?? 4;

  const ticketBlock = [
    `TICKET ${ticketId}: ${title}`,
    brief,
    extraContext ? `CONTEXT / DOSSIER:\n${extraContext}` : null,
  ]
    .filter(Boolean)
    .join("\n\n---\n");

  const research = ctx.latest(outputs.research, "research");
  const depgate = ctx.latest(outputs.depgate, "depgate");
  // The plan is the synthesized output of the plan panel's moderator.
  const plan = ctx.latest(outputs.planSynthesis, "plan-moderator");

  const requiresValidation = depgate?.needsValidation === true;
  const invalidDependencyConfig = requiresValidation && !(depgate?.testCommand ?? "").trim();

  // ── dependency-validation loop state ──────────────────────────────────────
  const validations = rawRows(ctx, "depvalidate").filter((row) => row.nodeId === "depvalidate:run") as Array<
    DepValidate & Record<string, unknown>
  >;
  const latestValidation = ctx.latest(outputs.depvalidate, "depvalidate:run") as DepValidate | undefined;
  const validationPassed = requiresValidation ? latestValidation?.passed === true : true;
  const dependencyExhausted =
    requiresValidation &&
    !invalidDependencyConfig &&
    latestValidation?.passed === false &&
    validations.length >= maxValidationAttempts;
  const dependencyReady = depgate !== undefined && !invalidDependencyConfig && !dependencyExhausted && validationPassed;
  // mount the ask-a-human gate only when the most recent real run failed
  const latestRunFailed = requiresValidation && latestValidation !== undefined && latestValidation.passed !== true;

  const depHelpSummary = latestValidation
    ? [
        `The assumption-validation tests for ticket "${ticketId}" are FAILING.`,
        ``,
        `Command: ${latestValidation.command}`,
        `Exit code: ${latestValidation.exitCode ?? "n/a"}`,
        ``,
        `These tests prove the external dependency this ticket relies on actually works.`,
        `They do not mock anything, so a failure means the environment is not ready.`,
        ``,
        `To unblock: fix the environment, then APPROVE to re-run the tests. Likely fixes:`,
        `  • Start Docker Desktop (docker info must succeed)`,
        `  • If the ticket uses Plue, clone it and export PLUE_DIR, then boot its compose`,
        `  • Boot the gateway (smithers up) so /health responds`,
        `  • Provide a valid Plue auth token for the seeded/dev user`,
        ``,
        `DENY to abort the ticket if the dependency cannot be satisfied.`,
        ``,
        `--- last test output (tail) ---`,
        (latestValidation.output ?? "").slice(-2500),
      ].join("\n")
    : "Assumption-validation tests have not produced output yet.";

  // ── implement-loop convergence (mirrors research-plan-implement) ──────────
  const implState = validationLoopState(ctx, { prefix: "impl", maxIterations: maxReviewIterations });
  const done = implState.done;
  const implIterations = implState.attempts;
  const loopExhausted = implState.exhausted;
  const feedback = implState.feedback;

  // ── prompts ───────────────────────────────────────────────────────────────
  const researchPrompt = `You are the RESEARCH stage for one ticket. Read the real code, docs, and the dossier below. Do not write any production code yet.

${ticketBlock}

Investigate thoroughly with your tools (read files, grep, run read-only commands). Produce:
- summary: what the ticket needs and how the relevant subsystem works today.
- findings: concrete facts with file:line references.
- fileRefs: the specific files/paths a fix would touch.
- unknowns: open questions a human or a validation test must answer.
- dependencies: every third-party dependency or external infra this ticket leans on (Docker, Plue, the gateway, GitHub App, Cerebras, Cloudflare, a token, etc.). Empty array if the ticket is self-contained.`;

  const depgatePrompt = `You are the DEPENDENCY GATE for ticket "${ticketId}". Decide whether this ticket depends on a third-party dependency or external infrastructure, and if so, AUTHOR real assumption-validation tests that prove the dependency actually works.

${ticketBlock}

${researchBlock(research) ?? "(research not available)"}

Rules:
- If the ticket is self-contained (no external infra/3rd-party dep), set needsValidation=false and stop.
- Otherwise set needsValidation=true and WRITE real test file(s) into the owning package's existing suite (or \`.smithers/tests/assumptions/${ticketId}.assumptions.test.ts\` for workflow-pack behavior). The tests MUST hit the real dependency — NO mocks, no route fabrication, no hardcoded stand-ins.
- Guard live assertions behind an env flag (e.g. process.env.SMITHERS_DEV_E2E === "1") so the suite SKIPS (not fails) in CI where the infra is absent — this is conditional execution against real infra, not a mock. The validation command below WILL set that flag so the tests really run now.
- Return testFiles (paths you wrote) and testCommand: a single shell command, runnable from the repo root, that runs exactly those tests. The workflow supplies \`SMITHERS_DEV_E2E=1\` in the child environment. assumptions: a short list of the concrete facts the tests prove.
- Actually create the files on disk now. Keep them small and deterministic.`;

  const planPromptParts = [
    `You are the PLAN stage for ticket "${ticketId}". Produce an implementation plan informed by the research and the validated assumptions.`,
    ticketBlock,
    researchBlock(research),
    requiresValidation && depgate
      ? `VALIDATED ASSUMPTIONS (already proven green — the plan may rely on these):\n${bullets(depgate.assumptions)}\nTest command kept green: ${depgate.testCommand}`
      : null,
    tdd ? "Follow test-driven development: the plan MUST start with test steps before implementation steps." : null,
    `Return: summary, steps (ordered, concrete), risks.`,
  ];
  const planPrompt = planPromptParts.filter(Boolean).join("\n\n---\n");

  const implementPrompt = [
    `You are implementing ticket "${ticketId}". Carry out the plan end-to-end against the real codebase.`,
    ticketBlock,
    researchBlock(research),
    plan
      ? `IMPLEMENTATION PLAN:\n${plan.summary}\n\nSteps:\n${numbered(plan.steps)}\n\nRisks:\n${bullets(plan.risks)}`
      : null,
    requiresValidation && depgate
      ? `ASSUMPTION-VALIDATION TESTS — these prove the external dependencies and MUST STAY GREEN. Run them as part of your work and do not weaken or mock them:\nFiles: ${depgate.testFiles.join(", ") || "(see suite)"}\nCommand: ${depgate.testCommand}`
      : null,
    tdd ? "Follow the plan's test-first approach: write/adjust tests before production code." : null,
    `Follow repo conventions in CLAUDE.md (work on main, atomic commits, no mocks, and the owning package's conventions). Update docs before code where the ticket defines a contract.`,
  ]
    .filter(Boolean)
    .join("\n\n---\n");

  return (
    <Workflow name="validated-implement">
      <Sequence>
        <Task
          id="research"
          output={outputs.research}
          agent={agents.research}
          timeoutMs={1_800_000}
          heartbeatTimeoutMs={600_000}
        >
          {researchPrompt}
        </Task>

        <Task
          id="depgate"
          output={outputs.depgate}
          agent={agents.implement}
          timeoutMs={1_800_000}
          heartbeatTimeoutMs={600_000}
        >
          {depgatePrompt}
        </Task>

        {invalidDependencyConfig ? (
          <Task id="depvalidate:configuration-error" output={outputs.depvalidate}>
            {() => {
              throw new Error(`dependency gate for ticket "${ticketId}" requires a non-blank testCommand`);
            }}
          </Task>
        ) : requiresValidation && !dependencyExhausted ? (
          <Loop
            id="depvalidate:loop"
            until={validationPassed}
            maxIterations={maxValidationAttempts}
            onMaxReached="return-last"
          >
            <Sequence>
              <Task id="depvalidate:run" output={outputs.depvalidate}>
                {() => runDependencyCommand(depgate?.testCommand ?? "")}
              </Task>
              {latestRunFailed ? (
                <Approval
                  id="depvalidate:help"
                  output={outputs.approval}
                  request={{
                    title: `Assumption validation failed for "${ticketId}" — fix the environment and retry?`,
                    summary: depHelpSummary,
                    metadata: {
                      ticketId,
                      command: latestValidation?.command ?? "",
                      exitCode: latestValidation?.exitCode ?? null,
                    },
                  }}
                  onDeny="fail"
                />
              ) : null}
            </Sequence>
          </Loop>
        ) : dependencyExhausted ? (
          <Task id="depvalidate:exhausted" output={outputs.depvalidate}>
            {() => {
              throw new Error(
                `dependency validation for ticket "${ticketId}" remained red after ${maxValidationAttempts} attempt(s)`,
              );
            }}
          </Task>
        ) : null}

        {dependencyReady ? (
          <>
            <PlanPanel
              idPrefix="plan"
              prompt={planPrompt}
              panelistOutput={planSchema}
              synthesisOutput={planSynthesisSchema}
            />

            <ValidationLoop
              idPrefix="impl"
              prompt={implementPrompt}
              implementAgents={implementer}
              validateAgents={agents.midTier}
              reviewAgents={panelists}
              synthesizeReview
              reviewWhen={implState.validationPassed}
              feedback={feedback}
              done={done}
              maxIterations={maxReviewIterations}
            />

            {loopExhausted ? (
              <Approval
                id="escalate"
                output={outputs.approval}
                request={{
                  title: `Ticket "${ticketId}" did not converge after ${maxReviewIterations} review iterations`,
                  summary: [
                    `The implement → validate → review loop ran ${implIterations} time(s) without a current green validation + same-iteration synthesized review approval.`,
                    ``,
                    `Latest blocking feedback:`,
                    feedback ?? "(no structured feedback captured)",
                    ``,
                    `APPROVE to accept the current state and finish the run, or DENY to abort for manual takeover.`,
                  ].join("\n"),
                  metadata: { ticketId, implIterations, done },
                }}
                onDeny="fail"
              />
            ) : null}
          </>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
