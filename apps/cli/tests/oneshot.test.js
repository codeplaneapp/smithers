import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildOneshotWorkflow } from "../src/oneshot/buildOneshotWorkflow.js";
import { buildOneshotChildArgs } from "../src/oneshot/buildOneshotChildArgs.js";
import { loadOneshotConfig } from "../src/oneshot/loadOneshotConfig.js";
import { saveOneshotConfig } from "../src/oneshot/saveOneshotConfig.js";
import { resolveOneshotChain } from "../src/oneshot/resolveOneshotChain.js";
import { rewriteOneshotBooleanValues } from "../src/oneshot/rewriteOneshotBooleanValues.js";
import { cleanStatusLine } from "../src/oneshot/startOneshotStatusUpdater.js";
import { startOneshotStatusUpdater } from "../src/oneshot/startOneshotStatusUpdater.js";
import { bundleGatewayUiEntry } from "../../../packages/server/src/gatewayUi/bundle.js";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTestDb } from "../../../packages/smithers/tests/helpers.js";
import { ddl, schema } from "../../../packages/smithers/tests/schema.js";
import { openDurableSqliteDatabase } from "@smithers-orchestrator/db";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
const cliEntry = join(repoRoot, "apps/cli/src/index.js");
const tempDirs = [];
const temp = (prefix) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
};
afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const availability = (id, usable = true) => ({ id, usable, deprecated: false });

