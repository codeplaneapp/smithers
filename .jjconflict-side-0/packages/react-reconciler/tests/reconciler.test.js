import { describe, expect, it, spyOn } from "bun:test";
import React from "react";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler";
/**
 * @param {HostNode | null} root
 * @returns {WorkflowGraph}
 */
function graphFrom(root) {
    return {
        xml: root,
        tasks: [],
        mountedTaskIds: [],
    };
}
describe("SmithersRenderer", () => {
    it("installs and registers the React DevTools hook for bippy consumers", () => {
        const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        expect(hook).toBeDefined();
        expect(typeof hook.inject).toBe("function");
    });
    it("uses @smithers-orchestrator/graph extractGraph by default", async () => {
        const renderer = new SmithersRenderer();
        const graph = await renderer.render(React.createElement("smithers:task", {
            id: "task-a",
            output: "result",
            __smithersKind: "static",
            __smithersPayload: { value: 1 },
        }));
        expect(graph.tasks).toHaveLength(1);
        expect(graph.tasks[0]?.nodeId).toBe("task-a");
        expect(graph.tasks[0]?.outputTableName).toBe("result");
        expect(graph.tasks[0]?.staticPayload).toEqual({ value: 1 });
    });
    it("builds a HostNode tree and hands it to extractGraph", async () => {
        let captured = null;
        const renderer = new SmithersRenderer({
            extractGraph: (root) => {
                captured = root;
                return graphFrom(root);
            },
        });
        const graph = await renderer.render(React.createElement("smithers:sequence", { id: "root", __private: "hidden" }, React.createElement("smithers:task", {
            id: "task-a",
            output: "result",
            enabled: true,
            compute: () => "ignored",
        }, "Prompt text")));
        expect(graph.xml).toBe(captured);
        expect(captured.kind).toBe("element");
        const root = captured;
        expect(root.tag).toBe("smithers:sequence");
        expect(root.props).toEqual({ id: "root" });
        expect(root.rawProps.__private).toBe("hidden");
        const task = root.children[0];
        expect(task.tag).toBe("smithers:task");
        expect(task.props).toEqual({
            id: "task-a",
            output: "result",
            enabled: "true",
        });
        expect(typeof task.rawProps.compute).toBe("function");
        expect(task.children).toEqual([{ kind: "text", text: "Prompt text" }]);
    });
    it("updates the existing container on re-render", async () => {
        const renderer = new SmithersRenderer({ extractGraph: graphFrom });
        await renderer.render(React.createElement("smithers:task", { id: "first", output: "out" }));
        await renderer.render(React.createElement("smithers:task", { id: "second", output: "out" }));
        const root = renderer.getRoot();
        expect(root.tag).toBe("smithers:task");
        expect(root.props.id).toBe("second");
    });
    it("preserves all ordered top-level Fragment children", async () => {
        const renderer = new SmithersRenderer({ extractGraph: graphFrom });
        await renderer.render(React.createElement(React.Fragment, null, React.createElement("smithers:task", { id: "first", output: "out" }), React.createElement("smithers:task", { id: "second", output: "out" }), React.createElement("smithers:task", { id: "third", output: "out" })));

        const root = renderer.getRoot();
        expect(root.kind).toBe("element");
        expect(root.tag).toBe("smithers:fragment");
        expect(root.children.map((child) => child.props.id)).toEqual(["first", "second", "third"]);
    });
    it("rejects when a component throws during render instead of resolving a stale graph", async () => {
        const renderer = new SmithersRenderer({ extractGraph: graphFrom });
        function Boom() {
            throw new Error("boom-in-render");
        }
        // An uncaught render throw is fatal: render() must reject loudly rather
        // than resolve with a partial/stale graph (xml: null) while the error is
        // silently rethrown out-of-band by React's default uncaught handler.
        await expect(renderer.render(React.createElement(Boom))).rejects.toThrow("boom-in-render");
    });
    it("propagates a SmithersError thrown during render (e.g. useCtx outside a Workflow)", async () => {
        const renderer = new SmithersRenderer({ extractGraph: graphFrom });
        function UseCtxOutsideWorkflow() {
            // Mirrors createSmithersContext().useCtx() when no provider is mounted.
            throw new SmithersError("CONTEXT_OUTSIDE_WORKFLOW", "useCtx() must be called inside a <Workflow> created by createSmithers()");
        }
        const error = await renderer
            .render(React.createElement(UseCtxOutsideWorkflow))
            .then(() => null, (e) => e);
        expect(error).toBeInstanceOf(SmithersError);
        expect(error.code).toBe("CONTEXT_OUTSIDE_WORKFLOW");
    });
    it("is not poisoned by a prior render throw: the same renderer renders a valid tree after", async () => {
        const renderer = new SmithersRenderer({ extractGraph: graphFrom });
        function Boom() {
            throw new Error("boom-in-render");
        }
        await expect(renderer.render(React.createElement(Boom))).rejects.toThrow("boom-in-render");
        // Re-render a valid tree on the SAME instance — the renderer must not be
        // left in a corrupted state by the prior throw.
        const graph = await renderer.render(React.createElement("smithers:task", { id: "after-throw", output: "out" }));
        expect(graph.xml.tag).toBe("smithers:task");
        expect(graph.xml.props.id).toBe("after-throw");
        expect(renderer.getRoot().props.id).toBe("after-throw");
    });
    it("resolves with the boundary fallback when an error boundary handles a render throw", async () => {
        // A boundary-caught error is handled, not fatal: render() resolves with
        // the recovered (fallback) tree rather than rejecting. React logs the
        // caught error via its default onCaughtError handler — spy to keep
        // output clean while asserting the path ran.
        const errorSpy = spyOn(console, "error").mockImplementation(() => {});
        try {
            const renderer = new SmithersRenderer({ extractGraph: graphFrom });
            function Boom() {
                throw new Error("boom-caught");
            }
            const graph = await renderer.render(React.createElement(ErrorBoundary, null, React.createElement(Boom)));
            expect(graph.xml.tag).toBe("smithers:task");
            expect(graph.xml.props.id).toBe("fallback");
        }
        finally {
            errorSpy.mockRestore();
        }
    });
    it("removes a specific middle root, preserving sibling order and collapsing on shrink", async () => {
        const renderer = new SmithersRenderer({ extractGraph: graphFrom });
        // Three top-level roots under a Fragment.
        await renderer.render(React.createElement(React.Fragment, null, React.createElement("smithers:task", { key: "a", id: "a", output: "out" }), React.createElement("smithers:task", { key: "b", id: "b", output: "out" }), React.createElement("smithers:task", { key: "c", id: "c", output: "out" })));
        expect(renderer.getRoot().tag).toBe("smithers:fragment");
        expect(renderer.getRoot().children.map((child) => child.props.id)).toEqual(["a", "b", "c"]);

        // Remove the MIDDLE root 'b' — exercises removeChildFromContainer's
        // `if (child)` branch (a specific, non-last root), not the clear-all path.
        await renderer.render(React.createElement(React.Fragment, null, React.createElement("smithers:task", { key: "a", id: "a", output: "out" }), React.createElement("smithers:task", { key: "c", id: "c", output: "out" })));
        const root = renderer.getRoot();
        expect(root.tag).toBe("smithers:fragment");
        expect(root.children.map((child) => child.props.id)).toEqual(["a", "c"]);

        // Shrink to a single root — the smithers:fragment wrapper must collapse
        // back to a bare element.
        await renderer.render(React.createElement(React.Fragment, null, React.createElement("smithers:task", { key: "a", id: "a", output: "out" })));
        const single = renderer.getRoot();
        expect(single.tag).toBe("smithers:task");
        expect(single.props.id).toBe("a");
        expect(renderer.container.roots).toHaveLength(1);
    });
});

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { errored: false };
    }
    static getDerivedStateFromError() {
        return { errored: true };
    }
    render() {
        if (this.state.errored) {
            return React.createElement("smithers:task", { id: "fallback", output: "out" });
        }
        return this.props.children;
    }
}
