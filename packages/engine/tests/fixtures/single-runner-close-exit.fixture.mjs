// #1378 repro, under Bun: a finite program runs a one-task workflow, awaits
// it, closes the process-local SingleRunner runtime, and must exit ON ITS OWN.
//
// There is deliberately NO process.exit() here; that is the entire point.
// Before closeSingleRunnerRuntime() existed, the cluster runtime built on the
// first task dispatch forked repeating daemon fibers (shard lock refresh,
// shard assignment, message polling, runner health) into a Scope that was
// dropped on the floor, so this process would hang forever after the run
// resolved.
//
// Spawned by ../single-runner-close-exit.test.js.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { Smithers } from "../../src/effect/builder.js";
import { closeSingleRunnerRuntime } from "../../src/effect/single-runner.js";

const dir = mkdtempSync(join(tmpdir(), "smithers-close-exit-"));
const runId = `single-runner-close-exit-${process.pid}`;

async function main() {
    if (typeof Bun === "undefined") {
        throw new Error("fixture must run under Bun");
    }
    const G = Smithers.workflow({
        name: "single-runner-close-exit",
        input: Schema.Struct({ repo: Schema.String }),
    });
    const step = G.step("compute", {
        output: Schema.Struct({ value: Schema.String }),
        run: ({ input }) => ({ value: `closed:${input.repo}` }),
    });
    const wf = G.from(step);
    const result = await Effect.runPromise(wf.execute({ repo: "smithers" }, { runId }).pipe(Effect.provide(Smithers.sqlite({ filename: join(dir, "db.sqlite") }))));
    if (result?.value !== "closed:smithers") {
        throw new Error(`unexpected extracted output: ${JSON.stringify(result)}`);
    }
    console.log(`RUN_FINISHED ${runId}`);
    await closeSingleRunnerRuntime();
    console.log("RUNTIME_CLOSED");
}

try {
    await main();
}
catch (error) {
    console.error(`FAIL: ${error?.stack ?? error}`);
    process.exitCode = 1;
}
finally {
    rmSync(dir, { recursive: true, force: true });
}
// No process.exit(): the event loop must drain by itself.
