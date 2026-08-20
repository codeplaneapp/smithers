import * as AgentEvent from "@flows/harness/AgentEvent";
import { HarnessError } from "@flows/harness/HarnessError";
import * as ModelRequest from "@flows/model/ModelRequest";
import { Cause, Effect, Layer, Option, Queue, Stream } from "effect";
import { z } from "zod";

const emitsHarnessEvents = Symbol("emitsHarnessEvents");
const harnessInvocation = Symbol("harnessInvocation");
const sourceAgent = Symbol("sourceAgent");
const sourceHarness = Symbol("sourceHarness");
const bridgeInput = "@smthrs/agents/harness-bridge.v1";
const checkpointEngine = "smithers-agent-checkpoint";
const bridgeEngine = "smithers-agentlike-bridge";

const bridgeEvent = (kind, value) => new AgentEvent.ResumeToken({
  eventType: "flows.harness.resume-token.v1",
  agentEngine: bridgeEngine,
  agentResume: JSON.stringify({ version: 1, kind, value }),
  discardResumeSession: false,
});

const bridgePayload = (event) => {
  if (event?._tag !== "resume-token" || event.agentEngine !== bridgeEngine) return undefined;
  try {
    const payload = JSON.parse(event.agentResume);
    return payload?.version === 1 && typeof payload.kind === "string" ? payload : undefined;
  } catch {
    return undefined;
  }
};

const settledObject = async (value) => {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await entry])));
};

const usageOf = (usage) => {
  if (!usage || typeof usage !== "object") return {};
  return {
    ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
    ...(typeof usage.reasoningTokens === "number" ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
    ...(typeof usage.inputTokenDetails?.cacheReadTokens === "number"
      ? { cachedInputTokens: usage.inputTokenDetails.cacheReadTokens }
      : {}),
    ...(typeof usage.inputTokenDetails?.cacheWriteTokens === "number"
      ? { cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens }
      : {}),
  };
};

const textOf = (value) => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return value == null ? "" : JSON.stringify(value);
};

const messageText = (message) => message.content
  .filter((part) => part.type === "text")
  .map((part) => part.text)
  .join("");

const bridgedOptionsOf = (step) => {
  const input = step?.input;
  return input && typeof input === "object" && input._tag === bridgeInput && input.options && typeof input.options === "object"
    ? input.options
    : {};
};

const generateOptionsOf = async (agent, step, host, abortSignal, runtime) => {
  const system = [step.system, ...step.instructions]
    .map((section) => section.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
  const bridged = { ...bridgedOptionsOf(step), ...(runtime?.options ?? {}) };
  const signals = [abortSignal, bridged.abortSignal].filter(Boolean);
  const options = {
    ...bridged,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: step.prompt.text },
    ],
    ...(bridged.messages !== undefined ? { messages: bridged.messages } : {}),
    ...(bridged.prompt !== undefined ? { prompt: bridged.prompt } : {}),
    abortSignal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    harnessStep: step,
    harnessHost: host,
    ...((agent.tools !== undefined || bridged.tools !== undefined) ? {
      tools: { ...(agent.tools ?? {}), ...(bridged.tools ?? {}) },
    } : {}),
    ...(runtime?.resumeCheckpoint === undefined ? {} : {
      resumeCheckpoint: runtime.resumeCheckpoint,
      checkpointMode: runtime.checkpointMode ?? "resume",
    }),
  };
  Object.defineProperty(options, harnessInvocation, {
    enumerable: true,
    value: Object.freeze({ step, host }),
  });
  return options;
};

const promptTextOf = (options) => {
  if (options.prompt !== undefined) return textOf(options.prompt);
  if (!Array.isArray(options.messages)) return "";
  return options.messages.map((message) => {
    if (typeof message?.content === "string") return message.content;
    if (Array.isArray(message?.content)) return message.content.map(textOf).join("");
    return textOf(message?.content);
  }).join("\n");
};

const declaration = (text, name) => ({ text, digest: `smithers-legacy:${name}` });

const schemaDocument = (schema) => {
  if (schema && typeof schema === "object" && "jsonSchema" in schema) return schema.jsonSchema;
  if (schema && typeof schema === "object" && "_zod" in schema) {
    return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  }
  return {};
};

