// Reference solution (effect arm, task `reuse`).
import { Schema } from "effect";
import { Smithers } from "smithers-orchestrator";

const G = Smithers.workflow({ name: "ab-reuse", input: Schema.Struct({ base: Schema.Number }) });

const valueSchema = Schema.Struct({ value: Schema.Number });
const labelSchema = Schema.Struct({ value: Schema.Number, tier: Schema.String });

const makeShard = (multiplier: number) => {
  const compute = G.step("compute", {
    output: valueSchema,
    run: ({ input }) => ({ value: input.base * multiplier }),
  });
  const label = (tier: string) =>
    G.step(`label-${tier}`, {
      needs: { compute },
      output: labelSchema,
      run: ({ compute }) => ({ value: compute.value, tier }),
    });
  return G.sequence(
    compute,
    G.match(compute, { when: (value) => value.value >= 12, then: label("high"), else: label("low") }),
  );
};

export const workflow = G.from(G.sequence(G.scope("alpha", makeShard(2)), G.scope("beta", makeShard(3))));
