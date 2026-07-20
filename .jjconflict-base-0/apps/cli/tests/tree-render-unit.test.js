import { describe, expect, test } from "bun:test";
import {
    TREE_INDENT,
    renderDevToolsTree,
    selectSubtree,
} from "../src/tree.js";

function snapshot() {
    const circularName = { label: "loop", self: null };
    circularName.self = circularName;
    return {
        runId: "run-tree",
        frameNo: 1,
        seq: 1,
        capturedAtMs: Date.now(),
        root: {
            type: "Workflow",
            name: "root",
            props: {
                enabled: true,
                count: 2,
                skipNull: null,
                skipObject: { nested: true },
            },
            children: [
                {
                    type: "Task",
                    name: circularName,
                    task: {
                        nodeId: "task-a",
                        kind: "agent",
                        agent: "codex",
                        iteration: 2,
                    },
                    props: { label: "A" },
                    children: [],
                },
                {
                    type: "Group",
                    name: "group",
                    props: {},
                    children: [
                        {
                            type: "Task",
                            name: "child",
                            task: { nodeId: "task-b" },
                            props: {},
                            children: [],
                        },
                    ],
                },
            ],
        },
    };
}

describe("tree rendering helpers", () => {
    test("selects subtrees and renders attributes, leaves, and depth truncation", () => {
        const snap = snapshot();
        expect(selectSubtree(snap.root, "task-b")?.name).toBe("child");
        expect(selectSubtree(snap.root, "group")?.type).toBe("Group");
        expect(selectSubtree(snap.root, "missing")).toBe(null);
        expect(renderDevToolsTree(snap, { nodeId: "missing" })).toBe("");

        const rendered = renderDevToolsTree(snap, { color: false });
        expect(rendered).toContain('<Workflow name="root" enabled=true count=2>');
        expect(rendered).toContain(`${TREE_INDENT}<Task name="[unserializable]" nodeId="task-a" kind="agent" agent="codex" iter=2 label="A"></Task>`);
        expect(rendered).toContain(`${TREE_INDENT}${TREE_INDENT}<Task name="child" nodeId="task-b"></Task>`);

        const limited = renderDevToolsTree(snap, { depth: 1, color: false });
        expect(limited).toBe('<Workflow name="root" enabled=true count=2>...2 hidden...</Workflow>');

        const colored = renderDevToolsTree(snap, { nodeId: "task-a", color: true });
        expect(colored).toContain("\x1b[");
        expect(colored).toContain("task-a");
    });
});
