import * as ModelRequest from "@flows/model/ModelRequest";
import * as OpenAICompatible from "@flows/model/OpenAICompatible";
import * as RequestExecutor from "@flows/model/RequestExecutor";
import * as Route from "@flows/model/Route";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { Effect, Redacted, Result, Stream } from "effect";
import { z } from "zod";
import { buildGenerateResult } from "./BaseCliAgent/buildGenerateResult.js";
import { runCellAgent, streamCellAgent } from "./cell-agent.js";

const MAX_TOOL_STEPS = 100;
const stopReasons = new Set(["stop", "length", "tool-calls", "content-filter", "error", "aborted", "unknown"]);

/** @param {unknown} schema */
const schemaJson = (schema) => {
  if (schema && typeof schema === "object" && "jsonSchema" in schema) return schema.jsonSchema;
  return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
};

/** @param {unknown} content */
const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("");
};

/** @param {unknown} value */
const stopReasonOf = (value) => (stopReasons.has(value) ? value : "unknown");

/** @param {unknown} value */
const jsonText = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? null));

/** @param {unknown} value */
const parseJson = (value) => {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
};

/** Preserve the complete provider-neutral transcript supported by flows. */
const asInput = (input) => {
  if (!Array.isArray(input)) {
    return { system: [], messages: [ModelRequest.Message.user(String(input ?? ""))] };
  }

  const system = [];
  const messages = [];
  for (const message of input) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system") {
      const text = textOf(message.content);
      if (text) system.push(ModelRequest.SystemPart.make({ text }));
      continue;
    }
    if (message.role === "assistant") {
      const content = Array.isArray(message.content)
        ? message.content
        : [{ type: "text", text: textOf(message.content) }];
      const parts = content.flatMap((part) => {
        if (part?.type === "text") return [ModelRequest.TextPart.make({ text: part.text ?? "" })];
        if (part?.type === "reasoning" || part?.type === "thinking") {
          return [ModelRequest.ThinkingPart.make({ text: part.text ?? "", signature: part.signature })];
        }
        if (part?.type === "tool-call") {
          return [
            ModelRequest.ToolCallPart.make({
              id: String(part.toolCallId ?? part.id ?? ""),
              name: String(part.toolName ?? part.name ?? ""),
              arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? part.args ?? {}),
            }),
          ];
        }
        return [];
      });
      messages.push(ModelRequest.Message.assistant(parts, { stopReason: stopReasonOf(message.finishReason) }));
      continue;
    }
    if (message.role === "tool") {
      const content = Array.isArray(message.content) ? message.content : [message.content];
      const parts = content.flatMap((part) => {
        if (part?.type !== "tool-result") return [];
        return [
          ModelRequest.ToolResultPart.make({
            toolCallId: String(part.toolCallId ?? part.id ?? ""),
            content: jsonText(part.output ?? part.result),
          }),
        ];
      });
      if (parts.length > 0) messages.push(ModelRequest.Message.tool(parts));
      continue;
    }
    messages.push(ModelRequest.Message.user(textOf(message.content)));
  }
  return { system, messages };
};

/** @param {string} baseUrl */
const normalizeOpenAICompatibleBaseUrl = (baseUrl) => {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.toLowerCase().endsWith("/v1") ? path.slice(0, -3) || "/" : path || "/";
  return url.toString();
};

/** @param {unknown} model @param {string | undefined} configured */
const resolveModelId = (model, configured) => {
  if (typeof model === "string") return configured ?? model;
  if (configured) return configured;
  if (model && typeof model === "object" && "modelId" in model && typeof model.modelId === "string") {
    return model.modelId;
  }
  throw new SmithersError(
    "AGENT_CONFIG_INVALID",
    "ModelAgent requires modelId when model is a prebuilt flows Model instance.",
    {},
  );
};

/** @param {unknown} timeout @param {"totalMs" | "stepMs"} key */
const timeoutOf = (timeout, key) => {
  const value = typeof timeout === "number" && key === "totalMs" ? timeout : timeout?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
};

/** @param {...(AbortSignal | undefined)} signals */
/** @param {unknown} schema @param {string} text */
const parseStructuredOutput = async (schema, text) => {
  if (!schema) return undefined;
  const parsedJson = parseJson(text);
  if (!parsedJson.ok) return undefined;
  if (typeof schema.safeParseAsync === "function") {
    const parsed = await schema.safeParseAsync(parsedJson.value);
    return parsed.success ? parsed.data : undefined;
  }
  if (typeof schema.safeParse === "function") {
    const parsed = schema.safeParse(parsedJson.value);
    return parsed.success ? parsed.data : undefined;
  }
  return parsedJson.value;
};

/** @param {unknown} schema */
const structuredOutputInstruction = (schema) =>
  ModelRequest.SystemPart.make({
    text: [
      "Return only a JSON value matching this schema. Do not add prose or markdown fences.",
      JSON.stringify(schemaJson(schema)),
    ].join("\n"),
  });

/** Provider-neutral Smithers agent backed only by the flows Model seam. */
export class ModelAgent {
  hijackEngine = "flows-model";
  supportsNativeStructuredOutput = false;

  /** @param {Record<string, any>} opts @param {"anthropic" | "openai"} family */
  constructor(opts, family) {
    this.id = opts.id;
    this.opts = opts;
    this.family = family;
    this.model = opts.model;
    this.modelId = resolveModelId(opts.model, opts.modelId);
    this.tools = opts.tools ?? {};
  }

