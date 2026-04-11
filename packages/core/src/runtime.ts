import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { DurablePrimitivesLive } from "./durables.ts";
import { ExecutionServiceLive } from "./execution.ts";
import { toSmithersError } from "./errors.ts";
import {
  CorrelationContextLive,
  MetricsServiceLive,
  TracingServiceLive,
} from "./observability/index.ts";
import { SchedulerLive } from "./scheduler.ts";
import { WorkflowSessionLive } from "./session/index.ts";

const ObservabilityLayer = Layer.mergeAll(
  CorrelationContextLive,
  MetricsServiceLive,
  TracingServiceLive,
);

export const SmithersCoreLayer = Layer.mergeAll(
  ObservabilityLayer,
  SchedulerLive.pipe(Layer.provide(ObservabilityLayer)),
  DurablePrimitivesLive,
  ExecutionServiceLive,
  WorkflowSessionLive,
);

export const SmithersRuntimeLayer = SmithersCoreLayer;

export function makeSmithersRuntime<R = never>(
  layer: Layer.Layer<R, never, never> = SmithersCoreLayer as Layer.Layer<
    R,
    never,
    never
  >,
) {
  return ManagedRuntime.make(layer);
}

const runtime = makeSmithersRuntime();

function decorate<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.annotateLogs("service", "smithers-core"),
    Effect.withTracerEnabled(true),
  );
}

function normalizeRejection(cause: unknown) {
  return toSmithersError(cause);
}

export async function runPromise<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: { readonly signal?: AbortSignal },
) {
  const exit = await runtime.runPromiseExit(
    decorate(effect) as Effect.Effect<A, E, never>,
    options,
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    throw normalizeRejection(failure.value);
  }
  throw normalizeRejection(Cause.squash(exit.cause));
}

export function runFork<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return runtime.runFork(decorate(effect) as Effect.Effect<A, E, never>);
}

export function runSync<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return runtime.runSync(decorate(effect) as Effect.Effect<A, E, never>);
}
