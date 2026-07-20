// smithers-display-name: E2E Monitor Failure
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  step: z.object({ label: z.string() }),
});

export default smithers(() => (
  <Workflow name="e2e-monitor-failure">
    <Sequence id="collapsed-failure-container">
      <Task id="before-failure" output={outputs.step}>
        {{ label: "completed before failure" }}
      </Task>
      <Sequence id="nested-failure-container">
        <Task id="deterministic-failure" output={outputs.step} retries={0}>
          {async () => {
            throw new Error("deterministic monitor failure");
          }}
        </Task>
      </Sequence>
    </Sequence>
  </Workflow>
));