const toolDefinitionsOf = (tools) => Object.entries(tools).map(([name, tool]) => ModelRequest.ToolDefinition.make({
  name,
  description: tool?.description ?? name,
  parameters: schemaDocument(tool?.inputSchema),
}));

const stepFromGenerateOptions = (options) => {
  const tools = options.tools && typeof options.tools === "object" ? options.tools : {};
  return {
    seat: "smithers:legacy",
    thinkingLevel: "medium",
    layers: [],
    capabilityEnvelope: [],
    placement: Option.none(),
    input: { _tag: bridgeInput },
    system: declaration("", "system"),
    instructions: [],
    prompt: declaration(promptTextOf(options), "prompt"),
    journal: [],
    activeToolNames: Object.keys(tools),
    toolDefinitions: toolDefinitionsOf(tools),
    contextWindowTokens: 0,
  };
};

const structuredOutputOf = async (schema, text) => {
  if (!schema) return undefined;
  let value;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (typeof schema.safeParseAsync === "function") {
    const result = await schema.safeParseAsync(value);
    return result.success ? result.data : undefined;
  }
  if (typeof schema.safeParse === "function") {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  }
  return value;
};

/**
 * True only for options minted by the AgentLike-to-Harness bridge. Presence of
 * the public step/host fields alone is insufficient to authorize instruction
 * translation on legacy generate() calls.
 *
 * @param {unknown} options
 */
export const isValidatedHarnessInvocation = (options) => {
  if (!options || typeof options !== "object") return false;
  const invocation = options[harnessInvocation];
  return invocation !== undefined && invocation.step === options.harnessStep && invocation.host === options.harnessHost;
};

/**
 * Adapt the legacy Smithers AgentLike contract to the flows Harness contract.
 * Native harness events delivered through onEvent are retained byte-for-byte;
 * plain legacy agents are projected to model deltas plus a resolved message.
 *
 * @param {import("./AgentLike.ts").AgentLike} agent
 * @param {{ resumeCheckpoint?: import("./AgentCheckpoint.ts").AgentCheckpoint; checkpointMode?: import("./AgentCheckpoint.ts").AgentCheckpointMode; options?: import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions }} [runtime]
 * @returns {import("@flows/harness/Harness").Harness}
 */
