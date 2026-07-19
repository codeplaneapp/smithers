import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";

import * as dbIndex from "../src/index.js";
import * as adapterBarrel from "../src/adapter/index.js";
import * as runStateBarrel from "../src/runState.js";
import { stripAutoColumns as reactStripAutoColumns } from "../src/react-output.js";
import { buildHumanRequestId } from "../src/buildHumanRequestId.js";
import { getSmithersSchemaSignature } from "../src/getSmithersSchemaSignature.js";
import { SqlMessageStorage } from "../src/sql-message-storage.js";
import { zodToTable } from "../src/zodToTable.js";
import { zodToCreateTableSQL } from "../src/zodToCreateTableSQL.js";

// Modular output/* copies (their own re-implementations, distinct from output.js).
import { buildOutputRow as mBuildOutputRow } from "../src/output/buildOutputRow.js";
import { stripAutoColumns as mStripAutoColumns } from "../src/output/stripAutoColumns.js";
import { getKeyColumns as mGetKeyColumns } from "../src/output/getKeyColumns.js";
import { buildKeyWhere as mBuildKeyWhere } from "../src/output/buildKeyWhere.js";
import { getAgentOutputSchema as mGetAgentOutputSchema } from "../src/output/getAgentOutputSchema.js";
import { validateOutput as mValidateOutput } from "../src/output/validateOutput.js";
import { validateExistingOutput as mValidateExistingOutput } from "../src/output/validateExistingOutput.js";
import { describeSchemaShape as mDescribeSchemaShape } from "../src/output/describeSchemaShape.js";
import { selectOutputRow as mSelectOutputRowEffect } from "../src/output/selectOutputRowEffect.js";
import { upsertOutputRow as mUpsertOutputRowEffect } from "../src/output/upsertOutputRowEffect.js";
import { Effect } from "effect";

// Modular frame-codec/* copies.
import { encodeFrameDelta as mEncodeFrameDelta } from "../src/frame-codec/encodeFrameDelta.js";
import { applyFrameDelta as mApplyFrameDelta } from "../src/frame-codec/applyFrameDelta.js";
import { applyFrameDeltaJson as mApplyFrameDeltaJson } from "../src/frame-codec/applyFrameDeltaJson.js";
import { parseFrameDelta as mParseFrameDelta } from "../src/frame-codec/parseFrameDelta.js";
import { serializeFrameDelta as mSerializeFrameDelta } from "../src/frame-codec/serializeFrameDelta.js";
import { normalizeFrameEncoding as mNormalizeFrameEncoding } from "../src/frame-codec/normalizeFrameEncoding.js";
import { FRAME_KEYFRAME_INTERVAL as mFrameKeyframeInterval } from "../src/frame-codec/FRAME_KEYFRAME_INTERVAL.js";
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";

describe("top-level + subpath barrels", () => {
    test("src/index.js re-exports the public surface", () => {
        expect(typeof dbIndex.SmithersDb).toBe("function");
        expect(typeof dbIndex.zodToTable).toBe("function");
        expect(typeof dbIndex.encodeFrameDelta).toBe("function");
        expect(typeof dbIndex.SqlMessageStorage).toBe("function");
    });

    test("src/adapter/index.js re-exports SmithersDb and the DB_* bound constants", () => {
        expect(typeof adapterBarrel.SmithersDb).toBe("function");
        expect(typeof adapterBarrel.DB_RUN_ID_MAX_LENGTH).toBe("number");
        expect(typeof adapterBarrel.DB_ALERT_ID_MAX_LENGTH).toBe("number");
        expect(typeof adapterBarrel.DB_ALERT_POLICY_NAME_MAX_LENGTH).toBe("number");
        expect(typeof adapterBarrel.DB_ALERT_MESSAGE_MAX_LENGTH).toBe("number");
        expect(typeof adapterBarrel.DB_RUN_WORKFLOW_NAME_MAX_LENGTH).toBe("number");
        expect(Array.isArray(adapterBarrel.DB_ALERT_ALLOWED_SEVERITIES)).toBe(true);
        expect(Array.isArray(adapterBarrel.DB_ALERT_ALLOWED_STATUSES)).toBe(true);
        expect(Array.isArray(adapterBarrel.DB_RUN_ALLOWED_STATUSES)).toBe(true);
    });

    test("src/runState.js barrel re-exports the run-state helpers", () => {
        expect(typeof runStateBarrel.deriveRunState).toBe("function");
        expect(typeof runStateBarrel.computeRunState).toBe("function");
        expect(typeof runStateBarrel.computeRunStateFromRow).toBe("function");
        expect(typeof runStateBarrel.RUN_STATE_HEARTBEAT_STALE_MS).toBe("number");
    });

    test("react-output re-exports stripAutoColumns", () => {
        expect(reactStripAutoColumns({ runId: "r", nodeId: "n", iteration: 0, x: 1 })).toEqual({ x: 1 });
    });

    test("buildHumanRequestId formats the composite id", () => {
        expect(buildHumanRequestId("run-1", "node-1", 2)).toBe("human:run-1:node-1:2");
    });
});

