// Reference solution (jsx arm, task `pipeline`). Proves the harness can score a correct candidate.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: z.object({ base: z.number() }),
  double: z.object({ value: z.number() }),
  result: z.object({ label: z.string(), total: z.number() }),
});

export default smithers(
  (ctx) => {
    const double = ctx.outputMaybe(outputs.double, { nodeId: "double" });
    const total = double ? double.value + 1 : 0;
    return (
      <Workflow name="ab-pipeline">
        <Sequence>
          <Task id="double" output={outputs.double}>
            {() => ({ value: ctx.input.base * 2 })}
          </Task>
          {double ? (
            <Task id="describe" output={outputs.result}>
              {() => ({ label: `base ${ctx.input.base} -> ${total}`, total })}
            </Task>
          ) : null}
        </Sequence>
      </Workflow>
    );
  },
  { output: outputs.result },
);
