import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { smithersVcsTags } from "../src/schema.js";

const jjCalls = [];

mock.module("@smithers-orchestrator/vcs/jj", () => ({
    getJjPointer: (cwd) => {
        jjCalls.push({ fn: "getJjPointer", cwd });
        return Effect.succeed("change-live");
    },
    captureWorkspaceSnapshot: (cwd) => {
        jjCalls.push({ fn: "captureWorkspaceSnapshot", cwd });
        return Effect.succeed({
            commitId: "commit-live",
            changeId: "change-live",
            operationId: "op-live",
        });
    },
    isJjRepo: (cwd) => {
        jjCalls.push({ fn: "isJjRepo", cwd });
        return Effect.succeed(true);
    },
    revertToJjPointer: (pointer, cwd) => {
        jjCalls.push({ fn: "revertToJjPointer", pointer, cwd });
        return Effect.succeed({ success: true });
    },
    runJj: (args, opts = {}) => {
        jjCalls.push({ fn: "runJj", args, cwd: opts.cwd });
        return Effect.succeed({
            code: 0,
            stdout: "op-live\n",
            stderr: "",
        });
    },
    workspaceAdd: (workspaceName, workspacePath, opts = {}) => {
        jjCalls.push({ fn: "workspaceAdd", workspaceName, workspacePath, opts });
        return Effect.succeed({ success: true, workspacePath });
    },
    workspaceClose: (workspaceName, opts = {}) => {
        jjCalls.push({ fn: "workspaceClose", workspaceName, opts });
        return Effect.succeed({ success: true });
    },
    workspaceList: (cwd) => {
        jjCalls.push({ fn: "workspaceList", cwd });
        return Effect.succeed([]);
    },
}));

function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), db, sqlite };
}
describe("loadVcsTag", () => {
    test("returns undefined when no tag exists", async () => {
        const { adapter } = createTestDb();
        const { loadVcsTag } = await import("../src/vcs-version/index.js");
        const tag = await loadVcsTag(adapter, "run-1", 0);
        expect(tag).toBeUndefined();
    });
    test("loads a stored VCS tag", async () => {
        const { adapter, db } = createTestDb();
        await db.insert(smithersVcsTags).values({
            runId: "run-1",
            frameNo: 3,
            vcsType: "jj",
            vcsPointer: "change-abc",
            vcsRoot: "/repo",
            jjOperationId: "op-123",
            createdAtMs: 1234,
        });
        const { loadVcsTag } = await import("../src/vcs-version/index.js");
        const tag = await loadVcsTag(adapter, "run-1", 3);
        expect(tag).toEqual({
            runId: "run-1",
            frameNo: 3,
            vcsType: "jj",
            vcsPointer: "change-abc",
            vcsRoot: "/repo",
            jjOperationId: "op-123",
            createdAtMs: 1234,
        });
    });
});
describe("tagSnapshotVcs", () => {
    test("records the current jj pointer and operation id", async () => {
        jjCalls.length = 0;
        const { adapter } = createTestDb();
        const { loadVcsTag, tagSnapshotVcs } = await import("../src/vcs-version/index.js");

        const result = await tagSnapshotVcs(adapter, "run-1", 0, { cwd: "/repo" });

        expect(result).toMatchObject({
            runId: "run-1",
            frameNo: 0,
            vcsType: "jj",
            vcsPointer: "change-live",
            vcsRoot: "/repo",
            jjOperationId: "op-live",
        });
        expect(result?.createdAtMs).toBeNumber();
        await expect(loadVcsTag(adapter, "run-1", 0)).resolves.toEqual(result);
        expect(jjCalls).toEqual([
            { fn: "getJjPointer", cwd: "/repo" },
            {
                fn: "runJj",
                args: ["operation", "log", "--no-graph", "--limit", "1", "-T", "self.id()"],
                cwd: "/repo",
            },
        ]);
    });
});
describe("rerunAtRevision", () => {
    test("returns restored:false when no VCS tag exists", async () => {
        const { adapter } = createTestDb();
        const { rerunAtRevision } = await import("../src/vcs-version/index.js");
        const result = await rerunAtRevision(adapter, "run-1", 0);
        expect(result.restored).toBe(false);
        expect(result.vcsPointer).toBeNull();
    });
    test("restores the stored VCS pointer for a tag", async () => {
        jjCalls.length = 0;
        const { adapter, db } = createTestDb();
        await db.insert(smithersVcsTags).values({
            runId: "run-1",
            frameNo: 4,
            vcsType: "jj",
            vcsPointer: "change-stored",
            vcsRoot: "/repo",
            jjOperationId: null,
            createdAtMs: 1234,
        });
        const { rerunAtRevision } = await import("../src/vcs-version/index.js");
        const result = await rerunAtRevision(adapter, "run-1", 4);
        expect(result).toEqual({ restored: true, vcsPointer: "change-stored" });
        expect(jjCalls).toEqual([
            { fn: "revertToJjPointer", pointer: "change-stored", cwd: "/repo" },
        ]);
    });
});
describe("resolveWorkflowAtRevision", () => {
    test("returns null when no VCS tag exists", async () => {
        const { adapter } = createTestDb();
        const { resolveWorkflowAtRevision } = await import("../src/vcs-version/index.js");
        const result = await resolveWorkflowAtRevision(adapter, "run-1", 0, "/tmp/workspace");
        expect(result).toBeNull();
    });

    test("creates a workspace at the stored VCS pointer", async () => {
        jjCalls.length = 0;
        const { adapter, db } = createTestDb();
        await db.insert(smithersVcsTags).values({
            runId: "run-abcdef123456",
            frameNo: 7,
            vcsType: "jj",
            vcsPointer: "change-workflow",
            vcsRoot: "/repo",
            jjOperationId: "op-123",
            createdAtMs: 1234,
        });
        const { resolveWorkflowAtRevision } = await import("../src/vcs-version/index.js");

        const result = await resolveWorkflowAtRevision(adapter, "run-abcdef123456", 7, "/tmp/workspace");

        expect(result).toEqual({
            workspacePath: "/tmp/workspace",
            vcsPointer: "change-workflow",
        });
        expect(jjCalls).toEqual([
            {
                fn: "workspaceAdd",
                workspaceName: "smithers-replay-run-abcd-f7",
                workspacePath: "/tmp/workspace",
                opts: { cwd: "/repo", atRev: "change-workflow" },
            },
        ]);
    });
});