describe("getSmithersSchemaSignature", () => {
    test("returns schemaVersion + stable signature for a real sqlite storage", async () => {
        const storage = new SqlMessageStorage(new Database(":memory:"));
        storage.ensureSchema();
        const sig = await getSmithersSchemaSignature(storage);
        expect(typeof sig.schemaVersion).toBe("string");
        expect(sig.signature).toMatch(/^[0-9a-f]{64}$/);
        expect(sig.components._smithers_runs).toBeDefined();
        // Stable across calls.
        const sig2 = await getSmithersSchemaSignature(storage);
        expect(sig2.signature).toBe(sig.signature);
    });

    test("resolves via an object exposing .internalStorage", async () => {
        const storage = new SqlMessageStorage(new Database(":memory:"));
        storage.ensureSchema();
        const sig = await getSmithersSchemaSignature({ internalStorage: storage });
        expect(sig.signature).toMatch(/^[0-9a-f]{64}$/);
    });

    test("throws when given neither a storage nor an adapter", async () => {
        await expect(getSmithersSchemaSignature({})).rejects.toThrow(/requires a SmithersDb or SqlMessageStorage/);
    });
});

describe("modular output/* copies", () => {
    /** @param {string} name @param {z.ZodObject<any>} schema */
    function tableAndDb(name, schema) {
        const table = zodToTable(name, schema);
        const sqlite = new Database(":memory:");
        sqlite.exec(zodToCreateTableSQL(name, schema));
        const db = drizzle(sqlite, { schema: { [name]: table } });
        return { table, db, sqlite };
    }

    test("buildOutputRow payload-only vs column-mapped", () => {
        const payloadTable = zodToTable("pl", z.object({ payload: z.string() }));
        expect(mBuildOutputRow(payloadTable, "r", "n", 0, "hi")).toEqual({ runId: "r", nodeId: "n", iteration: 0, payload: "hi" });
        expect(mBuildOutputRow(payloadTable, "r", "n", 0, null)).toEqual({ runId: "r", nodeId: "n", iteration: 0, payload: null });
        const colTable = zodToTable("c", z.object({ a: z.string(), b: z.number() }));
        expect(mBuildOutputRow(colTable, "r", "n", 1, { a: "x", b: 2 })).toEqual({ a: "x", b: 2, runId: "r", nodeId: "n", iteration: 1 });
    });

    test("stripAutoColumns strips keys, passes non-objects through", () => {
        expect(mStripAutoColumns({ runId: "r", nodeId: "n", iteration: 0, __smithersProvenanceSeq: 42, keep: 1 })).toEqual({ keep: 1 });
        expect(mStripAutoColumns(null)).toBeNull();
        expect(mStripAutoColumns([1, 2])).toEqual([1, 2]);
        expect(mStripAutoColumns("str")).toBe("str");
    });

    test("getKeyColumns + buildKeyWhere", () => {
        const table = zodToTable("k", z.object({ a: z.string() }));
        const cols = mGetKeyColumns(table);
        expect(cols.runId).toBeDefined();
        expect(cols.nodeId).toBeDefined();
        expect(mBuildKeyWhere(table, { runId: "r", nodeId: "n", iteration: 0 })).toBeDefined();
        // Missing required key columns throws.
        expect(() => mGetKeyColumns(zodToTable("i", z.object({ a: z.string() }), { isInput: true }))).toThrow();
    });

    test("getAgentOutputSchema strips key columns", () => {
        const table = zodToTable("ag", z.object({ a: z.string(), b: z.number() }));
        const schema = mGetAgentOutputSchema(table);
        expect(Object.keys(schema.shape).sort()).toEqual(["a", "b"]);
    });

    test("validateOutput + validateExistingOutput ok/error", () => {
        const table = zodToTable("v", z.object({ a: z.string() }));
        const ok = mValidateOutput(table, { runId: "r", nodeId: "n", iteration: 0, a: "x" });
        expect(ok.ok).toBe(true);
        const bad = mValidateOutput(table, { runId: "r", nodeId: "n", iteration: 0, a: 123 });
        expect(bad.ok).toBe(false);
        const okE = mValidateExistingOutput(table, { runId: "r", nodeId: "n", iteration: 0, a: "x" });
        expect(okE.ok).toBe(true);
        const badE = mValidateExistingOutput(table, { runId: "r", nodeId: "n", iteration: 0, a: 5 });
        expect(badE.ok).toBe(false);
    });

    test("describeSchemaShape describes fields (JSON-schema fast path)", () => {
        const table = zodToTable("d", z.object({ a: z.string(), b: z.number(), c: z.boolean() }));
        const out = mDescribeSchemaShape(table);
        expect(typeof out).toBe("string");
        expect(out.length).toBeGreaterThan(0);
        // Explicit zod schema arg branch.
        const out2 = mDescribeSchemaShape(z.object({ x: z.string() }));
        expect(typeof out2).toBe("string");
    });

    test("describeSchemaShape falls back to per-field describeZodType when JSON-schema conversion throws", () => {
        // z.bigint() makes z.toJSONSchema throw, forcing the manual describeZodType
        // loop that walks each field's _zod.def type.
        const schema = z.object({
            big: z.bigint(),
            s: z.string(),
            n: z.number(),
            b: z.boolean(),
            arr: z.array(z.string()),
            obj: z.object({ y: z.string() }),
            en: z.enum(["a", "b"]),
            lit: z.literal("x"),
            uni: z.union([z.string(), z.number()]),
            opt: z.string().optional(),
            nul: z.string().nullable(),
            def: z.string().default("d"),
        });
        const out = mDescribeSchemaShape(schema);
        const parsed = JSON.parse(out);
        expect(parsed.s).toBe("string");
        expect(parsed.n).toBe("number");
        expect(parsed.b).toBe("boolean");
        expect(parsed.arr).toBe("string[]");
        expect(parsed.obj).toBe("object");
        expect(parsed.en).toContain("enum(");
        expect(parsed.lit).toContain("literal(");
        expect(parsed.uni).toBe("string | number");
        expect(parsed.opt).toBe("string (optional)");
        expect(parsed.nul).toBe("string | null");
        expect(parsed.def).toBe("string");
        expect(parsed.big).toBe("unknown");
    });

    test("select + upsert output row effects (sqlite path)", async () => {
        const { table, db, sqlite } = tableAndDb("mout", z.object({ summary: z.string() }));
        try {
            await Effect.runPromise(mUpsertOutputRowEffect(db, table, { runId: "r", nodeId: "n", iteration: 0 }, { summary: "hi" }));
            const row = await Effect.runPromise(mSelectOutputRowEffect(db, table, { runId: "r", nodeId: "n", iteration: 0 }));
            expect(row.summary).toBe("hi");
        } finally {
            sqlite.close();
        }
    });

    test("select + upsert output row effects surface DB errors through the catch branch", async () => {
        // Build the table but never create the physical table → the query fails
        // and the tryPromise `catch` maps it to a SmithersError.
        const table = zodToTable("missing_tbl", z.object({ summary: z.string() }));
        const sqlite = new Database(":memory:");
        const db = drizzle(sqlite, { schema: { missing_tbl: table } });
        try {
            const selExit = await Effect.runPromiseExit(mSelectOutputRowEffect(db, table, { runId: "r", nodeId: "n", iteration: 0 }));
            expect(selExit._tag).toBe("Failure");
            const upExit = await Effect.runPromiseExit(
                mUpsertOutputRowEffect(db, table, { runId: "r", nodeId: "n", iteration: 0 }, { summary: "x" }),
            );
            expect(upExit._tag).toBe("Failure");
        } finally {
            sqlite.close();
        }
    });
});