describe("oneshot config", () => {
  test("round trips under SMITHERS_HOME and preserves unknown top-level keys", () => {
    const home = temp("smithers-oneshot-config-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ future: { enabled: true }, version: 7 }));
    const env = { SMITHERS_HOME: home };
    saveOneshotConfig({ review: "on", trivial: "direct", announced: true }, env);
    expect(loadOneshotConfig(env)).toEqual({ review: "on", trivial: "direct", announced: true });
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(raw.future).toEqual({ enabled: true });
    expect(raw.version).toBe(1);
    expect(
      Bun.file(join(home, "config.json"))
        .stat()
        .then((stat) => stat.mode & 0o777),
    ).resolves.toBe(0o600);
  });

  test("corrupt config falls back to unset defaults", () => {
    const home = temp("smithers-oneshot-corrupt-");
    writeFileSync(join(home, "config.json"), "{broken");
    expect(loadOneshotConfig({ SMITHERS_HOME: home })).toEqual({ review: null, trivial: null, announced: false });
  });
});

describe("oneshot model chain", () => {
  const all = [availability("codex"), availability("kimi"), availability("claude"), availability("opencode")];
  test("uses Opus, Sol, Kimi, Fable priority", () => {
    expect(resolveOneshotChain(all, { env: { SMITHERS_CODEX_PAUSED: "0" } })).toEqual([
      { engine: "claude", model: "claude-opus-5" },
      { engine: "codex", model: "gpt-5.6-sol" },
      { engine: "kimi", model: "kimi-code/k3" },
      { engine: "claude", model: "claude-fable-5" },
    ]);
  });
  test("drops paused Codex and maps model slots", () => {
    expect(resolveOneshotChain(all, { env: { SMITHERS_CODEX_PAUSED: "1" } })[0]).toEqual({
      engine: "claude",
      model: "claude-opus-5",
    });
    expect(resolveOneshotChain(all, { model: "terra", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({
      engine: "codex",
      model: "gpt-5.6-terra",
    });
    expect(resolveOneshotChain(all, { model: "opus", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({
      engine: "claude",
      model: "claude-opus-5",
    });
    expect(resolveOneshotChain(all, { model: "kimi", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({
      engine: "kimi",
      model: "kimi-code/k3",
    });
    expect(resolveOneshotChain(all, { model: "kimi-code/k3", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({
      engine: "kimi",
      model: "kimi-code/k3",
    });
  });
  test("maps canonical model ids or requires an explicit engine", () => {
    expect(resolveOneshotChain(all, { model: "gpt-future-codex", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({
      engine: "codex",
      model: "gpt-future-codex",
    });
    expect(resolveOneshotChain(all, { model: "claude-future", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({
      engine: "claude",
      model: "claude-future",
    });
    expect(() => resolveOneshotChain(all, { model: "future-model", env: { SMITHERS_CODEX_PAUSED: "0" } })).toThrow(
      "Pass --agent",
    );
    expect(
      resolveOneshotChain(all, { model: "future-model", agent: "kimi", env: { SMITHERS_CODEX_PAUSED: "0" } })[0],
    ).toEqual({ engine: "kimi", model: "future-model" });
  });
});

describe("oneshot status updater", () => {
  test("cleans narrator output to a single bounded line", () => {
    expect(cleanStatusLine("Editing foo.ts.")).toBe("Editing foo.ts");
    expect(cleanStatusLine('\n- "Running tests."\nsome second line')).toBe("Running tests");
    expect(cleanStatusLine("")).toBeNull();
    expect(cleanStatusLine("   \n  ")).toBeNull();
    expect(cleanStatusLine("x".repeat(200))).toHaveLength(140);
  });

  function statusDb() {
    const { db, cleanup } = createTestDb(schema, ddl);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    return { db, adapter, cleanup };
  }

  async function seedActivity(adapter) {
    await adapter.insertRun({
      runId: "status-run",
      workflowName: "oneshot",
      status: "running",
      createdAtMs: Date.now(),
    });
    await adapter.insertEventWithNextSeq({
      runId: "status-run",
      timestampMs: Date.now(),
      type: "NodeOutput",
      payloadJson: JSON.stringify({ nodeId: "implement", text: "Editing index.js" }),
    });
  }

  async function waitFor(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(5);
  }

  test("stop waits while events are loading and prevents narration", async () => {
    const { db, adapter, cleanup } = statusDb();
    try {
      await seedActivity(adapter);
      let release;
      const listEvents = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const controlled = {
        listEvents,
        insertEventWithNextSeqEffect: adapter.insertEventWithNextSeqEffect.bind(adapter),
      };
      let generated = false;
      const updater = startOneshotStatusUpdater({
        db,
        adapter: controlled,
        runId: "status-run",
        goal: "goal",
        cwd: process.cwd(),
        pollMs: 1,
        candidates: [
          {
            id: "test",
            build: () => ({
              generate: async () => {
                generated = true;
                return { text: "Running tests" };
              },
            }),
          },
        ],
      });
      await waitFor(() => release !== undefined);
      const stopped = updater.stop();
      let settled = false;
      void stopped.then(() => {
        settled = true;
      });
      await Bun.sleep(5);
      expect(settled).toBe(false);
      release([]);
      await stopped;
      expect(generated).toBe(false);
      expect(
        (await adapter.listEvents("status-run", -1, 100)).filter((event) => event.type === "NodeOutput"),
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("stop aborts and waits for an in-flight narrator", async () => {
    const { db, adapter, cleanup } = statusDb();
    try {
      await seedActivity(adapter);
      let resolveGeneration;
      let receivedSignal;
      const controlled = {
        listEvents: async () => [
          {
            seq: 1,
            type: "NodeOutput",
            payloadJson: JSON.stringify({ nodeId: "implement", text: "Editing index.js" }),
          },
        ],
        insertEventWithNextSeqEffect: adapter.insertEventWithNextSeqEffect.bind(adapter),
      };
      const updater = startOneshotStatusUpdater({
        db,
        adapter: controlled,
        runId: "status-run",
        goal: "goal",
        cwd: process.cwd(),
        pollMs: 1,
        candidates: [
          {
            id: "test",
            build: () => ({
              generate: ({ abortSignal }) => {
                receivedSignal = abortSignal;
                return new Promise((resolve) => {
                  resolveGeneration = resolve;
                });
              },
            }),
          },
        ],
      });
      await waitFor(() => receivedSignal !== undefined);
      const stopped = updater.stop();
      expect(receivedSignal?.aborted).toBe(true);
      resolveGeneration({ text: "Late status" });
      await stopped;
      expect(
        (await adapter.listEvents("status-run", -1, 100)).filter((event) => event.type === "NodeOutput"),
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("stop ignores a narrator that does not honor abort", async () => {
    const { db, adapter, cleanup } = statusDb();
    try {
      await seedActivity(adapter);
      let resolveGeneration;
      const controlled = {
        listEvents: async () => [
          {
            seq: 1,
            type: "NodeOutput",
            payloadJson: JSON.stringify({ nodeId: "implement", text: "Editing index.js" }),
          },
        ],
        insertEventWithNextSeqEffect: adapter.insertEventWithNextSeqEffect.bind(adapter),
      };
      const updater = startOneshotStatusUpdater({
        db,
        adapter: controlled,
        runId: "status-run",
        goal: "goal",
        cwd: process.cwd(),
        pollMs: 1,
        candidates: [
          {
            id: "test",
            build: () => ({
              generate: () =>
                new Promise((resolve) => {
                  resolveGeneration = resolve;
                }),
            }),
          },
        ],
      });
      await waitFor(() => resolveGeneration !== undefined);
      const stopped = updater.stop();
      resolveGeneration({ text: "Late status" });
      await stopped;
      expect(
        (await adapter.listEvents("status-run", -1, 100)).filter((event) => event.type === "NodeOutput"),
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});

test("detached child re-invokes oneshot and forwards launch flags", () => {
  const cliPath = join("root", "cli", "index.js");
  const workspace = join("root", "workspace");
  const goalFile = join(workspace, "goal.txt");
  expect(
    buildOneshotChildArgs({
      cliPath,
      goal: "focused goal",
      goalFile,
      cwd: workspace,
      review: "on",
      model: "terra",
      agent: "codex",
      open: true,
      startedByHarness: "codex",
      startedBySession: "thread-1",
      startedByPrompt: "launch context",
    }),
  ).toEqual([
    cliPath,
    "oneshot",
    "--goal-file",
    goalFile,
    "--cwd",
    workspace,
    "--detach",
    "false",
    "--open",
    "true",
    "--review",
    "on",
    "--model",
    "terra",
    "--agent",
    "codex",
    "--started-by-harness",
    "codex",
    "--started-by-session",
    "thread-1",
    "--started-by-prompt",
    "launch context",
  ]);
});

test("oneshot accepts explicit boolean values for default-true flags", () => {
  expect(rewriteOneshotBooleanValues(["oneshot", "goal", "--detach", "false", "--open=true"])).toEqual([
    "oneshot",
    "goal",
    "--no-detach",
    "--open",
  ]);
  expect(rewriteOneshotBooleanValues(["oneshot", "goal", "-d", "false", "--open", "false"])).toEqual([
    "oneshot",
    "goal",
    "--no-detach",
    "--no-open",
  ]);
});

function detachedFixture() {
  const cwd = temp("smithers-oneshot-detached-");
  const workflowDir = join(cwd, ".smithers", "workflows");
  const binDir = join(cwd, "bin");
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const codex = join(binDir, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n");
  chmodSync(codex, 0o755);
  // OPENAI_API_KEY makes agent detection self-sufficient: a bare CI runner
  // has no real agent credentials, and without any usable agent the CLI
  // exits NO_USABLE_AGENTS before reaching the paths these tests assert.
  return {
    cwd,
    workflowDir,
    binDir,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_HOME: join(cwd, "home"),
      SMITHERS_NO_SKILL_REFRESH: "1",
      OPENAI_API_KEY: "sk-oneshot-detached-fixture",
    },
  };
}

async function waitForDetachedRunTerminal(dbPath, runId) {
  const terminalStatuses = new Set(["finished", "failed", "cancelled", "canceled", "continued"]);
  for (let i = 0; i < 200; i++) {
    if (existsSync(dbPath)) {
      const sqlite = openDurableSqliteDatabase(dbPath);
      try {
        const run = (await new SmithersDb(sqlite.db).listRuns()).find((entry) => entry.runId === runId);
        if (run && terminalStatuses.has(run.status)) return run;
      } finally {
        sqlite.close();
      }
    }
    await Bun.sleep(25);
  }
  throw new Error(`detached run ${runId} did not reach a terminal state`);
}

async function terminateDetachedProcessGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const isAlive = () => {
    try {
      process.kill(-pid, 0);
    } catch {
      return false;
    }
    return true;
  };
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 40 && isAlive(); i++) await Bun.sleep(25);
  if (!isAlive()) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return;
  }
  for (let i = 0; i < 40 && isAlive(); i++) await Bun.sleep(25);
  if (isAlive()) {
    throw new Error(`detached process group ${pid} did not exit after SIGKILL`);
  }
}

test("detached oneshot reports pre-admission failure without advertising or persisting a run", async () => {
  const fixture = detachedFixture();
  writeFileSync(join(fixture.workflowDir, "oneshot.tsx"), "export default ;\n");
  const result = spawnSync(
    process.execPath,
    ["run", cliEntry, "oneshot", "broken child", "--open", "false", "--format", "json"],
    {
      cwd: fixture.cwd,
      env: fixture.env,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status).not.toBe(0);
  expect(output).toContain("DETACHED_ADMISSION_FAILED");
  expect(output).not.toContain('"runId"');
  const dbPath = join(fixture.cwd, "smithers.db");
  if (existsSync(dbPath)) {
    const sqlite = openDurableSqliteDatabase(dbPath);
    try {
      expect(await new SmithersDb(sqlite.db).listRuns()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  }
}, 40_000);

test("detached oneshot succeeds only after its run row is readable", async () => {
  const fixture = detachedFixture();
  const receipt = join(fixture.cwd, "receipt.json");
  writeFileSync(
    join(fixture.workflowDir, "oneshot.tsx"),
    `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from ${JSON.stringify(pathToFileURL(join(repoRoot, "packages/smithers/src/index.js")).href)};
import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "node_modules/zod/index.js")).href)};
const { Workflow, Task, smithers, outputs } = createSmithers({ input: z.object({ goal: z.string(), review: z.enum(["on", "off"]), model: z.string() }), receipt: z.object({ ok: z.boolean() }) });
export default smithers((ctx) => <Workflow name="custom-oneshot"><Task id="record" output={outputs.receipt}>{async () => { await Bun.write(${JSON.stringify(receipt)}, "ok"); return { ok: true }; }}</Task></Workflow>);
`,
  );
  const dbPath = join(fixture.cwd, "smithers.db");
  let pid;
  try {
    const result = spawnSync(
      process.execPath,
      ["run", cliEntry, "oneshot", "detached success", "--open", "false", "--format", "json"],
      {
        cwd: fixture.cwd,
        env: fixture.env,
        encoding: "utf8",
        timeout: 40_000,
      },
    );
    if (result.status !== 0) throw new Error(`detached oneshot failed\n${result.stdout}\n${result.stderr}`);
    const response = JSON.parse(result.stdout);
    pid = response.pid;
    expect(response.runId).toBeTruthy();
    expect(existsSync(dbPath)).toBe(true);
    const run = await waitForDetachedRunTerminal(dbPath, response.runId);
    expect(run.runId).toBe(response.runId);
  } finally {
    await terminateDetachedProcessGroup(pid);
  }
}, 50_000);

describe("oneshot workflow", () => {
  const agent = { generate: async () => ({ text: "unused" }) };
  test.each([
    [false, ["implement"]],
    [true, ["implement", "review"]],
  ])("builds review=%s shape", async (review, taskIds) => {
    const cwd = temp("smithers-oneshot-builder-");
    const workflow = await buildOneshotWorkflow({
      cwd,
      goal: "Make the focused test change",
      agents: [agent],
      reviewAgents: [agent],
      review,
    });
    try {
      const root = workflow.build();
      const children = review ? root.props.children.props.children : [root.props.children];
      expect(children.map((child) => child.props.id)).toEqual(taskIds);
      expect(children.every((child) => child.props.hijack === undefined)).toBe(true);
      expect([...workflow.schemaRegistry.keys()]).toEqual(
        review ? ["oneshotResult", "oneshotReview"] : ["oneshotResult"],
      );
      for (const key of workflow.schemaRegistry.keys())
        expect(["runId", "nodeId", "iteration", "id", "created_at"]).not.toContain(key);
      expect(root.props.children.type.name).toBe(review ? "Sequence" : "Task");
    } finally {
      workflow.db.$client.close();
    }
  });
});

test("status is JSON and the availability gate fails without supported CLIs", () => {
  const home = temp("smithers-oneshot-cli-");
  const baseEnv = { ...process.env, HOME: home, SMITHERS_HOME: home, PATH: "/usr/bin:/bin" };
  const status = spawnSync(process.execPath, ["run", cliEntry, "oneshot", "--status", "--format", "json"], {
    cwd: home,
    env: baseEnv,
    encoding: "utf8",
  });
  expect(status.status).toBe(0);
  expect(JSON.parse(status.stdout).usableAgents).toEqual([]);
  const red = spawnSync(
    process.execPath,
    ["run", cliEntry, "oneshot", "fix the thing", "--detach", "false", "--open", "false", "--format", "json"],
    { cwd: home, env: baseEnv, encoding: "utf8" },
  );
  expect(red.status).not.toBe(0);
  expect(`${red.stdout}${red.stderr}`).toContain("NO_USABLE_AGENTS");
}, 30_000);

test("oneshot UI bundles for the browser", async () => {
  const body = await bundleGatewayUiEntry({ entry: join(repoRoot, "apps/cli/src/oneshot/oneshot-ui.tsx") }, new Map());
  expect(body).toContain("Oneshot");
  expect(body.length).toBeGreaterThan(1000);
}, 60_000);

test("workspace override receives goal, review, and model input", () => {
  const cwd = temp("smithers-oneshot-override-");
  const workflowDir = join(cwd, ".smithers", "workflows");
  const binDir = join(cwd, "bin");
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const fakeCodex = join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
  writeFileSync(fakeCodex, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  chmodSync(fakeCodex, 0o755);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ type: "module", dependencies: { "smithers-orchestrator": "workspace:*", zod: "*" } }),
  );
  const receipt = join(cwd, "override-input.json");
  writeFileSync(
    join(workflowDir, "oneshot.tsx"),
    `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "${pathToFileURL(join(repoRoot, "packages/smithers/src/index.js")).href}";
import { z } from "${pathToFileURL(join(repoRoot, "node_modules/zod/index.js")).href}";
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ goal: z.string(), review: z.enum(["on", "off"]), model: z.string() }),
  receipt: z.object({ ok: z.boolean() }),
});
export default smithers((ctx) => <Workflow name="custom-oneshot"><Task id="record" output={outputs.receipt}>{async () => {
  await Bun.write(${JSON.stringify(receipt)}, JSON.stringify(ctx.input));
  return { ok: true };
}}</Task></Workflow>);
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      "run",
      cliEntry,
      "oneshot",
      "use the override",
      "--detach",
      "false",
      "--open",
      "false",
      "--review",
      "on",
      "--model",
      "terra",
      "--format",
      "json",
    ],
    {
      cwd,
      env: {
        ...process.env,
        SMITHERS_HOME: join(cwd, "home"),
        SMITHERS_NO_SKILL_REFRESH: "1",
        OPENAI_API_KEY: "sk-oneshot-override-fixture",
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    throw new Error(`override run exited ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  if (!existsSync(receipt))
    throw new Error(`override produced no receipt\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ goal: "use the override", review: "on", model: "terra" });
}, 30_000);
