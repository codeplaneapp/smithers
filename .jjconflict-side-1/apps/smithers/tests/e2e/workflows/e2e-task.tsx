// smithers-display-name: E2E Task
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

// A static, no-agent workflow: the task returns a literal value and completes
// instantly. CI-safe (no agent CLI). Seeds a COMPLETED run for the UI to list.
const { Workflow, Task, smithers, outputs } = createSmithers({
  result: z.object({ value: z.number() }),
});

export default smithers(() => (
  <Workflow name="e2e-task">
    <Task id="compute" output={outputs.result}>
      {async () => ({ value: 42 })}
    </Task>
  </Workflow>
));
