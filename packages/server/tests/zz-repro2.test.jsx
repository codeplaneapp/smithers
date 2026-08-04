/** @jsxImportSource smthrs */
import { expect, test } from "bun:test";
import { z } from "zod";
import { createSmithers } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { runWorkflow } from "smthrs";
import { Effect } from "effect";

test("engine resume of hijack-parked cancelled run", async () => {
  const { smithers, Workflow, Task, outputs, db } = createSmithers(
    { r: z.object({ value: z.number() }) },
    {},
  );
  const workflow = smithers(() => (
    <Workflow name="repro2">
      <Task id="task1" output={outputs.r}>{{ value: 1 }}</Task>
    </Workflow>
  ));
  const adapter = new SmithersDb(db);
  const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "run-r2" }));
  expect(first.status).toBe("finished");
  await adapter.updateRun("run-r2", {
    status: "cancelled",
    finishedAtMs: Date.now(),
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    hijackRequestedAtMs: Date.now(),
    hijackTarget: "claude-code",
    errorJson: JSON.stringify({ code: "RUN_HIJACKED", nodeId: "task1", engine: "claude-code", mode: "native-cli", resume: "s" }),
  });
  const second = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "run-r2", resume: true }));
  console.log("SECOND:", second.status, JSON.stringify(second.error ?? null));
  const run = await adapter.getRun("run-r2");
  console.log("ROW:", run.status, run.errorJson, "hijackReq:", run.hijackRequestedAtMs);
}, 30000);
