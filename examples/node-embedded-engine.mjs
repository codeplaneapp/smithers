/**
 * Plain-Node embedding example. Run with:
 *
 *   node examples/node-embedded-engine.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExternalSmithersEngine } from "smthrs";
import { z } from "zod";

const workspace = await mkdtemp(join(tmpdir(), "smithers-node-embed-"));
const logs = [];
const schemas = {
  input: z.object({ label: z.string() }),
  result: z.object({ value: z.string() }),
};

const taskWorkflow = (name, value) => () => ({
  kind: "element",
  tag: "smithers:workflow",
  props: {},
  rawProps: { name },
  children: [
    {
      kind: "element",
      tag: "smithers:task",
      props: {},
      rawProps: {
        id: name,
        output: "result",
        noRetry: true,
        __smithersKind: "static",
        __smithersPayload: { value },
      },
      children: [],
    },
  ],
});

const engine = await createExternalSmithersEngine({
  schemas,
  agents: {},
  cwd: workspace,
  pgliteDataDir: join(workspace, "pg"),
  env: {},
  logger: (record) => logs.push(record),
});

try {
  const first = engine.workflow(taskWorkflow("first", "one"), { output: "result" });
  const second = engine.workflow(taskWorkflow("second", "two"), { output: "result" });
  const firstResult = await engine.run(first, { input: { label: "first" } });
  const secondResult = await engine.run(second, { input: { label: "second" } });

  if (firstResult.status !== "finished" || secondResult.status !== "finished") {
    throw new Error(`expected two finished runs, got ${firstResult.status}/${secondResult.status}`);
  }
  if (firstResult.output?.[0]?.value !== "one" || secondResult.output?.[0]?.value !== "two") {
    throw new Error(`unexpected workflow outputs: ${JSON.stringify([firstResult.output, secondResult.output])}`);
  }
  if (!logs.some((record) => record.message.includes("workflow run finished"))) {
    throw new Error("injected logger did not receive engine logs");
  }

  const failing = engine.workflow(() => {
    throw new Error("provider request failed", { cause: new Error("connection refused") });
  });

  let failure;
  try {
    await engine.run(failing, { input: { label: "failure" } });
  } catch (error) {
    failure = error;
  }
  const causeText = [];
  for (let current = failure; current; current = current.cause) {
    causeText.push(current.message ?? String(current));
  }
  if (!causeText.some((message) => message.includes("provider request failed"))) {
    throw new Error(`provider error missing from cause chain: ${causeText.join(" <- ")}`);
  }
  if (!causeText.some((message) => message.includes("connection refused"))) {
    throw new Error(`root cause missing from cause chain: ${causeText.join(" <- ")}`);
  }

  console.log(
    JSON.stringify({
      status: "ok",
      runs: [firstResult.runId, secondResult.runId],
      logRecords: logs.length,
      causeChain: causeText,
    }),
  );
} finally {
  await engine.close();
  await rm(workspace, { recursive: true, force: true });
}
