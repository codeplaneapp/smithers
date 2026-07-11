// Example only: research is preserved here instead of being installed by default.
// It remains an example because the default init pack is deliberately curated; run `smithers graph examples/init-pack/research.tsx` after copying its imports.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Research
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import ResearchPrompt from "../prompts/research.mdx";

const researchOutputSchema = z.looseObject({
  summary: z.string(),
  keyFindings: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  prompt: z.string().default("Research the given topic."),
});

const { Workflow, Task, smithers } = createSmithers({
  input: inputSchema,
  research: researchOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="research">
    <UI entry="../ui/research.tsx" title={"Research"} />
    <Task id="research" output={researchOutputSchema} agent={agents.research}>
      <ResearchPrompt prompt={ctx.input.prompt} />
    </Task>
  </Workflow>
));
