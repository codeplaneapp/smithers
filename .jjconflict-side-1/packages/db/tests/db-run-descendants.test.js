import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";

function createDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { sqlite, db, adapter: new SmithersDb(db) };
}

const now = 1_700_000_000_000;
const runRow = (runId, status = "running", extra = {}) => ({ runId, workflowName: "wf", status, createdAtMs: now, ...extra });

describe("adapter: listRunDescendants", () => {
    test("walks parent_run_id DOWN breadth-first, self at depth 0", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("root"));
        await adapter.insertRun(runRow("child-a", "running", { parentRunId: "root" }));
        await adapter.insertRun(runRow("child-b", "waiting-approval", { parentRunId: "root" }));
        await adapter.insertRun(runRow("grand", "running", { parentRunId: "child-a" }));
        // Unrelated tree must not leak in.
        await adapter.insertRun(runRow("other-root"));
        await adapter.insertRun(runRow("other-child", "running", { parentRunId: "other-root" }));

        const tree = await adapter.listRunDescendants("root");
        expect(tree[0]).toMatchObject({ runId: "root", depth: 0 });
        expect(new Set(tree.filter((r) => r.depth === 1).map((r) => r.runId))).toEqual(new Set(["child-a", "child-b"]));
        expect(tree.filter((r) => r.depth === 2).map((r) => r.runId)).toEqual(["grand"]);
        expect(tree.map((r) => r.runId)).not.toContain("other-child");
        // Depths ascend: parents always precede their children.
        const depths = tree.map((r) => r.depth);
        expect(depths).toEqual([...depths].sort((a, b) => a - b));
    });

    test("a mid-tree run lists only its own subtree", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("root"));
        await adapter.insertRun(runRow("child", "running", { parentRunId: "root" }));
        await adapter.insertRun(runRow("grand", "running", { parentRunId: "child" }));

        const subtree = await adapter.listRunDescendants("child");
        expect(subtree.map((r) => r.runId)).toEqual(["child", "grand"]);
        expect(subtree.map((r) => r.depth)).toEqual([0, 1]);
    });

    test("stops at parent cycles and returns each run once", async () => {
        const { adapter } = createDb();
        // Corrupt parentage: a <-> b cycle must not hang the recursive walk.
        await adapter.insertRun(runRow("a", "running", { parentRunId: "b" }));
        await adapter.insertRun(runRow("b", "running", { parentRunId: "a" }));

        const tree = await adapter.listRunDescendants("a", 5);
        expect(tree.map((r) => r.runId)).toEqual(["a", "b"]);
        expect(new Set(tree.map((r) => r.runId)).size).toBe(tree.length);
    });

    test("respects the limit and returns [] for an unknown run", async () => {
        const { adapter } = createDb();
        await adapter.insertRun(runRow("root"));
        await adapter.insertRun(runRow("child", "running", { parentRunId: "root" }));

        expect((await adapter.listRunDescendants("root", 1)).map((r) => r.runId)).toEqual(["root"]);
        expect(await adapter.listRunDescendants("missing")).toEqual([]);
    });
});
