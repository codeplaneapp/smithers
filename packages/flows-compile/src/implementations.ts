import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { actionFor, type Tier } from "./actions.ts";
import type { CompiledWorkflow } from "./types.ts";
import { CompileError } from "./types.ts";

const TIERS: readonly Tier[] = ["sealed", "compensable", "irreversible"];

/**
 * The body of a compiled compute step: the task's own `computeFn`.
 *
 * The plan carries the function's source digest, never the function, so the
 * compilation that produced the plan is also what hands the implementation its
 * bodies. A dispatch naming a node this compilation did not produce is a wiring
 * error and dies rather than failing, matching the action's `Never` error
 * schema.
 */
export const computeImplementation =
  (compiled: CompiledWorkflow): ((payload: { readonly nodeId: string }) => Effect.Effect<unknown>) =>
  (payload) =>
    Effect.suspend(() => {
      const fn = compiled.computeFns.get(payload.nodeId);
      if (fn === undefined) {
        return Effect.die(new CompileError("unknown_compute_node", `No computeFn compiled for node ${payload.nodeId}`));
      }
      return Effect.promise(async () => await fn());
    });

/**
 * The body of a compiled static step: the sealed constant it was planned with.
 *
 * The value is in the payload, so the step is a pure function of its own
 * declaration and replays without consulting anything.
 */
export const staticImplementation = (payload: { readonly value: unknown }): Effect.Effect<unknown> =>
  Effect.succeed(payload.value);

const mergeAll = (layers: readonly Layer.Layer<never, never, never>[]): Layer.Layer<never, never, never> =>
  layers.reduce((left, right) => Layer.merge(left, right) as Layer.Layer<never, never, never>);

/**
 * Implementation layers for every compute, human, and static action tier.
 *
 * Agent steps are deliberately absent: an `AgentStep` is run by the harness,
 * and wiring that host is stage 1.4's work, not the compiler's.
 */
export const implementationLayers = (compiled: CompiledWorkflow): Layer.Layer<never, never, never> => {
  const compute = computeImplementation(compiled);
  const layers = TIERS.flatMap((tier) => [
    toLayer(actionFor("compute", tier), compute),
    toLayer(actionFor("human", tier), compute),
    toLayer(actionFor("static", tier), staticImplementation),
  ]);
  return mergeAll(layers);
};

type Layerable = {
  readonly toLayer: (execute: (payload: never) => Effect.Effect<unknown>) => Layer.Layer<never, never, never>;
};

const toLayer = (
  declaration: ReturnType<typeof actionFor>,
  execute: (payload: never) => Effect.Effect<unknown>,
): Layer.Layer<never, never, never> => (declaration as unknown as Layerable).toLayer(execute);
