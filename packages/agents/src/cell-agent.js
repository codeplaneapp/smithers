import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as CellTurn from "@flows/harness/CellTurn";
import * as ContextWindow from "@flows/harness/ContextWindow";
import * as EngineLike from "@flows/harness/EngineLike";
import * as FlowBinding from "@flows/harness/FlowBinding";
import { HarnessError } from "@flows/harness/HarnessError";
import * as QuickJSSandbox from "@flows/harness/QuickJSSandbox";
import * as Steering from "@flows/harness/Steering";
import * as ModelRequest from "@flows/model/ModelRequest";
import * as ModelEvent from "@flows/model/ModelEvent";
import * as ApplyPatch from "@flows/std/ApplyPatch";
import * as Bash from "@flows/std/Bash";
import * as Edit from "@flows/std/Edit";
import * as Glob from "@flows/std/Glob";
import * as Grep from "@flows/std/Grep";
import * as LanguageServer from "@flows/std/LanguageServer";
import * as Ls from "@flows/std/Ls";
import * as Lsp from "@flows/std/Lsp";
import * as Read from "@flows/std/Read";
import * as WebFetch from "@flows/std/WebFetch";
import * as WebSearch from "@flows/std/WebSearch";
import * as Write from "@flows/std/Write";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import * as Path from "effect/Path";
import { z } from "zod";

const standardModules = [Read, Write, Edit, Bash, Grep, Glob, Ls, ApplyPatch, WebFetch, WebSearch, Lsp];

const nodePlatform = Layer.mergeAll(NodeFileSystem.layer, Path.layer);
const nodeServices = Layer.mergeAll(
  nodePlatform,
  Layer.provide(NodeChildProcessSpawner.layer, nodePlatform),
  NodeHttpClient.layerFetch,
  WebSearch.layerNoop,
  LanguageServer.layerNoop,
);

const bindStandard = (module) => FlowBinding.make({
  flow: module.flow,
  handler: (input) => module.run(input).pipe(Effect.provide(nodeServices)),
});

const schemaDocument = (schema) => {
  if (schema && typeof schema === "object" && "jsonSchema" in schema) return schema.jsonSchema;
  if (schema && typeof schema === "object" && "_zod" in schema) return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" });
  try {
    return Schema.toJsonSchemaDocument(schema);
  } catch {
    return {};
  }
};

const bindTool = (name, tool, options) => FlowBinding.make({
  flow: {
    name,
    description: tool.description ?? name,
    input: Schema.Unknown,
    output: Schema.Unknown,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  },
  inputDocument: schemaDocument(tool.inputSchema),
  outputDocument: {},
  handler: (input, call) => Effect.tryPromise({
    try: async () => {
      const toolCallId = `${call.identity.frame}:${call.identity.ordinal}`;
      const event = { callId: toolCallId, toolCall: { toolCallId, toolName: name, input } };
      await options.onToolExecutionStart?.(event);
      try {
        let parsed = input;
        if (typeof tool.inputSchema?.parseAsync === "function") parsed = await tool.inputSchema.parseAsync(input);
        else if (typeof tool.inputSchema?.validate === "function") {
          const validated = await tool.inputSchema.validate(input);
          if (validated?.success === false) throw validated.error;
          parsed = validated?.success === true ? validated.value : validated;
        }
        const value = await tool.execute(parsed, {
          abortSignal: options.abortSignal,
          toolCallId,
          harnessStep: options.harnessStep,
          harnessHost: options.harnessHost,
        });
        await options.onToolExecutionEnd?.({ ...event, result: value, isError: false });
        return value;
      } catch (error) {
        await options.onToolExecutionEnd?.({ ...event, result: error instanceof Error ? error.message : String(error), isError: true });
        throw error;
      }
    },
    catch: (cause) => cause,
  }),
});

const capabilityPattern = (value) => {
  const parts = value.split(":");
  return { action: `${parts[0]}:${parts[1]}`, resource: parts.slice(2).join(":") };
};

const resolvedText = (event) => event._tag === "resolved"
  ? event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
  : undefined;

const toolDefinitions = (tools) => Object.entries(tools)
  .filter(([, tool]) => typeof tool?.execute === "function")
  .map(([name, tool]) => ModelRequest.ToolDefinition.make({
    name,
    description: tool.description ?? name,
    parameters: schemaDocument(tool.inputSchema),
  }));

/**
 * Cell-native models emit fenced cells directly. This adapter only handles
 * provider-native final text/tool calls, keeping those providers on the same
 * CellTurn execution path instead of introducing a second tool loop.
 */
