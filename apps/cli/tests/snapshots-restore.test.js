import { describe, expect, test } from "bun:test";
import { runSnapshotsOnce } from "../src/snapshots.js";
import { pickTargetCheckpoint, runRestoreOnce } from "../src/restore.js";

function capture() {
    let out = "";
    return { write: (s) => { out += s; }, get: () => out };
}

const snapAdapter = {
    async listWorkspaceCheckpoints() {
        return [
            { seq: 0, nodeId: "task", iteration: 0, attempt: 0, tier: 2, source: "watch", label: null, jjCwd: "/wt", jjCommitId: "commit000000aaa", createdAtMs: Date.now() - 3000 },
            { seq: 1, nodeId: "task", iteration: 0, attempt: 0, tier: 1, source: "hook", label: "Edit a.ts", jjCwd: "/wt", jjCommitId: "commit111111bbb", createdAtMs: Date.now() - 1000 },
        ];
    },
    async listWorkspaceStates() {
        return [
            { jjCwd: "/wt", jjCommitId: "commit000000aaa", jjOperationId: "op000000xxx" },
            { jjCwd: "/wt", jjCommitId: "commit111111bbb", jjOperationId: "op111111yyy" },
        ];
    },
};

describe("smithers snapshots", () => {
    test("lists checkpoints with their operation ids and labels", async () => {
        const out = capture();
        const r = await runSnapshotsOnce({ adapter: snapAdapter, runId: "r1", stdout: out });
        expect(r.exitCode).toBe(0);
        expect(out.get()).toContain("#0");
        expect(out.get()).toContain("#1");
        expect(out.get()).toContain("Edit a.ts");
        expect(out.get()).toContain("op111111yyy");
    });

    test("json mode emits machine-readable rows", async () => {
        const out = capture();
        await runSnapshotsOnce({ adapter: snapAdapter, runId: "r1", json: true, stdout: out });
        const parsed = JSON.parse(out.get());
        expect(parsed.snapshots).toHaveLength(2);
        expect(parsed.snapshots[1].operationId).toBe("op111111yyy");
        expect(parsed.snapshots[1].label).toBe("Edit a.ts");
    });

    test("empty run is reported, not an error", async () => {
        const out = capture();
        const r = await runSnapshotsOnce({ adapter: { async listWorkspaceCheckpoints() { return []; }, async listWorkspaceStates() { return []; } }, runId: "r1", stdout: out });
        expect(r.exitCode).toBe(0);
        expect(out.get()).toContain("No durability snapshots");
    });
});

describe("smithers restore", () => {
    const cps = [
        { nodeId: "n1", iteration: 0, attempt: 0, seq: 0, jjCommitId: "c0", jjCwd: "/wt", createdAtMs: 10 },
        { nodeId: "n1", iteration: 0, attempt: 0, seq: 1, jjCommitId: "c1", jjCwd: "/wt", createdAtMs: 20 },
        { nodeId: "n2", iteration: 0, attempt: 0, seq: 0, jjCommitId: "d0", jjCwd: "/wt", createdAtMs: 30 },
    ];

    test("pickTargetCheckpoint picks the latest, honors --seq, returns null on no match", () => {
        expect(pickTargetCheckpoint(cps, { nodeId: "n1" })?.jjCommitId).toBe("c1");
        expect(pickTargetCheckpoint(cps, { nodeId: "n1", seq: 0 })?.jjCommitId).toBe("c0");
        expect(pickTargetCheckpoint(cps, { nodeId: "none" })).toBeNull();
    });

    test("reverts to the target and reports success", async () => {
        const reverted = [];
        const out = capture();
        const r = await runRestoreOnce({
            adapter: { async listWorkspaceCheckpoints() { return cps; } },
            runId: "r1", nodeId: "n1", stdout: out, stderr: capture(),
            revert: async (commitId, cwd) => { reverted.push([commitId, cwd]); return { success: true }; },
        });
        expect(r.exitCode).toBe(0);
        expect(reverted).toEqual([["c1", "/wt"]]);
        expect(out.get()).toContain("Restored");
    });

    test("missing checkpoint exits non-zero with a message", async () => {
        const err = capture();
        const r = await runRestoreOnce({
            adapter: { async listWorkspaceCheckpoints() { return cps; } },
            runId: "r1", nodeId: "nope", stdout: capture(), stderr: err,
            revert: async () => ({ success: true }),
        });
        expect(r.exitCode).toBe(1);
        expect(err.get()).toContain("No matching");
    });

    test("a failed revert exits non-zero", async () => {
        const err = capture();
        const r = await runRestoreOnce({
            adapter: { async listWorkspaceCheckpoints() { return cps; } },
            runId: "r1", nodeId: "n1", stdout: capture(), stderr: err,
            revert: async () => ({ success: false, error: "commit gone" }),
        });
        expect(r.exitCode).toBe(1);
        expect(err.get()).toContain("commit gone");
    });
});
