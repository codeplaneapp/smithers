import { describe, expect, test } from "bun:test";

import { prettyValue, renderRunOutputs } from "../src/pretty.js";

/**
 * Identity color object: every role is `(s) => s`, so assertions check the pure
 * tree structure with zero ANSI. This is the no-mocks-friendly testability hook
 * baked into pretty.js (production passes `pc`).
 */
const id = new Proxy(
    {},
    { get: () => (/** @type {string} */ s) => s },
);

/** Strip ANSI so we can assert against the production (`pc`) output too. */
const stripAnsi = (/** @type {string} */ s) => s.replace(/\x1B\[[0-9;]*m/g, "");

describe("prettyValue", () => {
    test("flat object: key + inline primitive per line, no braces/quotes", () => {
        const out = prettyValue({ verdict: "pass", score: 0.92 }, { color: id });
        expect(out).toBe("verdict: pass\nscore: 0.92");
    });

    test("nested object breaks under its key and indents +2 spaces", () => {
        const out = prettyValue(
            { meta: { path: "src/a.ts", added: 12 } },
            { color: id },
        );
        expect(out).toBe("meta:\n  path: src/a.ts\n  added: 12");
    });

    test("array of primitives renders as '- <value>' lines", () => {
        const out = prettyValue(
            { issues: ["missing test", "flaky e2e"] },
            { color: id },
        );
        expect(out).toBe("issues:\n  - missing test\n  - flaky e2e");
    });

    test("array of objects uses '[i]' index headers", () => {
        const out = prettyValue(
            { files: [{ path: "src/a.ts", added: 12 }, { path: "src/b.ts", added: 3 }] },
            { color: id },
        );
        expect(out).toBe(
            [
                "files:",
                "  [0]",
                "    path: src/a.ts",
                "    added: 12",
                "  [1]",
                "    path: src/b.ts",
                "    added: 3",
            ].join("\n"),
        );
    });

    test("multi-line string breaks under its key, each line indented", () => {
        const out = prettyValue(
            { summary: "line one\nline two" },
            { color: id },
        );
        expect(out).toBe("summary:\n  line one\n  line two");
    });

    test("empty object inline is '{}'", () => {
        expect(prettyValue({ artifact: {} }, { color: id })).toBe("artifact: {}");
    });

    test("empty array inline is '[]'", () => {
        expect(prettyValue({ tags: [] }, { color: id })).toBe("tags: []");
    });

    test("null and undefined render as em dash", () => {
        expect(prettyValue({ a: null, b: undefined }, { color: id })).toBe("a: —\nb: —");
    });

    test("standalone scalars render with no key", () => {
        expect(prettyValue("hello", { color: id })).toBe("hello");
        expect(prettyValue(42, { color: id })).toBe("42");
        expect(prettyValue(true, { color: id })).toBe("true");
        expect(prettyValue(false, { color: id })).toBe("false");
        expect(prettyValue(null, { color: id })).toBe("—");
        expect(prettyValue(undefined, { color: id })).toBe("—");
    });

    test("standalone empty object/array render as dim placeholders", () => {
        expect(prettyValue({}, { color: id })).toBe("{}");
        expect(prettyValue([], { color: id })).toBe("[]");
    });

    test("bigint gets an 'n' suffix; NaN/Infinity stringify", () => {
        expect(prettyValue({ big: 10n }, { color: id })).toBe("big: 10n");
        expect(prettyValue({ x: NaN, y: Infinity }, { color: id })).toBe("x: NaN\ny: Infinity");
    });

    test("Date renders as ISO string", () => {
        const d = new Date("2020-01-02T03:04:05.000Z");
        expect(prettyValue({ when: d }, { color: id })).toBe("when: 2020-01-02T03:04:05.000Z");
    });

    test("deeply nested objects recurse with growing indent", () => {
        const out = prettyValue({ a: { b: { c: 1 } } }, { color: id });
        expect(out).toBe("a:\n  b:\n    c: 1");
    });

    test("mixed array handles primitives and objects per element", () => {
        const out = prettyValue({ items: ["plain", { k: "v" }] }, { color: id });
        expect(out).toBe("items:\n  - plain\n  [1]\n    k: v");
    });

    test("circular reference renders as [circular], never throws", () => {
        const a = { name: "root" };
        a.self = a;
        const out = prettyValue(a, { color: id });
        expect(out).toBe("name: root\nself: [circular]");
    });

    test("circular array reference renders as [circular]", () => {
        const arr = [1];
        arr.push(arr);
        const out = prettyValue({ list: arr }, { color: id });
        expect(out).toBe("list:\n  - 1\n  [1]\n    [circular]");
    });

    test("sibling reuse of the same object is NOT flagged circular", () => {
        const shared = { k: "v" };
        const out = prettyValue({ first: shared, second: shared }, { color: id });
        expect(out).toBe("first:\n  k: v\nsecond:\n  k: v");
    });

    test("long string is not wrapped (single line)", () => {
        const long = "x".repeat(300);
        const out = prettyValue({ blob: long }, { color: id });
        expect(out).toBe(`blob: ${long}`);
        expect(out.split("\n")).toHaveLength(1);
    });

    test("non-object primitive falls back to JSON.stringify-free string render", () => {
        expect(prettyValue(0, { color: id })).toBe("0");
        expect(prettyValue("", { color: id })).toBe("");
    });

    test("production picocolors output strips back to the identity structure", () => {
        // No color object -> defaults to pc; ANSI present, stripped form matches.
        const colored = prettyValue({ verdict: "pass", score: 1 });
        expect(stripAnsi(colored)).toBe("verdict: pass\nscore: 1");
        // Some styling actually applied when not piped-disabled.
        // (picocolors auto-disables on non-TTY; either way structure holds.)
    });

    test("layout example from the spec renders verbatim (color-stripped)", () => {
        const out = prettyValue(
            {
                verdict: "pass",
                score: 0.92,
                issues: ["missing test for retry path", "flaky e2e on CI"],
                files: [
                    { path: "src/a.ts", added: 12 },
                    { path: "src/b.ts", added: 3 },
                ],
                summary: "The change looks good overall.\nTwo follow-ups remain before merge.",
            },
            { color: id },
        );
        expect(out).toBe(
            [
                "verdict: pass",
                "score: 0.92",
                "issues:",
                "  - missing test for retry path",
                "  - flaky e2e on CI",
                "files:",
                "  [0]",
                "    path: src/a.ts",
                "    added: 12",
                "  [1]",
                "    path: src/b.ts",
                "    added: 3",
                "summary:",
                "  The change looks good overall.",
                "  Two follow-ups remain before merge.",
            ].join("\n"),
        );
    });
});

describe("renderRunOutputs", () => {
    /**
     * In-memory stub of the two adapter methods renderRunOutputs uses. This is a
     * real stub of the contract (not a mock framework, no network/DB fabrication).
     * @param {{ nodes: any[], rows: Record<string, any> }} cfg
     */
    function fakeAdapter({ nodes, rows }) {
        return {
            async listNodes() {
                return nodes;
            },
            async getRawNodeOutputForIteration(table /*, runId, nodeId, iteration */) {
                return rows[table] ?? null;
            },
        };
    }

    /** Capture printed lines into an array. */
    function capture() {
        /** @type {string[]} */
        const lines = [];
        return { lines, print: (/** @type {string} */ l) => lines.push(l) };
    }

    test("renders a bold header then the prettified body, skipping nodes with no outputTable", async () => {
        const adapter = fakeAdapter({
            nodes: [
                { runId: "r1", nodeId: "wf:review", iteration: 0, state: "succeeded", outputTable: "out_review", label: "review" },
                { runId: "r1", nodeId: "wf:noop", iteration: 0, state: "succeeded", outputTable: "", label: "noop" },
                { runId: "r1", nodeId: "wf:build", iteration: 0, state: "succeeded", outputTable: "out_build", label: "build" },
            ],
            rows: {
                out_review: {
                    runId: "r1",
                    nodeId: "wf:review",
                    iteration: 0,
                    verdict: "pass",
                    score: 0.92,
                },
                out_build: { runId: "r1", nodeId: "wf:build", iteration: 0, ok: true, durationMs: 4210 },
            },
        });
        const { lines, print } = capture();

        const result = await renderRunOutputs(adapter, "r1", { print, color: id });

        // renderRunOutputs emits each header as its own print() and each node's
        // whole pretty body as a SINGLE print() (multi-line string), per spec.
        expect(result).toEqual({ nodeCount: 2 });
        expect(lines).toEqual([
            "review",
            "  verdict: pass\n  score: 0.92",
            "", // blank separator before second card
            "build",
            "  ok: true\n  durationMs: 4210",
        ]);
    });

    test("strips meta columns and drops null values", async () => {
        const adapter = fakeAdapter({
            nodes: [
                { runId: "r1", nodeId: "wf:t", iteration: 0, state: "succeeded", outputTable: "out_t", label: "t" },
            ],
            rows: {
                out_t: {
                    run_id: "r1",
                    node_id: "wf:t",
                    iteration: 0,
                    attempt: 1,
                    created_at_ms: 1,
                    updated_at_ms: 2,
                    createdAtMs: 1,
                    updatedAtMs: 2,
                    kept: "yes",
                    dropped: null,
                },
            },
        });
        const { lines, print } = capture();

        await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(lines).toEqual(["t", "  kept: yes"]);
    });

    test("empty output (null row) still prints a header + em dash placeholder and counts the node", async () => {
        const adapter = fakeAdapter({
            nodes: [
                { runId: "r1", nodeId: "wf:empty", iteration: 0, state: "succeeded", outputTable: "out_empty", label: "empty" },
            ],
            rows: {},
        });
        const { lines, print } = capture();

        const result = await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(result).toEqual({ nodeCount: 1 });
        expect(lines).toEqual(["empty", "  —"]);
    });

    test("output that strips to {} still renders the em dash placeholder", async () => {
        const adapter = fakeAdapter({
            nodes: [
                { runId: "r1", nodeId: "wf:meta", iteration: 0, state: "succeeded", outputTable: "out_meta", label: "meta" },
            ],
            rows: { out_meta: { runId: "r1", nodeId: "wf:meta", iteration: 0 } },
        });
        const { lines, print } = capture();

        await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(lines).toEqual(["meta", "  —"]);
    });

    test("failed node gets a (failed) suffix; cancelled gets (cancelled)", async () => {
        const adapter = fakeAdapter({
            nodes: [
                { runId: "r1", nodeId: "wf:a", iteration: 0, state: "failed", outputTable: "out_a", label: "a" },
                { runId: "r1", nodeId: "wf:b", iteration: 0, state: "cancelled", outputTable: "out_b", label: "b" },
            ],
            rows: { out_a: { runId: "r1", nodeId: "wf:a", iteration: 0, err: "boom" }, out_b: {} },
        });
        const { lines, print } = capture();

        await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(lines).toEqual([
            "a (failed)",
            "  err: boom",
            "",
            "b (cancelled)",
            "  —",
        ]);
    });

    test("label falls back to the last nodeId segment when label is null", async () => {
        const adapter = fakeAdapter({
            nodes: [
                { runId: "r1", nodeId: "workflow:deep:review", iteration: 0, state: "succeeded", outputTable: "out_x", label: null },
            ],
            rows: { out_x: { ok: true } },
        });
        const { lines, print } = capture();

        await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(lines[0]).toBe("review");
    });

    test("uses node.iteration when fetching the output row", async () => {
        /** @type {number[]} */
        const seenIterations = [];
        const adapter = {
            async listNodes() {
                return [
                    { runId: "r1", nodeId: "wf:t", iteration: 3, state: "succeeded", outputTable: "out_t", label: "t" },
                ];
            },
            async getRawNodeOutputForIteration(_table, _runId, _nodeId, iteration) {
                seenIterations.push(iteration);
                return { ok: true };
            },
        };
        const { lines, print } = capture();

        await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(seenIterations).toEqual([3]);
        expect(lines).toEqual(["t", "  ok: true"]);
    });

    test("no nodes at all -> (no task outputs) and nodeCount 0", async () => {
        const adapter = fakeAdapter({ nodes: [], rows: {} });
        const { lines, print } = capture();

        const result = await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(result).toEqual({ nodeCount: 0 });
        expect(lines).toEqual(["(no task outputs)"]);
    });

    test("nodes without output tables only -> (no task outputs)", async () => {
        const adapter = fakeAdapter({
            nodes: [{ runId: "r1", nodeId: "wf:x", iteration: 0, state: "succeeded", outputTable: "", label: "x" }],
            rows: {},
        });
        const { lines, print } = capture();

        const result = await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(result).toEqual({ nodeCount: 0 });
        expect(lines).toEqual(["(no task outputs)"]);
    });

    test("listNodes throwing degrades to an empty render, never throws", async () => {
        const adapter = {
            async listNodes() {
                throw new Error("db down");
            },
            async getRawNodeOutputForIteration() {
                return null;
            },
        };
        const { lines, print } = capture();

        const result = await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(result).toEqual({ nodeCount: 0 });
        expect(lines).toEqual(["(no task outputs)"]);
    });

    test("getRawNodeOutputForIteration throwing degrades to the empty placeholder", async () => {
        const adapter = {
            async listNodes() {
                return [
                    { runId: "r1", nodeId: "wf:t", iteration: 0, state: "succeeded", outputTable: "out_t", label: "t" },
                ];
            },
            async getRawNodeOutputForIteration() {
                throw new Error("boom");
            },
        };
        const { lines, print } = capture();

        const result = await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(result).toEqual({ nodeCount: 1 });
        expect(lines).toEqual(["t", "  —"]);
    });

    test("renders nested arrays/objects from a real-shaped output row", async () => {
        const adapter = fakeAdapter({
            nodes: [
                { runId: "r1", nodeId: "wf:review", iteration: 0, state: "succeeded", outputTable: "out_review", label: "review" },
            ],
            rows: {
                out_review: {
                    runId: "r1",
                    nodeId: "wf:review",
                    iteration: 0,
                    issues: ["a", "b"],
                    files: [{ path: "src/a.ts", added: 12 }],
                },
            },
        });
        const { lines, print } = capture();

        await renderRunOutputs(adapter, "r1", { print, color: id });

        expect(lines).toEqual([
            "review",
            [
                "  issues:",
                "    - a",
                "    - b",
                "  files:",
                "    [0]",
                "      path: src/a.ts",
                "      added: 12",
            ].join("\n"),
        ]);
    });

    test("default print writes to stdout (smoke) without throwing", async () => {
        const adapter = fakeAdapter({ nodes: [], rows: {} });
        // No print override -> uses process.stdout.write path; just assert it resolves.
        const result = await renderRunOutputs(adapter, "r1", { color: id });
        expect(result).toEqual({ nodeCount: 0 });
    });
});
