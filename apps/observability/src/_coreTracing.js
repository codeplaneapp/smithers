import { Context, Effect, Layer } from "effect";
import {
  correlationContextToLogAnnotations,
  getCurrentCorrelationContext,
  withCorrelationContext,
} from "./_coreCorrelation/index.js";
import { smithersSpanAttributeAliases } from "./_smithersSpanAttributeAliases.js";
/** @typedef {import("./SmithersLogFormat.ts").SmithersLogFormat} SmithersLogFormat */
/** @typedef {import("./_coreTracingShape.ts").SmithersSpanAttributesInput} SmithersSpanAttributesInput */
/** @typedef {import("./_coreTracingShape.ts").TracingServiceShape} TracingServiceShape */

/** @type {"text/plain; version=0.0.4; charset=utf-8"} */
export const prometheusContentType = "text/plain; version=0.0.4; charset=utf-8";
/** @type {{ readonly run: "smithers.run"; readonly task: "smithers.task"; readonly agent: "smithers.agent"; readonly tool: "smithers.tool" }} */
export const smithersSpanNames = {
  run: "smithers.run",
  task: "smithers.task",
  agent: "smithers.agent",
  tool: "smithers.tool",
};
const _TracingServiceBase = /** @type {Context.TagClass<TracingService, "TracingService", TracingServiceShape>} */ (
  /** @type {unknown} */ (Context.Tag("TracingService")())
);
export class TracingService extends _TracingServiceBase {}
/**
 * @param {SmithersSpanAttributesInput} [attributes]
 * @returns {Record<string, unknown>}
 */
export function makeSmithersSpanAttributes(attributes = {}) {
  const aliases = smithersSpanAttributeAliases;
  const result = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      result[key.startsWith("smithers.") ? key : (aliases[key] ?? key)] = value;
    }
  }
  return result;
}
/**
 * @param {SmithersSpanAttributesInput} [attributes]
 * @returns {attributes is SmithersSpanAttributesInput}
 */
function hasAttributes(attributes) {
  return Boolean(attributes && Object.keys(attributes).length > 0);
}
/**
 * @param {string} name
 * @param {SmithersSpanAttributesInput} [attributes]
 * @returns {string}
 */
function inferSmithersSpanName(name, attributes) {
  if (name.startsWith("smithers.")) return name;
  if (name.startsWith("tool:") || "toolName" in (attributes ?? {}) || "tool_name" in (attributes ?? {})) {
    return smithersSpanNames.tool;
  }
  if (name.startsWith("agent:") || name.startsWith("agent.") || "agent" in (attributes ?? {})) {
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
/**
 * @param {SmithersSpanAttributesInput} [attributes]
 * @returns {Effect.Effect<void>}
 */
export function annotateSmithersTrace(attributes = {}) {
  const spanAttributes = makeSmithersSpanAttributes(attributes);
  let program = Effect.void;
  if (Object.keys(spanAttributes).length > 0) {
    program = program.pipe(
      Effect.tap(() => Effect.annotateCurrentSpan(spanAttributes).pipe(Effect.catchAll(() => Effect.void))),
    );
  }
  if (hasAttributes(attributes)) {
    program = program.pipe(Effect.annotateLogs(attributes));
  }
  return program;
}
/**
 * @template A, E, R
 * @param {string} name
 * @param {Effect.Effect<A, E, R>} effect
 * @param {SmithersSpanAttributesInput} [attributes]
 * @returns {Effect.Effect<A, E, R>}
 */
export function withSmithersSpan(name, effect, attributes) {
  const spanAttributes = makeSmithersSpanAttributes(attributes);
  return Effect.suspend(() => {
    const annotations = correlationContextToLogAnnotations(getCurrentCorrelationContext());
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
      Effect.withSpan(inferSmithersSpanName(name, attributes), {
        attributes: spanAttributes,
      }),
    );
  });
}
/** @type {Layer.Layer<TracingService, never, never>} */
export const TracingServiceLive = Layer.succeed(TracingService, {
  withSpan: (name, effect, attributes) => {
    return withSmithersSpan(name, effect, attributes);
  },
  annotate: (attributes) => {
    const spanAttributes = makeSmithersSpanAttributes(attributes);
    return Object.keys(spanAttributes).length > 0
      ? Effect.annotateCurrentSpan(spanAttributes).pipe(Effect.catchAll(() => Effect.void))
      : Effect.void;
  },
  withCorrelation: (context, effect) => withCorrelationContext(effect, context),
});
