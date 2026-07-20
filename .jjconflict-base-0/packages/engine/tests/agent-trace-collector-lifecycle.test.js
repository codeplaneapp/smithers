import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTraceCollector } from "../src/AgentTraceCollector.js";

class FakeEventBus extends EventEmitter {
    emitted = [];

    async emitEventQueued(event) {
        this.emitted.push(event);
    }
}

function makeCollector(overrides = {}) {
    const eventBus = overrides.eventBus ?? new FakeEventBus();
    return new AgentTraceCollector({
        eventBus,
        runId: "run-1",
        workflowPath: "/tmp/workflow.tsx",
        workflowHash: "hash",
        cwd: process.cwd(),
        nodeId: "task",
        iteration: 2,
        attempt: 3,
        agent: overrides.agent ?? { id: "plain-cli" },
        agentId: "plain-cli",
        model: "test-model",
        annotations: { keep: "yes", nested: { drop: true } },
        logDir: overrides.logDir,
    });
}

describe("AgentTraceCollector lifecycle and persistence", () => {
    const tempDirs = [];

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("registers and unregisters its event listener", () => {
        const eventBus = new FakeEventBus();
        const collector = makeCollector({ eventBus });

        collector.begin();
        expect(eventBus.listenerCount("event")).toBe(1);
        collector.endListener();
        expect(eventBus.listenerCount("event")).toBe(0);
    });

    test("observes matching Smithers tool and usage events while ignoring other attempts", () => {
        const eventBus = new FakeEventBus();
        const collector = makeCollector({ eventBus });
        collector.begin();

        eventBus.emit("event", {
            type: "ToolCallStarted",
            runId: "run-1",
            nodeId: "task",
            iteration: 2,
            attempt: 3,
            toolCallId: "tool-1",
            toolName: "read",
        });
        eventBus.emit("event", {
            type: "TokenUsageReported",
            runId: "run-1",
            nodeId: "other",
            iteration: 2,
            attempt: 3,
            model: "ignored",
            agent: "ignored",
            inputTokens: 99,
        });
        eventBus.emit("event", {
            type: "ToolCallFinished",
            runId: "run-1",
            nodeId: "task",
            iteration: 2,
            attempt: 3,
            toolCallId: "tool-1",
            toolName: "read",
            status: "error",
        });

        expect(collector.events.map((event) => event.event.kind)).toEqual([
            "tool.execution.start",
            "tool.execution.end",
        ]);
        expect(collector.expectedKinds.has("tool.execution.end")).toBe(true);
        expect(collector.events[1].payload.isError).toBe(true);
    });

    test("flush persists ndjson, emits trace events and rewrites summary with artifact refs", async () => {
        const logDir = mkdtempSync(join(tmpdir(), "smithers-agent-trace-"));
        tempDirs.push(logDir);
        const eventBus = new FakeEventBus();
        const collector = makeCollector({ eventBus, logDir });

        collector.onStdout("raw stdout");
        collector.observeResult({ text: "final answer", usage: { inputTokens: 4, outputTokens: 5 } });
        await collector.flush();

        const summaryEvent = eventBus.emitted.find((event) => event.type === "AgentTraceSummary");
        expect(summaryEvent.summary.traceCompleteness).toBe("final-only");
        expect(summaryEvent.summary.rawArtifactRefs).toHaveLength(1);

        const artifactPath = summaryEvent.summary.rawArtifactRefs[0];
        const lines = readFileSync(artifactPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(lines.at(-1).summary.rawArtifactRefs).toEqual([artifactPath]);
        expect(lines.some((line) => line.event?.kind === "artifact.created")).toBe(true);
        expect(eventBus.emitted.filter((event) => event.type === "AgentTraceEvent").map((event) => event.trace.event.kind)).toContain("assistant.message.final");
    });

    test("flush records truncated structured streams as capture failures without writing artifacts when logDir is absent", async () => {
        const eventBus = new FakeEventBus();
        const collector = makeCollector({
            eventBus,
            agent: { id: "codex", jsonStream: true },
        });

        collector.onStdout('{"type":"assistant_message_delta","delta":"partial"');
        await collector.flush();

        const summaryEvent = eventBus.emitted.find((event) => event.type === "AgentTraceSummary");
        expect(collector.failures.at(-1)).toContain("truncated structured stream");
        expect(summaryEvent.summary.traceCompleteness).toBe("capture-failed");
        expect(summaryEvent.summary.rawArtifactRefs).toEqual([]);
        expect(eventBus.emitted.some((event) => event.type === "AgentTraceEvent" && event.trace.event.kind === "capture.error")).toBe(true);
    });
});
