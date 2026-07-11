// Example only: ralph is preserved here instead of being installed by default.
// It remains an example because the default init pack is deliberately curated; run `smithers graph examples/init-pack/ralph.tsx` after copying its imports.
// Copy this implementation and its referenced .smithers prompts/components/UI/lib files into a project to use it.
// smithers-source: seeded
// smithers-display-name: Ralph
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const ralphOutputSchema = z.looseObject({
  summary: z.string(),
});

const inputSchema = z.object({
  prompt: z.string().default("Continue working on the current task."),
});

const { Workflow, Task, Loop, smithers } = createSmithers({
  input: inputSchema,
  ralph: ralphOutputSchema,
});

export default smithers((ctx) => (
  <Workflow name="ralph">
    <UI entry="../ui/ralph.tsx" title={"Ralph"} />
    <Loop until={false} maxIterations={Infinity}>
      <Task id="ralph" output={ralphOutputSchema} agent={agents.implement}>
        {ctx.input.prompt}
      </Task>
    </Loop>
  </Workflow>
));
