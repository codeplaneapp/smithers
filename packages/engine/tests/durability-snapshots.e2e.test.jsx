/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { Effect } from "effect";
import { runWorkflow, Task, Workflow } from "smthrs";
import { SmithersDb } from "@smthrs/db/adapter";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";

const jjAvailable = (() => {
  try {
    return spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();
const describeIfJj = jjAvailable ? describe : describe.skip;

function spawnCheckpointCrashRun({ dbPath, markerPath, rootDir, runId }) {
  const smithersPath = resolve(import.meta.dir, "../../smithers/src/index.js");
  const schemaPath = resolve(import.meta.dir, "../../smithers/tests/schema.js");
  const dbPathModule = resolve(import.meta.dir, "../../db/src/adapter.js");
  const script = `
import React from "react";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSmithers, Task, Workflow, runWorkflow } from ${JSON.stringify(smithersPath)};
import { outputSchemas } from ${JSON.stringify(schemaPath)};
import { SmithersDb } from ${JSON.stringify(dbPathModule)};
import { Effect } from "effect";

const api = createSmithers(outputSchemas, { dbPath: ${JSON.stringify(dbPath)} });
const adapter = new SmithersDb(api.db);
const stable = {
  codec: "smithers.cli-session",
  version: 1,
  payload: { engine: "fake-cli", resume: "stable-session" },
};
const waitForWorkspaceCheckpoints = async (count) => {
  for (let poll = 0; poll < 200; poll += 1) {
    if ((await adapter.listWorkspaceCheckpoints(${JSON.stringify(runId)})).length >= count) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for workspace checkpoint " + count);
};
const agent = {
  id: "checkpoint-identical-crash-resume",
  cliEngine: "fake-cli",
  checkpointFormats: [{ codec: stable.codec, versions: [1] }],
  checkpointCapabilities: [{ codec: stable.codec, versions: [1], modes: ["resume"] }],
  async generate(args) {
    const file = join(args.rootDir, "agent-output.txt");
    writeFileSync(file, "before republish\\n");
    await waitForWorkspaceCheckpoints(1);
    await args.onCheckpoint(stable);
    writeFileSync(file, "after republish\\n");
    await waitForWorkspaceCheckpoints(2);
    await args.onCheckpoint(stable);
    writeFileSync(${JSON.stringify(markerPath)}, "ready\\n");
    return new Promise(() => {});
  },
};
const workflow = api.smithers(() => React.createElement(
  Workflow,
  { name: "checkpoint-identical-crash-resume" },
  React.createElement(
    Task,
    { id: "work", output: api.outputs.outputA, agent },
    "update a file",
  ),
));
await Effect.runPromise(runWorkflow(workflow, {
  input: {},
  runId: ${JSON.stringify(runId)},
  rootDir: ${JSON.stringify(rootDir)},
}));
`;
  const child = spawn(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, SMITHERS_DURABILITY_SNAPSHOTS: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ exitCode: code, signal }));
  });
  return { child, exited, readStderr: () => stderr };
}

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
      const workflow = smithers(() => (
        <Workflow name="dur-snap-on">
          <Task id="task" output={outputs.outputA} agent={writingAgent()}>
            write a file
          </Task>
        </Workflow>
      ));
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
    } finally {
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
      const workflow = smithers(() => (
        <Workflow name="dur-snap-off">
          <Task id="task" output={outputs.outputA} agent={writingAgent()}>
            write a file
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, rootDir: jjDir }));
      expect(result.status).toBe("finished");

      const adapter = new SmithersDb(db);
      expect(await adapter.listWorkspaceCheckpoints(runId)).toHaveLength(0);
      expect(await adapter.listWorkspaceStates(runId)).toHaveLength(0);
    } finally {
      if (prev !== undefined) process.env.SMITHERS_DURABILITY_SNAPSHOTS = prev;
      cleanup();
      rmSync(jjDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("checkpoint fallback restores the workspace at the selected checkpoint horizon", async () => {
    const jjDir = mkdtempSync(join(tmpdir(), "dur-snap-checkpoint-horizon-"));
    expect(spawnSync("jj", ["git", "init"], { cwd: jjDir, encoding: "utf8" }).status).toBe(0);
    const prev = process.env.SMITHERS_DURABILITY_SNAPSHOTS;
    process.env.SMITHERS_DURABILITY_SNAPSHOTS = "1";
    const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "dur-snap-checkpoint-horizon";
    const compatible = { codec: "test.compatible", version: 1, payload: { cursor: "matching" } };
    const incompatible = { codec: "test.incompatible", version: 1, payload: { cursor: "later" } };
    const calls = [];
    let resumedWorkspace;
    const waitForWorkspaceCheckpoints = async (count) => {
      for (let poll = 0; poll < 60; poll += 1) {
        if ((await adapter.listWorkspaceCheckpoints(runId)).length >= count) return;
        await Bun.sleep(50);
      }
      throw new Error(`timed out waiting for ${count} workspace checkpoints`);
    };
    const agent = {
      id: "durability-checkpoint-horizon",
      checkpointFormats: [
        { codec: compatible.codec, versions: [1] },
        { codec: incompatible.codec, versions: [1] },
      ],
      checkpointCapabilities: [{ codec: compatible.codec, versions: [1], modes: ["resume"] }],
      async generate(args) {
        calls.push(args);
        const file = join(args.rootDir, "agent-output.txt");
        if (calls.length === 1) {
          writeFileSync(file, "matching checkpoint\n");
          await waitForWorkspaceCheckpoints(1);
          await args.onCheckpoint(compatible);
          await Bun.sleep(5);
          writeFileSync(file, "newer incompatible checkpoint\n");
          await waitForWorkspaceCheckpoints(2);
          return { text: '{"wrong":true}', checkpoint: incompatible };
        }
        resumedWorkspace = readFileSync(file, "utf8");
        return { text: '{"value":46}' };
      },
    };

    try {
      const workflow = smithers(() => (
        <Workflow name="durability-checkpoint-horizon">
          <Task id="task" output={outputs.outputA} agent={agent} retries={1} maxSchemaRetries={0}>
            update a file
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId, rootDir: jjDir }));
      expect(result.status).toBe("finished");
      expect(calls).toHaveLength(2);
      expect(calls[1].resumeCheckpoint).toEqual(compatible);
      expect(resumedWorkspace).toBe("matching checkpoint\n");
    } finally {
      if (prev === undefined) delete process.env.SMITHERS_DURABILITY_SNAPSHOTS;
      else process.env.SMITHERS_DURABILITY_SNAPSHOTS = prev;
      cleanup();
      rmSync(jjDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("crash resume keeps workspace changes preceding an identical checkpoint republish", async () => {
    const jjDir = mkdtempSync(join(tmpdir(), "dur-snap-identical-republish-"));
    expect(spawnSync("jj", ["git", "init"], { cwd: jjDir, encoding: "utf8" }).status).toBe(0);
    const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    const runId = "dur-snap-identical-republish";
    const markerPath = `${dbPath}.checkpoint-ready`;
    const child = spawnCheckpointCrashRun({ dbPath, markerPath, rootDir: jjDir, runId });
    let resumedWorkspace;
    let resumedSession;
    const stable = {
      codec: "smithers.cli-session",
      version: 1,
      payload: { engine: "fake-cli", resume: "stable-session" },
    };
    const agent = {
      id: "checkpoint-identical-crash-resume",
      cliEngine: "fake-cli",
      checkpointFormats: [{ codec: stable.codec, versions: [1] }],
      checkpointCapabilities: [{ codec: stable.codec, versions: [1], modes: ["resume"] }],
      async generate(args) {
        resumedSession = args.resumeSession;
        const file = join(args.rootDir, "agent-output.txt");
        resumedWorkspace = existsSync(file) ? readFileSync(file, "utf8") : null;
        return { text: '{"value":47}' };
      },
    };
    try {
      for (let poll = 0; poll < 400 && !existsSync(markerPath); poll += 1) await Bun.sleep(25);
      if (!existsSync(markerPath)) throw new Error(`child did not publish checkpoints: ${child.readStderr()}`);

      const refs = await adapter.listAgentCheckpointRefs(runId, { nodeId: "work" });
      expect(refs.map((ref) => ref.sequence)).toEqual([0, 1]);
      expect(new Set(refs.map((ref) => ref.contentHash)).size).toBe(1);

      child.child.kill("SIGKILL");
      await child.exited;
      const workflow = smithers(() => (
        <Workflow name="checkpoint-identical-crash-resume">
          <Task id="work" output={outputs.outputA} agent={agent}>
            update a file
          </Task>
        </Workflow>
      ));
      const resumed = await Effect.runPromise(
        runWorkflow(workflow, { input: {}, runId, rootDir: jjDir, resume: true, force: true }),
      );
      expect(resumed.status).toBe("finished");
      expect(resumedSession).toBe("stable-session");
      expect(resumedWorkspace).toBe("after republish\n");
    } finally {
      if (child.child.exitCode === null && !child.child.killed) {
        child.child.kill("SIGKILL");
        await child.exited.catch(() => undefined);
      }
      cleanup();
      rmSync(jjDir, { recursive: true, force: true });
    }
  }, 30_000);
});
