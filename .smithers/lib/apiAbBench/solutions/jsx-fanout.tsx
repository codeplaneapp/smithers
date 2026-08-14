// Reference solution (jsx arm, task `fanout`).
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod";

const { Workflow, Task, Parallel, Loop, smithers, outputs } = createSmithers({
  input: z.object({ items: z.array(z.number()) }),
  lane: z.object({ item: z.number(), value: z.number() }),
  result: z.object({ items: z.array(z.object({ item: z.number(), value: z.number() })), total: z.number() }),
});

export default smithers(
  (ctx) => {
    const items = ctx.input.items;
    const lanes = items.map((item) => ctx.outputMaybe(outputs.lane, { nodeId: `attempt-${item}` }));
    const done = lanes.every((lane) => lane !== undefined);
    return (
      <Workflow name="ab-fanout">
        <Parallel maxConcurrency={3}>
          {items.map((item) => (
            <Loop
              key={String(item)}
              id={`lane-${item}-loop`}
              until={ctx.outputMaybe(outputs.lane, { nodeId: `attempt-${item}` }) !== undefined}
              maxIterations={3}
              onMaxReached="return-last"
            >
              <Task id={`attempt-${item}`} output={outputs.lane}>
                {() => ({ item, value: item * 10 })}
              </Task>
            </Loop>
          ))}
        </Parallel>
        {done ? (
          <Task id="collect" output={outputs.result}>
            {() => ({
              items: lanes.map((lane) => ({ item: lane!.item, value: lane!.value })),
              total: lanes.reduce((sum, lane) => sum + lane!.value, 0),
            })}
          </Task>
        ) : null}
      </Workflow>
    );
  },
  { output: outputs.result },
);
