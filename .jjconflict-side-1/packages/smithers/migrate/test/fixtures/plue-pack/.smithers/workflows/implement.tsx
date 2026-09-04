// smithers-source: seeded
// smithers-display-name: Implement
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { Review, reviewOutputSchema } from "../components/Review";
import ResearchPrompt from "../prompts/research.mdx";
import PlanPrompt from "../prompts/plan.mdx";
import ImplementPrompt from "../prompts/implement.mdx";
import ValidatePrompt from "../prompts/validate.mdx";

const researchOutputSchema = z.object({
  summary: z.string(),
  keyFindings: z.array(z.string()).default([]),
}).passthrough();

const planOutputSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
}).passthrough();

const inputSchema = z.object({
  prompt: z.string().default("Implement the requested change."),
});

const { Workflow, Task, Sequence, smithers } = createSmithers({
  input: inputSchema,
  research: researchOutputSchema,
  plan: planOutputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
});

export default smithers((ctx) => {
  const prompt = ctx.input.prompt;
  return (
    <Workflow name="implement">
      <Sequence>
        <Task id="research" output={researchOutputSchema} agent={agents.smartTool}>
          <ResearchPrompt prompt={prompt} />
        </Task>
        <Task id="plan" output={planOutputSchema} agent={agents.smart}>
          <PlanPrompt prompt={prompt} />
        </Task>
        <Task id="implement" output={implementOutputSchema} agent={agents.smart}>
          <ImplementPrompt prompt={prompt} />
        </Task>
        <Task id="validate" output={validateOutputSchema} agent={agents.cheapFast}>
          <ValidatePrompt prompt={prompt} />
        </Task>
        <Review idPrefix="review" prompt={prompt} agents={agents.smart} />
      </Sequence>
    </Workflow>
  );
});
