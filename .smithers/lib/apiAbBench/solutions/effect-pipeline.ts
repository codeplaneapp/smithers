// Reference solution (effect arm, task `pipeline`). Proves the harness can score a correct candidate.
import { Schema } from "effect";
import { Smithers } from "smthrs";

const G = Smithers.workflow({ name: "ab-pipeline", input: Schema.Struct({ base: Schema.Number }) });

const double = G.step("double", {
  output: Schema.Struct({ value: Schema.Number }),
  run: ({ input }) => ({ value: input.base * 2 }),
});

const describe = G.step("describe", {
  needs: { double },
  output: Schema.Struct({ label: Schema.String, total: Schema.Number }),
  run: ({ input, double }) => ({ label: `base ${input.base} -> ${double.value + 1}`, total: double.value + 1 }),
});

export const workflow = G.from(G.sequence(double, describe));