export const agentLikeToHarness = (agent, runtime) => {
  if (agent[sourceHarness] && runtime === undefined) return agent[sourceHarness];
  const nativeEvents = agent[emitsHarnessEvents] === true;
  return {
    [sourceAgent]: runtime === undefined ? agent : undefined,
    run(step, host) {
      return Stream.callback((queue) => Effect.acquireRelease(
        Effect.sync(() => {
          const controller = new AbortController();
          let streamed = "";
          let sawHarnessEvent = false;
          let sawTerminalHarnessEvent = false;
          const emittedCheckpointTokens = new Set();
          let opened = false;
          const open = () => {
            if (opened || nativeEvents) return;
            opened = true;
            Queue.offerUnsafe(queue, new AgentEvent.TurnOpened({
              eventType: "flows.harness.turn-opened.v1",
              seat: step.seat ?? "smithers:legacy",
              modelParams: {},
              activeToolNames: step.activeToolNames ?? [],
              contextDigest: step.prompt?.digest ?? "smithers-legacy:prompt",
            }));
          };
          const run = generateOptionsOf(agent, step, host, controller.signal, runtime).then((generatedOptions) => agent.generate({
            ...generatedOptions,
            onStdout(text) {
              streamed += text;
              if (!nativeEvents) {
                open();
                Queue.offerUnsafe(queue, new AgentEvent.ModelDelta({
                  eventType: "flows.harness.model-delta.v1",
                  delta: { type: "text-delta", id: "legacy", text },
                }));
              }
            },
            onStderr(text) {
              if (!nativeEvents) Queue.offerUnsafe(queue, bridgeEvent("stderr", text));
            },
            async onToolExecutionStart(value) {
              if (!nativeEvents) Queue.offerUnsafe(queue, bridgeEvent("tool-start", value));
            },
            async onToolExecutionEnd(value) {
              if (!nativeEvents) Queue.offerUnsafe(queue, bridgeEvent("tool-end", value));
            },
            onEvent(value) {
              if (value.type === "harness-event") {
                sawHarnessEvent = true;
                sawTerminalHarnessEvent ||= ["turn-closed", "suspended", "aborted", "resolved"].includes(value.event._tag);
                if (value.event._tag === "turn-opened") opened = true;
                else open();
                if (value.event._tag === "resume-token" && value.event.agentEngine === checkpointEngine) {
                  emittedCheckpointTokens.add(value.event.agentResume);
                }
                Queue.offerUnsafe(queue, value.event);
              } else if (!nativeEvents) {
                Queue.offerUnsafe(queue, bridgeEvent("diagnostic", value));
              }
            },
          })).then(async (result) => {
            const settled = await settledObject(result);
            open();
            if (result?.checkpoint) {
              const agentResume = JSON.stringify(result.checkpoint);
              if (!emittedCheckpointTokens.has(agentResume)) Queue.offerUnsafe(queue, new AgentEvent.ResumeToken({
                eventType: "flows.harness.resume-token.v1",
                agentEngine: checkpointEngine,
                agentResume,
                discardResumeSession: false,
              }));
            }
            if (!nativeEvents && !sawHarnessEvent && settled && typeof settled === "object") {
              const { checkpoint: _checkpoint, text: _text, usage: _usage, ...metadata } = settled;
              if (Object.keys(metadata).length > 0) Queue.offerUnsafe(queue, bridgeEvent("result", metadata));
            }
            if (!nativeEvents && !sawTerminalHarnessEvent) {
              open();
              const message = ModelRequest.Message.assistant(textOf(settled?.text ?? settled) || streamed, { stopReason: "stop" });
              Queue.offerUnsafe(queue, new AgentEvent.ModelSettled({
                eventType: "flows.harness.model-settled.v1",
                message,
                usage: usageOf(settled?.usage),
              }));
              Queue.offerUnsafe(queue, new AgentEvent.TurnClosed({
                eventType: "flows.harness.turn-closed.v1",
                stopReason: "stop",
                outcome: "resolved",
              }));
              Queue.offerUnsafe(queue, new AgentEvent.Resolved({
                eventType: "flows.harness.resolved.v1",
                message,
              }));
            }
            Queue.endUnsafe(queue);
          }, (cause) => {
            if (controller.signal.aborted) return;
            Queue.failCauseUnsafe(queue, Cause.fail(new HarnessError({
              code: "unknown",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            })));
          });
          return { controller, run };
        }),
        ({ controller }) => Effect.sync(() => controller.abort(new DOMException("Harness stream interrupted", "AbortError"))),
      ));
    },
  };
};

/**
 * Native Harness entrypoint shared by first-class agents while generate()
 * remains available for legacy workflows.
 *
 * @param {import("./AgentLike.ts").AgentLike} agent
 * @param {import("@flows/harness/AgentStep").AgentStep} step
 * @param {import("@flows/harness/AgentStep").HostLike} host
 * @returns {ReturnType<import("@flows/harness/Harness").Harness["run"]>}
 */
export const runAgentLikeHarness = (agent, step, host) => agentLikeToHarness(agent).run(step, host);

/**
 * Adapt a flows Harness for legacy workflow code expecting AgentLike.generate.
 * The caller supplies harnessStep/harnessHost because both are part of the new
 * contract and intentionally cannot be reconstructed from a prompt string.
 *
 * @param {import("@flows/harness/Harness").Harness} harness
 * @returns {import("./AgentLike.ts").AgentLike}
 */
