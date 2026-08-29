/**
 * The authoring surface for a model-backed step.
 *
 * `packages/flow/src/Graph.ts` records the decision this module is built on:
 * the model-shaped `Dynamic` node did not come across, because **a model call
 * is an ordinary action**. That decision is right and it left a hole. The
 * runtime to run one already existed — {@link module:Agent} assembles the whole
 * cell loop and returns its `Stream<AgentEvent>` — but the only ways to reach it
 * were a markdown flow run whole by {@link module:AgentSession}, where the agent
 * *is* the flow, or a hand-registered flow body at a composition root. Neither
 * is something a workflow author can write as one step among other steps.
 *
 * {@link make} is that missing constructor. It declares an ordinary
 * `Action` — same tag, same payload schema, same `.call()`, same plan node,
 * same durable replay — and ships the implementation with it: seat, system
 * teaching, a prompt built from the step payload, and a declared output schema
 * that the answer must satisfy. Nothing about the graph changes; what changes
 * is that the author no longer supplies the implementation, because a model
 * call has exactly one.
 *
 * Structured output is enforced at this boundary by
 * `@smthrs/harness/StructuredOutput`, following
 * `docs/specs/Concepts/Structured Output.md`: the declared schema is rendered
 * into the run's system teaching, the final `complete` transition's `output` is
 * decoded by it, and a decode miss spends a correction slot on a re-prompt
 * before it becomes a typed `StructuredOutputFailure`.
 *
 * The host half is two services. {@link Host} carries the registry, the sandbox
 * budget, and the catalog every model-backed action in a composition shares;
 * `SeatResolver` turns the declared seat string into a live model. An author's
 * declaration therefore names no model credentials and no host wiring, and a
 * test swaps the whole model for a scripted one by providing a different
 * `SeatResolver`.
 *
 * Reference consulted: `reference/effect`
 * `packages/effect/src/unstable/ai/LanguageModel.ts` (`generateObject`) for the
 * declare-schema / decode-with-typed-failure shape, and `reference/opencode`
 * `packages/llm` for keeping provider resolution behind a host-supplied seam
 * rather than in the authoring call. Deviation from effect: `generateObject`
 * sends the schema as a provider `responseFormat`; `@smthrs/model` has no such
 * request field and the cell loop's answer is a `Cell.Complete` string, so the
 * schema travels in the prompt and is enforced locally.
 *
 * @since 0.1.0
 */
import type * as Capability from "@smthrs/capability/Capability"
import { Action, type Flow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as CellCalls from "@smthrs/harness/CellCalls"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import type * as Steering from "@smthrs/harness/Steering"
import * as StructuredOutput from "@smthrs/harness/StructuredOutput"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type { FlowsHooks, PluginInput } from "@smthrs/plugin"
import type { FlowsConfig } from "@smthrs/plugin/Config"
import { PluginError } from "@smthrs/plugin/PluginError"
import type * as Registry from "@smthrs/registry/Registry"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Agent } from "./Agent.ts"
import { EventSink } from "./EventSink.ts"
import * as Seat from "./Seat.ts"
import { SeatResolver } from "./SeatResolver.ts"

/**
 * The host composition every model-backed action in a run shares.
 *
 * This is half of the seam a test replaces: an in-memory registry here and a
 * scripted `Model` behind `SeatResolver` are the whole difference between a
 * deterministic run and a live one. Nothing here is declared by the author, and
 * nothing the author declares can widen it — the capability envelope and the
 * executable catalog are the host's.
 *
 * @category models
 * @since 0.1.0
 */
export interface Host {
  /** The catalog a cell is shown and the registry its calls resolve against. */
  readonly registry: Registry.Registry
  /** The explicit sandbox budget every cell runs under. Never unlimited. */
  readonly limits: Sandbox.Limits
  /** Host executable-flow sources composed into every run's catalog. */
  readonly flows?: ReadonlyArray<FlowBinding.Source> | undefined
  /** Host implementations for module-backed flows, keyed by flow name. */
  readonly implementations?: ReadonlyMap<string, CellCalls.Implementation> | undefined
  readonly plugins?: PluginInput<FlowsHooks> | undefined
  readonly config?: FlowsConfig | undefined
  /** Stable system teaching placed ahead of every action's own. */
  readonly system?: ReadonlyArray<string> | undefined
  readonly capabilityEnvelope?: ReadonlyArray<Capability.CapabilityPattern> | undefined
  readonly maxFrames?: number | undefined
}

/**
 * Context service for the shared host composition.
 *
 * @category services
 * @since 0.1.0
 */
