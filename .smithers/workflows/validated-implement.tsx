// smithers-source: authored
// smithers-display-name: Validated Implement
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Loop } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { implementer, panelists } from "../components/roles";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";
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

const depgateSchema = z.looseObject({
  needsValidation: z.boolean().default(false),
  rationale: z.string().default(""),
  assumptions: z.array(z.string()).default([]),
  testFiles: z.array(z.string()).default([]),
  testCommand: z.string().default(""),
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

const inputSchema = z.object({
  ticketId: z.string().default("ticket"),
  title: z.string().default("Untitled ticket"),
  brief: z.string().default("Implement the requested change."),
  context: z.string().default(""),
  tdd: z.boolean().default(false),
  maxReviewIterations: z.number().int().default(3),
  maxValidationAttempts: z.number().int().default(4),
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

  const research = ctx.outputMaybe(outputs.research, { nodeId: "research" });
  const depgate = ctx.outputMaybe(outputs.depgate, { nodeId: "depgate" });
  // The plan is the synthesized output of the plan panel's moderator.
  const plan = ctx.outputMaybe(outputs.planSynthesis, { nodeId: "plan-moderator" });

  const needsValidation = depgate?.needsValidation === true && (depgate?.testCommand ?? "").trim().length > 0;

  // ── dependency-validation loop state ──────────────────────────────────────
  const validations = (ctx.outputs.depvalidate ?? []) as DepValidate[];
  const latestValidation = validations.length ? validations[validations.length - 1] : undefined;
  const validationPassed = needsValidation ? latestValidation?.passed === true : true;
  // mount the ask-a-human gate only when the most recent real run failed
  const latestRunFailed = needsValidation && latestValidation !== undefined && latestValidation.passed !== true;

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
        `  • Clone Plue and export PLUE_DIR (default /Users/williamcory/plue), boot its compose`,
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
  const validateOut = ctx.outputMaybe(outputs.validate, { nodeId: "impl:validate" });
  const implValidationPassed = validateOut !== undefined && validateOut.allPassed !== false;
  const gate = reviewGate(ctx, "impl:review-moderator");
  const done = implValidationPassed && gate.approved;
  const implIterations = (ctx.outputs.validate ?? []).length;
  const loopExhausted = !done && implIterations >= maxReviewIterations;

  const feedbackParts: string[] = [];
  if (validateOut && !implValidationPassed && validateOut.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validateOut.failingSummary}`);
  }
  if (gate.feedback) {
    feedbackParts.push(`REVIEW PANEL REJECTED:\n${gate.feedback}`);
  }
  const feedback = feedbackParts.length ? feedbackParts.join("\n\n") : null;

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
- Otherwise set needsValidation=true and WRITE real test file(s) into the project's existing test suite (prefer apps/smithers/tests/assumptions/${ticketId}.assumptions.test.ts). The tests MUST hit the real dependency — NO mocks, no route fabrication, no hardcoded stand-ins. Examples that fit this repo: Plue's API on :4000 returns 401 on GET /api/user without a token; a seeded/dev token makes GET /api/user return a user; the gateway on :7331 returns ok from /health.
- Guard live assertions behind an env flag (e.g. process.env.SMITHERS_DEV_E2E === "1") so the suite SKIPS (not fails) in CI where the infra is absent — this is conditional execution against real infra, not a mock. The validation command below WILL set that flag so the tests really run now.
- Return testFiles (paths you wrote) and testCommand: a single shell command, runnable from the repo root, that sets the env flag and runs exactly those tests (e.g. \`SMITHERS_DEV_E2E=1 bun test apps/smithers/tests/assumptions/${ticketId}.assumptions.test.ts\`). assumptions: a short list of the concrete facts the tests prove.
- Actually create the files on disk now. Keep them small and deterministic.`;

  const planPromptParts = [
    `You are the PLAN stage for ticket "${ticketId}". Produce an implementation plan informed by the research and the validated assumptions.`,
    ticketBlock,
    researchBlock(research),
    needsValidation && depgate
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
    plan ? `IMPLEMENTATION PLAN:\n${plan.summary}\n\nSteps:\n${numbered(plan.steps)}\n\nRisks:\n${bullets(plan.risks)}` : null,
    needsValidation && depgate
      ? `ASSUMPTION-VALIDATION TESTS — these prove the external dependencies and MUST STAY GREEN. Run them as part of your work and do not weaken or mock them:\nFiles: ${depgate.testFiles.join(", ") || "(see suite)"}\nCommand: ${depgate.testCommand}`
      : null,
    tdd ? "Follow the plan's test-first approach: write/adjust tests before production code." : null,
    `Follow repo conventions in CLAUDE.md (work on main, atomic commits, no mocks, apps/smithers React style). Update docs before code where the ticket defines a contract.`,
  ]
    .filter(Boolean)
    .join("\n\n---\n");

  return (
    <Workflow name="validated-implement">
      <Sequence>
        <Task id="research" output={outputs.research} agent={agents.smartTool} timeoutMs={1_800_000} heartbeatTimeoutMs={600_000}>
          {researchPrompt}
        </Task>

        <Task id="depgate" output={outputs.depgate} agent={agents.smartTool} timeoutMs={1_800_000} heartbeatTimeoutMs={600_000}>
          {depgatePrompt}
        </Task>

        {needsValidation ? (
          <Loop id="depvalidate:loop" until={validationPassed} maxIterations={maxValidationAttempts} onMaxReached="return-last">
            <Sequence>
              <Task id="depvalidate:run" output={outputs.depvalidate}>
                {async () => {
                  const { spawnSync } = await import("node:child_process");
                  const command = (depgate?.testCommand ?? "").trim();
                  if (!command) {
                    return { ran: false, passed: true, command: "", exitCode: null, output: "no testCommand provided; nothing to validate" };
                  }
                  const res = spawnSync("bash", ["-lc", command], {
                    cwd: process.cwd(),
                    encoding: "utf8",
                    timeout: 600_000,
                    maxBuffer: 64 * 1024 * 1024,
                    env: { ...process.env, SMITHERS_DEV_E2E: "1" },
                  });
                  const stdout = res.stdout ?? "";
                  const stderr = res.stderr ?? "";
                  const combined = `${stdout}\n${stderr}`.trim();
                  const exitCode = typeof res.status === "number" ? res.status : null;
                  return {
                    ran: true,
                    passed: exitCode === 0,
                    command,
                    exitCode,
                    output: combined.slice(-12000),
                  };
                }}
              </Task>
              {latestRunFailed ? (
                <Approval
                  id="depvalidate:help"
                  output={outputs.approval}
                  request={{
                    title: `Assumption validation failed for "${ticketId}" — fix the environment and retry?`,
                    summary: depHelpSummary,
                    metadata: { ticketId, command: latestValidation?.command ?? "", exitCode: latestValidation?.exitCode ?? null },
                  }}
                  onDeny="fail"
                />
              ) : null}
            </Sequence>
          </Loop>
        ) : null}

        <PlanPanel idPrefix="plan" prompt={planPrompt} panelistOutput={planSchema} synthesisOutput={planSynthesisSchema} />

        <ValidationLoop
          idPrefix="impl"
          prompt={implementPrompt}
          implementAgents={implementer}
          validateAgents={agents.cheapFast}
          reviewAgents={panelists}
          synthesizeReview
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
                `The implement → validate → review loop ran ${implIterations} time(s) without a green validation + synthesized review approval.`,
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
      </Sequence>
    </Workflow>
  );
});
