/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Workflow, Task } from "smithers-orchestrator";
import { z } from "zod";
const { smithers, outputs } = createSmithers({ result: z.object({ summary: z.string(), prompt: z.string().nullable() }) });
export default smithers((ctx) => (
  <Workflow name="fixture-workflow">
    <Task id="write-result" output={outputs.result}>
      {{ summary: "fixture workflow ran", prompt: ctx.input.prompt ?? null }}
    </Task>
  </Workflow>
));
