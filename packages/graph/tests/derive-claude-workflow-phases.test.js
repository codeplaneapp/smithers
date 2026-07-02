import { describe, expect, test } from "bun:test";
import { deriveClaudeWorkflowPhases } from "../src/deriveClaudeWorkflowPhases.js";
import { extractGraph } from "../src/extract.js";

/**
 * @param {string} tag
 * @param {Record<string, any>} [rawProps]
 * @param {any[]} [children]
 */
function hostEl(tag, rawProps = {}, children = []) {
    const stringProps = {};
    for (const [key, value] of Object.entries(rawProps)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            stringProps[key] = String(value);
        }
    }
    return { kind: "element", tag, props: stringProps, rawProps, children };
}

/** @param {ReturnType<typeof extractGraph>} graph */
function snapshot(graph) {
    return { runId: "phase-test", frameNo: 0, xml: graph.xml, tasks: graph.tasks };
}

describe("deriveClaudeWorkflowPhases", () => {
    test("derives ordered phases from sequence, parallel, and loop containers", () => {
        const root = hostEl("smithers:workflow", { name: "wf" }, [
            hostEl("smithers:sequence", { label: "Setup" }, [
                hostEl("smithers:task", {
                    id: "prepare",
                    output: "out",
                    __smithersKind: "static",
                    __smithersPayload: { ok: true },
                    label: "Prepare",
                }),
            ]),
            hostEl("smithers:parallel", { label: "Review" }, [
                hostEl("smithers:task", { id: "review", output: "out", agent: { id: "fake" } }),
            ]),
            hostEl("smithers:ralph", { id: "loop", label: "Items" }, [
                hostEl("smithers:task", { id: "auditItem", output: "out", agent: { id: "fake" } }),
            ]),
        ]);
        const graph = extractGraph(root, { ralphIterations: { loop: 2 } });
        const plan = deriveClaudeWorkflowPhases(snapshot(graph));

        expect(plan.phases.map((phase) => phase.title)).toEqual(["wf", "Setup", "Review", "Items"]);
        expect(plan.nodes).toEqual([
            { nodeId: "prepare", label: "Prepare", phase: "Setup", kind: "static" },
            { nodeId: "review", label: "review", phase: "Review", kind: "agent" },
            { nodeId: "auditItem", label: "auditItem", phase: "Items", kind: "agent" },
        ]);
    });

    test("deduplicates phase titles deterministically", () => {
        const graph = extractGraph(hostEl("smithers:workflow", { name: "wf" }, [
            hostEl("smithers:sequence", { label: "Work" }, [
                hostEl("smithers:task", { id: "a", output: "out" }),
            ]),
            hostEl("smithers:sequence", { label: "Work" }, [
                hostEl("smithers:task", { id: "b", output: "out" }),
            ]),
        ]));
        const plan = deriveClaudeWorkflowPhases(snapshot(graph));

        expect(plan.phases.map((phase) => phase.title)).toEqual(["wf", "Work", "Work 2"]);
        expect(plan.nodes.map((node) => [node.nodeId, node.phase])).toEqual([
            ["a", "Work"],
            ["b", "Work 2"],
        ]);
    });

    test("classifies task kinds from extracted descriptors", () => {
        const graph = extractGraph(hostEl("smithers:workflow", { name: "wf" }, [
            hostEl("smithers:task", { id: "agent", output: "out", agent: { id: "fake" } }),
            hostEl("smithers:task", { id: "compute", output: "out", __smithersKind: "compute", __smithersComputeFn: () => ({ ok: true }) }),
            hostEl("smithers:task", { id: "static", output: "out", __smithersKind: "static", __smithersPayload: { ok: true } }),
            hostEl("smithers:timer", { id: "timer", duration: "1s" }),
            hostEl("smithers:wait-for-event", { id: "wait", output: "out", event: "ready" }),
            hostEl("smithers:subflow", { id: "sub", output: "out" }),
            hostEl("smithers:sandbox", { id: "safe", output: "out" }),
            hostEl("smithers:task", { id: "approval", output: "out", needsApproval: true }),
        ]));
        const plan = deriveClaudeWorkflowPhases(snapshot(graph));

        expect(Object.fromEntries(plan.nodes.map((node) => [node.nodeId, node.kind]))).toEqual({
            agent: "agent",
            compute: "compute",
            static: "static",
            timer: "timer",
            wait: "wait",
            sub: "subflow",
            safe: "sandbox",
            approval: "approval",
        });
    });

    test("collapses all nodes into one phase when requested", () => {
        const graph = extractGraph(hostEl("smithers:workflow", { name: "wf" }, [
            hostEl("smithers:sequence", { label: "A" }, [hostEl("smithers:task", { id: "a", output: "out" })]),
            hostEl("smithers:parallel", { label: "B" }, [hostEl("smithers:task", { id: "b", output: "out" })]),
        ]));
        const plan = deriveClaudeWorkflowPhases(snapshot(graph), { collapsePhases: true });

        expect(plan.phases).toEqual([{ title: "Smithers run" }]);
        expect(plan.nodes.map((node) => node.phase)).toEqual(["Smithers run", "Smithers run"]);
    });
});

