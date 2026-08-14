// Reference solution (jsx arm, task `reuse`).
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod";

const { Workflow, Task, Sequence, Branch, smithers, outputs } = createSmithers({
  input: z.object({ base: z.number() }),
  value: z.object({ value: z.number() }),
  result: z.object({ value: z.number(), tier: z.string() }),
});

function Shard({
  scope,
  multiplier,
  base,
  computed,
}: {
  scope: string;
  multiplier: number;
  base: number;
  computed?: { value: number };
}) {
  const value = computed?.value ?? 0;
  return (
    <Sequence>
      <Task id={`${scope}.compute`} output={outputs.value}>
        {() => ({ value: base * multiplier })}
      </Task>
      {computed ? (
        <Branch
          if={value >= 12}
          then={
            <Task id={`${scope}.label-high`} output={outputs.result}>
              {() => ({ value, tier: "high" })}
            </Task>
          }
          else={
            <Task id={`${scope}.label-low`} output={outputs.result}>
              {() => ({ value, tier: "low" })}
            </Task>
          }
        />
      ) : null}
    </Sequence>
  );
}

export default smithers(
  (ctx) => (
    <Workflow name="ab-reuse">
      <Shard
        scope="alpha"
        multiplier={2}
        base={ctx.input.base}
        computed={ctx.outputMaybe(outputs.value, { nodeId: "alpha.compute" })}
      />
      <Shard
        scope="beta"
        multiplier={3}
        base={ctx.input.base}
        computed={ctx.outputMaybe(outputs.value, { nodeId: "beta.compute" })}
      />
    </Workflow>
  ),
  { output: outputs.result },
);
