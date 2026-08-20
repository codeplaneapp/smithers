import * as ModelEvent from "@flows/model/ModelEvent";
import * as ModelRequest from "@flows/model/ModelRequest";
import * as OpenAICompatible from "@flows/model/OpenAICompatible";
import * as RequestExecutor from "@flows/model/RequestExecutor";
import * as Route from "@flows/model/Route";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { Effect, Redacted, Result, Stream } from "effect";
import { z } from "zod";
import { buildGenerateResult } from "./BaseCliAgent/buildGenerateResult.js";
import { runAgentLikeHarness } from "./harness-adapter.js";

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
const combineSignals = (...signals) => {
  const defined = signals.filter(Boolean);
  if (defined.length === 0) return undefined;
  return defined.length === 1 ? defined[0] : AbortSignal.any(defined);
};

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

/**
 * Tool input schemas arrive in two shapes. A Zod schema validates through
 * `parseAsync`, while `zodSchema()`/`jsonSchema()` wrappers expose a
 * `validate` that returns a `{ success, value }` result instead of throwing.
 * Unwrapping the result matters: the tool must see its arguments, not the
 * envelope around them.
 * @param {any} schema @param {unknown} input @param {string} toolName
 */
const validateToolInput = async (schema, input, toolName) => {
  if (!schema) return input;
  if (typeof schema.parseAsync === "function") return schema.parseAsync(input);
  if (typeof schema.validate === "function") {
    const result = await schema.validate(input);
    if (!result || typeof result !== "object" || !("success" in result)) return result;
    if (result.success) return result.value;
    throw result.error instanceof Error
      ? result.error
      : new Error(`Tool ${toolName} received arguments that failed schema validation`);
  }
  return input;
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
    return runAgentLikeHarness(this, {
      ...step,
      system: step.system ?? { text: "", digest: "" },
      instructions: step.instructions ?? [],
      prompt: step.prompt ?? { text: "", digest: "" },
    }, host);
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
    const definitions = Object.entries(tools).map(([name, value]) =>
      ModelRequest.ToolDefinition.make({
        name,
        description: value.description ?? name,
        parameters: schemaJson(value.inputSchema),
      }),
    );
    const input = "messages" in args ? asInput(args.messages) : asInput(args.prompt);
    const system = [
      ...(this.opts.instructions ? [ModelRequest.SystemPart.make({ text: this.opts.instructions })] : []),
      ...input.system,
      ...(args.outputSchema ? [structuredOutputInstruction(args.outputSchema)] : []),
    ];
    const totalMs = timeoutOf(args.timeout, "totalMs");
    const stepMs = timeoutOf(args.timeout, "stepMs");
    const totalSignal = totalMs === undefined ? undefined : AbortSignal.timeout(totalMs);
    const generatedMessages = [];
    let messages = [...input.messages];
    let request;
    let finalSettled;
    let finalText = "";
    const allToolCalls = [];
    const allToolResults = [];
    const steps = [];
    const totalUsage = {};
    const onStepEnd = args.onStepEnd ?? args.onStepFinish;

    // Each turn settles with tool calls or a final answer. Interrupting
    // runPromise interrupts the stream fiber and cancels the provider request.
    for (let stepIndex = 0; stepIndex < MAX_TOOL_STEPS; stepIndex += 1) {
      request = ModelRequest.ModelRequest.make({
        modelId: this.modelId,
        system,
        messages,
        tools: definitions,
        params: ModelRequest.GenerationParams.make({
          maxTokens: this.opts.maxOutputTokens,
          temperature: this.opts.temperature,
          topP: this.opts.topP,
        }),
      });
      const values = [];
      const stepSignal = stepMs === undefined ? undefined : AbortSignal.timeout(stepMs);
      const signal = combineSignals(args.abortSignal, totalSignal, stepSignal);
      await Effect.runPromise(
        model.stream(request).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              values.push(event);
              if (event.type === "text-delta") args.onStdout?.(event.text);
            }),
          ),
          Effect.provideService(NodeHttpClient.Fetch)(globalThis.fetch),
        ),
        signal ? { signal } : undefined,
      );

      const settled = ModelEvent.settledMessage(values);
      finalSettled = settled;
      finalText = settled.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      Object.assign(totalUsage, settled.usage);
      const calls = settled.message.content.filter((part) => part.type === "tool-call");
      const stepToolCalls = calls.map((call) => ({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        input: parseJson(call.arguments).value ?? {},
      }));
      const stepToolResults = [];
      messages.push(settled.message);
      generatedMessages.push(settled.message);

      if (calls.length > 0) {
        const results = [];
        for (const call of calls) {
          const tool = tools[call.name];
          const parsedArguments = parseJson(call.arguments);
          const toolCall = {
            toolCallId: call.id,
            toolName: call.name,
            input: parsedArguments.value ?? {},
          };
          const event = { callId: call.id, toolCall };
          await args.onToolExecutionStart?.(event);
          let value;
          let isError = false;
          try {
            if (!tool?.execute) throw new Error(`Tool ${call.name} is not executable`);
            if (!parsedArguments.ok) throw new Error(`Tool ${call.name} received invalid JSON arguments`);
            const parsed = await validateToolInput(tool.inputSchema, parsedArguments.value, call.name);
            value = await tool.execute(parsed, {
              abortSignal: signal,
              toolCallId: call.id,
              messages,
              harnessStep: args.harnessStep,
              harnessHost: args.harnessHost,
            });
          } catch (error) {
            isError = true;
            value = error instanceof Error ? error.message : String(error);
          }
          const resultPart = ModelRequest.ToolResultPart.make({
            toolCallId: call.id,
            content: jsonText(value),
          });
          results.push(resultPart);
          const toolResult = {
            type: "tool-result",
            toolCallId: call.id,
            toolName: call.name,
            output: value,
            isError,
          };
          stepToolResults.push(toolResult);
          await args.onToolExecutionEnd?.({ ...event, result: value, isError });
        }
        const toolMessage = ModelRequest.Message.tool(results);
        messages.push(toolMessage);
        generatedMessages.push(toolMessage);
      }

      const step = {
        text: finalText,
        content: settled.message.content,
        toolCalls: stepToolCalls,
        toolResults: stepToolResults,
        finishReason: settled.message.stopReason,
        usage: settled.usage,
        response: { messages: [settled.message] },
      };
      steps.push(step);
      allToolCalls.push(...stepToolCalls);
      allToolResults.push(...stepToolResults);
      await onStepEnd?.(step);
      if (calls.length === 0) break;
      if (stepIndex === MAX_TOOL_STEPS - 1) {
        throw new SmithersError("AGENT_EXECUTION_FAILED", `ModelAgent exceeded ${MAX_TOOL_STEPS} tool steps.`, {});
      }
    }

    const output = await parseStructuredOutput(args.outputSchema, finalText);
    const result = buildGenerateResult(finalText, output, request.modelId, {
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      totalTokens: totalUsage.totalTokens ?? (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0),
    });
    result.finishReason = finalSettled.message.stopReason;
    result.toolCalls = allToolCalls;
    result.staticToolCalls = allToolCalls;
    result.toolResults = allToolResults;
    result.staticToolResults = allToolResults;
    result.steps = steps;
    result.response.messages = generatedMessages;
    return result;
  }
}
