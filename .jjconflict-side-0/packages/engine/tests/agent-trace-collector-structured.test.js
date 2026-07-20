import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { AgentTraceCollector } from "../src/AgentTraceCollector.js";

class FakeEventBus extends EventEmitter {
    emitted = [];

    async emitEventQueued(event) {
        this.emitted.push(event);
    }
}

function makeCollector() {
    return new AgentTraceCollector({
        eventBus: new FakeEventBus(),
        runId: "run-1",
        workflowPath: "/tmp/workflow.tsx",
        workflowHash: "hash",
        cwd: process.cwd(),
        nodeId: "task",
        iteration: 0,
        attempt: 1,
        agent: { id: "codex-agent" },
        agentId: "codex-agent",
        model: "codex-test",
        annotations: { keep: "yes", drop: { nested: true } },
    });
}

describe("AgentTraceCollector structured capture", () => {
    test("processes structured stdout, normalized batches and provider rows", () => {
        const collector = makeCollector();

        collector.processStructuredStdoutLine("{not json");
        expect(collector.failures.at(-1)).toContain("malformed upstream JSON");
        expect(collector.events.at(-1).event.kind).toBe("capture.error");

        const delta = { type: "assistant_message_delta", delta: "hello", thread_id: "thread-1" };
        collector.processStructuredStdoutLine(JSON.stringify(delta));
        expect(collector.finalText).toBe("hello");
        expect(collector.sessionEvents.at(-1).source.providerThreadId).toBe("thread-1");

        collector.observeProviderSessionRow(delta, "live");
        expect(collector.sessionEvents.filter((event) => event.raw?.type === "assistant_message_delta").length).toBe(1);

        collector.processStructuredStdoutLine(JSON.stringify({
            type: "assistant_message_end",
            message: { role: "assistant", content: "final answer" },
            thread_id: "thread-2",
        }));
        expect(collector.finalText).toBe("final answer");

        collector.emitObservedBatch({
            expectedKinds: ["tool.execution.end"],
            events: [
                {
                    kind: "tool.execution.start",
                    payload: { toolName: "read" },
                    raw: { type: "tool" },
                    rawType: "tool",
                    observed: true,
                },
                {
                    kind: "usage",
                    payload: { inputTokens: 1, outputTokens: 2 },
                    raw: { usage: true },
                    rawType: "usage",
                    observed: false,
                },
            ],
        }, "manual:1");

        expect(collector.expectedKinds.has("tool.execution.end")).toBe(true);
        expect(collector.events.some((event) => event.event.kind === "tool.execution.start" && event.source.observed)).toBe(true);
        expect(collector.events.some((event) => event.event.kind === "usage" && !event.source.observed)).toBe(true);
        expect(collector.annotations).toEqual({ keep: "yes" });
    });
});
