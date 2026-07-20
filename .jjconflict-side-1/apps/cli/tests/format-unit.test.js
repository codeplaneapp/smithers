import { describe, expect, test } from "bun:test";
import {
    colorizeEventText,
    formatAge,
    formatElapsedCompact,
    formatEventLine,
    formatRelativeOffset,
    formatTimestamp,
} from "../src/format.js";

const BASE = Date.UTC(2026, 0, 2, 3, 4, 5);

function event(type, payload = {}, overrides = {}) {
    return {
        runId: "run-format",
        seq: 1,
        timestampMs: BASE + 65_000,
        type,
        payloadJson: JSON.stringify(payload),
        ...overrides,
    };
}

describe("format helpers", () => {
    test("formats ages, elapsed durations, timestamps, and relative offsets", () => {
        const originalNow = Date.now;
        Date.now = () => BASE;
        try {
            expect(formatAge(BASE + 1)).toBe("just now");
            expect(formatAge(BASE - 30_000)).toBe("30s ago");
            expect(formatAge(BASE - 5 * 60_000)).toBe("5m ago");
            expect(formatAge(BASE - 2 * 60 * 60_000)).toBe("2h ago");
            expect(formatAge(BASE - 3 * 24 * 60 * 60_000)).toBe("3d ago");

            expect(formatElapsedCompact(BASE - 45_000)).toBe("45s");
            expect(formatElapsedCompact(BASE, BASE + 65_000)).toBe("1m 5s");
            expect(formatElapsedCompact(BASE, BASE + 2 * 60 * 60_000 + 3 * 60_000)).toBe("2h 3m");
            expect(formatTimestamp(BASE, BASE + 3_661_000)).toBe("01:01:01");
            expect(formatRelativeOffset(BASE, BASE - 1_000)).toBe("+00:00.000");
            expect(formatRelativeOffset(BASE, BASE + 65_432)).toBe("+01:05.432");
            expect(formatRelativeOffset(BASE, BASE + 3_661_007)).toBe("+01:01:01.007");
        }
        finally {
            Date.now = originalNow;
        }
    });

    test("colorizes event text by severity and category", () => {
        expect(colorizeEventText("NodeFailed", "bad")).toContain("bad");
        expect(colorizeEventText("RunFinished", "ok")).toContain("ok");
        expect(colorizeEventText("ApprovalRequested", "approval")).toContain("approval");
        expect(colorizeEventText("ToolCallStarted", "tool")).toContain("tool");
        expect(colorizeEventText("OpenApiToolCalled", "api")).toContain("api");
        expect(colorizeEventText("NodeStarted", "start")).toContain("start");
        expect(colorizeEventText("UnknownEvent", "plain")).toBe("plain");
    });

    test("formats known event lines", () => {
        const cases = [
            ["RunStarted", {}, "Run started"],
            ["RunStatusChanged", { status: "waiting" }, "Run status: waiting"],
            ["RunFinished", {}, "Run finished"],
            ["RunFailed", { error: "failed badly" }, "Run failed: failed badly"],
            ["RunCancelled", {}, "Run cancelled"],
            ["RunContinuedAsNew", { newRunId: "run-2", iteration: 3 }, "Continued as new: run-2"],
            ["RunHijackRequested", {}, "Hijack requested"],
            ["SandboxCreated", { sandboxId: "sb", runtime: "vm" }, "Sandbox created: sb (vm)"],
            ["SandboxShipped", { sandboxId: "sb", bundleSizeBytes: 42 }, "Sandbox shipped: sb (42 bytes)"],
            ["SandboxHeartbeat", { sandboxId: "sb" }, "Sandbox heartbeat: sb"],
            ["SandboxBundleReceived", { sandboxId: "sb", patchCount: 2 }, "Sandbox bundle received: sb (2 patches)"],
            ["SandboxCompleted", { sandboxId: "sb", status: "ok" }, "Sandbox completed: sb (ok)"],
            ["SandboxFailed", { sandboxId: "sb" }, "Sandbox failed: sb"],
            ["SandboxDiffReviewRequested", { sandboxId: "sb" }, "Sandbox diff review requested: sb"],
            ["SandboxDiffAccepted", { sandboxId: "sb" }, "Sandbox diffs accepted: sb"],
            ["SandboxDiffRejected", { sandboxId: "sb" }, "Sandbox diffs rejected: sb"],
            ["NodePending", { nodeId: "n", iteration: 2 }, "n pending (iteration 2)"],
            ["NodeStarted", { nodeId: "n", attempt: 3, iteration: 2 }, "n (attempt 3, iteration 2)"],
            ["TaskHeartbeat", { nodeId: "n", dataSizeBytes: 5 }, "n heartbeat (5 bytes)"],
            ["TaskHeartbeatTimeout", { nodeId: "n", timeoutMs: 500 }, "n heartbeat timeout (500ms)"],
            ["NodeFinished", { nodeId: "n", attempt: 2 }, "n (attempt 2)"],
            ["NodeFailed", { nodeId: "n", attempt: 2, error: "abcdef" }, "abcdef"],
            // Engine events serialize Error objects; the line must carry the
            // message, not "[object Object]".
            [
                "NodeFailed",
                { nodeId: "n", attempt: 1, error: { name: "Error", message: "connect ECONNRESET", stack: "..." } },
                "connect ECONNRESET",
            ],
            [
                "RunFailed",
                { error: { name: "Error", message: "Task failed: export", stack: "..." } },
                "Run failed: Task failed: export",
            ],
            ["NodeCancelled", { nodeId: "n" }, "n cancelled"],
            ["NodeSkipped", { nodeId: "n" }, "n skipped"],
            ["NodeRetrying", { nodeId: "n", attempt: 4 }, "n retrying (attempt 4)"],
            ["NodeWaitingApproval", { nodeId: "n" }, "n waiting for approval"],
            ["NodeWaitingTimer", { nodeId: "n" }, "Waiting for timer: n"],
            ["ApprovalRequested", { nodeId: "n" }, "Approval requested: n"],
            ["ApprovalGranted", { nodeId: "n" }, "Approved: n"],
            ["ApprovalAutoApproved", { nodeId: "n" }, "Auto-approved: n"],
            ["ApprovalDenied", { nodeId: "n" }, "Denied: n"],
            ["ToolCallStarted", { nodeId: "n", toolName: "bash", attempt: 2 }, "n → bash"],
            ["ToolCallFinished", { nodeId: "n", toolName: "bash", status: "success" }, "n ← bash (success)"],
            ["ScorerStarted", { nodeId: "n", scorerName: "Quality" }, "scorer Quality started"],
            ["ScorerFinished", { nodeId: "n", scorerId: "quality", score: 0.7 }, "scorer quality = 0.7"],
            ["ScorerFailed", { nodeId: "n", scorerName: "Quality" }, "scorer Quality failed"],
            ["TokenUsageReported", { nodeId: "n", model: "gpt", inputTokens: 10, outputTokens: 20 }, "n gpt in=10 out=20"],
            ["TimerCreated", { timerId: "t", firesAtMs: 0 }, "Timer created: t"],
            ["TimerFired", { timerId: "t", delayMs: 12 }, "Timer fired: t (delay 12ms)"],
            ["TimerCancelled", { timerId: "t" }, "Timer cancelled: t"],
            ["WorkflowReloadDetected", {}, "File change detected"],
            ["WorkflowReloaded", {}, "Workflow reloaded"],
            ["WorkflowReloadFailed", {}, "Workflow reload failed"],
            ["WorkflowReloadUnsafe", {}, "Workflow reload skipped: unsafe"],
            ["AgentEvent", { engine: "codex", event: { type: "action" } }, "codex: action"],
            ["FrameCommitted", { frameNo: 7 }, "Frame 7 committed"],
            ["SnapshotCaptured", { frameNo: 7 }, "Snapshot 7 captured"],
            ["RevertStarted", { nodeId: "n" }, "Revert started on n"],
            ["RevertFinished", { nodeId: "n", success: true }, "Revert finished on n"],
            ["RevertFinished", { nodeId: "n", success: false }, "Revert failed on n"],
            ["TimeTravelStarted", { nodeId: "n" }, "Time travel started on n"],
            ["TimeTravelFinished", { nodeId: "n", success: true }, "Time travel finished on n"],
            ["TimeTravelFinished", { nodeId: "n", success: false }, "Time travel failed on n"],
            ["OpenApiToolCalled", { method: "GET", path: "/v1", status: 200 }, "GET /v1 (200)"],
            ["MemoryFactSet", { namespace: "ns", key: "k" }, "Memory set ns/k"],
            ["MemoryRecalled", { resultCount: 3 }, "Memory recalled 3 results"],
            ["MemoryMessageSaved", { threadId: "thread" }, "Message saved to thread thread"],
        ];

        for (const [type, payload, expected] of cases) {
            expect(formatEventLine(event(type, payload), BASE)).toContain(expected);
        }

        expect(formatEventLine(event("NodeFailed", { nodeId: "n", error: "abcdef" }), BASE, { truncatePayloadAt: 5 })).toContain("ab...");
        expect(formatEventLine(event("RunHijacked", { mode: "conversation", engine: "codex" }), BASE)).toContain("Hijacked codex conversation");
        expect(formatEventLine(event("RunHijacked", { engine: "codex", resume: "abc" }), BASE)).toContain("Hijacked codex session abc");
        expect(formatEventLine(event("RunStatusChanged", {}), BASE)).toContain("unknown");
        expect(formatEventLine(event("TimerCreated", {}), BASE)).toContain("1970-01-01T00:00:00.000Z");
    });

    test("formats default and malformed event payloads", () => {
        expect(formatEventLine(event("CustomEvent", { a: 1 }), BASE, { includeTimestamp: false })).toBe('CustomEvent {"a":1}');
        expect(formatEventLine(event("StringEvent", "hello"), BASE, { includeTimestamp: false })).toBe("StringEvent hello");
        expect(formatEventLine({
            ...event("RawEvent"),
            payloadJson: "not json payload",
        }, BASE, { includeTimestamp: false, truncatePayloadAt: 8 })).toBe("RawEvent not j...");
        expect(formatEventLine({
            ...event("EmptyEvent"),
            payloadJson: "",
        }, BASE, { includeTimestamp: false })).toBe("EmptyEvent");
    });
});
