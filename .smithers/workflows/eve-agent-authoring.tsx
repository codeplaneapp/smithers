// smithers-source: seeded
// smithers-display-name: Eve Agent Authoring
/** @jsxImportSource smithers-orchestrator */
//
// Implements the `.smithers/specs/eve-agent-authoring.md` feature via strict
// documentation-driven development:
//
//   research  -> read the spec so planners are grounded
//   plan      -> PANEL of Opus + Codex, synthesized by the moderator (Codex)
//   phase 1   -> DOCS: write the API contract in docs/, regenerate llms bundles
//   phase 2   -> TESTS: write failing tests that encode the doc'd contract
//   phase 3   -> IMPLEMENT: make the tests pass (fork eve's authoring layer)
//
// Each phase is a ValidationLoop: Sonnet implements, cheapFast validates
// (typecheck + tests), and an Opus + Codex panel reviews with a synthesized
// verdict. A phase only advances when validation passes AND the review panel
// approves (or maxIterations is hit).
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { panelists, synthesizer } from "../components/roles";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";
import { PlanPanel, planOutputSchema, planSynthesisSchema } from "../components/PlanPanel";
import ResearchPrompt from "../prompts/research.mdx";

const SPEC_PATH = ".smithers/specs/eve-agent-authoring.md";

const researchOutputSchema = z.looseObject({
  summary: z.string(),
  keyFindings: z.array(z.string()).default([]),
});

// NOTE: ctx.input fields arrive null/undefined at graph-render and first-run
// time (they are NOT zod-defaulted until later), so coalesce every read against
// these constants rather than trusting the schema `.default()`.
const DEFAULT_PROMPT =
  `Implement the eve-style agent authoring feature specified in ${SPEC_PATH}. ` +
  "Adopt Vercel eve's filesystem agent conventions (agent/ dir: defineAgent + " +
  "instructions.md + tools/*.ts + skills/ + subagents/) as smithers' canonical " +
  "custom-agent authoring format, compiling an agent/ directory to a smithers " +
  "AgentLike. Unify CLI harness adapters (ClaudeCodeAgent, CodexAgent, ...) behind " +
  "the same defineAgent API via a `harness:` discriminator. Keep workflows/*.tsx on " +
  "existing smithers CLI conventions. Fork eve's authoring/discovery layer only; drop " +
  "its runtime (Vercel Workflows/Sandbox/AI Gateway) and run on smithers' engine. " +
  "Non-breaking: additive over the existing ai^6 dependency.";
const DEFAULT_MAX_ITERATIONS = 3;

const inputSchema = z.object({
  prompt: z.string().default(DEFAULT_PROMPT),
  maxIterations: z.number().int().default(DEFAULT_MAX_ITERATIONS),
});

const { Workflow, Task, Sequence, smithers } = createSmithers({
  input: inputSchema,
  research: researchOutputSchema,
  plan: planOutputSchema,
  planSynthesis: planSynthesisSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
});

