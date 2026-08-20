import { describe, expect, test } from "bun:test";
import * as AgentEvent from "@flows/harness/AgentEvent";
import * as ModelRequest from "@flows/model/ModelRequest";
import { Effect, Layer, Option, Stream } from "effect";
import { z } from "zod";
import {
  AmpAgent, AntigravityAgent, ClaudeCodeAgent, CodexAgent, CursorAgent, ForgeAgent, GeminiAgent,
  GrokAgent, HermesAgent, HermesCliAgent, KimiAgent, NanocodexAgent, OmpAgent, OpenClawAgent,
  OpenCodeAgent, PiAgent, agentLikeToHarness, harnessToAgentLike,
} from "../src/index.js";

const assistant = ModelRequest.Message.assistant("done", { stopReason: "stop" });
const identity = { session: "s", frame: 0, cell: "cell", ordinal: 0, declaration: "decl", layers: [] };
const effects = { tier: "sealed", reads: [], writes: [], mode: "hermetic", onConflict: "serialize" };
const transition = { _tag: "complete", state: null, output: "done" };

const events = [
  new AgentEvent.TurnOpened({ eventType: "flows.harness.turn-opened.v1", seat: "main", modelParams: {}, activeToolNames: [], contextDigest: "ctx" }),
  new AgentEvent.ModelDelta({ eventType: "flows.harness.model-delta.v1", delta: { type: "text-delta", id: "text", text: "done" } }),
  new AgentEvent.ModelSettled({ eventType: "flows.harness.model-settled.v1", message: assistant, usage: { totalTokens: 1 } }),
  new AgentEvent.Elaborated({ eventType: "flows.harness.elaborated.v1", batch: { children: [] } }),
  new AgentEvent.ChildProgress({ eventType: "flows.harness.child-progress.v1", progress: { _tag: "progress", callId: "call", message: "working" } }),
  new AgentEvent.ChildResult({ eventType: "flows.harness.child-result.v1", result: { callId: "call", outcome: "success", result: { type: "tool-result", toolCallId: "call", content: "ok", addedToolNames: [] } } }),
  new AgentEvent.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell: { language: "javascript", text: "return 1", digest: "cell" } }),
  new AgentEvent.CellCallStarted({ eventType: "flows.harness.cell-call-started.v1", call: { flowName: "flow", input: {}, capabilities: [], effects, placement: Option.none(), identity } }),
  new AgentEvent.CellCallSettled({ eventType: "flows.harness.cell-call-settled.v1", flowName: "flow", identity, result: { outcome: "success", value: "ok" } }),
  new AgentEvent.CellSettled({ eventType: "flows.harness.cell-settled.v1", cell: "cell", outcome: { _tag: "settled", transition } }),
  new AgentEvent.TransitionApplied({ eventType: "flows.harness.transition-applied.v1", transition }),
  new AgentEvent.Suspended({ eventType: "flows.harness.suspended.v1", reason: { code: "waiting-input", message: "wait" } }),
  new AgentEvent.CompactionSettled({ eventType: "flows.harness.compaction-settled.v1", replacedPrefixDigest: "old", summary: assistant }),
  new AgentEvent.SteeringDrained({ eventType: "flows.harness.steering-drained.v1", messages: [ModelRequest.Message.user("steer")] }),
  new AgentEvent.TurnClosed({ eventType: "flows.harness.turn-closed.v1", stopReason: "stop", outcome: "resolved" }),
  new AgentEvent.PermissionRequired({ eventType: "flows.harness.permission-required.v1", request: { _tag: "@smthrs/capability/PermissionRequired", code: "permission_required", requestId: "req", capability: { action: "fs:read", resource: "/tmp/x" }, tier: "sealed", meta: {} } }),
  new AgentEvent.ResumeToken({ eventType: "flows.harness.resume-token.v1", agentEngine: "third-party", agentResume: "token", discardResumeSession: false }),
  new AgentEvent.Aborted({ eventType: "flows.harness.aborted.v1", reason: "stopped" }),
  new AgentEvent.Resolved({ eventType: "flows.harness.resolved.v1", message: assistant }),
];