export const Host: Context.Service<Host, Host> = Context.Service(
  "@smthrs/agent/AgentAction/Host"
)

/**
 * Constructs a host composition value.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeHost = (host: Host): Host => Host.of(host)

/**
 * Provides one host composition to every model-backed action in a run.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHost = (host: Host): Layer.Layer<Host> => Layer.succeed(Host)(makeHost(host))

/**
 * Everything a model-backed action can fail with.
 *
 * `StructuredOutputFailure` is the one an author handles: the model answered
 * and the answer did not fit the declared schema after its correction budget.
 * `SeatUnresolved` is the host having no model for the declared seat. The other
 * two are the composition failing underneath it.
 *
 * @category models
 * @since 0.1.0
 */
export const AgentFailure = Schema.Union([
  StructuredOutput.StructuredOutputFailure,
  Seat.SeatUnresolved,
  HarnessError,
  PluginError
])

/**
 * Everything a model-backed action can fail with.
 *
 * @category models
 * @since 0.1.0
 */
export type AgentFailure = typeof AgentFailure.Type

/**
 * The schema a payload declaration resolves to: a field record becomes a
 * `Schema.Struct`, a schema stays itself. The same widening `Flow.make` and
 * `Action.make` perform, restated because neither exports it.
 *
 * @category models
 * @since 0.1.0
 */
export type PayloadSchemaOf<Payload extends Schema.Struct.Fields | Flow.AnyStructSchema> = Payload extends
  Schema.Struct.Fields ? Schema.Struct<Payload> : Payload

/**
 * What an author declares about one model-backed step.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options<
  Payload extends Schema.Struct.Fields | Flow.AnyStructSchema,
  Output extends Schema.Top
> {
  /** The step's typed input, exactly as `Action.make` takes it. */
  readonly payload: Payload
  /** The schema the answer must satisfy. Rendered into the prompt and enforced. */
  readonly output: Output
  /**
   * The seat id the host's `SeatResolver` resolves into a live model. It is an
   * opaque string here: the resolver owns the vocabulary, so
   * `anthropic:claude-sonnet-4-5`, a bare model id, and a logical name like
   * `reviewer` are all legal declarations.
   */
  readonly seat: string
  /** The task, built from the decoded payload. */
  readonly prompt: (payload: PayloadSchemaOf<Payload>["Type"]) => string
  /** Stable system teaching for this step, after the host's and before the schema's. */
  readonly system?: ReadonlyArray<string> | undefined
  /**
   * How many times a decode miss may be re-prompted before the step fails.
   *
   * One by default, which matches the harness's existing "correct once, then
   * report" posture. Zero declares that a first miss is terminal.
   */
  readonly corrections?: number | undefined
  readonly modelParams?: ModelRequest.GenerationParams | undefined
  readonly maxFrames?: number | undefined
}

/**
 * Raised synchronously when an action declaration has an unbounded correction
 * budget.
 *
 * @category errors
 * @since 0.1.0
 */
export class InvalidCorrectionBudget extends Schema.TaggedError<InvalidCorrectionBudget>()(
  "flows/agent/InvalidCorrectionBudget",
  {
    corrections: Schema.Number,
    message: Schema.String
  }
) {}

/**
 * A declared model-backed action, plus the layer that implements it.
 *
 * The declaration half is an ordinary `Action.Declared`: `.call()` records the
 * same plan node any other action records. The {@link AgentAction.layer} half
 * is what {@link make} adds — an author never writes `toLayer` for a model
 * call, because there is only one implementation and it ships here.
 *
 * @category models
 * @since 0.1.0
 */
export interface AgentAction<
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Output extends Schema.Top
> extends Action.Declared<Tag, Payload, Output, typeof AgentFailure> {
  readonly layer: Layer.Layer<
    Action.Requirement<Tag>,
    never,
    | Agent
    | FlowRuntime.FlowRuntime
    | Host
    | Sandbox.Sandbox
    | SeatResolver
    | Steering.Source
    | Crypto.Crypto
    | Payload["DecodingServices"]
    | Payload["EncodingServices"]
    | Output["DecodingServices"]
    | Output["EncodingServices"]
  >
}

const completedOutput = (
  events: ReadonlyArray<AgentEvent.AgentEvent>
): string | undefined => {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event._tag === "transition-applied" && event.transition._tag === "complete") {
      return event.transition.output
    }
  }
  return undefined
}

