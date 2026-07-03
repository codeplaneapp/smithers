import { expect, setDefaultTimeout, test } from "bun:test";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

setDefaultTimeout(120_000);

/**
 * `ps --format json` must expose `finishedAtMs` (raw epoch ms) on a terminal
 * run so run watchers (e.g. the `smithers monitor` live UI and run-triage
 * workflows) can gate failure freshness on time-since-FAILURE rather than
 * time-since-start. Real CLI, real temp store, a compute-only workflow — no
 * agent CLI needed, so this runs in CI.
 */
function finishingWorkflowSource() {
    return [
        "/** @jsxImportSource smithers-orchestrator */",
        'import { createSmithers, Workflow, Task } from "smithers-orchestrator";',
        'import { z } from "zod";',
        "",
        "const { smithers, outputs } = createSmithers({",
        "  result: z.object({ ok: z.boolean() }),",
        "});",
        "",
        "export default smithers(() => (",
        '  <Workflow name="ps-finish-demo">',
        '    <Task id="done" output={outputs.result}>',
        "      {() => ({ ok: true })}",
        "    </Task>",
        "  </Workflow>",
        "));",
        "",
    ].join("\n");
}

test("ps --format json exposes finishedAtMs on a finished run", () => {
    const repo = createTempRepo();
    repo.write("done.tsx", finishingWorkflowSource());

    const run = runSmithers(["up", "done.tsx", "--run-id", "ps-finished"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 90_000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.json.status).toBe("finished");

    const ps = runSmithers(["ps", "--all", "--limit", "50"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: 60_000,
    });
    const rows = Array.isArray(ps.json) ? ps.json : (ps.json?.runs ?? []);
    const row = rows.find((r) => String(r.id ?? r.runId ?? "") === "ps-finished");
    expect(row).toBeDefined();
    expect(typeof row.finishedAtMs).toBe("number");
    expect(row.finishedAtMs).toBeGreaterThan(0);
});
