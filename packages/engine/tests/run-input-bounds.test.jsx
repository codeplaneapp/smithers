/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

// These constants mirror engine.js. They are not exported, so we duplicate
// them to assert the limit ± 1 boundaries.
const RUN_WORKFLOW_INPUT_MAX_BYTES = 1024 * 1024;
const RUN_WORKFLOW_INPUT_MAX_DEPTH = 32;
const RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH = 512;
const RUN_WORKFLOW_INPUT_MAX_STRING_LENGTH = 64 * 1024;

// Workflow runs over moderately-sized inputs need a generous timeout because
// the test harness spins up a real SQLite-backed engine, scheduler, etc.
const TIMEOUT_MS = 30_000;

function buildSmithers() {
    return createTestSmithers(outputSchemas);
}

function trivialWorkflow() {
    const { smithers, outputs, cleanup } = buildSmithers();
    const workflow = smithers(() => (
        <Workflow name="bounds-trivial">
            <Task id="t" output={outputs.outputA}>
                {{ value: 1 }}
            </Task>
        </Workflow>
    ));
    return { workflow, cleanup };
}

/**
 * Build a deeply nested object with `levels` levels of nesting.
 * `levels=1` => `{ x: 1 }` (a single level of object).
 * @param {number} levels
 */
function nestObject(levels) {
    /** @type {unknown} */
    let value = 1;
    for (let i = 0; i < levels; i += 1) {
        value = { x: value };
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Run workflow expecting validation rejection. Returns the resulting error.
 * Errors from runWorkflow are wrapped in Effect FiberFailure; the
 * SmithersError is the `cause`.
 * @param {unknown} workflow
 * @param {Record<string, unknown>} input
 */
async function runExpectingError(workflow, input) {
    try {
        await Effect.runPromise(
            runWorkflow(/** @type {any} */ (workflow), { input }),
        );
        throw new Error("expected runWorkflow to fail");
    } catch (error) {
        return error;
    }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function fullErrorText(error) {
    const err = /** @type {any} */ (error);
    return [err?.message, err?.cause?.message, String(err)].filter(Boolean).join(" || ");
}

describe("runWorkflow input bound: maxStringLength (64KB)", () => {
    test("string at limit-1 succeeds", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = { s: "x".repeat(RUN_WORKFLOW_INPUT_MAX_STRING_LENGTH - 1) };
        const r = await Effect.runPromise(runWorkflow(workflow, { input }));
        expect(r.status).toBe("finished");
        cleanup();
    }, TIMEOUT_MS);

    test("string at limit succeeds", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = { s: "x".repeat(RUN_WORKFLOW_INPUT_MAX_STRING_LENGTH) };
        const r = await Effect.runPromise(runWorkflow(workflow, { input }));
        expect(r.status).toBe("finished");
        cleanup();
    }, TIMEOUT_MS);

    test("string at limit+1 throws INVALID_INPUT", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = { s: "x".repeat(RUN_WORKFLOW_INPUT_MAX_STRING_LENGTH + 1) };
        const error = await runExpectingError(workflow, input);
        const text = fullErrorText(error);
        expect(text).toContain("input contains a string exceeding");
        expect(text).toContain(String(RUN_WORKFLOW_INPUT_MAX_STRING_LENGTH));
        cleanup();
    }, TIMEOUT_MS);
});

describe("runWorkflow input bound: maxArrayLength (512)", () => {
    test("array at limit-1 succeeds", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = { a: Array.from({ length: RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH - 1 }, (_, i) => i) };
        const r = await Effect.runPromise(runWorkflow(workflow, { input }));
        expect(r.status).toBe("finished");
        cleanup();
    }, TIMEOUT_MS);

    test("array at limit succeeds", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = { a: Array.from({ length: RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH }, (_, i) => i) };
        const r = await Effect.runPromise(runWorkflow(workflow, { input }));
        expect(r.status).toBe("finished");
        cleanup();
    }, TIMEOUT_MS);

    test("array at limit+1 throws INVALID_INPUT", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = { a: Array.from({ length: RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH + 1 }, (_, i) => i) };
        const error = await runExpectingError(workflow, input);
        const text = fullErrorText(error);
        expect(text).toContain("contains an array exceeding");
        expect(text).toContain(String(RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH));
        cleanup();
    }, TIMEOUT_MS);
});

describe("runWorkflow input bound: maxDepth (32)", () => {
    // assertMaxJsonDepth starts depth at 1 for the top-level value, then +1 per
    // child step. The validator throws when `depth > maxDepth`. Using
    // `nestObject(N)` produces N nested object layers, with the deepest leaf at
    // depth N+1. So the maximum legal N is maxDepth-1.
    test("nest depth at maxDepth-1 (legal max) succeeds", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = nestObject(RUN_WORKFLOW_INPUT_MAX_DEPTH - 1);
        const r = await Effect.runPromise(runWorkflow(workflow, { input }));
        expect(r.status).toBe("finished");
        cleanup();
    }, TIMEOUT_MS);

    test("nest depth one below legal max also succeeds", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = nestObject(RUN_WORKFLOW_INPUT_MAX_DEPTH - 2);
        const r = await Effect.runPromise(runWorkflow(workflow, { input }));
        expect(r.status).toBe("finished");
        cleanup();
    }, TIMEOUT_MS);

    test("nest depth one above legal max throws INVALID_INPUT", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = nestObject(RUN_WORKFLOW_INPUT_MAX_DEPTH);
        const error = await runExpectingError(workflow, input);
        const text = fullErrorText(error);
        expect(text).toContain("maximum JSON depth");
        expect(text).toContain(String(RUN_WORKFLOW_INPUT_MAX_DEPTH));
        cleanup();
    }, TIMEOUT_MS);
});

describe("runWorkflow input bound: maxBytes (1MB)", () => {
    /**
     * Build a JSON object whose serialized form is at least targetBytes.
     * Each value stays under maxStringLength so only the byte limit can fire.
     * @param {number} targetBytes
     */
    function buildPayloadOfBytes(targetBytes) {
        const chunkLen = 30_000; // < 64KB so per-string limit never fires.
        const chunk = "a".repeat(chunkLen);
        const result = /** @type {Record<string, string>} */ ({});
        let approxBytes = 2;
        let i = 0;
        while (approxBytes < targetBytes) {
            const key = `k${i}`;
            result[key] = chunk;
            // Each entry contributes roughly: "key":"chunk", => key + 6 + chunk.
            approxBytes += key.length + 6 + chunkLen;
            i += 1;
        }
        return result;
    }

    test("payload below maxBytes succeeds", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = buildPayloadOfBytes(RUN_WORKFLOW_INPUT_MAX_BYTES / 2);
        const r = await Effect.runPromise(runWorkflow(workflow, { input }));
        expect(r.status).toBe("finished");
        cleanup();
    }, TIMEOUT_MS);

    test("payload over maxBytes throws INVALID_INPUT", async () => {
        const { workflow, cleanup } = trivialWorkflow();
        const input = buildPayloadOfBytes(RUN_WORKFLOW_INPUT_MAX_BYTES + 200_000);
        const error = await runExpectingError(workflow, input);
        const text = fullErrorText(error);
        expect(text).toContain("exceeds the maximum size");
        expect(text).toContain(String(RUN_WORKFLOW_INPUT_MAX_BYTES));
        cleanup();
    }, TIMEOUT_MS);
});
