// smithers-source: user
// smithers-display-name: Research Plan Implement
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { implementer, panelists } from "../components/roles";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";
import { PlanPanel, planOutputSchema, planSynthesisSchema } from "../components/PlanPanel";
import ResearchPrompt from "../prompts/research.mdx";

const researchOutputSchema = z.looseObject({
  summary: z.string(),
  keyFindings: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  prompt: z.string().default("Implement the requested change."),
  tdd: z.boolean().default(false),
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
  const prompt = ctx.input.prompt;
  const tdd = ctx.input.tdd;

  const research = ctx.outputMaybe("research", { nodeId: "research" });
  // The plan is the synthesized output of the plan panel's moderator.
  const plan = ctx.outputMaybe("planSynthesis", { nodeId: "plan-moderator" });

  // Enrich plan prompt with research findings (fed to the plan panelists)
  const planPromptParts = [
    prompt,
    research
      ? `RESEARCH FINDINGS:\n${research.summary}\n\nKey findings:\n${research.keyFindings.map((f: string) => `- ${f}`).join("\n")}`
      : null,
    tdd
      ? "IMPORTANT: Write tests FIRST. The plan MUST start with test steps before any implementation steps. Follow test-driven development: define expected behavior in tests, then implement to make them pass."
      : null,
  ];
  const planPrompt = planPromptParts.filter(Boolean).join("\n\n---\n");

  // Enrich implement prompt with both research and the synthesized plan
  const implementPrompt = [
    prompt,
    research ? `RESEARCH FINDINGS:\n${research.summary}\n\nKey findings:\n${research.keyFindings.map((f: string) => `- ${f}`).join("\n")}` : null,
    plan ? `IMPLEMENTATION PLAN:\n${plan.summary}\n\nSteps:\n${plan.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}` : null,
    tdd ? "IMPORTANT: Follow the plan's test-first approach. Write or update tests before implementing production code." : null,
  ].filter(Boolean).join("\n\n---\n");

  // Validation loop feedback
  const validate = ctx.latest("validate", "impl:validate");

  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const gate = reviewGate(ctx, "impl:review-moderator");
  const done = validationPassed && gate.approved;

  const feedbackParts: string[] = [];
  if (validate && !validationPassed && validate.failingSummary) {
    feedbackParts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  if (gate.feedback) {
    feedbackParts.push(`REVIEW PANEL REJECTED:\n${gate.feedback}`);
  }
  const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n\n") : null;

  return (
    <Workflow name="research-plan-implement">
      <UI entry="../ui/research-plan-implement.tsx" title={"Research Plan Implement"} />
      <Sequence>
        <Task id="research" output={researchOutputSchema} agent={agents.research}>
          <ResearchPrompt prompt={prompt} />
        </Task>
        <PlanPanel idPrefix="plan" prompt={planPrompt} />
        <ValidationLoop
          idPrefix="impl"
          prompt={implementPrompt}
          implementAgents={implementer}
          validateAgents={agents.midTier}
          reviewAgents={panelists}
          synthesizeReview
          feedback={feedback}
          done={done}
          maxIterations={3}
        />
      </Sequence>
    </Workflow>
  );
});
