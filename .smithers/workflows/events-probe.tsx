// smithers-display-name: Events probe
// smithers-system: true
// smithers-source: agent-free liveness probe — emits a steady stream of node lifecycle events so gateway/monitor streaming can be verified end to end.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const tickSchema = z.object({
  tickNo: z.number().int(),
  atMs: z.number().int(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  epTick: tickSchema,
});

const TICKS = [1, 2, 3, 4, 5, 6];
const TICK_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default smithers(() => (
  <Workflow name="events-probe">
    <Sequence>
      {TICKS.map((tickNo) => (
        <Task key={"tick-" + tickNo} id={"tick-" + tickNo} output={outputs.epTick}>
          {async () => {
            await sleep(TICK_DELAY_MS);
            return { tickNo, atMs: Date.now() };
          }}
        </Task>
      ))}
    </Sequence>
  </Workflow>
));
