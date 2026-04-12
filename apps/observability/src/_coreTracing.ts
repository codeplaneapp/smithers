import { Context, Effect, Layer } from "effect";
import type { CorrelationPatch } from "./_coreCorrelation/index.ts";
import {
  correlationContextToLogAnnotations,
  getCurrentCorrelationContext,
  withCorrelationContext,
} from "./_coreCorrelation/index.ts";

export type SmithersLogFormat = "json" | "pretty" | "string" | "logfmt";

export const prometheusContentType =
  "text/plain; version=0.0.4; charset=utf-8";

export const smithersSpanNames = {
  run: "smithers.run",
  task: "smithers.task",
  agent: "smithers.agent",
  tool: "smithers.tool",
} as const;

export type SmithersSpanAttributesInput = Readonly<Record<string, unknown>>;

export class TracingService extends Context.Tag("TracingService")<
  TracingService,
  {
    readonly withSpan: <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>,
      attributes?: Record<string, unknown>,
    ) => Effect.Effect<A, E, R>;
    readonly annotate: (
      attributes: Record<string, unknown>,
    ) => Effect.Effect<void>;
    readonly withCorrelation: <A, E, R>(
      context: CorrelationPatch,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>() {}

export function getCurrentSmithersTraceAnnotations():
  | Readonly<Record<string, string>>
  | undefined {
  const context = getCurrentCorrelationContext();
  if (!context?.traceId || !context.spanId) return undefined;
  return { traceId: context.traceId, spanId: context.spanId };
}

export function makeSmithersSpanAttributes(
  attributes: SmithersSpanAttributesInput = {},
): Record<string, unknown> {
  const aliases: Record<string, string> = {
    runId: "smithers.run_id",
    run_id: "smithers.run_id",
    workflowName: "smithers.workflow_name",
    workflow_name: "smithers.workflow_name",
    nodeId: "smithers.node_id",
    node_id: "smithers.node_id",
    iteration: "smithers.iteration",
    attempt: "smithers.attempt",
    nodeLabel: "smithers.node_label",
    node_label: "smithers.node_label",
    toolName: "smithers.tool_name",
    tool_name: "smithers.tool_name",
    agent: "smithers.agent",
    model: "smithers.model",
    status: "smithers.status",
    waitReason: "smithers.wait_reason",
    wait_reason: "smithers.wait_reason",
  };
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      result[key.startsWith("smithers.") ? key : (aliases[key] ?? key)] = value;
    }
  }
  return result;
}

function hasAttributes(
  attributes?: SmithersSpanAttributesInput,
): attributes is SmithersSpanAttributesInput {
  return Boolean(attributes && Object.keys(attributes).length > 0);
}

function inferSmithersSpanName(
  name: string,
  attributes?: SmithersSpanAttributesInput,
): string {
  if (name.startsWith("smithers.")) return name;
  if (
    name.startsWith("tool:") ||
    "toolName" in (attributes ?? {}) ||
    "tool_name" in (attributes ?? {})
  ) {
    return smithersSpanNames.tool;
  }
  if (
    name.startsWith("agent:") ||
    name.startsWith("agent.") ||
    "agent" in (attributes ?? {})
  ) {
    return smithersSpanNames.agent;
  }
  if ("nodeId" in (attributes ?? {}) || "node_id" in (attributes ?? {})) {
    return smithersSpanNames.task;
  }
  if ("runId" in (attributes ?? {}) || "run_id" in (attributes ?? {})) {
    return smithersSpanNames.run;
  }
  return name;
}

export function annotateSmithersTrace(
  attributes: SmithersSpanAttributesInput = {},
): Effect.Effect<void> {
  const spanAttributes = makeSmithersSpanAttributes(attributes);
  let program = Effect.void;
  if (Object.keys(spanAttributes).length > 0) {
    program = program.pipe(
      Effect.tap(() =>
        Effect.annotateCurrentSpan(spanAttributes).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      ),
    );
  }
  if (hasAttributes(attributes)) {
    program = program.pipe(Effect.annotateLogs(attributes));
  }
  return program;
}

export function withSmithersSpan<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  attributes?: SmithersSpanAttributesInput,
): Effect.Effect<A, E, R> {
  const spanAttributes = makeSmithersSpanAttributes(attributes);
  const annotations = correlationContextToLogAnnotations(
    getCurrentCorrelationContext(),
  );
  let program = effect;
  if (Object.keys(spanAttributes).length > 0) {
    program = program.pipe(Effect.annotateSpans(spanAttributes));
  }
  if (hasAttributes(attributes)) {
    program = program.pipe(Effect.annotateLogs(attributes));
  }
  if (annotations) {
    program = program.pipe(Effect.annotateLogs(annotations));
  }
  return program.pipe(
    Effect.withLogSpan(name),
    Effect.withSpan(inferSmithersSpanName(name, attributes)),
  );
}

export const TracingServiceLive = Layer.succeed(TracingService, {
  withSpan: (name, effect, attributes) => {
    return withSmithersSpan(name, effect, attributes);
  },
  annotate: (attributes) => {
    const spanAttributes = makeSmithersSpanAttributes(attributes);
    return Object.keys(spanAttributes).length > 0
      ? Effect.annotateCurrentSpan(spanAttributes).pipe(
          Effect.catchAll(() => Effect.void),
        )
      : Effect.void;
  },
  withCorrelation: (context, effect) => withCorrelationContext(effect, context),
});
