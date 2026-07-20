/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

// Mirrors engine.js TASK_HEARTBEAT_MAX_PAYLOAD_BYTES.
const TASK_HEARTBEAT_MAX_PAYLOAD_BYTES = 1_000_000;
const TIMEOUT_MS = 60_000;

function buildSmithers() {
    return createTestSmithers(outputSchemas);
}

/**
 * Build a heartbeat payload whose JSON-serialized size is exactly `bytes`.
 * The wrapping `{"d":"..."}` adds 8 bytes (2 quotes around key, colon, braces,
 * 2 quotes around value), so the inner string length is bytes - 8.
 * @param {number} bytes
 */
function payloadOfSize(bytes) {
    const inner = "x".repeat(bytes - 8);
    const obj = { d: inner };
    // Sanity: confirm exact size.
    if (Buffer.byteLength(JSON.stringify(obj), "utf8") !== bytes) {
        throw new Error(`failed to build payload of exactly ${bytes} bytes`);
    }
    return obj;
}

describe("heartbeat payload bound: TASK_HEARTBEAT_MAX_PAYLOAD_BYTES (1MB)", () => {
    test("payload at limit-1 bytes succeeds", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers(() => (
                <Workflow name="hb-bound-below">
                    <Task id="below" output={outputs.outputA}>
                        {() => {
                            const runtime = requireTaskRuntime();
                            runtime.heartbeat(payloadOfSize(TASK_HEARTBEAT_MAX_PAYLOAD_BYTES - 1));
                            return { value: 1 };
                        }}
                    </Task>
                </Workflow>
            ));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            const adapter = new SmithersDb(db);
            const attempts = await adapter.listAttempts(result.runId, "below", 0);
            expect(typeof attempts[0]?.heartbeatAtMs).toBe("number");
        }
        finally {
            cleanup();
        }
    }, TIMEOUT_MS);

    test("payload at limit succeeds", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers(() => (
                <Workflow name="hb-bound-at">
                    <Task id="at" output={outputs.outputA}>
                        {() => {
                            const runtime = requireTaskRuntime();
                            runtime.heartbeat(payloadOfSize(TASK_HEARTBEAT_MAX_PAYLOAD_BYTES));
                            return { value: 1 };
                        }}
                    </Task>
                </Workflow>
            ));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("finished");
            const adapter = new SmithersDb(db);
            const attempts = await adapter.listAttempts(result.runId, "at", 0);
            expect(typeof attempts[0]?.heartbeatAtMs).toBe("number");
        }
        finally {
            cleanup();
        }
    }, TIMEOUT_MS);

    test("payload at limit+1 fails with HEARTBEAT_PAYLOAD_TOO_LARGE", async () => {
        const { smithers, outputs, db, cleanup } = buildSmithers();
        try {
            const workflow = smithers(() => (
                <Workflow name="hb-bound-over">
                    <Task id="over" output={outputs.outputA}>
                        {() => {
                            const runtime = requireTaskRuntime();
                            runtime.heartbeat(payloadOfSize(TASK_HEARTBEAT_MAX_PAYLOAD_BYTES + 1));
                            return { value: 1 };
                        }}
                    </Task>
                </Workflow>
            ));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
            expect(result.status).toBe("failed");
            const adapter = new SmithersDb(db);
            const attempts = await adapter.listAttempts(result.runId, "over", 0);
            const errorJson = JSON.parse(attempts[0]?.errorJson ?? "{}");
            expect(errorJson.code).toBe("HEARTBEAT_PAYLOAD_TOO_LARGE");
        }
        finally {
            cleanup();
        }
    }, TIMEOUT_MS);
});
