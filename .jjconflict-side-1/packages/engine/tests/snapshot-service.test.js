import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunContext";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { captureWorkspaceSnapshot } from "@smithers-orchestrator/vcs/jj";
import { createSnapshotService } from "../src/snapshotService.js";

/** A fake adapter that records rows in memory, for deterministic logic tests. */
function fakeAdapter() {
    const states = [];
    const checkpoints = [];
    return {
        states,
        checkpoints,
        async upsertWorkspaceState(row) {
            const i = states.findIndex((s) => s.runId === row.runId && s.jjCwd === row.jjCwd && s.jjCommitId === row.jjCommitId);
            if (i >= 0) states[i] = row;
            else states.push(row);
        },
        async insertWorkspaceCheckpoint(row) {
            checkpoints.push(row);
        },
    };
}

let clock = 0;
const nowMs = () => ++clock;

function req(overrides) {
    return {
        runId: "r1", nodeId: "n1", iteration: 0, attempt: 0,
        cwd: "/wt", source: "watch", tier: 2, label: null, toolUseId: null,
        ...overrides,
    };
}

describe("createSnapshotService logic (fake capture + adapter)", () => {
    test("watch dedups an unchanged state but records a new one when it changes", async () => {
        const adapter = fakeAdapter();
        let commit = "c1";
        const svc = createSnapshotService({
            captureSnapshot: async () => ({ commitId: commit, changeId: "ch1", operationId: `op-${commit}` }),
            adapter, nowMs,
        });
        await svc.snapshot(req());                 // c1 -> checkpoint
        await svc.snapshot(req());                 // c1 again -> deduped
        commit = "c2";
        await svc.snapshot(req());                 // c2 -> checkpoint
        expect(adapter.checkpoints).toHaveLength(2);
        expect(adapter.checkpoints.map((c) => c.jjCommitId)).toEqual(["c1", "c2"]);
        expect(adapter.checkpoints.map((c) => c.seq)).toEqual([0, 1]);
    });

    test("hook (tier 1) always records a checkpoint even when the state is unchanged", async () => {
        const adapter = fakeAdapter();
        const svc = createSnapshotService({
            captureSnapshot: async () => ({ commitId: "c1", changeId: "ch1", operationId: "op1" }),
            adapter, nowMs,
        });
        await svc.snapshot(req({ source: "hook", tier: 1, label: "Edit a.ts", toolUseId: "t1" }));
        await svc.snapshot(req({ source: "hook", tier: 1, label: "Edit a.ts", toolUseId: "t2" }));
        expect(adapter.checkpoints).toHaveLength(2);
        expect(adapter.checkpoints.map((c) => c.seq)).toEqual([0, 1]);
        expect(adapter.checkpoints.every((c) => c.jjCommitId === "c1")).toBe(true);
        // The state table deduped to a single row.
        expect(adapter.states).toHaveLength(1);
    });

    test("seq is monotonic per scope and independent across scopes", async () => {
        const adapter = fakeAdapter();
        let n = 0;
        const svc = createSnapshotService({
            captureSnapshot: async () => ({ commitId: `c${++n}`, changeId: "ch", operationId: `op${n}` }),
            adapter, nowMs,
        });
        await svc.snapshot(req({ source: "hook", tier: 1 }));
        await svc.snapshot(req({ source: "hook", tier: 1, nodeId: "n2" }));
        await svc.snapshot(req({ source: "hook", tier: 1 }));
        const n1 = adapter.checkpoints.filter((c) => c.nodeId === "n1").map((c) => c.seq);
        const n2 = adapter.checkpoints.filter((c) => c.nodeId === "n2").map((c) => c.seq);
        expect(n1).toEqual([0, 1]);
        expect(n2).toEqual([0]);
    });

    test("a null capture reports a gap and writes nothing, never throwing", async () => {
        const adapter = fakeAdapter();
        const gaps = [];
        const svc = createSnapshotService({
            captureSnapshot: async () => null,
            adapter, nowMs, onGap: (g) => gaps.push(g),
        });
        const result = await svc.snapshot(req());
        expect(result).toMatchObject({ gap: true });
        expect(gaps).toHaveLength(1);
        expect(adapter.states).toHaveLength(0);
        expect(adapter.checkpoints).toHaveLength(0);
    });

    test("an adapter write failure becomes a gap, not a throw", async () => {
        const gaps = [];
        const svc = createSnapshotService({
            captureSnapshot: async () => ({ commitId: "c1", changeId: "ch", operationId: "op1" }),
            adapter: {
                upsertWorkspaceState: async () => { throw new Error("db down"); },
                insertWorkspaceCheckpoint: async () => {},
            },
            nowMs, onGap: (g) => gaps.push(g),
        });
        const result = await svc.snapshot(req());
        expect(result).toMatchObject({ gap: true });
        expect(gaps[0]?.reason).toContain("db down");
    });

    test("snapshots for one worktree run strictly in order (serial queue)", async () => {
        const adapter = fakeAdapter();
        const order = [];
        let n = 0;
        const svc = createSnapshotService({
            captureSnapshot: async () => {
                const id = ++n;
                // Earlier calls take longer; a serial queue still preserves order.
                await new Promise((r) => setTimeout(r, id === 1 ? 25 : 1));
                order.push(id);
                return { commitId: `c${id}`, changeId: "ch", operationId: `op${id}` };
            },
            adapter, nowMs,
        });
        await Promise.all([
            svc.snapshot(req({ source: "hook", tier: 1 })),
            svc.snapshot(req({ source: "hook", tier: 1 })),
            svc.snapshot(req({ source: "hook", tier: 1 })),
        ]);
        expect(order).toEqual([1, 2, 3]);
        expect(adapter.checkpoints.map((c) => c.seq)).toEqual([0, 1, 2]);
    });
});

