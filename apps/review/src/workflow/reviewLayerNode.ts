/**
 * The durable review composition: the workflow over the Node runtime.
 *
 * Kept apart from `reviewLayer.ts` because `@smthrs/flows/NodeRuntime` opens
 * `node:sqlite` when it is imported. A caller that wants the in-process root
 * never pays that import, and a runtime without the module (Bun 1.3) can still
 * load the shared declarations and run the scripted tests.
 *
 * @since 1.0.0
 */
import * as Agent from "@smthrs/agent/Agent"
import type * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Layer from "effect/Layer"
import { agentHost, agentPolicy, declarations } from "./reviewLayer.ts"
import { modelCallRules } from "./reviewSeatResolver.ts"

/**
 * Builds the review workflow over the durable Node runtime.
 *
 * The run's state lives in `filename`, so a review that dies mid-fan-out
 * resumes into the batches it had already settled instead of re-asking their
 * seats.
 *
 * `rules` is what makes the run able to call a model at all. The durable host
 * guards its HTTP client with the capability kernel, which asks `model:call`
 * on `<host>/<model id>` for every model request; a host built without a rule
 * for it parks the first request on a permission and, with `attended: false`,
 * nobody ever answers. `layerMemory` never meets the check because a scripted
 * seat builds no request, which is why this grant has to be tested through a
 * real route.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerNode = (options: {
  readonly filename: string
  readonly seats: Layer.Layer<SeatResolver.SeatResolver>
  /** The environment the reachable model hosts are read from. */
  readonly environment?: Readonly<Record<string, string | undefined>>
}) => {
  const environment = options.environment ?? process.env
  return NodeRuntime.layerHost(
    {
      filename: options.filename,
      owner: { hostId: "smithers-review" },
      rules: modelCallRules(environment)
    },
    declarations.pipe(
      Layer.provideMerge(Layer.mergeAll(agentHost(environment), options.seats, Agent.layer)),
      Layer.provideMerge(agentPolicy),
      Layer.provideMerge(Agent.layerDefaults),
      Layer.provideMerge(Action.layerImplementations)
    )
  )
}

/** Refuses a composition root that still owes a service. */
type Complete<L> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>] ? [R] extends [never] ? true : false
  : false

/** Fails to compile unless its argument is `true`. */
type Expect<T extends true> = T

/**
 * The durable review runtime supplies every service the workflow can require.
 *
 * @category models
 * @since 1.0.0
 */
export type NodeCompositionRootIsComplete = Expect<Complete<ReturnType<typeof layerNode>>>
