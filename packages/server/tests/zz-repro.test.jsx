/** @jsxImportSource smthrs */
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { Gateway } from "/Users/williamcory/smithers/packages/server/src/gateway.js";
import { sleep } from "/Users/williamcory/smithers/packages/smithers/tests/helpers.js";

const AUTH = { triggeredBy: "tester", scopes: ["*"], role: "operator" };

test("repro: resume hijack-parked run settles how?", async () => {
  const dbPath = join(tmpdir(), `repro-${Date.now()}.db`);
  const { smithers, Workflow, Task, outputs } = createSmithers(
    { r: z.object({ value: z.number() }) },
    { dbPath },
  );
  const workflow = smithers((ctx) => (
    <Workflow name="repro">
      <Task id="task1" output={outputs.r}>{{ value: 1 }}</Task>
    </Workflow>
  ));
  const gateway = new Gateway({});
  gateway.register("repro", workflow);
  await gateway.listen({ port: 0 });
  await gateway.startRun("repro", {}, AUTH, "run-1", { resume: false });
  await gateway.inflightRuns.get("run-1");
  const adapter = new SmithersDb(workflow.db);
  await adapter.updateRun("run-1", {
    status: "cancelled",
    finishedAtMs: Date.now(),
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    hijackRequestedAtMs: Date.now(),
    hijackTarget: "claude-code",
    errorJson: JSON.stringify({ code: "RUN_HIJACKED", nodeId: "task1", engine: "claude-code", mode: "native-cli", resume: "s" }),
  });
  await gateway.resumeRunIfNeeded("run-1", "repro", adapter, { triggeredBy: "t", scopes: [], role: "operator", tokenId: null });
  for (let i = 0; i < 100; i += 1) {
    const run = await adapter.getRun("run-1");
    if (run.status !== "running") break;
    await sleep(100);
  }
  for (let i = 0; i < 100; i += 1) {
    const run2 = await adapter.getRun("run-1");
    if (run2.status !== "running") break;
    await sleep(100);
  }
  const run = await adapter.getRun("run-1");
  console.log("FINAL:", run.status, run.errorJson, "hijackReq:", run.hijackRequestedAtMs, "cancelReq:", run.cancelRequestedAtMs, "owner:", run.runtimeOwnerId);
  const events = await adapter.listEventHistory("run-1", { limit: 100 });
  console.log("EVENTS:", events.map((e) => e.type).join(","));
  await gateway.close();
}, 30000);