export const harnessToAgentLike = (harness) => {
  return {
    [emitsHarnessEvents]: true,
    [sourceHarness]: harness,
    async generate(options = {}) {
      const activeHarness = harness[sourceAgent]
        ? agentLikeToHarness(harness[sourceAgent], {
            options,
            resumeCheckpoint: options.resumeCheckpoint,
            checkpointMode: options.checkpointMode,
          })
        : harness;
      const step = options.harnessStep ?? stepFromGenerateOptions(options);
      const host = options.harnessHost ?? Layer.empty;
      const events = [];
      const toolCalls = [];
      const toolResults = [];
      const steps = [];
      let bridgedResult;
      await Effect.runPromise(Stream.runForEach(
        activeHarness.run(step, host),
        (event) => Effect.promise(async () => {
          events.push(event);
          await options.onEvent?.({ type: "harness-event", event });
          const bridge = bridgePayload(event);
          if (bridge?.kind === "stderr") options.onStderr?.(bridge.value);
          if (bridge?.kind === "diagnostic") await options.onEvent?.(bridge.value);
          if (bridge?.kind === "tool-start") await options.onToolExecutionStart?.(bridge.value);
          if (bridge?.kind === "tool-end") await options.onToolExecutionEnd?.(bridge.value);
          if (bridge?.kind === "result") bridgedResult = bridge.value;
          if (event._tag === "model-delta" && event.delta.type === "text-delta") options.onStdout?.(event.delta.text);
          if (event._tag === "cell-call-started") {
            const callId = `${event.call.identity.frame}:${event.call.identity.ordinal}`;
            const toolCall = { type: "tool-call", toolCallId: callId, toolName: event.call.flowName, input: event.call.input };
            toolCalls.push(toolCall);
            await options.onToolExecutionStart?.({ callId, toolCall });
          }
          if (event._tag === "cell-call-settled") {
            const callId = `${event.identity.frame}:${event.identity.ordinal}`;
            const toolResult = { type: "tool-result", toolCallId: callId, toolName: event.flowName, output: event.result.value, isError: event.result.outcome !== "success" };
            toolResults.push(toolResult);
            await options.onToolExecutionEnd?.({ callId, toolCall: toolCalls.find((call) => call.toolCallId === callId), toolResult });
          }
          if (event._tag === "model-settled") steps.push({
            text: messageText(event.message), content: event.message.content,
            toolCalls: toolCalls.filter((call) => call.toolCallId.startsWith(`${steps.length}:`)),
            toolResults: toolResults.filter((result) => result.toolCallId.startsWith(`${steps.length}:`)),
            finishReason: event.message.stopReason, usage: event.usage,
            response: { messages: [event.message] },
          });
          if (event._tag === "resume-token" && event.agentEngine === checkpointEngine) {
            let checkpoint;
            try { checkpoint = JSON.parse(event.agentResume); } catch { /* invalid tokens stay opaque */ }
            if (checkpoint !== undefined) await options.onCheckpoint?.(checkpoint);
          }
        }),
      ), options.abortSignal ? { signal: options.abortSignal } : undefined);
      const resolved = events.findLast((event) => event._tag === "resolved");
      const text = resolved ? messageText(resolved.message) : "";
      const checkpointEvent = events.findLast((event) => event._tag === "resume-token" && event.agentEngine === checkpointEngine);
      let checkpoint;
      if (checkpointEvent) {
        try { checkpoint = JSON.parse(checkpointEvent.agentResume); } catch { /* an invalid foreign token stays opaque */ }
      }
      const output = await structuredOutputOf(options.outputSchema, text);
      const usage = events.filter((event) => event._tag === "model-settled").reduce((total, event) => ({
        inputTokens: (total.inputTokens ?? 0) + (event.usage.inputTokens ?? 0),
        outputTokens: (total.outputTokens ?? 0) + (event.usage.outputTokens ?? 0),
        totalTokens: (total.totalTokens ?? 0) + (event.usage.totalTokens ?? 0),
      }), {});
      const finishReason = events.findLast((event) => event._tag === "turn-closed")?.stopReason ?? resolved?.message.stopReason ?? "stop";
      for (const item of steps) await (options.onStepEnd ?? options.onStepFinish)?.(item);
      return {
        ...bridgedResult,
        text,
        output: output ?? bridgedResult?.output ?? resolved?.message,
        events,
        toolCalls: bridgedResult?.toolCalls ?? toolCalls,
        staticToolCalls: bridgedResult?.staticToolCalls ?? toolCalls,
        toolResults: bridgedResult?.toolResults ?? toolResults,
        staticToolResults: bridgedResult?.staticToolResults ?? toolResults,
        steps: bridgedResult?.steps ?? steps,
        usage: bridgedResult?.usage ?? usage,
        totalUsage: bridgedResult?.totalUsage ?? usage,
        finishReason: bridgedResult?.finishReason ?? finishReason,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      };
    },
  };
};
