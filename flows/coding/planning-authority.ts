/** Private composition of captured-evidence model actions over existing authority. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Layer, Option } from "effect"
import * as CapabilitySet from "../../packages/smithers/flows/kernel/src/CapabilitySet.ts"

const restricted = new Set([
  "coding/review-request",
  "coding/draft-plan",
  "coding/select-owner-repair",
  "coding/draft-poc",
  "coding/review-poc",
  "wiki/review-page"
])

const emptyRegistry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

const evidence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    // Implementation.action erases the services captured by its action layer.
    // Read the live host after native authority restoration, and refuse if the
    // required model host was not installed rather than falling back to one.
    const current = yield* Effect.serviceOption(AgentAction.Host)
    if (Option.isNone(current)) {
      return yield* Effect.die(new Error("Evidence model action requires its runtime AgentAction.Host"))
    }
    return yield* effect.pipe(
      Effect.provideService(AgentAction.Host, {
        ...current.value,
        registry: emptyRegistry,
        flows: [],
        implementations: undefined,
        promptRunner: undefined,
        capabilityEnvelope: []
      }),
      CapabilitySet.attenuate([])
    )
  })

/** Apply under these action layers, above the composition's shared table/runtime.
 * Wrapping the executing handlers matters: ModuleAuthority restores the parent
 * Host at invocation and resume, after the action layers were constructed.
 */
export const evidenceOnly = <A, E, R>(actions: Layer.Layer<A, E, R>) =>
  actions.pipe(
    Layer.provide(Layer.mergeAll(
      Layer.effect(FlowRuntime.FlowRuntime)(Effect.map(FlowRuntime.FlowRuntime, (runtime) => ({
        ...runtime,
        register: (flow, handler) =>
          runtime.register(
            flow,
            restricted.has(flow._tag)
              ? (payload, executionId) => evidence(handler(payload, executionId))
              : handler
          )
      }))),
      Layer.effect(Action.Implementations)(Effect.map(Action.Implementations, (table) => ({
        ...table,
        add: (implementation, options) =>
          table.add(
            restricted.has(implementation.name)
              ? { ...implementation, action: (payload) => evidence(implementation.action(payload)) }
              : implementation,
            options
          )
      })))
    ))
  )
