// smithers-source: user
// smithers-display-name: Ralph
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { createSmithers } from "smthrs";
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
