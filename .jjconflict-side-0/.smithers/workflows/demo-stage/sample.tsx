// smithers-source: authored
// smithers-display-name: Demo Sample (Ship It)
/** @jsxImportSource smithers-orchestrator */
//
// Tiny 3-task workflow the autonomous demo runs LIVE to show crash-resume.
// Designed so:
//   - research finishes fast      (~1.2s)
//   - plan is slow on purpose      (~7s — gives the demo a window to SIGTERM)
//   - implement is fast            (~1.2s)
// If you run it through, total wall time is ~10s.

import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const result = z.object({ message: z.string() });

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  research: result,
  plan: result,
  implement: result,
});

const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

export default smithers(() => (
  <Workflow name="ship-it">
    <Sequence>
      <Task id="research" output={outputs.research}>
        {async () => {
          await wait(1.2);
          return { message: "scanned repo · found 3 relevant files" };
        }}
      </Task>
      <Task id="plan" output={outputs.plan}>
        {async () => {
          // Intentionally slow — the demo crashes the process during this task
          // so we can show that resume re-runs incomplete work.
          await wait(7);
          return { message: "drafted implementation plan" };
        }}
      </Task>
      <Task id="implement" output={outputs.implement}>
        {async () => {
          await wait(1.2);
          return { message: "applied patches · all tests green" };
        }}
      </Task>
    </Sequence>
  </Workflow>
));
