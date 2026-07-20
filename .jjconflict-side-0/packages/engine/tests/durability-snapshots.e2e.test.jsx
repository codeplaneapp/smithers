/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import { runWorkflow, Task, Workflow } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";

const jjAvailable = (() => {
    try {
        return spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
    }
    catch {
        return false;
    }
})();
const describeIfJj = jjAvailable ? describe : describe.skip;

/** An agent that writes a file into its worktree (taskRoot) during the turn. */
function writingAgent() {
    return {
        id: "writer",
        tools: {},
        generate: async (args) => {
            if (args.rootDir) {
                writeFileSync(join(args.rootDir, "agent-output.txt"), "from agent\n");
            }
            return { output: { value: 1 } };
        },
    };
}

describeIfJj("durability snapshots wired into the engine", () => {
    test("flag on: a file-writing agent produces workspace checkpoint + state rows", async () => {
        const jjDir = mkdtempSync(join(tmpdir(), "dur-snap-on-"));
        expect(spawnSync("jj", ["git", "init"], { cwd: jjDir, encoding: "utf8" }).status).toBe(0);
        const prev = process.env.SMITHERS_DURABILITY_SNAPSHOTS;
        process.env.SMITHERS_DURABILITY_SNAPSHOTS = "1";
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        try {
            const runId = "dur-snap-on";
            const workflow = smithers(() => (<Workflow name="dur-snap-on">
        <Task id="task" output={outputs.outputA} agent={writingAgent()}>
          write a file
        </Task>
      </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, rootDir: jjDir }));
            expect(result.status).toBe("finished");

            const adapter = new SmithersDb(db);
            const checkpoints = await adapter.listWorkspaceCheckpoints(runId);
            expect(checkpoints.length).toBeGreaterThanOrEqual(1);
            expect(checkpoints.some((c) => c.source === "watch")).toBe(true);

            const states = await adapter.listWorkspaceStates(runId);
            expect(states.length).toBeGreaterThanOrEqual(1);
            // The durable operation handle is recorded on the state.
            expect(states.every((s) => typeof s.jjOperationId === "string" && s.jjOperationId.length > 0)).toBe(true);
        }
        finally {
            if (prev === undefined) delete process.env.SMITHERS_DURABILITY_SNAPSHOTS;
            else process.env.SMITHERS_DURABILITY_SNAPSHOTS = prev;
            cleanup();
            rmSync(jjDir, { recursive: true, force: true });
        }
    }, 30_000);

    test("flag off: the same run records no workspace rows", async () => {
        const jjDir = mkdtempSync(join(tmpdir(), "dur-snap-off-"));
        expect(spawnSync("jj", ["git", "init"], { cwd: jjDir, encoding: "utf8" }).status).toBe(0);
        const prev = process.env.SMITHERS_DURABILITY_SNAPSHOTS;
        delete process.env.SMITHERS_DURABILITY_SNAPSHOTS;
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        try {
            const runId = "dur-snap-off";
            const workflow = smithers(() => (<Workflow name="dur-snap-off">
        <Task id="task" output={outputs.outputA} agent={writingAgent()}>
          write a file
        </Task>
      </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, rootDir: jjDir }));
            expect(result.status).toBe("finished");

            const adapter = new SmithersDb(db);
            expect(await adapter.listWorkspaceCheckpoints(runId)).toHaveLength(0);
            expect(await adapter.listWorkspaceStates(runId)).toHaveLength(0);
        }
        finally {
            if (prev !== undefined) process.env.SMITHERS_DURABILITY_SNAPSHOTS = prev;
            cleanup();
            rmSync(jjDir, { recursive: true, force: true });
        }
    }, 30_000);
});
