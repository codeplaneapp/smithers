/** @jsxImportSource smthrs */
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Task, Workflow, runWorkflow } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { z } from "zod";

test("persists the actual Codex effort from array-form config", async () => {
  const { smithers, outputs, db, cleanup } = createTestSmithers({ result: z.object({ ok: z.boolean() }) });
  try {
    const runId = "codex-array-effort";
    const agent = {
      id: "codex-fixture",
      cliEngine: "codex",
      effort: "high",
      opts: {
        effort: "high",
        config: ["sandbox_workspace_write.network_access=true", "model_reasoning_effort=low"],
      },
      tools: {},
      generate: async () => ({ output: { ok: true } }),
    };
    const workflow = smithers(() => (
      <Workflow name="codex-array-effort">
        <Task id="task" output={outputs.result} agent={agent}>
          go
        </Task>
      </Workflow>
    ));

    expect((await Effect.runPromise(runWorkflow(workflow, { input: {}, runId }))).status).toBe("finished");
    const adapter = new SmithersDb(db);
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, "task", 0));
    expect(JSON.parse(attempts[0].metaJson).effort).toBe("low");
  } finally {
    cleanup();
  }
});