const step = {
  system: { text: "system" },
  instructions: [{ text: "instruction one" }, { text: "instruction two" }],
  prompt: { text: "prompt" },
};
const host = {};
const collect = (stream) => Effect.runPromise(Stream.runCollect(stream)).then(Array.from);
const resolvedText = (message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join("");

describe("Harness/AgentLike adapter", () => {
  test("translates the complete declared prompt and propagates cancellation", async () => {
    let received;
    let aborted = false;
    const agent = {
      generate(options) {
        received = options;
        options.onStdout("started");
        return new Promise((_, reject) => options.abortSignal.addEventListener("abort", () => {
          aborted = true;
          reject(options.abortSignal.reason);
        }, { once: true }));
      },
    };

    await Effect.runPromise(Stream.runDrain(Stream.take(agentLikeToHarness(agent).run(step, host), 1)));
    await Promise.resolve();

    expect(received.messages).toEqual([
      { role: "system", content: "system\n\ninstruction one\n\ninstruction two" },
      { role: "user", content: "prompt" },
    ]);
    expect(received.harnessStep).toBe(step);
    expect(received.harnessHost).toBe(host);
    expect(aborted).toBe(true);
  });

  test("every CLI-driven first-class adapter runs through the Harness contract", async () => {
    const adapters = [
      ClaudeCodeAgent, CodexAgent, GeminiAgent, OpenCodeAgent, AmpAgent, CursorAgent, GrokAgent,
      KimiAgent, HermesAgent, HermesCliAgent, AntigravityAgent, OmpAgent, OpenClawAgent, PiAgent,
      NanocodexAgent, ForgeAgent,
    ];
    for (const Adapter of adapters) {
      const agent = Object.create(Adapter.prototype);
      agent.generate = async (options) => {
        expect(options.messages[0].content).toContain("instruction one");
        return { text: Adapter.name };
      };
      const result = await collect(agent.run(step, host));
      expect(result.map((event) => event._tag)).toEqual([
        "turn-opened", "model-settled", "turn-closed", "resolved",
      ]);
      expect(resolvedText(result.at(-1).message)).toBe(Adapter.name);
    }
  });

  test("CLI harnesses project legacy usage into canonical model settlement", async () => {
    const agent = Object.create(CodexAgent.prototype);
    agent.generate = async () => ({
      text: "done",
      usage: Promise.resolve({
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 2,
        totalTokens: 14,
        inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 1 },
      }),
    });

    const result = await collect(agent.run(step, host));

    expect(result.find((event) => event._tag === "model-settled").usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 2,
      totalTokens: 14,
      cachedInputTokens: 3,
      cacheWriteTokens: 1,
    });
  });

  test("legacy onEvent checkpoints open the turn before forwarding without stdout", async () => {
    const checkpoint = { codec: "third-party", version: 1, payload: { cursor: 2 } };
    const checkpointEvent = new AgentEvent.ResumeToken({
      eventType: "flows.harness.resume-token.v1",
      agentEngine: "smithers-agent-checkpoint",
      agentResume: JSON.stringify(checkpoint),
      discardResumeSession: false,
    });
    const agent = {
      async generate({ onEvent }) {
        onEvent({ type: "harness-event", event: checkpointEvent });
        return { text: "done", checkpoint };
      },
    };

    const result = await collect(agentLikeToHarness(agent).run(step, host));

    expect(result.map((event) => event._tag)).toEqual([
      "turn-opened", "resume-token", "model-settled", "turn-closed", "resolved",
    ]);
    expect(result[1]).toBe(checkpointEvent);
  });

  test("harnessToAgentLike forwards every concrete AgentEvent as it arrives", async () => {
    const seen = [];
    const agent = harnessToAgentLike({ run: () => Stream.fromIterable(events) });
    const result = await agent.generate({ harnessStep: step, harnessHost: host, onEvent: ({ event }) => seen.push(event) });
    expect(seen).toEqual(events);
    expect(result.text).toBe("done");
    events.forEach((event, index) => expect(seen[index]).toBeInstanceOf(event.constructor));
  });

  test("agentLikeToHarness streams every concrete AgentEvent without buffering", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const agent = {
      async generate({ onEvent }) {
        for (const event of events) onEvent({ type: "harness-event", event });
        await gate;
        return { text: "ignored" };
      },
    };
    const streamed = [];
    let sawEvent;
    const firstEvent = new Promise((resolve) => { sawEvent = resolve; });
    const running = Effect.runPromise(Stream.runForEach(agentLikeToHarness(agent).run(step, host), (event) => Effect.sync(() => {
      streamed.push(event);
      sawEvent();
    })));
    await firstEvent;
    expect(streamed.length).toBeGreaterThan(0);
    release();
    await running;
    expect(streamed).toEqual(events);
  });

  test("composed adapters preserve step, host, and every concrete AgentEvent", async () => {
    let receivedStep;
    let receivedHost;
    const harness = {
      run(actualStep, actualHost) {
        receivedStep = actualStep;
        receivedHost = actualHost;
        return Stream.fromIterable(events);
      },
    };

    const roundTripped = await collect(agentLikeToHarness(harnessToAgentLike(harness)).run(step, host));

    expect(receivedStep).toBe(step);
    expect(receivedHost).toBe(host);
    expect(roundTripped).toEqual(events);
    events.forEach((event, index) => expect(roundTripped[index]).toBeInstanceOf(event.constructor));
  });

  test("composed adapters preserve a Smithers checkpoint event exactly once", async () => {
    const checkpoint = { codec: "third-party", version: 3, payload: { cursor: 9 } };
    const checkpointEvent = new AgentEvent.ResumeToken({
      eventType: "flows.harness.resume-token.v1",
      agentEngine: "smithers-agent-checkpoint",
      agentResume: JSON.stringify(checkpoint),
      discardResumeSession: false,
    });
    const originalEvents = [checkpointEvent, events.at(-1)];
    const harness = { run: () => Stream.fromIterable(originalEvents) };

    const roundTripped = await collect(agentLikeToHarness(harnessToAgentLike(harness)).run(step, host));

    expect(roundTripped).toEqual(originalEvents);
    expect(roundTripped[0]).toBe(checkpointEvent);
  });

  test("legacy generate calls preserve tools, structured output, checkpoints, and callbacks", async () => {
    const tools = { inspect: { description: "inspect", execute: () => "ok" } };
    const checkpoint = { codec: "third-party", version: 1, payload: { cursor: 3 } };
    let receivedStep;
    let publishedCheckpoint;
    let started = 0;
    let settled = 0;
    const harness = {
      run(actualStep) {
        receivedStep = actualStep;
        return Stream.fromIterable([
          events.find((event) => event._tag === "cell-call-started"),
          events.find((event) => event._tag === "cell-call-settled"),
          new AgentEvent.ResumeToken({ eventType: "flows.harness.resume-token.v1", agentEngine: "smithers-agent-checkpoint", agentResume: JSON.stringify(checkpoint), discardResumeSession: false }),
          new AgentEvent.Resolved({ eventType: "flows.harness.resolved.v1", message: ModelRequest.Message.assistant('{"answer":42}') }),
        ]);
      },
    };
    const options = {
      prompt: "solve",
      tools,
      outputSchema: z.object({ answer: z.number() }),
      resumeCheckpoint: checkpoint,
      checkpointMode: "resume",
      onCheckpoint: async (value) => { publishedCheckpoint = value; },
      onToolExecutionStart: () => { started += 1; },
      onToolExecutionEnd: () => { settled += 1; },
    };

    const result = await harnessToAgentLike(harness).generate(options);

    expect(receivedStep.input).toEqual({ _tag: "@smthrs/agents/harness-bridge.v1" });
    expect(receivedStep.activeToolNames).toEqual(["inspect"]);
    expect(receivedStep.toolDefinitions).toEqual([
      ModelRequest.ToolDefinition.make({ name: "inspect", description: "inspect", parameters: {} }),
    ]);
    expect(result.output).toEqual({ answer: 42 });
    expect(result.checkpoint).toEqual(checkpoint);
    expect(publishedCheckpoint).toEqual(checkpoint);
    expect(started).toBe(1);
    expect(settled).toBe(1);
  });

  test("legacy result checkpoints survive both adapters", async () => {
    const checkpoint = { codec: "third-party", version: 2, payload: ["state"] };
    const original = { async generate(options) {
      expect(options.tools.inspect).toBeDefined();
      expect(options.outputSchema).toBeDefined();
      return { text: '{"ok":true}', checkpoint };
    } };
    const roundTrip = harnessToAgentLike(agentLikeToHarness(original));
    const result = await roundTrip.generate({
      prompt: "go",
      tools: { inspect: { execute: () => "ok" } },
      outputSchema: z.object({ ok: z.boolean() }),
    });
    expect(result.output).toEqual({ ok: true });
    expect(result.checkpoint).toEqual(checkpoint);
  });

  test("configured tools and engine resume state reach AgentLike on the ordinary HostLike path", async () => {
    const checkpoint = { codec: "flows", version: 2, payload: ["resume"] };
    let execution;
    const agent = {
      tools: { lookup: { execute: async ({ id }) => ({ id, found: true }) } },
      async generate(options) {
        execution = await options.tools.lookup.execute({ id: 7 });
        expect(options.resumeCheckpoint).toEqual(checkpoint);
        expect(options.checkpointMode).toBe("fork");
        return { text: "used harness host" };
      },
    };
    const result = await harnessToAgentLike(agentLikeToHarness(agent, {
      resumeCheckpoint: checkpoint,
      checkpointMode: "fork",
    })).generate({ harnessStep: step, harnessHost: host });

    expect(execution).toEqual({ id: 7, found: true });
    expect(result.text).toBe("used harness host");
  });

  test("conventional third-party AgentLike diagnostics, tools, and rich result survive both adapters", async () => {
    const diagnostic = { type: "action", action: "read", phase: "completed", detail: { path: "src/a.js" } };
    const toolCall = { type: "tool-call", toolCallId: "call-7", toolName: "inspect", input: { path: "src/a.js" } };
    const toolResult = { type: "tool-result", toolCallId: "call-7", toolName: "inspect", output: { lines: 4 }, isError: false };
    const usage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
    const rich = {
      text: "complete",
      output: { answer: 42 },
      toolCalls: [toolCall],
      staticToolCalls: [toolCall],
      toolResults: [toolResult],
      staticToolResults: [toolResult],
      steps: [{ text: "complete", toolCalls: [toolCall], toolResults: [toolResult], usage, finishReason: "stop" }],
      usage,
      totalUsage: usage,
      finishReason: "stop",
      response: { id: "response-1", modelId: "third-party", messages: [{ role: "assistant", content: "complete" }] },
      warnings: [{ type: "unsupported-setting", setting: "temperature" }],
      providerMetadata: { vendor: { traceId: "trace-9" } },
    };
    const original = {
      async generate(options) {
        options.onStderr("debug line\n");
        await options.onEvent(diagnostic);
        await options.onToolExecutionStart({ callId: "call-7", toolCall });
        await options.onToolExecutionEnd({ callId: "call-7", toolCall, toolResult });
        return rich;
      },
    };
    const stderr = [];
    const diagnostics = [];
    const starts = [];
    const ends = [];
    const result = await harnessToAgentLike(agentLikeToHarness(original)).generate({
      prompt: "inspect",
      onStderr: (value) => stderr.push(value),
      onEvent: (value) => { if (value.type !== "harness-event") diagnostics.push(value); },
      onToolExecutionStart: (value) => starts.push(value),
      onToolExecutionEnd: (value) => ends.push(value),
    });

    expect(stderr).toEqual(["debug line\n"]);
    expect(diagnostics).toEqual([diagnostic]);
    expect(starts).toEqual([{ callId: "call-7", toolCall }]);
    expect(ends).toEqual([{ callId: "call-7", toolCall, toolResult }]);
    for (const [key, value] of Object.entries(rich)) expect(result[key]).toEqual(value);
  });

  test("harness interruption follows the legacy abort signal", async () => {
    let interrupted = false;
    const harness = { run: () => Stream.never.pipe(Stream.ensuring(Effect.sync(() => { interrupted = true; }))) };
    const controller = new AbortController();
    const running = harnessToAgentLike(harness).generate({ prompt: "wait", abortSignal: controller.signal });
    controller.abort();
    await expect(running).rejects.toThrow();
    expect(interrupted).toBe(true);
  });
});