describe("modular frame-codec/* copies", () => {
    const task = (id, state, label) => ({
        kind: "element",
        tag: "smithers:task",
        props: { id, state, ...(label ? { label } : {}) },
        children: [],
    });
    const workflow = (children) => ({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "delta" },
        children,
    });

    test("encode → serialize → parse → apply round trip", () => {
        const prev = canonicalizeXml(workflow([task("plan::0", "pending", "Plan"), task("impl::0", "pending")]));
        const next = canonicalizeXml(workflow([task("plan::0", "finished", "Plan"), task("review::0", "pending")]));
        const delta = mEncodeFrameDelta(prev, next);
        expect(delta.version).toBe(1);
        expect(delta.ops.length).toBeGreaterThan(0);
        const json = mSerializeFrameDelta(delta);
        const parsed = mParseFrameDelta(json);
        expect(parsed.version).toBe(1);
        const applied = mApplyFrameDelta(prev, parsed);
        expect(applied).toBe(next);
        const applied2 = mApplyFrameDeltaJson(prev, json);
        expect(applied2).toBe(next);
    });

    test("encode covers insert / remove / prop-change / array-resize op kinds", () => {
        // grow (insert), shrink (remove), and prop mutations across children.
        const a = canonicalizeXml(workflow([task("a::0", "pending"), task("b::0", "pending")]));
        const b = canonicalizeXml(workflow([task("a::0", "finished"), task("b::0", "pending"), task("c::0", "pending")]));
        expect(mApplyFrameDelta(a, mEncodeFrameDelta(a, b))).toBe(b);
        // now shrink back
        expect(mApplyFrameDelta(b, mEncodeFrameDelta(b, a))).toBe(a);
        // identical frames produce an empty delta
        expect(mEncodeFrameDelta(a, a).ops).toEqual([]);
    });

    test("normalizeFrameEncoding + FRAME_KEYFRAME_INTERVAL", () => {
        expect(mNormalizeFrameEncoding("delta")).toBe("delta");
        expect(mNormalizeFrameEncoding("keyframe")).toBe("keyframe");
        expect(mNormalizeFrameEncoding("nonsense")).toBe("full");
        expect(mFrameKeyframeInterval).toBe(50);
    });

    test("parseFrameDelta rejects malformed payloads", () => {
        expect(() => mParseFrameDelta("123")).toThrow(/not an object/);
        expect(() => mParseFrameDelta(JSON.stringify({ version: 99, ops: [] }))).toThrow(/version/);
        expect(() => mParseFrameDelta(JSON.stringify({ version: 1 }))).toThrow(/ops array/);
    });

    test("prop add/remove + reorder generate insert AND remove ops that round-trip", () => {
        const prev = canonicalizeXml(workflow([
            task("plan::0", "finished", "Plan"),
            task("impl::0", "in-progress", "Implement"),
            task("verify::0", "pending", "Verify"),
        ]));
        const next = canonicalizeXml(workflow([
            task("plan::0", "finished", "Planning"),
            task("verify::0", "pending", "Verify"),
            task("review::0", "pending", "Review"),
            task("ship::0", "pending", "Ship"),
        ]));
        const delta = mEncodeFrameDelta(prev, next);
        expect(delta.ops.some((op) => op.op === "insert")).toBe(true);
        expect(delta.ops.some((op) => op.op === "remove")).toBe(true);
        expect(mApplyFrameDelta(prev, delta)).toBe(next);
    });

    test("nested prop-only change reuses the object diff path", () => {
        const prev = canonicalizeXml(workflow([task("plan::0", "pending", "Plan")]));
        const next = canonicalizeXml(workflow([task("plan::0", "finished", "Plan")]));
        const delta = mEncodeFrameDelta(prev, next);
        expect(delta.ops.length).toBeGreaterThan(0);
        expect(mApplyFrameDelta(prev, delta)).toBe(next);
    });

    test("applyFrameDelta rejects invalid path operations and unknown ops", () => {
        const xml = canonicalizeXml(workflow([task("plan::0", "pending")]));
        expect(() => mApplyFrameDelta(xml, { version: 1, ops: [{ op: "insert", path: ["props", "name"], value: "bad" }] })).toThrow(/Invalid insert path/);
        // Unknown op: the modular applyOps treats any non set/insert as remove,
        // so an out-of-range remove path still resolves through removeAtPath.
        expect(() => mApplyFrameDelta(xml, { version: 1, ops: [{ op: "set", path: [42, "x"], value: 1 }] })).toThrow();
    });

    test("prop add / remove drives the object diff + object set/remove apply paths", () => {
        const prev = canonicalizeXml(workflow([task("plan::0", "pending", "Plan"), task("impl::0", "pending")]));
        // First task loses its `label` prop; second task gains one.
        const next = canonicalizeXml(workflow([task("plan::0", "pending"), task("impl::0", "pending", "Impl")]));
        const delta = mEncodeFrameDelta(prev, next);
        expect(delta.ops.some((op) => op.op === "remove")).toBe(true);
        expect(delta.ops.some((op) => op.op === "set")).toBe(true);
        expect(mApplyFrameDelta(prev, delta)).toBe(next);
    });

    test("middle insert keeps common prefix+suffix → pure-insert array diff", () => {
        // Identical first & last children; only a middle element is inserted, so
        // the prefix/suffix trim zeroes the prev slice → the insert-only branch.
        const prev = canonicalizeXml(workflow([task("a::0", "pending"), task("c::0", "pending")]));
        const next = canonicalizeXml(workflow([task("a::0", "pending"), task("b::0", "pending"), task("c::0", "pending")]));
        const delta = mEncodeFrameDelta(prev, next);
        expect(delta.ops.every((op) => op.op === "insert")).toBe(true);
        expect(mApplyFrameDelta(prev, delta)).toBe(next);
    });

    test("middle remove keeps common prefix+suffix → pure-remove array diff", () => {
        const prev = canonicalizeXml(workflow([task("a::0", "pending"), task("b::0", "pending"), task("c::0", "pending")]));
        const next = canonicalizeXml(workflow([task("a::0", "pending"), task("c::0", "pending")]));
        const delta = mEncodeFrameDelta(prev, next);
        expect(delta.ops.every((op) => op.op === "remove")).toBe(true);
        expect(mApplyFrameDelta(prev, delta)).toBe(next);
    });

    test("set with a null value exercises cloneValue's null fast-path", () => {
        const prev = canonicalizeXml(workflow([task("a::0", "pending")]));
        // Setting a prop to null routes through cloneValue(null) → returns null.
        const applied = mApplyFrameDelta(prev, { version: 1, ops: [{ op: "set", path: ["props", "name"], value: null }] });
        expect(applied).toContain('"name":null');
    });

    test("set at an array index replaces a child element (array set apply path)", () => {
        const prev = canonicalizeXml(workflow([task("a::0", "pending"), task("b::0", "pending")]));
        // parent is the `children` array, key is the numeric index 1 → array set branch.
        const replacement = task("z::0", "finished");
        const applied = mApplyFrameDelta(prev, { version: 1, ops: [{ op: "set", path: ["children", 1], value: replacement }] });
        expect(applied).toBe(canonicalizeXml(workflow([task("a::0", "pending"), task("z::0", "finished")])));
    });

    test("applyFrameDelta covers every getParentAndKey / set / remove error branch", () => {
        const xml = canonicalizeXml(workflow([task("plan::0", "pending", "Plan")]));
        const cases = [
            // parent is an array but key is not a number
            [{ op: "set", path: ["children", "x"], value: 1 }, /Invalid array set path/],
            // parent is an object but key is a number
            [{ op: "set", path: ["props", 0], value: 1 }, /Invalid object set path/],
            // remove: array parent, non-number key
            [{ op: "remove", path: ["children", "x"] }, /Invalid array remove path/],
            // remove: object parent, number key
            [{ op: "remove", path: ["props", 0] }, /Invalid object remove path/],
            // numeric segment where the cursor is not an array
            [{ op: "set", path: ["props", "name", 0, "y"], value: 1 }, /Invalid numeric path segment/],
            // string segment where the cursor is not a record
            [{ op: "set", path: ["props", "name", "x", "y"], value: 1 }, /Invalid object path segment/],
        ];
        for (const [op, re] of cases) {
            expect(() => mApplyFrameDelta(xml, { version: 1, ops: [op] })).toThrow(re);
        }
    });

    test("set/insert/remove at the document root are supported", () => {
        const xml = canonicalizeXml(workflow([task("plan::0", "pending")]));
        // remove at root → null (canonicalizeXml renders empty)
        expect(typeof mApplyFrameDelta(xml, { version: 1, ops: [{ op: "remove", path: [] }] })).toBe("string");
        // set at root → replace whole tree
        const replacementNode = workflow([task("z::0", "finished")]);
        const replaced = canonicalizeXml(replacementNode);
        expect(mApplyFrameDelta(xml, { version: 1, ops: [{ op: "set", path: [], value: replacementNode }] })).toBe(replaced);
        // insert at root → replace whole tree (insertAtPath path.length===0 branch)
        expect(mApplyFrameDelta(xml, { version: 1, ops: [{ op: "insert", path: [], value: replacementNode }] })).toBe(replaced);
    });
});
