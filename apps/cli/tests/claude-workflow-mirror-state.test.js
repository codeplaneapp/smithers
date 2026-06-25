import { describe, expect, test } from "bun:test";
import {
    diffMirrorNodes,
    eventSignalsFrame,
    isTerminalNodeState,
    isTerminalRunStatus,
    nodesFromInspect,
    parseInspectJson,
} from "../src/claude-workflow/mirrorState.js";

const phasePlan = {
    phases: [{ title: "Items" }],
    nodes: [
        { nodeId: "auditItem", label: "Audit item", phase: "Items", kind: "agent" },
        { nodeId: "prepare", label: "Prepare", phase: "Setup", kind: "static" },
    ],
};

describe("claude workflow mirror state", () => {
    test("parses inspect JSON steps and run status", () => {
        expect(parseInspectJson({
            run: { status: "running" },
            steps: [
                { id: "auditItem@@loop=2", state: "running", label: "Audit 2", attempt: 1 },
                { id: "prepare", state: "finished" },
            ],
        })).toEqual({
            runStatus: "running",
            steps: [
                { id: "auditItem@@loop=2", state: "running", label: "Audit 2", attempt: 1 },
                { id: "prepare", state: "finished", label: "prepare" },
            ],
        });
    });

    test("maps runtime @@ suffixed node ids through logical phase and kind maps", () => {
        const result = nodesFromInspect({
            run: { status: "running" },
            steps: [
                { id: "auditItem@@loop=2", state: "pending", label: "Audit 2" },
                { id: "prepare", state: "finished", label: "Prepare" },
            ],
        }, phasePlan);

        expect(result).toEqual({
            runStatus: "running",
            nodes: [
                { nodeId: "auditItem@@loop=2", label: "Audit 2", state: "pending", phase: "Items", kind: "agent" },
            ],
        });
    });

    test("can include non-agent nodes when requested", () => {
        expect(nodesFromInspect({
            run: { status: "finished" },
            steps: [{ id: "prepare", state: "finished", label: "Prepare" }],
        }, phasePlan, { mirrorAllNodes: true }).nodes).toEqual([
            { nodeId: "prepare", label: "Prepare", state: "finished", phase: "Setup", kind: "static" },
        ]);
    });

    test("detects terminal run and node states", () => {
        expect(["finished", "failed", "cancelled"].map(isTerminalRunStatus)).toEqual([true, true, true]);
        expect(isTerminalRunStatus("continued")).toBe(false);
        expect(["finished", "failed", "skipped", "cancelled"].map(isTerminalNodeState)).toEqual([true, true, true, true]);
        expect(isTerminalNodeState("running")).toBe(false);
    });

    test("diffs added and vanished nodes", () => {
        expect(diffMirrorNodes(new Set(["a", "b"]), [{ nodeId: "b" }, { nodeId: "c" }])).toEqual({
            added: ["c"],
            vanished: ["a"],
        });
    });

    test("detects frame and terminal events from NDJSON objects", () => {
        expect(eventSignalsFrame({ type: "FrameCommitted", payload: { frameNo: 2 } }, 1)).toEqual({ kind: "frame", frameNo: 2 });
        expect(eventSignalsFrame({ type: "FrameCommitted", payload: { frameNo: 1 } }, 1)).toBeNull();
        expect(eventSignalsFrame({ type: "RunFinished", payload: {} }, 1)).toEqual({ kind: "terminal", status: "finished" });
        expect(eventSignalsFrame({ type: "RunContinuedAsNew", payload: { newRunId: "next" } }, 1)).toEqual({ kind: "continued", runId: "next" });
    });

    test("signals the same frame event only once when the cursor advances", () => {
        const event = { type: "FrameCommitted", payload: { frameNo: 3 } };
        const first = eventSignalsFrame(event, 2);
        expect(first).toEqual({ kind: "frame", frameNo: 3 });
        expect(eventSignalsFrame(event, first?.kind === "frame" ? first.frameNo : 2)).toBeNull();
    });
});