import { deriveClaudeWorkflowPhasesFromFrame } from "../src/deriveClaudeWorkflowPhasesFromFrame.js";
import { canonicalizeXml } from "../src/utils/xml.js";

/**
 * Serialize a graph the way the engine persists a frame row:
 * `canonicalizeXml(graph.xml)` for xml_json and the
 * `{ nodeId, ordinal, iteration, kind }` projection for task_index_json
 * (see persistDriverFrame in packages/engine).
 * @param {ReturnType<typeof extractGraph>} graph
 */
function frameRowFor(graph) {
    return {
        xmlJson: canonicalizeXml(graph.xml),
        taskIndexJson: JSON.stringify(graph.tasks.map((task) => ({
            nodeId: task.nodeId,
            ordinal: task.ordinal,
            iteration: task.iteration,
            kind: task.kind,
        }))),
    };
}

describe("deriveClaudeWorkflowPhasesFromFrame", () => {
    test("matches the live-snapshot derivation for a persisted frame", () => {
        const root = hostEl("smithers:workflow", { name: "wf" }, [
            hostEl("smithers:sequence", { label: "Setup" }, [
                hostEl("smithers:task", {
                    id: "prepare",
                    output: "out",
                    __smithersKind: "static",
                    __smithersPayload: { ok: true },
                    label: "Prepare",
                }),
            ]),
            hostEl("smithers:parallel", { label: "Review" }, [
                hostEl("smithers:task", { id: "review", output: "out", agent: { id: "fake" } }),
            ]),
        ]);
        const graph = extractGraph(root);
        const live = deriveClaudeWorkflowPhases(snapshot(graph));
        const fromFrame = deriveClaudeWorkflowPhasesFromFrame(frameRowFor(graph), {
            labels: { prepare: "Prepare" },
        });

        expect(fromFrame.phases).toEqual(live.phases);
        // Kinds agree because the persisted task index carries the engine's own
        // task.kind projection; no function fields are needed at read time.
        expect(fromFrame.nodes).toEqual(live.nodes);
    });

    test("uses node-table labels and falls back to unknown kinds", () => {
        const graph = extractGraph(hostEl("smithers:workflow", { name: "wf" }, [
            hostEl("smithers:task", { id: "a", output: "out", agent: { id: "fake" } }),
        ]));
        const frame = frameRowFor(graph);
        const noKinds = JSON.parse(frame.taskIndexJson).map(({ kind, ...rest }) => rest);
        const plan = deriveClaudeWorkflowPhasesFromFrame({
            xmlJson: frame.xmlJson,
            taskIndexJson: JSON.stringify(noKinds),
        }, { labels: { a: "Agent A" } });

        expect(plan.nodes).toEqual([{ nodeId: "a", label: "Agent A", phase: "wf", kind: "unknown" }]);
    });

    test("degrades to an empty plan on missing or corrupt frame data", () => {
        expect(deriveClaudeWorkflowPhasesFromFrame({ xmlJson: null, taskIndexJson: null }))
            .toEqual({ phases: [{ title: "Workflow" }], nodes: [] });
        expect(deriveClaudeWorkflowPhasesFromFrame({ xmlJson: "not json{", taskIndexJson: "also not json[" }))
            .toEqual({ phases: [{ title: "Workflow" }], nodes: [] });
    });
});
