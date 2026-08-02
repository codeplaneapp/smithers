// Example only: research is preserved here instead of being installed by default.
// Research a topic and return grounded findings and next steps. It remains an example because the curated init pack installs only authoring and documentation workflows. Run `smithers graph examples/init-pack/research.tsx` after copying it into a project.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Research
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { createSmithers } from "smthrs";
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
