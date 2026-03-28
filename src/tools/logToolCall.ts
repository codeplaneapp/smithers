import { Effect, Metric } from "effect";
import { nowMs } from "../utils/time";
import { sha256Hex } from "../utils/hash";
import { errorToJson } from "../utils/errors";
import { getToolContext, nextToolSeq } from "./context";
import { runPromise } from "../effect/runtime";
import { toolDuration } from "../effect/metrics";

export function logToolCallEffect(
  toolName: string,
  input: unknown,
  output: unknown,
  status: "success" | "error",
  error?: unknown,
  startedAtMs?: number,
  seqOverride?: number,
  toolCallIdOverride?: string,
) {
  const ctx = getToolContext();
  if (!ctx) return Effect.void;
  const seq =
    typeof seqOverride === "number" ? seqOverride : nextToolSeq(ctx);
  const toolCallId = toolCallIdOverride ?? `${toolName}:${seq}`;
  const started = startedAtMs ?? nowMs();
  const finished = nowMs();
  const durationMs = finished - started;
  const maxLogBytes = ctx.maxOutputBytes ?? 200_000;
  const inputJson = safeJson(input, maxLogBytes);
  const outputJson = safeJson(output, maxLogBytes);
  const errorJson = error ? safeJson(errorToJson(error), maxLogBytes) : null;
  void ctx.emitEvent?.({
    type: "ToolCallFinished",
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    iteration: ctx.iteration,
    attempt: ctx.attempt,
    toolCallId,
    toolName,
    seq,
    status,
    timestampMs: finished,
  });
  const spanAttributes = {
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    iteration: ctx.iteration,
    attempt: ctx.attempt,
    toolName,
    toolStatus: status,
  };
  return Metric.update(toolDuration, durationMs).pipe(
    Effect.andThen(
      ctx.db.insertToolCallEffect({
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        iteration: ctx.iteration,
        attempt: ctx.attempt,
        seq,
        toolName,
        inputJson,
        outputJson,
        startedAtMs: started,
        finishedAtMs: finished,
        status,
        errorJson,
      }),
    ),
    Effect.annotateLogs(spanAttributes),
    Effect.annotateSpans(spanAttributes),
    Effect.withLogSpan(`tool:${toolName}:log`),
    Effect.withSpan(`tool:${toolName}:log`, { attributes: spanAttributes }),
  );
}

export async function logToolCall(
  toolName: string,
  input: unknown,
  output: unknown,
  status: "success" | "error",
  error?: unknown,
  startedAtMs?: number,
) {
  await runPromise(
    logToolCallEffect(toolName, input, output, status, error, startedAtMs),
  );
}

export function logToolCallStartEffect(
  toolName: string,
  startedAtMs?: number,
) {
  const ctx = getToolContext();
  if (!ctx) return Effect.succeed(undefined);
  const seq = nextToolSeq(ctx);
  const toolCallId = `${toolName}:${seq}`;
  const started = startedAtMs ?? nowMs();
  void ctx.emitEvent?.({
    type: "ToolCallStarted",
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    iteration: ctx.iteration,
    attempt: ctx.attempt,
    toolCallId,
    toolName,
    seq,
    timestampMs: started,
  });
  return Effect.succeed({ seq, toolCallId });
}

export function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}

export function safeJson(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return json;
  const preview = truncateToBytes(json, maxBytes);
  return JSON.stringify({
    truncated: true,
    bytes: Buffer.byteLength(json, "utf8"),
    preview,
  });
}
