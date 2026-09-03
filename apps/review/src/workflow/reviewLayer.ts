/**
 * The compositions a review run needs: one for a real host, one for a test.
 *
 * The split is one seam wide. Everything above it — the flows, the actions, the
 * cell loop, the structured-output boundary — is identical in both. What
 * changes is where the run's state lives (a SQLite file or the process) and
 * what a declared seat resolves to (a live provider route or a scripted model).
 *
 * This module holds the shared declarations and the in-process root. The
 * durable root lives in `reviewLayerNode.ts`, because building it imports
 * `@smthrs/flows/NodeRuntime`, which opens `node:sqlite` at import time; a
 * test that only wants the in-process root has to be loadable on a runtime
 * without that module.
 *
 * @since 1.0.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  applyVerdictsLayer,
  finalizeReviewLayer,
  mergeFileBatchLayer,
  prepareReviewLayer,
  renderWalkthroughLayer
} from "./reviewActions.ts"
import { NarrateChanges, QuizChanges, ReviewFile, VerifyFindings } from "./reviewAgentActions.ts"
import { NarrateReview, Review, ReviewFiles, VerifyReview } from "./reviewFlow.ts"
import { modelCallEnvelope } from "./reviewSeatResolver.ts"

/**
 * Every action implementation and flow registration the review workflow needs,
 * before the agent host and the engine are supplied.
 *
 * @since 1.0.0
 * @category layers
 */
export const declarations = Layer.mergeAll(
  prepareReviewLayer,
  mergeFileBatchLayer,
  finalizeReviewLayer,
  applyVerdictsLayer,
  renderWalkthroughLayer,
  ReviewFile.layer,
  VerifyFindings.layer,
  NarrateChanges.layer,
  QuizChanges.layer,
  Interpreter.layer(Review),
  Interpreter.layer(ReviewFiles),
  Interpreter.layer(VerifyReview),
  Interpreter.layer(NarrateReview)
)

/**
 * The agent host: an empty catalog, an explicit cell budget, and the one
 * capability a review actually exercises.
 *
 * The review seats answer from the prompt they were given — every diff a
 * reviewer needs is embedded by `buildNativeReviewPrompt` — so the host offers
 * no tool flows. A cell that tries to reach for one finds an empty registry
 * rather than an unbounded surface on the repository under review.
 *
 * The envelope is the run's complete authority claim, so it names the model
 * hosts the seats can dial and nothing else. It is derived from the same
 * environment the seat resolver reads, which keeps the claim and the grant
 * rules in {@link layerNode} describing one set of origins.
 *
 * @since 1.0.0
 * @category layers
 */
export const agentHost = (environment: Readonly<Record<string, string | undefined>> = process.env) =>
  AgentAction.layerHost({
    registry: Registry.makeNoop({
      list: () => Effect.succeed([]),
      visible: () => Effect.succeed([]),
      getOption: () => Effect.succeed(Option.none())
    }),
    limits: { calls: 8 },
    capabilityEnvelope: modelCallEnvelope(environment),
    maxFrames: 4
  })

/**
 * Review calls real providers, so reset-bearing refusals park and resume. The
 * review launcher has no approved plan budget envelope, so a numeric ceiling
 * here would be one no reviewer selected.
 */
// eslint-disable-next-line no-restricted-syntax -- no approved envelope exists, see above
/**
 * The quota and budget policy both roots run under.
 *
 * @since 1.0.0
 * @category layers
 */
export const agentPolicy = Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())

/**
 * Builds the review workflow over a caller-supplied seat resolver and the
 * in-process engine.
 *
 * This is the composition the tests and the seeded-bug eval run: no SQLite
 * file, no credential, and every seat answered by whatever model the caller
 * passes.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerMemory = (
  seats: Layer.Layer<SeatResolver.SeatResolver>,
  environment: Readonly<Record<string, string | undefined>> = process.env
) =>
  declarations.pipe(
    Layer.provideMerge(Layer.mergeAll(agentHost(environment), seats, Agent.layer)),
    Layer.provideMerge(agentPolicy),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer)
  )

/** Refuses a composition root that still owes a service. */
type Complete<L> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>] ? [R] extends [never] ? true : false
  : false

/** Fails to compile unless its argument is `true`. */
type Expect<T extends true> = T

/**
 * The in-process review runtime supplies every service the workflow can
 * require; `reviewLayerNode.ts` makes the same promise for the durable one.
 *
 * @category models
 * @since 1.0.0
 */
export type CompositionRootsAreComplete = [
  Expect<Complete<ReturnType<typeof layerMemory>>>
]
