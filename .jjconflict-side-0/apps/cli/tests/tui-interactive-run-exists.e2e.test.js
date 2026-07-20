import { expect, setDefaultTimeout, test } from "bun:test";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";
import { runTuiCommand } from "../src/tui.js";

setDefaultTimeout(240_000);

/**
 * E2E for the interactive launcher's RUN_EXISTS guard (real CLI run, real temp
 * store, no mocks): `up --interactive --run-id <existing>` must fail up front,
 * BEFORE prompting or spawning the detached child. Without the guard the child
 * dies RUN_EXISTS with its stderr only in the log file, the PRE-EXISTING row
 * satisfies the run-row wait, and the launcher declares the OLD run "started"
 * and monitors it. The seed run is a compute task, so no agent CLI is needed
 * and this stays green on the clean CI box.
 *
 * runTuiCommand is driven directly (the CLI's TTY gate blocks --interactive
 * under a piped stdin long before this code, and the guard fires before any
 * clack prompt, so no PTY is required to exercise it).
 */
const okWorkflow = [
    "/** @jsxImportSource smithers-orchestrator */",
    'import { createSmithers, Workflow, Task } from "smithers-orchestrator";',
    'import { z } from "zod";',
    "",
    "const { smithers, outputs } = createSmithers({",
    "  result: z.object({ ok: z.boolean() }),",
    "});",
    "",
    "export default smithers(() => (",
    '  <Workflow name="ok-demo">',
    '    <Task id="ok" output={outputs.result} retries={0}>',
    "      {() => ({ ok: true })}",
    "    </Task>",
    "  </Workflow>",
    "));",
    "",
].join("\n");

test("interactive launch with a colliding --run-id fails RUN_EXISTS before spawning", async () => {
    const repo = createTempRepo();
    repo.write("ok.tsx", okWorkflow);

    const first = runSmithers(["up", "ok.tsx", "--run-id", "r1"], { cwd: repo.dir, format: "json", timeoutMs: 120_000 });
    expect(first.exitCode).toBe(0);
    expect(first.json?.status).toBe("finished");

    // The probe resolves the store from process.cwd(), like the launcher does.
    const prevCwd = process.cwd();
    process.chdir(repo.dir);
    try {
        const failures = [];
        const oks = [];
        const c = {
            options: { runId: "r1" },
            ok: (value) => {
                oks.push(value);
                return value;
            },
        };
        const startedAt = Date.now();
        await runTuiCommand(c, (opts) => {
            failures.push(opts);
            return opts;
        }, { preselect: { entryFile: "ok.tsx", id: "ok-demo", displayName: "ok-demo" } });
        const elapsedMs = Date.now() - startedAt;

        expect(oks).toHaveLength(0);
        expect(failures).toHaveLength(1);
        expect(failures[0].code).toBe("RUN_EXISTS");
        expect(failures[0].exitCode).toBe(4);
        expect(failures[0].message).toContain("Run already exists: r1");
        // Failed FAST: it never entered the 20s spawn/db/run-row waits, i.e. no
        // detached child was launched for the doomed run id.
        expect(elapsedMs).toBeLessThan(10_000);
    } finally {
        process.chdir(prevCwd);
    }
});