  /**
   * Execute this provider adapter through the flows Harness contract.
   * @param {import("@flows/harness/AgentStep").AgentStep} step
   * @param {import("@flows/harness/AgentStep").HostLike} host
   */
  run(step, host) {
    return Stream.unwrap(Effect.promise(() => this.resolveModel()).pipe(Effect.map((model) => {
      const input = asInput(step.messages ?? step.prompt?.text ?? step.prompt ?? "");
      return streamCellAgent({
        model,
        modelId: this.modelId,
        messages: input.messages,
        system: [this.opts.instructions, step.system?.text, ...input.system.map((part) => part.text)].filter(Boolean),
        tools: { ...this.tools, ...(step.tools ?? {}) },
        modelParams: ModelRequest.GenerationParams.make({
          maxTokens: this.opts.maxOutputTokens,
          temperature: this.opts.temperature,
          topP: this.opts.topP,
        }),
        maxFrames: MAX_TOOL_STEPS,
        abortSignal: step.abortSignal,
        harnessStep: step,
        harnessHost: host,
      });
    })));
  }

  async resolveModel() {
    if (typeof this.opts.model !== "string") return this.opts.model;
    const envKey = this.family === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
    const apiKey = Redacted.make(this.opts.apiKey ?? envKey ?? "");
    const routeResult =
      this.family === "anthropic"
        ? Route.anthropic({ apiKey })
        : this.opts.baseURL
          ? OpenAICompatible.make({
              id: "openai-compatible",
              baseUrl: normalizeOpenAICompatibleBaseUrl(this.opts.baseURL),
              apiKey,
            })
          : Route.openai({ apiKey });
    const route = Result.getOrThrow(routeResult);
    return Effect.runPromise(
      Route.toModel(route).pipe(Effect.provide(RequestExecutor.layer), Effect.provide(NodeHttpClient.layerFetch)),
    );
  }

  /** @param {import("./BaseCliAgent/AgentGenerateOptions.ts").AgentGenerateOptions} [args] */
  async generate(args = {}) {
    const model = await this.resolveModel();
    const tools = { ...this.tools, ...(args.tools && typeof args.tools === "object" ? args.tools : {}) };
    const input = "messages" in args ? asInput(args.messages) : asInput(args.prompt);
    const system = [
      this.opts.instructions,
      ...input.system.map((part) => part.text),
      ...(args.outputSchema ? [structuredOutputInstruction(args.outputSchema).text] : []),
    ].filter(Boolean);
    const totalMs = timeoutOf(args.timeout, "totalMs");
    const stepMs = timeoutOf(args.timeout, "stepMs");
    const timeoutSignal = totalMs === undefined && stepMs === undefined ? undefined : AbortSignal.timeout(totalMs ?? stepMs);
    const signal = args.abortSignal && timeoutSignal ? AbortSignal.any([args.abortSignal, timeoutSignal]) : args.abortSignal ?? timeoutSignal;
    const run = await runCellAgent({
      model,
      modelId: this.modelId,
      messages: input.messages,
      system,
      tools,
      modelParams: ModelRequest.GenerationParams.make({
        maxTokens: this.opts.maxOutputTokens,
        temperature: this.opts.temperature,
        topP: this.opts.topP,
      }),
      maxFrames: MAX_TOOL_STEPS,
      abortSignal: signal,
      onToolExecutionStart: args.onToolExecutionStart,
      onToolExecutionEnd: args.onToolExecutionEnd,
      harnessStep: args.harnessStep,
      harnessHost: args.harnessHost,
    });
    const finalText = run.text;
    args.onStdout?.(finalText);
    const settled = run.events.filter((event) => event._tag === "model-settled");
    const generatedMessages = settled.map((event) => event.message);
    const callsById = new Map(run.events.filter((event) => event._tag === "cell-call-started").map((event) => {
      const id = `${event.call.identity.frame}:${event.call.identity.ordinal}`;
      return [id, { type: "tool-call", toolCallId: id, toolName: event.call.flowName, input: event.call.input }];
    }));
    const allToolCalls = [...callsById.values()];
    const allToolResults = run.events.filter((event) => event._tag === "cell-call-settled").map((event) => {
      const id = `${event.identity.frame}:${event.identity.ordinal}`;
      return { type: "tool-result", toolCallId: id, toolName: event.flowName, output: event.result.value, isError: event.result.outcome !== "success" };
    });
    const steps = settled.map((event, frame) => ({
      text: frame === settled.length - 1 ? finalText : "",
      content: event.message.content,
      toolCalls: allToolCalls.filter((call) => call.toolCallId.startsWith(`${frame}:`)),
      toolResults: allToolResults.filter((result) => result.toolCallId.startsWith(`${frame}:`)),
      finishReason: event.message.stopReason,
      usage: event.usage,
      response: { messages: [event.message] },
    }));
    for (const step of steps) await (args.onStepEnd ?? args.onStepFinish)?.(step);
    const totalUsage = settled.reduce((usage, event) => ({
      inputTokens: (usage.inputTokens ?? 0) + (event.usage?.inputTokens ?? 0),
      outputTokens: (usage.outputTokens ?? 0) + (event.usage?.outputTokens ?? 0),
      totalTokens: (usage.totalTokens ?? 0) + (event.usage?.totalTokens ?? 0),
    }), {});
    const output = await parseStructuredOutput(args.outputSchema, finalText);
    const result = buildGenerateResult(finalText, output, this.modelId, {
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      totalTokens: totalUsage.totalTokens ?? (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0),
    });
    result.finishReason = run.events.findLast((event) => event._tag === "resolved")?.message.stopReason ?? "stop";
    result.toolCalls = allToolCalls;
    result.staticToolCalls = allToolCalls;
    result.toolResults = allToolResults;
    result.staticToolResults = allToolResults;
    result.steps = steps;
    result.response.messages = generatedMessages;
    return result;
  }
}
