// smithers-display-name: E2E Monitor Live Events
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  step: z.object({ index: z.number(), label: z.string() }),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default smithers(() => (
  <Workflow name="e2e-monitor-live">
    <Sequence id="live-event-sequence">
      {Array.from({ length: 18 }, (_, index) => (
        <Task key={index} id={`live-step-${String(index + 1).padStart(2, "0")}`} output={outputs.step}>
          {async () => {
            await sleep(300);
            return { index, label: `live event ${index + 1}` };
          }}
        </Task>
      ))}
    </Sequence>
  </Workflow>
));
