import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { __engineInternals as I, runsDueForQuotaResume } from "../src/engine.js";

const inputPayloadTable = sqliteTable("input_payload", {
    runId: text("run_id").primaryKey(),
    payload: text("payload", { mode: "json" }),
});

const inputWideTable = sqliteTable("input_wide", {
    runId: text("run_id").primaryKey(),
    prompt: text("prompt"),
    count: integer("count"),
});

const outputTable = sqliteTable("task_output", {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    iteration: integer("iteration").notNull().default(0),
    value: text("value"),
});

function tool(metadata) {
    return { [Symbol.for("smithers.tool.metadata")]: metadata };
}

function makeContinueDb() {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE input_wide (
        run_id TEXT PRIMARY KEY,
        prompt TEXT,
        count INTEGER
      );
      CREATE TABLE task_output (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        value TEXT
      );
    `);
    const schema = { input: inputWideTable, output: outputTable };
    const db = drizzle(sqlite, { schema });
    ensureSmithersTables(db);
    return { sqlite, db, schema, adapter: new SmithersDb(db) };
}

async function insertRun(adapter, runId, overrides = {}) {
    await Effect.runPromise(adapter.insertRun({
        runId,
        parentRunId: null,
        workflowName: "workflow",
        workflowPath: "/tmp/workflow.ts",
        workflowHash: "old-hash",
        status: "running",
        createdAtMs: 1,
        startedAtMs: 1,
        finishedAtMs: null,
        heartbeatAtMs: 1,
        runtimeOwnerId: "owner",
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        vcsType: "git",
        vcsRoot: "/repo",
        vcsRevision: "old-rev",
        errorJson: null,
        configJson: "{}",
        ...overrides,
    }));
}

describe("engine internals: errors, heartbeat and continuation helpers", () => {
    test("cancellation resolves pending approvals and human requests", async () => {
        const { adapter, sqlite } = makeContinueDb();
        try {
            await insertRun(adapter, "cancel-waits", { status: "waiting-approval" });
            await Effect.runPromise(adapter.insertNode({
                runId: "cancel-waits",
                nodeId: "gate",
                iteration: 0,
                state: "waiting-approval",
                updatedAtMs: 1,
                outputTable: "task_output",
                label: "Gate",
            }));
            await Effect.runPromise(adapter.insertOrUpdateApproval({
                runId: "cancel-waits",
                nodeId: "gate",
                iteration: 0,
                status: "requested",
                requestedAtMs: 1,
                decidedAtMs: null,
                note: null,
                decidedBy: null,
                requestJson: '{"title":"Gate"}',
                decisionJson: null,
                autoApproved: false,
            }));
            await Effect.runPromise(adapter.insertHumanRequest({
                requestId: "human:cancel-waits:ask:0",
                runId: "cancel-waits",
                nodeId: "ask",
                iteration: 0,
                kind: "ask",
                status: "pending",
                prompt: "Continue?",
                schemaJson: null,
                optionsJson: null,
                responseJson: null,
                requestedAtMs: 1,
                answeredAtMs: null,
                answeredBy: null,
                timeoutAtMs: null,
            }));

            await I.cancelPendingExternalWaits(adapter, "cancel-waits");

            expect((await adapter.listPendingApprovals("cancel-waits"))).toEqual([]);
            expect((await adapter.getApproval("cancel-waits", "gate", 0))?.status).toBe("denied");
            expect((await adapter.getNode("cancel-waits", "gate", 0))?.state).toBe("cancelled");
            expect((await adapter.getHumanRequest("human:cancel-waits:ask:0"))?.status).toBe("cancelled");
        }
        finally {
            sqlite.close();
        }
    });

    test("classifies abort-like errors and preserves Effect failures", async () => {
        expect(I.isAbortError(null)).toBe(false);
        expect(I.isAbortError({ name: "AbortError" })).toBe(true);
        expect(I.isAbortError(new DOMException("stop", "AbortError"))).toBe(true);
        expect(I.isAbortError(new Error("request aborted"))).toBe(true);

        const abort = I.makeAbortError("halt");
        expect(abort.name).toBe("AbortError");
        expect(abort.code).toBe("TASK_ABORTED");

        expect(I.abortPromise()).toBeNull();
        const controller = new AbortController();
        controller.abort();
        await expect(I.abortPromise(controller.signal)).rejects.toMatchObject({ code: "TASK_ABORTED" });

        await expect(I.runPromisePreservingFailure(Effect.succeed("ok"))).resolves.toBe("ok");
        const failure = new SmithersError("INTERNAL_ERROR", "kept");
        await expect(I.runPromisePreservingFailure(Effect.fail(failure))).rejects.toBe(failure);
    });

    test("clears compute timeout timers when another race settles first", async () => {
        let scheduledId;
        let clearedId;
        const result = await I.raceWithTimeout([Promise.resolve("done")], 600_000, () => new Error("timed out"), {
            setTimeoutFn: (callback, delay) => {
                expect(delay).toBe(600_000);
                scheduledId = callback;
                return 42;
            },
            clearTimeoutFn: (id) => {
                clearedId = id;
            },
        });

        expect(result).toBe("done");
        expect(scheduledId).toBeInstanceOf(Function);
        expect(clearedId).toBe(42);
    });

    test("extracts nested error messages and structured-output parse failures", () => {
        const nested = new Error("outer", { cause: new Error("inner") });
        expect(I.collectErrorMessages(nested)).toEqual(["Error", "outer", "Error", "inner"]);
        expect(I.collectErrorMessages("plain failure")).toEqual(["plain failure"]);

        expect(I.isStructuredOutputParseFailure({ name: "AI_JSONParseError", message: "bad" })).toBe(true);
        expect(I.isStructuredOutputParseFailure(new Error("response did not match schema"))).toBe(true);
        expect(I.isStructuredOutputParseFailure(new Error("network failed"))).toBe(false);

        expect(I.depsTextAccessHint("summary")).toBe("deps.summary.text");
        expect(I.depsTextAccessHint("bad-key")).toBe('deps["bad-key"].text');
        expect(I.makeStructuredOutputCompatibilityError({ nodeId: "t", outputTableName: "out" }, new Error("bad")).code).toBe("INVALID_OUTPUT");
        expect(I.makePlainTextOutputError({ nodeId: "bad-key", outputTableName: "out" }, " hello\nworld ").details?.textPreview).toBe("hello world");
    });

    test("parses attempt metadata and heartbeat payloads defensively", () => {
        expect(I.parseAttemptMetaJson(null)).toEqual({});
        expect(I.parseAttemptMetaJson("[]")).toEqual({});
        expect(I.parseAttemptMetaJson("{")).toEqual({});
        expect(I.parseAttemptMetaJson('{"ok":true}')).toEqual({ ok: true });

        expect(I.asConversationMessages([{ role: "user" }])).toEqual([{ role: "user" }]);
        expect(I.asConversationMessages("nope")).toBeUndefined();
        expect(I.cloneJsonValue(undefined)).toBeUndefined();
        expect(I.cloneJsonValue({ x: 1 })).toEqual({ x: 1 });
        const circular = {};
        circular.self = circular;
        expect(I.cloneJsonValue(circular)).toBeUndefined();

        expect(I.parseAttemptHeartbeatData(null)).toBeNull();
        expect(I.parseAttemptHeartbeatData("")).toBeNull();
        expect(I.parseAttemptHeartbeatData("{")).toBeNull();
        expect(I.parseAttemptHeartbeatData('{"step":1}')).toEqual({ step: 1 });
    });

    test("validates heartbeat payload values and timeout errors", () => {
        expect(I.serializeHeartbeatPayload({ ok: true, items: [1, "two"], when: new Date(0) })).toMatchObject({
            heartbeatDataJson: expect.any(String),
            dataSizeBytes: expect.any(Number),
        });
        expect(() => I.validateHeartbeatValue(Number.NaN, "$.n", new Set())).toThrow("finite numbers");
        expect(() => I.validateHeartbeatValue(undefined, "$.x", new Set())).toThrow("undefined");
        expect(() => I.validateHeartbeatValue(1n, "$.big", new Set())).toThrow("non-JSON");
        expect(() => I.validateHeartbeatValue(Object.create({ inherited: true }), "$.obj", new Set())).toThrow("plain JSON objects");
        const circular = {};
        circular.self = circular;
        expect(() => I.validateHeartbeatValue(circular, "$", new Set())).toThrow("circular");
        expect(() => I.serializeHeartbeatPayload("x".repeat(1_000_001))).toThrow("exceeds");

        const timeout = new SmithersError("TASK_HEARTBEAT_TIMEOUT", "stale");
        const controller = new AbortController();
        controller.abort(timeout);
        expect(I.heartbeatTimeoutReasonFromAbort(controller.signal, new Error("other"))).toBe(timeout);
        expect(I.heartbeatTimeoutReasonFromAbort(undefined, { code: "TASK_HEARTBEAT_TIMEOUT", message: "late", details: { nodeId: "t" } })).toMatchObject({
            code: "TASK_HEARTBEAT_TIMEOUT",
        });
        expect(I.heartbeatTimeoutReasonFromAbort(undefined, new Error("other"))).toBeNull();
        expect(I.isHeartbeatPayloadValidationError({ code: "HEARTBEAT_PAYLOAD_TOO_LARGE" })).toBe(true);
        expect(I.isHeartbeatPayloadValidationError(new Error("other"))).toBe(false);
    });

    test("finds hijack continuations and tool-resume warnings", () => {
        expect(I.extractHijackContinuation({
            hijackHandoff: { engine: "cli", mode: "native-cli", resume: "sess" },
        }, "cli")).toEqual({ mode: "native-cli", resume: "sess" });
        expect(I.extractHijackContinuation({
            hijackHandoff: { engine: "sdk", mode: "conversation", messages: [{ role: "user" }] },
        }, "sdk")).toEqual({ mode: "conversation", messages: [{ role: "user" }] });
        expect(I.extractHijackContinuation({ agentEngine: "cli", agentResume: "old" }, "cli")).toEqual({ mode: "native-cli", resume: "old" });
        expect(I.extractHijackContinuation({ agentEngine: "cli", agentConversation: [{ role: "assistant" }] }, "cli")).toEqual({ mode: "conversation", messages: [{ role: "assistant" }] });
        expect(I.extractHijackContinuation({}, "cli")).toBeNull();
        expect(I.findHijackContinuation([{ metaJson: "{" }, { metaJson: '{"agentEngine":"cli","agentResume":"r"}' }], "cli")).toEqual({ mode: "native-cli", resume: "r" });

        const charge = tool({ name: "charge-card", sideEffect: true, idempotent: false });
        const safe = tool({ name: "read-card", sideEffect: false, idempotent: true });
        expect([...I.collectDefinedToolMetadata([{ tools: { charge, safe } }]).keys()]).toContain("charge-card");
        const warnings = I.collectToolResumeWarnings([
            { toolName: "charge", attempt: 1, seq: 4, status: "completed" },
            { toolName: "read-card", attempt: 1, seq: 5, status: "completed" },
        ], [{ tools: { charge, safe } }], 2);
        expect(warnings).toEqual([{ toolName: "charge", attempt: 1, seq: 4, status: "completed" }]);
        expect(I.collectToolResumeWarnings(warnings, [], 1)).toEqual([]);

        const message = I.buildToolResumeWarningMessage([
            ...warnings,
            { toolName: "a", attempt: 1, seq: 1, status: "done" },
            { toolName: "b", attempt: 1, seq: 2, status: "done" },
            { toolName: "c", attempt: 1, seq: 3, status: "done" },
            { toolName: "d", attempt: 1, seq: 4, status: "done" },
            { toolName: "e", attempt: 1, seq: 5, status: "done" },
        ]);
        expect(message).toContain("Previous attempts");
        expect(message).toContain("and 1 more");
        expect(I.buildToolResumeWarningMessage([])).toBeNull();
        expect(I.hasToolResumeWarningMessage([{ role: "user", content: message }])).toBe(true);
        expect(I.hasToolResumeWarningMessage([{ toJSON() { throw new Error("no"); } }])).toBe(false);
        expect(I.appendToolResumeWarningMessage([{ role: "user", content: "hi" }], message)).toHaveLength(2);
        expect(I.appendToolResumeWarningMessage(undefined, message)).toBeUndefined();
        expect(I.appendToolResumeWarningMessage([{ role: "user", content: message }], message)).toHaveLength(1);
        expect(I.prependToolResumeWarningMessage("prompt", message)).toContain("prompt");
        expect(I.prependToolResumeWarningMessage(message, message)).toBe(message);
    });
});

describe("engine internals: scheduler summaries and row shaping", () => {
    test("summarizes workflow-session and legacy scheduler decisions", () => {
        expect(I.workflowSessionTaskId({ nodeId: "b", iteration: 2 })).toBe("b::2");
        expect(I.workflowSessionTaskIds([{ nodeId: "b", iteration: 1 }, { nodeId: "a", iteration: 0 }])).toEqual(["a::0", "b::1"]);

        expect(I.summarizeWorkflowSessionDecision({ _tag: "Execute", tasks: [{ nodeId: "t", iteration: 0 }] })).toEqual({ tag: "Execute", tasks: ["t::0"] });
        expect(I.summarizeWorkflowSessionDecision({ _tag: "Wait", reason: { _tag: "Timer" } })).toEqual({ tag: "Wait", reason: "Timer" });
        expect(I.summarizeWorkflowSessionDecision({ _tag: "ContinueAsNew", transition: { reason: "loop" } })).toEqual({ tag: "ContinueAsNew", reason: "loop" });
        expect(I.summarizeWorkflowSessionDecision({ _tag: "Finished", result: { status: "finished" } })).toEqual({ tag: "Finished", status: "finished" });
        expect(I.summarizeWorkflowSessionDecision({ _tag: "Failed", error: { code: "BAD" } })).toEqual({ tag: "Failed", code: "BAD" });
        expect(I.summarizeWorkflowSessionDecision({ _tag: "ReRender" })).toEqual({ tag: "ReRender" });
        expect(I.summarizeWorkflowSessionDecision({ _tag: "Unexpected" })).toEqual({ tag: "Failed", code: "UNKNOWN_DECISION" });

        const base = { runnable: [], pendingExists: false, waitingApprovalExists: false, waitingEventExists: false, waitingTimerExists: false, readyRalphs: [] };
        expect(I.summarizeLegacySchedulerDecision({ ...base, fatalError: "bad" }, new Map(), [], new Set())).toEqual({ tag: "Failed" });
        expect(I.summarizeLegacySchedulerDecision(base, new Map([["t::0", "failed"]]), [{ nodeId: "t", iteration: 0, continueOnFail: false }], new Set())).toEqual({ tag: "Failed" });
        expect(I.summarizeLegacySchedulerDecision({ ...base, continuation: {} }, new Map(), [], new Set())).toEqual({ tag: "ContinueAsNew", reason: "explicit" });
        expect(I.summarizeLegacySchedulerDecision({ ...base, runnable: [{ nodeId: "t", iteration: 1 }] }, new Map(), [], new Set())).toEqual({ tag: "Execute", tasks: ["t::1"] });
        expect(I.summarizeLegacySchedulerDecision(base, new Map(), [], new Set(["t::0"]))).toEqual({ tag: "Wait", reason: "ExternalTrigger" });
        expect(I.summarizeLegacySchedulerDecision({ ...base, waitingApprovalExists: true }, new Map(), [], new Set())).toEqual({ tag: "Wait", reason: "Approval" });
        expect(I.summarizeLegacySchedulerDecision({ ...base, waitingEventExists: true }, new Map(), [], new Set())).toEqual({ tag: "Wait", reason: "Event" });
        expect(I.summarizeLegacySchedulerDecision({ ...base, waitingTimerExists: true }, new Map(), [], new Set())).toEqual({ tag: "Wait", reason: "Timer" });
        expect(I.summarizeLegacySchedulerDecision({ ...base, pendingExists: true }, new Map(), [], new Set())).toEqual({ tag: "Wait", reason: "ExternalTrigger" });
        expect(I.summarizeLegacySchedulerDecision({ ...base, pendingExists: true, nextRetryAtMs: 10 }, new Map(), [], new Set())).toEqual({ tag: "Wait", reason: "RetryBackoff" });
        expect(I.summarizeLegacySchedulerDecision({ ...base, readyRalphs: [{}] }, new Map(), [], new Set())).toEqual({ tag: "ReRender" });
        expect(I.summarizeLegacySchedulerDecision(base, new Map(), [], new Set())).toEqual({ tag: "Finished", status: "finished" });
        expect(I.workflowSessionSummaryKey({ tag: "Finished", status: "finished" })).toBe('{"tag":"Finished","status":"finished"}');
    });

    test("builds and normalizes input/output rows", () => {
        expect(I.buildInputRow(inputPayloadTable, "run", { prompt: "hi" })).toEqual({ runId: "run", payload: { prompt: "hi" } });
        expect(I.buildInputRow(inputWideTable, "run", { prompt: "hi", count: 2 })).toEqual({ runId: "run", prompt: "hi", count: 2 });
        expect(I.normalizeInputRow(null)).toEqual({});
        expect(I.normalizeInputRow({ runId: "run", payload: { a: 1 }, extra: 2 })).toEqual({ a: 1, extra: 2 });
        expect(I.normalizeInputRow({ runId: "run", payload: "raw", extra: 2 })).toEqual({ extra: 2 });
        expect(I.normalizeInputRow({ runId: "run", value: 3 })).toEqual({ value: 3 });
        expect(I.normalizeOutputRow(null)).toBeNull();
        expect(I.normalizeOutputRow({ runId: "run", nodeId: "t", iteration: 0, payload: { x: 1 } })).toEqual({ x: 1 });
        expect(I.normalizeOutputRow({ runId: "run", nodeId: "t", iteration: 0, value: "ok" })).toEqual({ value: "ok" });
    });

    test("quotes SQL identifiers and copies run-scoped rows with a raw client", () => {
        expect(I.quoteSqlIdent('a"b')).toBe('"a""b"');
        expect(I.toSqlValue(undefined)).toBeNull();
        expect(I.toSqlValue({ a: 1 })).toBe('{"a":1}');
        const date = new Date(0);
        expect(I.toSqlValue(date)).toBe(date);

        expect(I.getTableColumnEntries(outputTable).map((entry) => entry.sqlName)).toEqual(["run_id", "node_id", "iteration", "value"]);
        const calls = [];
        const client = {
            query(sql) {
                return {
                    run(...values) {
                        calls.push({ sql, values });
                    },
                };
            },
        };
        I.insertRowWithClient(client, "table", { runId: "run", value: { ok: true } }, [
            { key: "runId", sqlName: "run_id" },
            { key: "missing", sqlName: "missing" },
            { key: "value", sqlName: "value" },
        ]);
        I.insertRowWithClient(client, "table", {}, [{ key: "missing", sqlName: "missing" }]);
        I.copyRunScopedRowsWithClient(client, outputTable, "old", "new");
        expect(calls[0].sql).toContain('INSERT INTO "table"');
        expect(calls[0].values).toEqual(["run", '{"ok":true}']);
        expect(calls[1].sql).toContain('FROM "task_output"');
        expect(calls[1].values).toEqual(["new", "old"]);

        const noRunId = sqliteTable("no_run", { value: text("value") });
        I.copyRunScopedRowsWithClient(client, noRunId, "old", "new");
        expect(calls).toHaveLength(2);
    });
});

describe("engine internals: durability, options and graph helpers", () => {
    test("runsDueForQuotaResume returns only quota parks whose reset has elapsed", async () => {
        const { sqlite, adapter } = makeContinueDb();
        try {
            await insertRun(adapter, "quota-due", {
                status: "waiting-quota",
                errorJson: JSON.stringify({ resetAtMs: 1_000 }),
            });
            await insertRun(adapter, "quota-future", {
                status: "waiting-quota",
                errorJson: JSON.stringify({ resetAtMs: 3_000 }),
            });
            await insertRun(adapter, "quota-manual", {
                status: "waiting-quota",
                errorJson: JSON.stringify({ quotaBlockedCount: 1 }),
            });

            const due = await runsDueForQuotaResume(adapter, 2_000);
            expect(due.map((run) => run.runId)).toEqual(["quota-due"]);
        } finally {
            sqlite.close();
        }
    });

    test("nextAttemptNumber discounts only reset-cancelled attempts, not crash-recovery cancels", () => {
        // Attempts are newest-first (as listAttempts returns them).
        const failed = (attempt) => ({ attempt, state: "failed", metaJson: null });
        const crashCancel = (attempt) => ({ attempt, state: "cancelled", metaJson: null });
        const resetCancel = (attempt) => ({
            attempt,
            state: "cancelled",
            metaJson: JSON.stringify({ resetCancelled: true }),
        });

        // No history -> attempt 1.
        expect(I.nextAttemptNumber([])).toBe(1);
        // A normal failed attempt advances the number.
        expect(I.nextAttemptNumber([failed(1)])).toBe(2);
        // A crash-recovery cancellation (unmarked) STILL counts -> preserves
        // crash attempt numbering, tool-resume warnings, and revert anchors.
        expect(I.nextAttemptNumber([crashCancel(1)])).toBe(2);
        expect(I.nextAttemptNumber([crashCancel(2), failed(1)])).toBe(3);
        // A reset-cancelled attempt is discounted -> retry restarts at rung 0.
        expect(I.nextAttemptNumber([resetCancel(1)])).toBe(1);
        expect(I.nextAttemptNumber([resetCancel(3), resetCancel(2), resetCancel(1)])).toBe(1);
        // Mixed: reset-cancels discounted, an unmarked failed row still counts.
        expect(I.nextAttemptNumber([resetCancel(2), failed(1)])).toBe(2);

        expect(I.isResetCancelledAttempt(resetCancel(1))).toBe(true);
        expect(I.isResetCancelledAttempt(crashCancel(1))).toBe(false);
        expect(I.isResetCancelledAttempt(failed(1))).toBe(false);
        // Marker only counts on a cancelled row, not any other state.
        expect(I.isResetCancelledAttempt({ attempt: 1, state: "failed", metaJson: JSON.stringify({ resetCancelled: true }) })).toBe(false);
    });

    test("handles carried input rows and durability metadata comparisons", () => {
        expect(I.ralphStateToObject(new Map([
            ["b", { iteration: 2, done: true }],
            ["a", { iteration: 1, done: false }],
        ]))).toEqual({
            a: { iteration: 1, done: false },
            b: { iteration: 2, done: true },
        });
        const cloned = I.cloneRalphStateMap(new Map([["loop", { iteration: 1, done: false }]]));
        expect(cloned.get("loop")).toEqual({ iteration: 1, done: false });

        expect(I.buildCarriedInputRow(inputPayloadTable, "new-run", { runId: "old", payload: { prompt: "hi" } }, { next: true })).toEqual({
            runId: "new-run",
            payload: { prompt: "hi", __smithersContinuation: { next: true } },
        });
        expect(I.buildCarriedInputRow(inputWideTable, "new-run", { runId: "old", prompt: "hi" }, { next: true })).toEqual({
            runId: "new-run",
            prompt: "hi",
            count: null,
        });
        const badInput = sqliteTable("bad_input", { payload: text("payload") });
        expect(() => I.buildCarriedInputRow(badInput, "new", {}, {})).toThrow("runId column");

        const config = I.buildDurabilityConfig({ maxConcurrency: 2 }, { entryWorkflowHash: "entry" });
        expect(I.getStoredDurabilityConfig(config)).toEqual({ version: 2, entryWorkflowHash: "entry" });
        expect(I.getStoredDurabilityConfig({})).toBeNull();
        const mismatches = [];
        I.compareNullableString("a", "b", "changed", mismatches);
        expect(mismatches).toEqual(["changed"]);
        expect(() => I.assertResumeDurabilityMetadata({
            workflowPath: "/tmp/wf.ts",
            workflowHash: "old",
            vcsRoot: "/repo",
            vcsType: "git",
            vcsRevision: "abc",
        }, config, {
            workflowHash: "new",
            entryWorkflowHash: "entry2",
            vcsRoot: "/repo2",
            vcsType: "git",
            vcsRevision: "def",
        }, "/tmp/wf.ts")).toThrow("durable metadata changed");
    });

    test("assertResumeDurabilityMetadata covers matching, missing-hash, legacy and VCS-root branches", () => {
        // Derive the durability config key from a built config so legacy configs
        // can be hand-built without coupling to the private constant name.
        const v2Config = I.buildDurabilityConfig({}, { entryWorkflowHash: "entry" });
        const [durabilityKey] = Object.keys(v2Config).filter((k) => k !== "maxConcurrency");
        const legacyConfig = (overrides = {}) => ({ [durabilityKey]: { version: 0, ...overrides } });

        // (a) Matching metadata + matching stored config must NOT throw — a legitimate
        // resume has to be allowed (otherwise every resume would brick).
        expect(() => I.assertResumeDurabilityMetadata({
            workflowPath: "/tmp/wf.ts",
            workflowHash: "graph-1",
            vcsRoot: "/repo",
            vcsType: "git",
            vcsRevision: "abc",
        }, v2Config, {
            workflowHash: "graph-1",
            entryWorkflowHash: "entry",
            vcsRoot: "/repo",
            vcsType: "git",
            vcsRevision: "abc",
        }, "/tmp/wf.ts")).not.toThrow();

        // (b) version >= current (2): a missing module-graph hash on EITHER side must
        // be treated as a mismatch (fail closed), not silently allowed.
        expect(() => I.assertResumeDurabilityMetadata({
            workflowPath: "/tmp/wf.ts",
            workflowHash: null,
            vcsRoot: "/repo",
        }, v2Config, {
            workflowHash: "graph-1",
            entryWorkflowHash: "entry",
            vcsRoot: "/repo",
        }, "/tmp/wf.ts")).toThrow("workflow module graph unavailable");
        expect(() => I.assertResumeDurabilityMetadata({
            workflowPath: "/tmp/wf.ts",
            workflowHash: "graph-1",
            vcsRoot: "/repo",
        }, v2Config, {
            workflowHash: null,
            entryWorkflowHash: "entry",
            vcsRoot: "/repo",
        }, "/tmp/wf.ts")).toThrow("workflow module graph unavailable");

        // (b cont.) a missing entry-workflow hash on EITHER side => entry hash unavailable.
        expect(() => I.assertResumeDurabilityMetadata({
            workflowPath: "/tmp/wf.ts",
            workflowHash: "graph-1",
            vcsRoot: "/repo",
        }, I.buildDurabilityConfig({}, { entryWorkflowHash: null }), {
            workflowHash: "graph-1",
            entryWorkflowHash: "entry",
            vcsRoot: "/repo",
        }, "/tmp/wf.ts")).toThrow("workflow entry hash unavailable");
        expect(() => I.assertResumeDurabilityMetadata({
            workflowPath: "/tmp/wf.ts",
            workflowHash: "graph-1",
            vcsRoot: "/repo",
        }, v2Config, {
            workflowHash: "graph-1",
            entryWorkflowHash: null,
            vcsRoot: "/repo",
        }, "/tmp/wf.ts")).toThrow("workflow entry hash unavailable");

        // (c) legacy stored version (< 2): compares existingRun.workflowHash against
        // current.entryWorkflowHash. A differing entry hash => "workflow entry file changed".
        expect(() => I.assertResumeDurabilityMetadata({
            workflowPath: "/tmp/wf.ts",
            workflowHash: "old-entry-hash",
            vcsRoot: "/repo",
        }, legacyConfig(), {
            workflowHash: "ignored-graph",
            entryWorkflowHash: "new-entry-hash",
            vcsRoot: "/repo",
        }, "/tmp/wf.ts")).toThrow("workflow entry file changed");
        // ...and a matching legacy entry hash must NOT throw.
        expect(() => I.assertResumeDurabilityMetadata({
            workflowPath: "/tmp/wf.ts",
            workflowHash: "same-entry-hash",
            vcsRoot: "/repo",
        }, legacyConfig(), {
            workflowHash: "ignored-graph",
            entryWorkflowHash: "same-entry-hash",
            vcsRoot: "/repo",
        }, "/tmp/wf.ts")).not.toThrow();

        // (d) VCS root changed in isolation (everything else matching).
        expect(() => I.assertResumeDurabilityMetadata({
            workflowPath: "/tmp/wf.ts",
            workflowHash: "graph-1",
            vcsRoot: "/repo",
        }, v2Config, {
            workflowHash: "graph-1",
            entryWorkflowHash: "entry",
            vcsRoot: "/repo2",
        }, "/tmp/wf.ts")).toThrow("VCS root changed");
        // ...but a trailing-slash-only difference is resolve()-normalized => no throw.
        expect(() => I.assertResumeDurabilityMetadata({
            workflowPath: "/tmp/wf.ts",
            workflowHash: "graph-1",
            vcsRoot: "/repo",
        }, v2Config, {
            workflowHash: "graph-1",
            entryWorkflowHash: "entry",
            vcsRoot: "/repo/",
        }, "/tmp/wf.ts")).not.toThrow();
    });

    test("parses run config/auth and validates run options", () => {
        expect(I.resolveRootDir({ rootDir: "/tmp/root" }, null)).toBe(resolvePath("/tmp/root"));
        expect(I.resolveLogDir("/tmp/root", "run", null)).toBeUndefined();
        expect(I.resolveLogDir("/tmp/root", "run", "logs")).toBe(resolvePath("/tmp/root", "logs"));
        expect(I.parseRunConfigJson("")).toEqual({});
        expect(I.parseRunConfigJson("[]")).toEqual({});
        expect(I.parseRunConfigJson("{")).toEqual({});
        expect(I.parseRunConfigJson('{"auth":{"role":"admin"}}')).toEqual({ auth: { role: "admin" } });
        expect(I.parseRunAuthContext(null)).toBeNull();
        expect(I.parseRunAuthContext({ triggeredBy: "u", scopes: ["a", 1], role: "operator", createdAt: "now" })).toEqual({
            triggeredBy: "u",
            scopes: ["a"],
            role: "operator",
            createdAt: "now",
        });
        expect(I.isResumableRunStatus("waiting-event")).toBe(true);
        expect(I.isResumableRunStatus("queued")).toBe(false);
        expect(I.normalizeHotOptions(false)).toEqual({ enabled: false });
        expect(I.normalizeHotOptions(true)).toEqual({ enabled: true });
        expect(I.normalizeHotOptions({ rootDir: "/tmp" })).toEqual({ enabled: true, rootDir: "/tmp" });
        expect(() => I.assertInputObject([])).toThrow("JSON object");
        expect(() => I.validateRunOptions({ input: {}, maxConcurrency: 0 })).toThrow("maxConcurrency");
        expect(() => I.validateRunOptions({
            input: {},
            resumeClaim: { claimOwnerId: "owner", claimHeartbeatAtMs: 1, restoreHeartbeatAtMs: 2 },
        })).not.toThrow();

        const outer = new AbortController();
        const inner = new AbortController();
        const detach = I.wireAbortSignal(inner, outer.signal);
        outer.abort();
        expect(inner.signal.aborted).toBe(true);
        detach();
    });

    test("validates remaining run option bounds and default log-dir resolution", () => {
        expect(I.resolveLogDir("/tmp/root", "run-1", undefined)).toBe(
            resolvePath("/tmp/root", ".smithers", "executions", "run-1", "logs"),
        );
        expect(I.coercePositiveInt("workers", undefined, 3)).toBe(3);
        expect(I.coercePositiveInt("workers", "4", 1)).toBe(4);
        expect(() => I.coercePositiveInt("workers", "4.9", 1)).toThrow("workers");
        expect(() => I.coercePositiveInt("workers", 0, 1)).toThrow("workers");
        expect(() => I.coercePositiveInt("workers", Number.POSITIVE_INFINITY, 1)).toThrow("workers");

        expect(() => I.validateRunOptions({ input: {}, maxOutputBytes: 0 })).toThrow("maxOutputBytes");
        expect(() => I.validateRunOptions({ input: {}, maxOutputBytes: Number.NaN })).toThrow("maxOutputBytes");
        expect(() => I.validateRunOptions({ input: {}, toolTimeoutMs: -1 })).toThrow("toolTimeoutMs");
        expect(() => I.validateRunOptions({
            input: {},
            resumeClaim: {
                claimOwnerId: "x".repeat(257),
                claimHeartbeatAtMs: 1,
                restoreHeartbeatAtMs: 1,
            },
        })).toThrow("resumeClaim.claimOwnerId");
    });

    test("extracts workflow imports and resolves local imports", async () => {
        expect(I.getWorkflowImportScanLoader("file.tsx")).toBe("tsx");
        expect(I.getWorkflowImportScanLoader("file.cts")).toBe("ts");
        expect(I.getWorkflowImportScanLoader("file.js")).toBe("js");
        expect(I.extractWorkflowImportSpecifiers('import x from "./x"; import "pkg"; export { y } from "./y"; import("./z")', "file.js").sort()).toEqual(["./x", "./y", "./z"]);

        const dir = mkdtempSync(join(tmpdir(), "smithers-engine-imports-"));
        try {
            const workflowPath = join(dir, "workflow.ts");
            const helperPath = join(dir, "helper.ts");
            const indexPath = join(dir, "nested", "index.js");
            writeFileSync(workflowPath, 'import "./helper";');
            writeFileSync(helperPath, "export const helper = true;");
            mkdirSync(join(dir, "nested"));
            writeFileSync(indexPath, "export const nested = true;");
            expect(I.resolveWorkflowImport(workflowPath, "./helper")).toBe(resolvePath(helperPath));
            expect(I.resolveWorkflowImport(workflowPath, "./nested")).toBe(resolvePath(indexPath));
            expect(I.resolveWorkflowImport(workflowPath, "./missing")).toBeNull();
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("handles Ralph state and task output resolution helpers", () => {
        expect(I.iterationsToMap(null)).toEqual(new Map());
        expect(I.iterationsToMap({ a: 1 })).toEqual(new Map([["a", 1]]));
        expect(I.ralphStateFromDriverTransition({ statePayload: { ralphState: { loop: { iteration: "2", done: true } } } })).toEqual(new Map([["loop", { iteration: 2, done: true }]]));
        expect(I.ralphStateFromDriverTransition({ statePayload: { ralphState: [] } })).toBeUndefined();
        // timerStarts rides on a dedicated `timerStarts` envelope field, never inside `payload`,
        // so a user-supplied continue-as-new `state` can't clobber the anchors.
        expect(I.timerStartsFromDriverTransition({ timerStarts: { "timer::0": 1000, bad: "nope" } })).toEqual({ "timer::0": 1000 });
        expect(I.timerStartsFromDriverTransition({ statePayload: { timerStarts: { "timer::0": 1000 } } })).toBeUndefined();
        expect(I.continuationEnvelopeFromInput({ payload: { __smithersContinuation: { timerStarts: { "timer::0": 1000 } } } })).toEqual({
            timerStarts: { "timer::0": 1000 },
        });
        expect(I.continuationEnvelopeFromConfig({ continuation: { timerStarts: { "timer::0": 1000 } } })).toEqual({
            timerStarts: { "timer::0": 1000 },
        });
        // Numeric strings are rejected (typeof-number only), and non-object shapes yield undefined.
        expect(I.timerStartsFromContinuationEnvelope({ timerStarts: { "timer::0": 1000, bad: "nope", weird: "1000" } })).toEqual(new Map([["timer::0", 1000]]));
        expect(I.timerStartsFromContinuationEnvelope({ timerStarts: [] })).toBeUndefined();
        expect(I.timerStartsFromContinuationEnvelope(undefined)).toBeUndefined();

        const state = new Map([
            ["outer", { iteration: 1, done: false }],
            ["inner@@outer=1", { iteration: 3, done: false }],
            ["inner@@outer=0", { iteration: 2, done: false }],
        ]);
        expect(I.ralphIterationsFromState(state).get("inner@@outer=1")).toBe(3);
        expect(I.ralphIterationsObject(state)).toMatchObject({ outer: 1, inner: 3 });
        expect(I.buildRalphDoneMap([{ id: "outer", until: false }, { id: "done", until: true }], state)).toEqual(new Map([["outer", false], ["done", true]]));

        const schemaRef = { schema: true };
        const registry = new Map([["out", { table: outputTable, zodSchema: schemaRef }]]);
        const outputRef = { ref: true };
        const workflow = {
            schemaRegistry: registry,
            zodToKeyName: new Map([[outputRef, "out"], [schemaRef, "out"]]),
            ambiguousZodSchemas: new Set(),
        };
        const tasks = [{ nodeId: "a", outputRef }, { nodeId: "b", outputSchema: schemaRef }, { nodeId: "c", outputTableName: "out" }];
        I.resolveTaskOutputs(tasks, workflow);
        expect(tasks.map((task) => task.outputTableName)).toEqual(["out", "out", "out"]);
        const existing = [{ nodeId: "existing", outputTable: outputTable, outputTableName: "out" }];
        I.resolveTaskOutputs(existing, workflow);
        expect(existing[0].outputSchema).toBe(schemaRef);
        expect(() => I.resolveTaskOutputs([{ nodeId: "bad", outputRef }], {
            schemaRegistry: registry,
            zodToKeyName: new Map(),
            ambiguousZodSchemas: new Set([outputRef]),
        })).toThrow("multiple keys");
        expect(() => I.resolveTaskOutputs([{ nodeId: "missing", outputTableName: "missing" }], workflow)).toThrow("not registered");

        expect(I.buildDescriptorMap(tasks).get("a")).toBe(tasks[0]);
        expect(I.buildRalphStateMap([{ ralphId: "r", iteration: 4, done: 1 }])).toEqual(new Map([["r", { iteration: 4, done: true }]]));
        expect(I.parseAttemptErrorCode('{"code":"INVALID_OUTPUT"}')).toBe("INVALID_OUTPUT");
        expect(I.parseAttemptErrorCode("{")).toBeNull();
        expect(I.isRetryableTaskFailure({ metaJson: '{"failureRetryable":false}' })).toBe(false);
        expect(I.isRetryableTaskFailure({ errorJson: '{"code":"AGENT_CONFIG_INVALID"}' })).toBe(false);
        expect(I.isRetryableTaskFailure({ metaJson: '{"kind":"compute"}', errorJson: '{"code":"INVALID_OUTPUT"}' })).toBe(false);
        expect(I.isRetryableTaskFailure({ metaJson: '{"kind":"agent"}', errorJson: '{"code":"INVALID_OUTPUT"}' })).toBe(true);
    });

    test("duration-timer anchors survive a continue-as-new handoff even when the user supplies continuation state", () => {
        // Reproduces the clobber bug: an explicit `<ContinueAsNew state={...}>`
        // sets `stateJson`, which the engine JSON-parses into `payload`. Anchors
        // must ride the dedicated `timerStarts` field so they are never lost.
        const userState = { keepMe: 42, timerStarts: { spoofed: 1 } };
        const transition = {
            reason: "explicit",
            stateJson: JSON.stringify(userState),
            timerStarts: { "timer::0": 1_000, "timer::1": 2_000 },
        };

        // Extraction reads the dedicated field, unaffected by the user payload.
        const carried = I.timerStartsFromDriverTransition(transition);
        expect(carried).toEqual({ "timer::0": 1_000, "timer::1": 2_000 });

        // The envelope the engine writes carries `payload` (user state) AND the
        // dedicated `timerStarts` field side by side, exactly like `ralph`.
        const envelope = {
            payload: JSON.parse(transition.stateJson),
            ralph: {},
            timerStarts: carried,
        };

        // Next run reads the anchors off the dedicated field — the spoofed
        // `payload.timerStarts` is ignored entirely.
        const fromInput = I.continuationEnvelopeFromInput({
            payload: { __smithersContinuation: envelope },
        });
        expect(I.timerStartsFromContinuationEnvelope(fromInput)).toEqual(new Map([
            ["timer::0", 1_000],
            ["timer::1", 2_000],
        ]));

        // The config-carried copy of the envelope resolves identically.
        const fromConfig = I.continuationEnvelopeFromConfig({ continuation: envelope });
        expect(I.timerStartsFromContinuationEnvelope(fromConfig)).toEqual(new Map([
            ["timer::0", 1_000],
            ["timer::1", 2_000],
        ]));
    });

    test("continueRunAsNew rejects oversized continuation state before writing child state", async () => {
        const { sqlite, db, schema, adapter } = makeContinueDb();
        const runId = "continue-as-new-oversized-source";
        await insertRun(adapter, runId);
        sqlite
            .query("INSERT INTO input_wide (run_id, prompt, count) VALUES (?, ?, ?)")
            .run(runId, "seed", 1);

        const oversizedPayload = { blob: "x".repeat(10 * 1024 * 1024) };
        let caught;
        try {
            await I.continueRunAsNew({
                db,
                adapter,
                schema,
                inputTable: inputWideTable,
                runId,
                workflowPath: "/tmp/workflow.ts",
                runMetadata: {
                    workflowHash: "new-hash",
                    vcsType: "git",
                    vcsRoot: "/repo",
                    vcsRevision: "new-rev",
                },
                currentFrameNo: 3,
                continuation: {
                    reason: "loop",
                    iteration: 1,
                    loopId: "loop",
                    statePayload: oversizedPayload,
                },
                ralphState: new Map(),
            });
        }
        catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(SmithersError);
        expect(caught?.code).toBe("CONTINUATION_STATE_TOO_LARGE");
        expect(caught?.details?.maxBytes).toBe(10 * 1024 * 1024);
        expect(caught?.details?.carriedStateBytes).toBeGreaterThan(10 * 1024 * 1024);

        const childRun = await Effect.runPromise(adapter.getLatestChildRun(runId));
        expect(childRun).toBeUndefined();
        const events = await Effect.runPromise(adapter.listEvents(runId, -1, 100));
        expect(events.some((event) => event.type === "RunContinuedAsNew")).toBe(false);
        const sourceRun = await Effect.runPromise(adapter.getRun(runId));
        expect(sourceRun?.status).toBe("running");
    });

    test("resolveWorkflowOutputTable resolves declared outputs and fails fast on unregistered targets", () => {
        const schemaRef = { schema: true };
        const registry = new Map([["childResult", { table: outputTable, zodSchema: schemaRef }]]);
        const zodToKeyName = new Map([[schemaRef, "childResult"]]);
        const defaultOutput = { defaultOutput: true };
        const stringKeyTable = { stringKeyTable: true };
        const schema = { output: defaultOutput, phase: stringKeyTable };

        const base = { schemaRegistry: registry, zodToKeyName, ambiguousZodSchemas: new Set() };

        // No explicit output: falls back to the schema key literally named `output`.
        expect(I.resolveWorkflowOutputTable({ opts: {}, ...base }, schema)).toBe(defaultOutput);

        // A registered schema object resolves to its table.
        expect(
            I.resolveWorkflowOutputTable({ opts: { output: schemaRef }, ...base }, schema),
        ).toBe(outputTable);

        // A string key resolves via the schema registry first...
        expect(
            I.resolveWorkflowOutputTable({ opts: { output: "childResult" }, ...base }, schema),
        ).toBe(outputTable);
        // ...then falls back to a raw schema key.
        expect(
            I.resolveWorkflowOutputTable({ opts: { output: "phase" }, ...base }, schema),
        ).toBe(stringKeyTable);

        // A real Drizzle table passes through the isTable() guard.
        expect(
            I.resolveWorkflowOutputTable({ opts: { output: outputTable }, ...base }, schema),
        ).toBe(outputTable);

        // An unregistered, non-table object fails fast with the clear error
        // instead of being returned as a bogus table (the isTable() fix).
        const unregistered = { schema: true };
        expect(() =>
            I.resolveWorkflowOutputTable({ opts: { output: unregistered }, ...base }, schema),
        ).toThrow("not registered");

        // A schema object registered under multiple keys reports the ambiguity.
        const ambiguous = { ambiguous: true };
        expect(() =>
            I.resolveWorkflowOutputTable(
                {
                    opts: { output: ambiguous },
                    schemaRegistry: registry,
                    zodToKeyName: new Map(),
                    ambiguousZodSchemas: new Set([ambiguous]),
                },
                schema,
            ),
        ).toThrow("multiple keys");
    });
});

describe("engine internals: cancellation maintenance", () => {
    test("cancels in-progress and stale attempts through adapter effects", async () => {
        const calls = [];
        const adapter = {
            listInProgressAttempts: () => Effect.succeed([
                { nodeId: "active", iteration: 0, attempt: 2, startedAtMs: 1 },
            ]),
            getNode: () => Effect.succeed({ outputTable: "out", label: "Active" }),
            updateAttempt: (...args) => Effect.sync(() => calls.push(["updateAttempt", args])),
            insertNode: (row) => Effect.sync(() => calls.push(["insertNode", row])),
            withTransaction: (_label, effect) => Effect.runPromise(effect),
        };
        const events = [];
        const eventBus = {
            emitEventWithPersist: (event) => Effect.sync(() => events.push(event)),
        };

        await I.cancelInProgress(adapter, "run", eventBus);
        expect(calls.some(([kind]) => kind === "updateAttempt")).toBe(true);
        expect(events).toMatchObject([{ type: "NodeCancelled", nodeId: "active", attempt: 2 }]);

        calls.length = 0;
        await I.cancelStaleAttempts(adapter, "run");
        expect(calls.some(([kind, row]) => kind === "insertNode" && row.state === "pending")).toBe(true);
    });
});

describe("engine internals: quota task failure detection", () => {
    test("isQuotaTaskFailure returns true for AGENT_QUOTA_EXCEEDED error code", () => {
        const attempt = {
            errorJson: JSON.stringify({ code: "AGENT_QUOTA_EXCEEDED", message: "quota hit" }),
            metaJson: null,
        };
        expect(I.isQuotaTaskFailure(attempt)).toBe(true);
    });

    test("isQuotaTaskFailure returns true for failureQuota: true in error details", () => {
        const attempt = {
            errorJson: JSON.stringify({
                code: "AGENT_CLI_ERROR",
                message: "rate limit",
                details: { failureQuota: true },
            }),
            metaJson: null,
        };
        expect(I.isQuotaTaskFailure(attempt)).toBe(true);
    });

    test("isQuotaTaskFailure returns false for regular AGENT_CLI_ERROR", () => {
        const attempt = {
            errorJson: JSON.stringify({ code: "AGENT_CLI_ERROR", message: "transient" }),
            metaJson: null,
        };
        expect(I.isQuotaTaskFailure(attempt)).toBe(false);
    });

    test("isQuotaTaskFailure returns false for AGENT_CONFIG_INVALID", () => {
        const attempt = {
            errorJson: JSON.stringify({ code: "AGENT_CONFIG_INVALID", message: "bad model" }),
            metaJson: null,
        };
        expect(I.isQuotaTaskFailure(attempt)).toBe(false);
    });

    test("isQuotaTaskFailure handles null/missing attempt gracefully", () => {
        expect(I.isQuotaTaskFailure(null)).toBe(false);
        expect(I.isQuotaTaskFailure(undefined)).toBe(false);
        expect(I.isQuotaTaskFailure({ errorJson: null, metaJson: null })).toBe(false);
    });

    test("quota attempts do not decrement retry budget via DB round-trip", async () => {
        const { adapter } = makeContinueDb();
        const runId = "test-quota-run";
        await insertRun(adapter, runId);

        // Simulate a persisted AGENT_QUOTA_EXCEEDED attempt
        await Effect.runPromise(adapter.insertAttempt({
            runId,
            nodeId: "task-1",
            iteration: 0,
            attempt: 1,
            state: "failed",
            startedAtMs: 1,
            finishedAtMs: 2,
            errorJson: JSON.stringify({ code: "AGENT_QUOTA_EXCEEDED", message: "quota hit" }),
            metaJson: JSON.stringify({ kind: "agent" }),
            heartbeatDataJson: null,
            heartbeatDataSizeBytes: null,
        }));

        const attempts = await Effect.runPromise(adapter.listAttempts(runId, "task-1", 0));
        expect(attempts).toHaveLength(1);

        // The quota attempt should be recognized as a quota failure
        const [attempt] = attempts;
        expect(I.isQuotaTaskFailure(attempt)).toBe(true);
        // And should still be retryable (not a non-retryable failure)
        expect(I.isRetryableTaskFailure(attempt)).toBe(true);
    });
});
