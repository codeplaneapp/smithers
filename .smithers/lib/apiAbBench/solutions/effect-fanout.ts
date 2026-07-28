// Reference solution (effect arm, task `fanout`).
import { Schema } from "effect";
import { Smithers } from "smithers-orchestrator";

const G = Smithers.workflow({ name: "ab-fanout", input: Schema.Struct({ items: Schema.Array(Schema.Number) }) });

const laneSchema = Schema.Struct({ item: Schema.Number, value: Schema.Number });

const attempts = [1, 2, 3].map((item) =>
  G.step(`attempt-${item}`, { output: laneSchema, run: () => ({ item, value: item * 10 }) }),
);

const lanes = attempts.map((attempt, index) =>
  G.loop({
    id: `lane-${index + 1}-loop`,
    children: attempt,
    maxIterations: 3,
    onMaxReached: "return-last",
    until: (outputs) => Boolean(outputs[`attempt-${index + 1}`]),
  }),
);

const collect = G.step("collect", {
  needs: { a1: attempts[0], a2: attempts[1], a3: attempts[2] },
  output: Schema.Struct({ items: Schema.Array(laneSchema), total: Schema.Number }),
  run: ({ a1, a2, a3 }) => ({ items: [a1, a2, a3], total: a1.value + a2.value + a3.value }),
});

export const workflow = G.from(G.sequence(G.parallel(...lanes, { maxConcurrency: 3 }), collect));
