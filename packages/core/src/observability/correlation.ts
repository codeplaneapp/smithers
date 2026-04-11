import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Effect, FiberRef, Layer } from "effect";

export type CorrelationContext = {
  runId: string;
  nodeId?: string;
  iteration?: number;
  attempt?: number;
  workflowName?: string;
  parentRunId?: string;
  traceId?: string;
  spanId?: string;
};

export type CorrelationPatch = Partial<CorrelationContext> | undefined | null;

const storage = new AsyncLocalStorage<CorrelationContext>();

export const correlationContextFiberRef =
  FiberRef.unsafeMake<CorrelationContext | undefined>(undefined);

export class CorrelationContextService extends Context.Tag(
  "CorrelationContextService",
)<
  CorrelationContextService,
  {
    readonly current: () => Effect.Effect<CorrelationContext | undefined>;
    readonly withCorrelation: <A, E, R>(
      patch: CorrelationPatch,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly toLogAnnotations: (
      context?: CorrelationContext | null,
    ) => Record<string, unknown> | undefined;
  }
>() {}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePatch(
  patch: CorrelationPatch,
): Partial<CorrelationContext> | undefined {
  if (!patch) return undefined;
  const normalized: Partial<CorrelationContext> = {};
  const runId = cleanString(patch.runId);
  const nodeId = cleanString(patch.nodeId);
  const workflowName = cleanString(patch.workflowName);
  const parentRunId = cleanString(patch.parentRunId);
  const traceId = cleanString(patch.traceId);
  const spanId = cleanString(patch.spanId);
  const iteration = cleanNumber(patch.iteration);
  const attempt = cleanNumber(patch.attempt);
  if (runId) normalized.runId = runId;
  if (nodeId) normalized.nodeId = nodeId;
  if (workflowName) normalized.workflowName = workflowName;
  if (parentRunId) normalized.parentRunId = parentRunId;
  if (traceId) normalized.traceId = traceId;
  if (spanId) normalized.spanId = spanId;
  if (iteration !== undefined) normalized.iteration = iteration;
  if (attempt !== undefined) normalized.attempt = attempt;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function mergeCorrelationContext(
  base?: CorrelationContext | null,
  patch?: CorrelationPatch,
): CorrelationContext | undefined {
  const normalizedPatch = normalizePatch(patch);
  const merged = { ...base, ...normalizedPatch } as Partial<CorrelationContext>;
  return merged.runId ? (merged as CorrelationContext) : undefined;
}

export function getCurrentCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

export function getCurrentCorrelationContextEffect(): Effect.Effect<
  CorrelationContext | undefined
> {
  return FiberRef.get(correlationContextFiberRef).pipe(
    Effect.map((fiberContext) => fiberContext ?? storage.getStore()),
  );
}

export function updateCurrentCorrelationContext(
  patch: CorrelationPatch,
): Effect.Effect<CorrelationContext | undefined> {
  return Effect.gen(function* () {
    const current = yield* getCurrentCorrelationContextEffect();
    const next = mergeCorrelationContext(current, patch);
    yield* FiberRef.set(correlationContextFiberRef, next);
    return next;
  });
}

export function runWithCorrelationContext<T>(
  patch: CorrelationPatch,
  fn: () => T,
): T {
  const next = mergeCorrelationContext(storage.getStore(), patch);
  return next ? storage.run(next, fn) : fn();
}

export function withCorrelationContext<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  patch: CorrelationPatch,
) {
  const next = mergeCorrelationContext(storage.getStore(), patch);
  return next ? effect.pipe(Effect.locally(correlationContextFiberRef, next)) : effect;
}

export function withCurrentCorrelationContext<A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const current = storage.getStore();
  return current
    ? effect.pipe(Effect.locally(correlationContextFiberRef, current))
    : effect;
}

export function correlationContextToLogAnnotations(
  context?: CorrelationContext | null,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const annotations: Record<string, unknown> = {};
  if (context.runId) annotations.runId = context.runId;
  if (context.nodeId) annotations.nodeId = context.nodeId;
  if (context.workflowName) annotations.workflowName = context.workflowName;
  if (context.parentRunId) annotations.parentRunId = context.parentRunId;
  if (context.traceId) annotations.traceId = context.traceId;
  if (context.spanId) annotations.spanId = context.spanId;
  if (typeof context.iteration === "number") annotations.iteration = context.iteration;
  if (typeof context.attempt === "number") annotations.attempt = context.attempt;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export const CorrelationContextLive = Layer.succeed(CorrelationContextService, {
  current: () => getCurrentCorrelationContextEffect(),
  withCorrelation: (patch, effect) => withCorrelationContext(effect, patch),
  toLogAnnotations: correlationContextToLogAnnotations,
});
