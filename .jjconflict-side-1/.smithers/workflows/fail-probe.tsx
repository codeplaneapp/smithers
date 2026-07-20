// smithers-source: authored
// smithers-display-name: Fail Probe
// smithers-description: Deliberately failing workflow to smoke-test the post-failure auto-trigger. Safe to delete.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const { Workflow, Task, smithers, outputs } = createSmithers({
  out: z.object({ ok: z.boolean() }),
});

export default smithers(() => (
  <Workflow name="fail-probe">
    <Task id="boom" output={outputs.out} retries={0}>
      {() => {
        throw new Error("fail-probe: intentional failure to exercise the post-failure auto-trigger");
      }}
    </Task>
  </Workflow>
));
