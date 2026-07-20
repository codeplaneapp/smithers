import { describe, expect, test } from "bun:test";
import {
    renderPrettyOutput,
    runOutputOnce,
} from "../src/output.js";

function capture() {
    return {
        chunks: [],
        write(text) {
            this.chunks.push(text);
        },
        text() {
            return this.chunks.join("");
        },
    };
}

function makeAdapter(overrides = {}) {
    const state = {
        run: { runId: "run-1" },
        node: { nodeId: "task-a", iteration: 3, outputTable: "task_output" },
        iterations: [{ iteration: 0 }, { iteration: 3 }, { iteration: "bad" }],
        rawRow: {
            run_id: "run-1",
            runId: "run-1",
            node_id: "task-a",
            nodeId: "task-a",
            iteration: 3,
            value: 42,
        },
        throwIterations: false,
        ...overrides,
    };
    return {
        listNodeIterations: async () => {
            if (state.throwIterations) throw new Error("iteration lookup failed");
            return state.iterations;
        },
        getRun: async () => state.run,
        getNode: async (_runId, _nodeId, iteration) => state.node
            ? { ...state.node, iteration }
            : null,
        getRawNodeOutputForIteration: async () => state.rawRow,
    };
}

async function runRaw(inputOverrides = {}, adapterOverrides = {}) {
    const stdout = capture();
    const stderr = capture();
    const result = await runOutputOnce({
        adapter: makeAdapter(adapterOverrides),
        runId: "run-1",
        nodeId: "task-a",
        json: true,
        pretty: false,
        stdout,
        stderr,
        ...inputOverrides,
    });
    return { result, stdout: stdout.text(), stderr: stderr.text() };
}

describe("output helpers", () => {
    test("renders pretty output states and field ordering", () => {
        expect(renderPrettyOutput(null)).toBe("(no output)");
        expect(renderPrettyOutput({ status: "pending", row: null })).toBe("(pending)");
        expect(renderPrettyOutput({ status: "failed", row: undefined })).toBe("(failed)");
        expect(renderPrettyOutput({ row: null })).toBe("(no output)");

        const circular = { self: null };
        circular.self = circular;
        expect(renderPrettyOutput({
            schema: {
                fields: [
                    null,
                    { name: 123 },
                    { name: "first" },
                    { name: "missing" },
                ],
            },
            row: {
                first: "one",
                second: 2,
                bool: true,
                nothing: null,
                absent: undefined,
                object: { nested: true },
                circular,
            },
        })).toBe([
            "first: one",
            "second: 2",
            "bool: true",
            "nothing: null",
            "absent: ",
            "object: {\"nested\":true}",
            "circular: [object Object]",
        ].join("\n"));
    });

    test("writes raw json output with latest iteration and stripped key columns", async () => {
        const { result, stdout, stderr } = await runRaw();

        expect(result.exitCode).toBe(0);
        expect(stderr).toBe("");
        expect(stdout).toBe("{\"value\":42}\n");
    });

    test("falls back to iteration zero when latest iteration cannot be resolved", async () => {
        const { result, stdout } = await runRaw({}, {
            throwIterations: true,
            rawRow: null,
        });

        expect(result.exitCode).toBe(0);
        expect(stdout).toBe("null\n");
    });

    test("maps raw output validation failures to cli errors", async () => {
        expect((await runRaw({ runId: "INVALID!" })).result.exitCode).not.toBe(0);
        expect((await runRaw({ nodeId: "bad node" })).result.exitCode).not.toBe(0);
        expect((await runRaw({}, { run: null })).stderr).toContain("RunNotFound");
        expect((await runRaw({}, { node: null })).stderr).toContain("NodeNotFound");
        expect((await runRaw({}, { node: { nodeId: "task-a", outputTable: "  " } })).stderr).toContain("NodeHasNoOutput");
    });
});