const cellModel = (model, definitions) => ({
  stream: (request) => Stream.unwrap(
    Stream.runCollect(model.stream(ModelRequest.ModelRequest.make({
      ...request,
      tools: [...request.tools, ...definitions],
    })).pipe(Stream.provideService(NodeHttpClient.Fetch, globalThis.fetch))).pipe(Effect.map((chunk) => {
      const events = Array.from(chunk);
      const settled = ModelEvent.settledMessage(events);
      const text = settled.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.includes("```cell")) return Stream.fromIterable(events);
      const calls = settled.message.content.filter((part) => part.type === "tool-call");
      const body = calls.length > 0
        ? `${calls.map((call, index) => `const result${index} = await ctx.call(${JSON.stringify(call.name)}, ${call.arguments || "{}"})`).join("\n")}
return { intent: "continue", state: ctx.state, context: [{ role: "user", text: ${JSON.stringify("Tool results: ")} + JSON.stringify([${calls.map((_, index) => `result${index}`).join(", ")}]) }] }`
        : `return { intent: "complete", state: ctx.state, output: ${JSON.stringify(text)} }`;
      const cell = `\`\`\`cell\n${body}\n\`\`\``;
      return Stream.fromIterable([
        ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "smithers-cell" }),
        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "smithers-cell", text: cell }),
        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "smithers-cell" }),
        ...(settled.usage ? [ModelEvent.ModelEvent.Usage(settled.usage)] : []),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: settled.message.stopReason }),
      ]);
    })),
  ),
});

/** The in-process CellHarness composition used by every built-in model run. */
const CellHarness = {
  run: ({ state, flows, port }) => CellTurn.run({ state, flows }).pipe(
    Stream.provideService(EngineLike.EngineLike, port),
    Stream.provide(Layer.merge(QuickJSSandbox.layer, Steering.layerNoop())),
  ),
};

/** Compose one live built-in-agent event stream. */
export const streamCellAgent = ({ model, modelId, messages = [], system = [], tools = {}, modelParams, maxFrames = 100, ...options }) => {
  const bindings = [
    ...standardModules.map(bindStandard),
    ...Object.entries(tools).filter(([, tool]) => typeof tool?.execute === "function").map(([name, tool]) => bindTool(name, tool, options)),
  ];
  const byName = new Map(bindings.map((binding) => [binding.descriptor.name, binding]));
  const flows = bindings.map((binding) => binding.descriptor);
  const envelope = [...new Set(flows.flatMap((flow) => flow.capabilities))].map(capabilityPattern);
  const opening = CellTurn.teach(ContextWindow.make({
    modelId,
    segments: [
      ...system.filter(Boolean).map((text) => ({ kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text })] })),
      { kind: "transcript", zone: "tail", content: messages },
    ],
  }), flows);
  const compatibleModel = cellModel(model, toolDefinitions(tools));
  const port = EngineLike.make({
    sealStep: (step) => compatibleModel.stream(step.request),
    splice: () => Stream.fail(new HarnessError({ code: "engine_failed", message: "The in-process cell agent does not splice plans" })),
    call: (call) => {
      const binding = byName.get(call.flowName);
      return binding
        ? binding.run(call)
        : Effect.fail(new HarnessError({ code: "engine_failed", message: `Unknown cell flow: ${call.flowName}` }));
    },
    record: (boundary) => boundary.execute,
    suspend: (reason) => Effect.fail(new HarnessError({ code: "suspended", message: reason.message, cause: reason })),
  });
  const state = CellTurn.make({
    session: options.session ?? crypto.randomUUID(),
    seat: modelId,
    modelParams: modelParams ?? ModelRequest.GenerationParams.make(),
    layers: ["smithers/in-process-cell"],
    capabilityEnvelope: envelope,
    placement: Option.none(),
    contextWindow: opening,
    maxFrames,
  });
  return CellHarness.run({ state, flows, port }).pipe(
    Stream.tap((event) => Effect.promise(async () => {
      await options.onEvent?.({ type: "harness-event", event });
    })),
  );
};

/** Run the built-in in-process agent exclusively through the flows cell loop. */
export const runCellAgent = async (options) => {
  const events = await Effect.runPromise(Stream.runCollect(streamCellAgent(options)), options.abortSignal ? { signal: options.abortSignal } : undefined)
    .then(Array.from);
  return { events, text: events.map(resolvedText).findLast((text) => text !== undefined) ?? "" };
};
