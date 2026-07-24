import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { captureSnapshot } from "@smithers-orchestrator/time-travel/snapshot";
import {
    createTempRepo,
    pinSqliteBackend,
    runSmithers,
} from "../../../packages/smithers/tests/e2e-helpers.js";

const TIMEOUT_MS = 120_000;

function hasJj() {
    try {
        execFileSync("jj", ["--version"], { stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}

function effectWorkflowSource() {
    return `/** @jsxImportSource smithers-orchestrator */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSmithers, defineTool } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, Workflow, Task, outputs } = createSmithers({
  result: z.object({ value: z.number() }),
});

const undoable = defineTool({
  name: "cli-undoable",
  schema: z.object({ value: z.number() }),
  sideEffect: true,
  idempotent: false,
  execute: async ({ value }, _context) => ({ value }),
  revert: async (_input, context) => {
    appendFileSync(resolve(process.cwd(), "reverts.log"), context.runId + "\\n");
  },
});

const agent = {
  tools: { undoable },
  async generate() {
    return { output: { value: 1 } };
  },
};

export default smithers(() => (
  <Workflow name="cli-effect-boundary">
    <Task id="target" output={outputs.result} agent={agent}>
      Complete without calling the tool.
    </Task>
  </Workflow>
));
`;
}

async function seedRun(adapter, input) {
    const base = Date.now() - 100_000;
    const workflowHash = createHash("sha256")
        .update(readFileSync(input.workflowPath, "utf8"))
        .digest("hex");
    await adapter.insertRun({
        runId: input.runId,
        workflowName: "cli-effect-boundary",
        workflowPath: input.workflowPath,
        workflowHash,
        status: "finished",
        createdAtMs: base - 1_000,
        startedAtMs: base,
        finishedAtMs: base + 5_000,
        heartbeatAtMs: null,
        vcsType: "jj",
        vcsRoot: input.root,
        vcsRevision: input.jjPointer,
    });
    await adapter.insertNode({
        runId: input.runId,
        nodeId: "target",
        iteration: 0,
        state: "finished",
        lastAttempt: 2,
        outputTable: "result",
        updatedAtMs: base + 3_000,
    });
    await adapter.insertAttempt({
        runId: input.runId,
        nodeId: "target",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: base - 500,
        finishedAtMs: base - 100,
        jjPointer: input.jjPointer,
        jjCwd: input.root,
        cached: false,
    });
    await adapter.insertAttempt({
        runId: input.runId,
        nodeId: "target",
        iteration: 0,
        attempt: 2,
        state: "finished",
        startedAtMs: base + 1_000,
        finishedAtMs: base + 2_000,
        jjPointer: input.jjPointer,
        jjCwd: input.root,
        cached: false,
    });
    await adapter.insertFrame({
        runId: input.runId,
        frameNo: 0,
        createdAtMs: base,
        xmlJson: '{"kind":"element","tag":"smithers:workflow","props":{},"children":[]}',
        xmlHash: `${input.runId}-frame-0`,
        mountedTaskIdsJson: "[]",
        taskIndexJson: "[]",
        note: null,
    });
    await adapter.insertFrame({
        runId: input.runId,
        frameNo: 1,
        createdAtMs: base + 3_000,
        xmlJson: '{"kind":"element","tag":"smithers:workflow","props":{},"children":[]}',
        xmlHash: `${input.runId}-frame-1`,
        mountedTaskIdsJson: '["target"]',
        taskIndexJson: "[]",
        note: null,
    });
    const snapshot = await captureSnapshot(adapter, input.runId, 0, {
        nodes: [{
            nodeId: "target",
            iteration: 0,
            state: "pending",
            lastAttempt: null,
            outputTable: "result",
            label: null,
        }],
        outputs: {},
        ralph: [],
        input: {},
    });
    if (input.effect !== "none") {
        await Effect.runPromise(adapter.insertToolCall({
            runId: input.runId,
            nodeId: "target",
            iteration: 0,
            attempt: 2,
            seq: 1,
            toolName: "cli-undoable",
            inputJson: '{"value":1}',
            outputJson: '{"value":1}',
            startedAtMs: snapshot.createdAtMs + 10,
            finishedAtMs: snapshot.createdAtMs + 11,
            status: "succeeded",
            errorJson: null,
            kind: "tool",
            sideEffect: true,
            idempotent: false,
            acceptsIdempotencyKey: true,
            hasRevert: input.effect === "revertible",
            idempotencyKey: `${input.runId}-key`,
            revertStatus: null,
            revertedAtMs: null,
            revertErrorJson: null,
            forcedPastJson: null,
        }));
    }
}

function commandArgs(command, workflow, runId, extra = []) {
    if (command === "revert") {
        return ["revert", workflow, "--run-id", runId, "--node-id", "target", ...extra];
    }
    if (command === "timetravel") {
        return ["timetravel", workflow, "--run-id", runId, "--node-id", "target", "--no-vcs", ...extra];
    }
    if (command === "rewind") {
        return ["rewind", runId, "0", "--yes", ...extra];
    }
    if (command === "replay") {
        return ["replay", workflow, "--run-id", runId, "--frame", "0", ...extra];
    }
    return ["fork", workflow, "--run-id", runId, "--frame", "0", "--run", ...extra];
}

function run(repo, command, workflow, runId, extra = []) {
    return runSmithers(commandArgs(command, workflow, runId, extra), {
        cwd: repo.dir,
        format: null,
        timeoutMs: TIMEOUT_MS,
    });
}

describe("CLI side-effect boundaries", () => {
    const cliTest = hasJj() ? test : test.skip;

    cliTest("prints reports for blocked, forced, no-revert, and clean crossings on all five commands", async () => {
        const repo = createTempRepo();
        pinSqliteBackend(repo.dir);
        const workflow = repo.write("workflow.tsx", effectWorkflowSource());
        execFileSync("jj", ["git", "init", "--colocate"], { cwd: repo.dir, stdio: "ignore" });
        const jjPointer = execFileSync(
            "jj",
            ["log", "-r", "@", "--no-graph", "-T", "change_id"],
            { cwd: repo.dir, encoding: "utf8" },
        ).trim();
        const sqlite = new Database(repo.path("smithers.db"));
        const adapter = new SmithersDb(drizzle(sqlite));
        ensureSmithersTables(adapter.db);
        const commands = ["revert", "timetravel", "rewind", "replay", "fork"];
        try {
            for (const command of commands) {
                await seedRun(adapter, {
                    runId: `${command}-blocked`,
                    workflowPath: workflow,
                    root: repo.dir,
                    jjPointer,
                    effect: "blocking",
                });
                await seedRun(adapter, {
                    runId: `${command}-forced`,
                    workflowPath: workflow,
                    root: repo.dir,
                    jjPointer,
                    effect: "blocking",
                });
                await seedRun(adapter, {
                    runId: `${command}-clean`,
                    workflowPath: workflow,
                    root: repo.dir,
                    jjPointer,
                    effect: ["revert", "timetravel", "rewind"].includes(command) ? "revertible" : "none",
                });
            }
            for (const command of ["revert", "timetravel", "rewind"]) {
                await seedRun(adapter, {
                    runId: `${command}-no-revert`,
                    workflowPath: workflow,
                    root: repo.dir,
                    jjPointer,
                    effect: "revertible",
                });
            }
        }
        finally {
            sqlite.close();
        }

        for (const command of commands) {
            const blocked = run(repo, command, "workflow.tsx", `${command}-blocked`);
            expect(blocked.exitCode).not.toBe(0);
            expect(blocked.stderr).toContain("Effect boundary:");
            expect(blocked.stderr).toContain("disposition=blocked");

            const forced = run(repo, command, "workflow.tsx", `${command}-forced`, ["--force"]);
            expect(forced.exitCode).toBe(0);
            expect(forced.stderr).toContain("Effect boundary:");
            expect(forced.stderr).toContain("Forced crossing");

            const clean = run(repo, command, "workflow.tsx", `${command}-clean`);
            expect(clean.exitCode).toBe(0);
            expect(clean.stderr).toContain("Effect boundary:");
            if (["revert", "timetravel", "rewind"].includes(command)) {
                expect(clean.stderr).toContain("Reverted successfully");
            }
            else {
                expect(clean.stderr).toContain("clean (0 crossed effects)");
            }
        }

        for (const command of ["revert", "timetravel", "rewind"]) {
            const skipped = run(
                repo,
                command,
                "workflow.tsx",
                `${command}-no-revert`,
                ["--no-revert"],
            );
            expect(skipped.exitCode).not.toBe(0);
            expect(skipped.stderr).toContain("Effect boundary:");
            expect(skipped.stderr).toContain("Revert handler skipped by noRevert");
        }

        const warningForkRunId = "fork-warning";
        const warningDb = new Database(repo.path("smithers.db"));
        try {
            const warningAdapter = new SmithersDb(drizzle(warningDb));
            await seedRun(warningAdapter, {
                runId: warningForkRunId,
                workflowPath: workflow,
                root: repo.dir,
                jjPointer,
                effect: "blocking",
            });
        }
        finally {
            warningDb.close();
        }
        const warningFork = runSmithers(
            ["fork", "workflow.tsx", "--run-id", warningForkRunId, "--frame", "0"],
            { cwd: repo.dir, format: null, timeoutMs: TIMEOUT_MS },
        );
        expect(warningFork.exitCode).toBe(0);
        expect(warningFork.stderr).toContain("Fork warning");
    }, TIMEOUT_MS);
});
