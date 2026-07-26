// Runs a real engine workflow to completion under PLAIN NODE (no Bun).
// Spawned by ../engine-node-run.test.js via `node <this file>`; lives in its
// own file (not a -e string) so bare imports (effect, @effect/platform-node,
// @electric-sql/pglite) resolve against packages/engine's node_modules.
//
// The run uses:
//   - a compute step (a `run` function) so no agent CLI or API key is needed,
//   - PGlite storage persisted to a temp dataDir so the run row and output row
//     can be re-read and asserted after the engine closes its connection,
//   - effectPlatformRuntime "node" + @effect/platform-node's NodeContext.layer,
//     the injectable platform layer that replaces the Bun default.
//
// Exits 0 only when the run reaches status "finished" AND the persisted output
// row carries the exact computed payload. Any other outcome exits non-zero with
// a FAIL line on stderr for the parent test to surface. The final process.exit
// is deliberate: the engine memoizes a process-wide cluster runtime whose
// timers keep the node event loop alive after the run completes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import * as NodeContext from "@effect/platform-node/NodeContext";
import { Smithers } from "../../src/effect/builder.js";

const dataDir = mkdtempSync(join(tmpdir(), "smithers-node-run-"));
const runId = `engine-node-run-${Date.now().toString(36)}-${process.pid}`;

async function main() {
  if (typeof Bun !== "undefined") {
    throw new Error("fixture must run under plain node, but Bun is defined");
  }

  const G = Smithers.workflow({
    name: "engine-node-run",
    input: Schema.Struct({ repo: Schema.String }),
  });
  const step = G.step("compute", {
    output: Schema.Struct({ value: Schema.String }),
    run: ({ input }) => ({ value: `node:${input.repo}` }),
  });
  const wf = G.from(step);

  const result = await Effect.runPromise(
    wf
      .execute(
        { repo: "smithers" },
        {
          runId,
          effectPlatformRuntime: "node",
          effectPlatformLayer: NodeContext.layer,
        },
      )
      .pipe(Effect.provide(Smithers.pglite({ dataDir }))),
  );

  // execute() returns the extracted step output only when the run finished;
  // waiting states come back as { status, runId }.
  if (result && typeof result === "object" && "status" in result) {
    throw new Error(`run did not finish: ${JSON.stringify(result)}`);
  }
  if (result?.value !== "node:smithers") {
    throw new Error(`unexpected extracted output: ${JSON.stringify(result)}`);
  }

  // Reopen the persisted PGlite store directly and assert the durable rows,
  // not just the in-process return value.
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = await PGlite.create(dataDir);
  try {
    const runs = await pglite.query("SELECT status FROM _smithers_runs WHERE run_id = $1", [runId]);
    if (runs.rows.length !== 1) {
      throw new Error(`expected 1 run row, got ${runs.rows.length}`);
    }
    if (runs.rows[0].status !== "finished") {
      throw new Error(`persisted run status is ${JSON.stringify(runs.rows[0].status)}, expected "finished"`);
    }
    const outputs = await pglite.query(
      "SELECT run_id, node_id, iteration, payload FROM smithers_compute WHERE run_id = $1",
      [runId],
    );
    if (outputs.rows.length !== 1) {
      throw new Error(`expected 1 output row, got ${outputs.rows.length}`);
    }
    const row = outputs.rows[0];
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    if (row.node_id !== "compute" || Number(row.iteration) !== 0 || payload?.value !== "node:smithers") {
      throw new Error(`unexpected output row: ${JSON.stringify(row)}`);
    }
  } finally {
    await pglite.close().catch(() => {});
  }
}

let exitCode = 0;
try {
  await main();
  console.log(`RUN_FINISHED ${runId}`);
} catch (error) {
  console.error(`FAIL: ${error?.stack ?? error}`);
  exitCode = 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(exitCode);