/**
 * Declares a model-backed action and ships its implementation.
 *
 * The returned value is used exactly like any other declared action — `.call()`
 * in a flow body, `.layer` in the composition — with one difference: the layer
 * is already written. What it does is resolve the seat through `SeatResolver`,
 * run one agent loop through {@link module:Agent} inside the current flow
 * execution, and decode the run's final answer with the declared output schema,
 * spending {@link Options.corrections} re-prompts before it reports a typed
 * `StructuredOutputFailure`.
 *
 * @example
 * ```ts
 * import * as AgentAction from "@smthrs/agent/AgentAction"
 * import * as Schema from "effect/Schema"
 *
 * const Research = AgentAction.make("docs/Research", {
 *   payload: { topic: Schema.String },
 *   output: Schema.Struct({ summary: Schema.String }),
 *   seat: "anthropic:claude-sonnet-4-5",
 *   system: ["You are a research assistant."],
 *   prompt: ({ topic }) => `Research ${topic}.`
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  const Tag extends string,
  Payload extends Schema.Struct.Fields | Flow.AnyStructSchema,
  Output extends Schema.Top
>(
  tag: Tag,
  options: Options<Payload, Output>
): AgentAction<Tag, PayloadSchemaOf<Payload>, Output> => {
  const limit = options.corrections ?? 1
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new InvalidCorrectionBudget({
      corrections: limit,
      message: "AgentAction corrections must be a non-negative safe integer"
    })
  }
  type PayloadSchema = PayloadSchemaOf<Payload>
  const declared = Action.make(tag, {
    payload: options.payload,
    success: options.output,
    error: AgentFailure
  }) as unknown as Action.Declared<Tag, PayloadSchema, Output, typeof AgentFailure>

  const execute = (payload: PayloadSchema["Type"]) =>
    Effect.gen(function*() {
      const host = yield* Host
      const seats = yield* SeatResolver
      const agent = yield* Agent
      const instance = yield* FlowRuntime.FlowInstance
      // Resolved once, before the first attempt, and asked nothing further. A
      // composition either equips its steps with somewhere to send events as
      // they happen or it does not, and the absence is the buffered behavior
      // this action has always had rather than a failure.
      const sink = yield* Effect.serviceOption(EventSink)
      const observe = Option.match(sink, {
        onNone: () => (_event: AgentEvent.AgentEvent): Effect.Effect<void> => Effect.void,
        onSome: (service) => service.emit
      })
      const seat = yield* seats.resolve(options.seat)
      const task = options.prompt(payload)
      const system = [
        ...(host.system ?? []),
        ...(options.system ?? []),
        StructuredOutput.instructions(options.output)
      ]

      // One attempt is one whole cell run. The correction re-prompt is a NEW
      // run under a distinct session, so its sealed step keys differ from the
      // attempt it is correcting and a replay reproduces both rather than
      // collapsing them onto one recorded model call.
      const attempt = (
        correction: number,
        prompt: string
      ): Effect.Effect<
        Output["Type"],
        AgentFailure,
        | FlowRuntime.FlowRuntime
        | FlowRuntime.FlowInstance
        | Sandbox.Sandbox
        | Steering.Source
        | Crypto.Crypto
        | Output["DecodingServices"]
      > =>
        Effect.gen(function*() {
          const events: Array<AgentEvent.AgentEvent> = []
          yield* agent.run({
            session: `${instance.executionId}/${tag}#${correction}`,
            seat,
            prompt,
            system,
            registry: host.registry,
            flows: host.flows,
            implementations: host.implementations,
            plugins: host.plugins,
            config: host.config,
            modelParams: options.modelParams,
            capabilityEnvelope: host.capabilityEnvelope,
            limits: host.limits,
            maxFrames: options.maxFrames ?? host.maxFrames
          }).pipe(
            // The buffer is what the decode reads, so it is filled first and
            // the sink is handed the event afterwards: a sink that fails to
            // return still leaves the run's own record of the event complete.
            Stream.runForEach((event) =>
              Effect.suspend(() => {
                events.push(event)
                return observe(event)
              })
            )
          )
          const answer = completedOutput(events)
          if (answer === undefined) {
            return yield* new HarnessError({
              code: "model_failed",
              message: `The agent action "${tag}" ended without a completed answer`
            })
          }
          return yield* StructuredOutput.decode(options.output, answer, {
            corrections: correction,
            limit
          }).pipe(
            Effect.catchTag("/harness/StructuredOutputFailure", (failure) =>
              correction >= limit
                ? Effect.fail(failure)
                : attempt(
                  correction + 1,
                  `${task}\n\n${StructuredOutput.correction(failure)}`
                ))
          )
        })

      return yield* attempt(0, task)
    })

  return {
    ...declared,
    layer: declared.toLayer(execute)
  }
}
