import { describe, expect, test } from "bun:test";
import { startDurability } from "../src/startDurability.js";
import { drainGaps, defaultGapSpoolPath } from "../src/durabilityGapSpool.js";

function fakeAdapter() {
    const states = [];
    const checkpoints = [];
    const pruned = [];
    return {
        states,
        checkpoints,
        pruned,
        async upsertWorkspaceState(row) {
            const i = states.findIndex((s) => s.jjCommitId === row.jjCommitId && s.jjCwd === row.jjCwd);
            if (i >= 0) states[i] = row; else states.push(row);
        },
        async insertWorkspaceCheckpoint(row) { checkpoints.push(row); },
        async pruneWorkspaceStates(runId, n) { pruned.push(["states", n]); },
        async pruneWorkspaceCheckpoints(runId, n) { pruned.push(["checkpoints", n]); },
    };
}

function fakeWatcher() {
    let onSettle = () => {};
    let closed = false;
    return {
        create({ onSettle: cb }) { onSettle = cb; return { close() { closed = true; }, watching: true }; },
        settle: () => onSettle(),
        isClosed: () => closed,
    };
}

const baseOpts = (over) => ({
    enabled: true,
    adapter: fakeAdapter(),
    runId: "r1", nodeId: "n1", iteration: 0, attempt: 0,
    cwd: "/wt",
    nowMs: () => 1,
    isJjRepoFn: async () => true,
    captureSnapshot: async () => ({ commitId: "c1", changeId: "ch", operationId: "op1" }),
    ...over,
});

describe("startDurability", () => {
    test("returns a no-op handle when disabled", async () => {
        const adapter = fakeAdapter();
        const h = await startDurability(baseOpts({ enabled: false, adapter }));
        expect(h.active).toBe(false);
        await h.snapshot();
        await h.stop();
        expect(adapter.checkpoints).toHaveLength(0);
    });

    test("returns a no-op handle when the worktree is not a jj repo", async () => {
        const adapter = fakeAdapter();
        const h = await startDurability(baseOpts({ adapter, isJjRepoFn: async () => false }));
        expect(h.active).toBe(false);
        expect(adapter.checkpoints).toHaveLength(0);
    });

    test("returns a no-op handle when there is no worktree", async () => {
        const h = await startDurability(baseOpts({ cwd: undefined }));
        expect(h.active).toBe(false);
    });

    test("a watcher settle records a Tier 2 checkpoint; stop flushes and closes", async () => {
        const adapter = fakeAdapter();
        const watcher = fakeWatcher();
        let n = 0;
        const h = await startDurability(baseOpts({
            adapter,
            createWatcher: watcher.create.bind(watcher),
            captureSnapshot: async () => ({ commitId: `c${++n}`, changeId: "ch", operationId: `op${n}` }),
        }));
        expect(h.active).toBe(true);
        watcher.settle();
        await new Promise((r) => setTimeout(r, 0)); // let the queued snapshot drain
        expect(adapter.checkpoints).toHaveLength(1);
        expect(adapter.checkpoints[0].source).toBe("watch");
        expect(adapter.checkpoints[0].tier).toBe(2);
        await h.stop();
        expect(watcher.isClosed()).toBe(true);
        // The stop flush captured a new state (c2), so a second checkpoint landed.
        expect(adapter.checkpoints).toHaveLength(2);
        // stop() also prunes to bound table growth.
        expect(adapter.pruned).toEqual([["checkpoints", 100], ["states", 50]]);
    });

    test("a capture failure with no explicit onGap is spooled durably", async () => {
        const runId = `gap-spool-${process.pid}-${Date.now()}`;
        const spool = defaultGapSpoolPath(runId);
        const watcher = fakeWatcher();
        const h = await startDurability(baseOpts({
            runId,
            adapter: fakeAdapter(),
            createWatcher: watcher.create.bind(watcher),
            captureSnapshot: async () => null,
        }));
        try {
            watcher.settle();
            await new Promise((r) => setTimeout(r, 0));
            const gaps = drainGaps(spool);
            expect(gaps.length).toBeGreaterThanOrEqual(1);
            expect(gaps[0].runId).toBe(runId);
            expect(gaps[0].reason).toBe("snapshot-failed");
        }
        finally {
            await h.stop();
            drainGaps(spool);
        }
    });

    test("withSocket: a hook request records a Tier 1 checkpoint", async () => {
        const net = await import("node:net");
        const adapter = fakeAdapter();
        const fw = fakeWatcher();
        const h = await startDurability(baseOpts({ adapter, withSocket: true, createWatcher: fw.create.bind(fw) }));
        try {
            expect(typeof h.socketPath).toBe("string");
            const ack = await new Promise((resolve, reject) => {
                const c = net.connect(h.socketPath, () => c.write(`${JSON.stringify({ toolName: "Edit", filePath: "a.ts", toolUseId: "t1" })}\n`));
                let buf = "";
                c.setEncoding("utf8");
                c.on("data", (x) => {
                    buf += x;
                    const nl = buf.indexOf("\n");
                    if (nl === -1) return;
                    c.end();
                    try { resolve(JSON.parse(buf.slice(0, nl) || "{}")); } catch { resolve({}); }
                });
                c.on("error", reject);
            });
            expect(ack.ok).toBe(true);
            const hook = adapter.checkpoints.find((cp) => cp.source === "hook" && cp.tier === 1);
            expect(hook).toBeTruthy();
            expect(hook.label).toContain("Edit");
            expect(hook.toolUseId).toBe("t1");
        }
        finally {
            await h.stop();
        }
    });

    test("a capture failure surfaces as a gap, never throwing", async () => {
        const adapter = fakeAdapter();
        const gaps = [];
        const watcher = fakeWatcher();
        const h = await startDurability(baseOpts({
            adapter,
            createWatcher: watcher.create.bind(watcher),
            captureSnapshot: async () => null,
            onGap: (g) => gaps.push(g),
        }));
        watcher.settle();
        await new Promise((r) => setTimeout(r, 0));
        expect(gaps.length).toBeGreaterThanOrEqual(1);
        expect(adapter.checkpoints).toHaveLength(0);
        await h.stop();
    });
});