export default smithers((ctx) => {
  const prompt = ctx.input.prompt ?? DEFAULT_PROMPT;
  const maxIterations = ctx.input.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const research = ctx.outputMaybe("research", { nodeId: "research" });
  const plan = ctx.outputMaybe("planSynthesis", { nodeId: "plan-moderator" });

  const researchBlock = research
    ? `RESEARCH FINDINGS:\n${research.summary}\n\nKey findings:\n${research.keyFindings
        .map((f: string) => `- ${f}`)
        .join("\n")}`
    : null;

  const planBlock = plan
    ? `SYNTHESIZED PLAN:\n${plan.summary}\n\nSteps:\n${plan.steps
        .map((s: string, i: number) => `${i + 1}. ${s}`)
        .join("\n")}`
    : null;

  // The plan panelists get research + the raw feature prompt.
  const planPrompt = [
    prompt,
    `The design spec lives at ${SPEC_PATH}. Read it in full before planning.`,
    researchBlock,
    "Produce a documentation-driven plan whose steps are ordered strictly as: " +
      "(1) DOCS updates that define the API contract, (2) failing TESTS that encode it, " +
      "(3) IMPLEMENTATION that makes the tests pass. Call out the eve fork boundary " +
      "(vendor the authoring/discovery layer, drop the Vercel runtime) and the AI SDK " +
      "version question (does the vendored loader need AI SDK 7, or does it compile against " +
      "the pinned 6.x?).",
  ]
    .filter(Boolean)
    .join("\n\n---\n");

  // Per-phase gate: a phase is done when its validate step passed AND its review
  // panel moderator approved. Feedback (validation failures + review rejections)
  // is threaded back into the next iteration of that phase's ValidationLoop.
  const phaseGate = (idPrefix: string) => {
    const validate = ctx.outputMaybe("validate", { nodeId: `${idPrefix}:validate` });
    const validationPassed = validate !== undefined && validate.allPassed !== false;
    const gate = reviewGate(ctx, `${idPrefix}:review-moderator`);
    const done = validationPassed && gate.approved;
    const parts: string[] = [];
    if (validate && !validationPassed && validate.failingSummary) {
      parts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
    }
    if (gate.feedback) parts.push(`REVIEW PANEL REJECTED:\n${gate.feedback}`);
    return { done, feedback: parts.length > 0 ? parts.join("\n\n") : null };
  };

  const docsGate = phaseGate("docs");
  const testsGate = phaseGate("tests");
  const implGate = phaseGate("impl");

  const context = [prompt, `Design spec: ${SPEC_PATH} (read it fully).`, researchBlock, planBlock]
    .filter(Boolean)
    .join("\n\n---\n");

  const docsPrompt = [
    context,
    "DOCUMENTATION-DRIVEN DEVELOPMENT — PHASE 1 of 3: DOCS ONLY.",
    "Write the docs that DEFINE the API contract for eve-style agent authoring before any " +
      "code exists. Update the `docs/` source: how you author an agent/ directory " +
      "(agent.ts defineAgent, instructions.md, tools/*.ts defineTool, skills/, subagents/), " +
      "how it compiles to an AgentLike, how the `harness:` discriminator makes CLI adapters " +
      "use the same API, and how workflows/*.tsx stay on smithers CLI conventions. Then " +
      "regenerate the LLM bundles with `pnpm docs:llms` so `check-docs`/`check-llms` pass. " +
      "Do NOT write tests or implementation in this phase.",
  ].join("\n\n---\n");

  const testsPrompt = [
    context,
    "PHASE 2 of 3: TESTS (test-first, real backends, NO mocks).",
    "Write FAILING tests that encode the contract documented in phase 1: a defineAgent that " +
      "compiles an agent/ directory to an AgentLike (instructions.md -> system prompt, " +
      "tools/*.ts -> defineTool, filename -> tool name, skills/subagents wired), and the " +
      "`harness:` discriminator resolving to the existing CLI adapter classes. Tests must " +
      "fail for the right reason (feature absent), not from setup errors. Do NOT write " +
      "production implementation in this phase.",
  ].join("\n\n---\n");

  const implPrompt = [
    context,
    "PHASE 3 of 3: IMPLEMENT.",
    "Make the phase-2 tests pass. Fork/vendor eve's authoring & discovery layer only " +
      "(defineAgent, directory loader, defineTool file loader, skills, subagents) and adapt " +
      "its output to smithers' AgentLike; DROP eve's runtime (Vercel Workflows/Sandbox/AI " +
      "Gateway) and resolve models through resolveSdkModel. Keep everything additive and " +
      "non-breaking: existing `.smithers/agents.ts` pools and workflows must be unaffected. " +
      "Keep `pnpm typecheck` and `pnpm test` green.",
  ].join("\n\n---\n");

  return (
    <Workflow name="eve-agent-authoring">
      <Sequence>
        <Task id="research" output={researchOutputSchema} agent={agents.smart}>
          <ResearchPrompt prompt={`${prompt}\n\nRead the design spec at ${SPEC_PATH} and summarize the concrete API surface, the eve fork boundary, and the open questions.`} />
        </Task>

        {/* Plan PANEL: Opus + Codex, synthesized by the moderator (Codex). */}
        <PlanPanel idPrefix="plan" prompt={planPrompt} panelists={panelists} moderator={synthesizer} />

        {/* Phase 1 — DOCS. Sonnet implements, Opus + Codex review. */}
        <ValidationLoop
          idPrefix="docs"
          prompt={docsPrompt}
          implementAgents={agents.cheapFast}
          validateAgents={agents.cheapFast}
          reviewAgents={panelists}
          reviewModerator={synthesizer}
          synthesizeReview
          feedback={docsGate.feedback}
          done={docsGate.done}
          maxIterations={maxIterations}
        />

        {/* Phase 2 — TESTS. */}
        <ValidationLoop
          idPrefix="tests"
          prompt={testsPrompt}
          implementAgents={agents.cheapFast}
          validateAgents={agents.cheapFast}
          reviewAgents={panelists}
          reviewModerator={synthesizer}
          synthesizeReview
          feedback={testsGate.feedback}
          done={testsGate.done}
          maxIterations={maxIterations}
        />

        {/* Phase 3 — IMPLEMENT. */}
        <ValidationLoop
          idPrefix="impl"
          prompt={implPrompt}
          implementAgents={agents.cheapFast}
          validateAgents={agents.cheapFast}
          reviewAgents={panelists}
          reviewModerator={synthesizer}
          synthesizeReview
          feedback={implGate.feedback}
          done={implGate.done}
          maxIterations={maxIterations}
        />
      </Sequence>
    </Workflow>
  );
});
