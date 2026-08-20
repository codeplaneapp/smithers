import { describe, expect, test } from "bun:test";
import * as AgentEvent from "@flows/harness/AgentEvent";
import * as ModelRequest from "@flows/model/ModelRequest";
import { Effect, Option, Stream } from "effect";
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
      expect(resolvedText(result.at(-1).message)).toBe(Adapter.name);
    }
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
});
