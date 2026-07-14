/** @jsxImportSource smithers-orchestrator */
import { Loop, Task, Workflow, smithers } from "smithers-orchestrator";
import { z } from "zod";

const output = z.object({ value: z.number() });

export default smithers((ctx) => (
  <Workflow name="nested-loop-fixture">
    <Loop id="outer" until={false} maxIterations={2}>
      <Loop id="inner" until={false} maxIterations={2}>
        <Task id="work" output={output}>{() => ({ value: ctx.iteration })}</Task>
      </Loop>
    </Loop>
  </Workflow>
));
