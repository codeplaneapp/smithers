import { describe, expect, test } from "bun:test";
import { Gateway } from "../src/gateway.js";

// mapEvent is a pure switch on event.type — test each case directly on a
// minimal Gateway instance (no server started, no DB needed).
const gateway = new Gateway({ auth: { mode: "token", tokens: {} } });

describe("Gateway.mapEvent — SmithersEvent→wire mapping", () => {
    test("NodePending → node.pending", () => {
        const result = gateway.mapEvent({
            type: "NodePending",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 0,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "node.pending",
            payload: { runId: "run-1", nodeId: "node-1", state: "pending", iteration: 0 },
        });
    });

    test("NodeStarted → node.started", () => {
        const result = gateway.mapEvent({
            type: "NodeStarted",
            runId: "run-1",
            nodeId: "node-1",
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "node.started",
            payload: { runId: "run-1", nodeId: "node-1", state: "in-progress" },
        });
    });

    test("NodeFinished → node.finished", () => {
        const result = gateway.mapEvent({
            type: "NodeFinished",
            runId: "run-1",
            nodeId: "node-1",
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "node.finished",
            payload: { runId: "run-1", nodeId: "node-1", state: "finished" },
        });
    });

    test("NodeFailed → node.failed", () => {
        const err = { message: "boom" };
        const result = gateway.mapEvent({
            type: "NodeFailed",
            runId: "run-1",
            nodeId: "node-1",
            error: err,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "node.failed",
            payload: { runId: "run-1", nodeId: "node-1", state: "failed", error: err },
        });
    });

    test("NodeSkipped → node.skipped", () => {
        const result = gateway.mapEvent({
            type: "NodeSkipped",
            runId: "run-1",
            nodeId: "node-1",
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "node.skipped",
            payload: { runId: "run-1", nodeId: "node-1", state: "skipped" },
        });
    });

    test("NodeCancelled → node.cancelled", () => {
        const result = gateway.mapEvent({
            type: "NodeCancelled",
            runId: "run-1",
            nodeId: "node-1",
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "node.cancelled",
            payload: { runId: "run-1", nodeId: "node-1", state: "cancelled" },
        });
    });

    test("NodeRetrying → node.retrying", () => {
        const result = gateway.mapEvent({
            type: "NodeRetrying",
            runId: "run-1",
            nodeId: "node-1",
            attempt: 2,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "node.retrying",
            payload: { runId: "run-1", nodeId: "node-1", state: "in-progress", attempt: 2 },
        });
    });

    test("NodeOutput → task.output", () => {
        const result = gateway.mapEvent({
            type: "NodeOutput",
            runId: "run-1",
            nodeId: "node-1",
            text: "hello",
            stream: "stdout",
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "task.output",
            payload: { runId: "run-1", nodeId: "node-1", output: "hello", stream: "stdout" },
        });
    });

    test("ApprovalRequested → approval.requested", () => {
        const result = gateway.mapEvent({
            type: "ApprovalRequested",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 1,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "approval.requested",
            payload: { runId: "run-1", nodeId: "node-1", iteration: 1 },
        });
    });

    test("ApprovalGranted → approval.decided approved=true", () => {
        const result = gateway.mapEvent({
            type: "ApprovalGranted",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 1,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "approval.decided",
            payload: { runId: "run-1", nodeId: "node-1", iteration: 1, approved: true },
        });
    });

    test("ApprovalAutoApproved → approval.auto_approved", () => {
        const result = gateway.mapEvent({
            type: "ApprovalAutoApproved",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 1,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "approval.auto_approved",
            payload: { runId: "run-1", nodeId: "node-1", iteration: 1 },
        });
    });

    test("ApprovalDenied → approval.decided approved=false", () => {
        const result = gateway.mapEvent({
            type: "ApprovalDenied",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 1,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "approval.decided",
            payload: { runId: "run-1", nodeId: "node-1", iteration: 1, approved: false },
        });
    });

    test("TaskHeartbeat → task.heartbeat", () => {
        const result = gateway.mapEvent({
            type: "TaskHeartbeat",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 0,
            attempt: 1,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "task.heartbeat",
            payload: { runId: "run-1", nodeId: "node-1", iteration: 0, attempt: 1 },
        });
    });

    test("NodeWaitingApproval → node.waiting_approval", () => {
        const result = gateway.mapEvent({
            type: "NodeWaitingApproval",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 2,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "node.waiting_approval",
            payload: { runId: "run-1", nodeId: "node-1", state: "waiting", iteration: 2 },
        });
    });

    test("NodeWaitingTimer → node.waiting_timer", () => {
        const result = gateway.mapEvent({
            type: "NodeWaitingTimer",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 3,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "node.waiting_timer",
            payload: { runId: "run-1", nodeId: "node-1", state: "waiting", iteration: 3 },
        });
    });

    test("AgentEvent → agent.event", () => {
        const agentEvt = { type: "text", text: "hi" };
        const result = gateway.mapEvent({
            type: "AgentEvent",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 0,
            attempt: 1,
            engine: "claude",
            event: agentEvt,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "agent.event",
            payload: {
                runId: "run-1",
                nodeId: "node-1",
                iteration: 0,
                attempt: 1,
                engine: "claude",
                event: agentEvt,
            },
        });
    });

    test("AgentSessionEvent → agent.session", () => {
        const transcript = [{ role: "user", content: "hello" }];
        const result = gateway.mapEvent({
            type: "AgentSessionEvent",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 0,
            attempt: 1,
            transcript,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "agent.session",
            payload: {
                runId: "run-1",
                nodeId: "node-1",
                iteration: 0,
                attempt: 1,
                transcript,
            },
        });
    });

    test("AgentTraceEvent → agent.trace", () => {
        const trace = { steps: [] };
        const result = gateway.mapEvent({
            type: "AgentTraceEvent",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 0,
            attempt: 1,
            trace,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "agent.trace",
            payload: {
                runId: "run-1",
                nodeId: "node-1",
                iteration: 0,
                attempt: 1,
                trace,
            },
        });
    });

    test("AgentTraceSummary → agent.trace_summary", () => {
        const summary = "did stuff";
        const result = gateway.mapEvent({
            type: "AgentTraceSummary",
            runId: "run-1",
            nodeId: "node-1",
            iteration: 0,
            attempt: 1,
            summary,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "agent.trace_summary",
            payload: {
                runId: "run-1",
                nodeId: "node-1",
                iteration: 0,
                attempt: 1,
                summary,
            },
        });
    });

    test("TimeTravelJumped → run.time_travel_jumped", () => {
        const result = gateway.mapEvent({
            type: "TimeTravelJumped",
            runId: "run-1",
            fromFrameNo: 5,
            toFrameNo: 2,
            timestampMs: 1000,
            caller: "test",
        });
        expect(result).toEqual({
            event: "run.time_travel_jumped",
            payload: {
                runId: "run-1",
                fromFrameNo: 5,
                toFrameNo: 2,
                timestampMs: 1000,
                caller: "test",
            },
        });
    });

    test("TimeTravelJumped with no caller → caller null", () => {
        const result = gateway.mapEvent({
            type: "TimeTravelJumped",
            runId: "run-1",
            fromFrameNo: 1,
            toFrameNo: 0,
            timestampMs: 2000,
        });
        expect(result?.payload).toMatchObject({ caller: null });
    });

    test("RunFinished → run.completed status=finished", () => {
        const result = gateway.mapEvent({
            type: "RunFinished",
            runId: "run-1",
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "run.completed",
            payload: { runId: "run-1", status: "finished" },
        });
    });

    test("RunFailed → run.completed status=failed", () => {
        const err = { message: "oops" };
        const result = gateway.mapEvent({
            type: "RunFailed",
            runId: "run-1",
            error: err,
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "run.completed",
            payload: { runId: "run-1", status: "failed", error: err },
        });
    });

    test("RunCancelled → run.completed status=cancelled", () => {
        const result = gateway.mapEvent({
            type: "RunCancelled",
            runId: "run-1",
            timestampMs: 1000,
        });
        expect(result).toEqual({
            event: "run.completed",
            payload: { runId: "run-1", status: "cancelled" },
        });
    });

    test("unknown event type → null", () => {
        const result = gateway.mapEvent({
            type: "SomeFutureEventType",
            runId: "run-1",
            timestampMs: 1000,
        });
        expect(result).toBeNull();
    });
});
