/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const output = z.object({ value: z.number() });
const { Loop, Task, Workflow, smithers, outputs } = createSmithers({ output });

export default smithers((ctx) => (
  <Workflow name="nested-loop-fixture">
    <Loop id="outer" until={false} maxIterations={2}>
      <Loop id="inner" until={false} maxIterations={2}>
        <Task id="work" output={outputs.output}>{() => ({ value: ctx.iteration })}</Task>
      </Loop>
    </Loop>
  </Workflow>
));
