// smithers-display-name: E2E Monitor Tree
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const { Workflow, Task, Sequence, Parallel, Loop, smithers, outputs } = createSmithers({
  step: z.object({ label: z.string(), attempt: z.number() }),
});

let flakyAttempts = 0;

export default smithers((ctx) => (
  <Workflow name="e2e-monitor">
    <Sequence id="monitor-sequence">
      <Task id="intake" output={outputs.step}>
        {{ label: "seeded intake output", attempt: 0 }}
      </Task>
      <Loop id="review-loop" until={false} maxIterations={2} onMaxReached="return-last">
        <Sequence id="review-iteration">
          <Parallel id="review-fanout" maxConcurrency={2}>
            <Task id="review-api" output={outputs.step}>
              {{ label: "reviewed the API", attempt: ctx.iteration }}
            </Task>
            <Task id="review-tests" output={outputs.step}>
              {{ label: "reviewed the tests", attempt: ctx.iteration }}
            </Task>
          </Parallel>
          <Task id="flaky-check" output={outputs.step} retries={1}>
            {async () => {
              flakyAttempts += 1;
              if (flakyAttempts === 1) throw new Error("deterministic first-attempt failure");
              return { label: "retry recovered", attempt: ctx.iteration };
            }}
          </Task>
        </Sequence>
      </Loop>
      <Task id="publish" output={outputs.step}>
        {{ label: "published monitor fixture", attempt: 0 }}
      </Task>
    </Sequence>
  </Workflow>
));
