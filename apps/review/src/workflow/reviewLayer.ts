/**
 * The compositions a review run needs: one for a real host, one for a test.
 *
 * The split is one seam wide. Everything above it — the flows, the actions, the
 * cell loop, the structured-output boundary — is identical in both. What
 * changes is where the run's state lives (a SQLite file or the process) and
 * what a declared seat resolves to (a live provider route or a scripted model).
 *
 * @since 1.0.0
 */
import * as Agent from "@smthrs/agent/Agent";
import * as AgentAction from "@smthrs/agent/AgentAction";
import * as SeatResolver from "@smthrs/agent/SeatResolver";
import { FlowEngine } from "@smthrs/engine";
import { Action, Interpreter } from "@smthrs/flow";
import * as NodeRuntime from "@smthrs/flows/NodeRuntime";
import * as Registry from "@smthrs/registry/Registry";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  applyVerdictsLayer,
  finalizeReviewLayer,
  mergeFileBatchLayer,
  prepareReviewLayer,
  renderWalkthroughLayer,
} from "./reviewActions.ts";
import { NarrateChanges, QuizChanges, ReviewFile, VerifyFindings } from "./reviewAgentActions.ts";
import { NarrateReview, Review, ReviewFiles, VerifyReview } from "./reviewFlow.ts";

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
  Interpreter.layer(NarrateReview),
);

/**
 * The agent host: an empty catalog and an explicit cell budget.
 *
 * The review seats answer from the prompt they were given — every diff a
 * reviewer needs is embedded by `buildNativeReviewPrompt` — so the host offers
 * no tool flows. A cell that tries to reach for one finds an empty registry
 * rather than an unbounded surface on the repository under review.
 *
 * @since 1.0.0
 * @category layers
 */
export const agentHost = AgentAction.layerHost({
  registry: Registry.makeNoop({
    list: () => Effect.succeed([]),
    visible: () => Effect.succeed([]),
    getOption: () => Effect.succeed(Option.none()),
  }),
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 4,
});

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
export const layerMemory = (seats: Layer.Layer<SeatResolver.SeatResolver>) =>
  declarations.pipe(
    Layer.provideMerge(Layer.mergeAll(agentHost, seats, Agent.layer)),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
  );

/**
 * Builds the review workflow over the durable Node runtime.
 *
 * The run's state lives in `filename`, so a review that dies mid-fan-out
 * resumes into the batches it had already settled instead of re-asking their
 * seats.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerNode = (options: {
  readonly filename: string;
  readonly seats: Layer.Layer<SeatResolver.SeatResolver>;
}) =>
  NodeRuntime.layerHost(
    { filename: options.filename, owner: { hostId: "smithers-review" } },
    declarations.pipe(
      Layer.provideMerge(Layer.mergeAll(agentHost, options.seats, Agent.layer)),
      Layer.provideMerge(Agent.layerDefaults),
      Layer.provideMerge(Action.layerImplementations),
    ),
  );