const jjAvailable = (() => {
    try {
        return spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
    }
    catch {
        return false;
    }
})();
const describeIfJj = jjAvailable ? describe : describe.skip;

describeIfJj("createSnapshotService against real jj + real db", () => {
    test("records real state + checkpoint rows and advances on a new write", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "snap-svc-"));
        try {
            const init = spawnSync("jj", ["git", "init"], { cwd: dir, encoding: "utf8" });
            expect(init.status).toBe(0);
            const sqlite = new Database(":memory:");
            const db = drizzle(sqlite);
            ensureSmithersTables(db);
            const adapter = new SmithersDb(db);
            const svc = createSnapshotService({
                captureSnapshot: (cwd) => Effect.runPromise(captureWorkspaceSnapshot(cwd).pipe(Effect.provide(BunContext.layer))),
                adapter,
                nowMs: () => Date.now(),
            });

            await fs.writeFile(path.join(dir, "work.txt"), "v1\n");
            const a = await svc.snapshot(req({ cwd: dir, source: "hook", tier: 1, label: "write work.txt" }));
            expect(a).toHaveProperty("seq", 0);
            expect(a.commitId.length).toBeGreaterThan(0);

            await fs.writeFile(path.join(dir, "work.txt"), "v2\n");
            const b = await svc.snapshot(req({ cwd: dir, source: "hook", tier: 1, label: "rewrite work.txt" }));
            expect(b.seq).toBe(1);
            expect(b.commitId).not.toBe(a.commitId);

            const states = await adapter.listWorkspaceStates("r1");
            expect(states).toHaveLength(2);
            // The durable operation handle lives on the state row.
            expect(states.every((s) => typeof s.jjOperationId === "string" && s.jjOperationId.length > 0)).toBe(true);
            const checkpoints = await adapter.listWorkspaceCheckpoints("r1");
            expect(checkpoints).toHaveLength(2);
            // Each checkpoint references its state by commit id.
            expect(checkpoints[0]?.jjCommitId).toBe(a.commitId);
            expect(checkpoints[1]?.jjCommitId).toBe(b.commitId);
            sqlite.close();
        }
        finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, 30_000);
});
