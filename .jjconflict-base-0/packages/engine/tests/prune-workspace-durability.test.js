import { describe, expect, test } from "bun:test";
import { pruneWorkspaceDurability } from "../src/pruneWorkspaceDurability.js";

describe("pruneWorkspaceDurability", () => {
    test("calls both prune methods with clamped defaults", async () => {
        const calls = [];
        await pruneWorkspaceDurability({
            adapter: {
                async pruneWorkspaceStates(runId, n) { calls.push(["states", runId, n]); },
                async pruneWorkspaceCheckpoints(runId, n) { calls.push(["checkpoints", runId, n]); },
            },
            runId: "r1",
        });
        expect(calls).toEqual([["checkpoints", "r1", 100], ["states", "r1", 50]]);
    });

    test("honors configured retention", async () => {
        const calls = [];
        await pruneWorkspaceDurability({
            adapter: {
                async pruneWorkspaceStates(runId, n) { calls.push(["states", n]); },
                async pruneWorkspaceCheckpoints(runId, n) { calls.push(["checkpoints", n]); },
            },
            runId: "r1",
            config: { stateRetentionPerRun: 5, checkpointRetentionPerScope: 7 },
        });
        expect(calls).toEqual([["checkpoints", 7], ["states", 5]]);
    });

    test("never throws when a prune method fails", async () => {
        await expect(pruneWorkspaceDurability({
            adapter: {
                async pruneWorkspaceStates() { throw new Error("db down"); },
                async pruneWorkspaceCheckpoints() { throw new Error("db down"); },
            },
            runId: "r1",
        })).resolves.toBeUndefined();
    });
});
