import { expect, onTestFinished, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";
import { gatewayRuntimePaths, readGatewayRuntimeState, writeGatewayRuntimeState } from "../src/gateway-runtime.js";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

function makeStateDirEnv() {
  const stateDir = mkdtempSync(join(tmpdir(), "smithers-gwstate-e2e-"));
  onTestFinished(() => rmSync(stateDir, { recursive: true, force: true }));
  return { stateDir, env: { NO_COLOR: "1", FORCE_COLOR: "0", SMITHERS_GATEWAY_STATE_DIR: stateDir } };
}

/**
 * Spawn a long-running `smithers gateway` and wait until it is serving.
 *
 * @param {{ dir: string }} repo
 * @param {Record<string, string>} env
 * @param {string[]} [extraArgs]
 */
async function startGateway(repo, env, extraArgs = []) {
  const gateway = spawnGateway(repo, env, extraArgs);
  await waitFor(() => gateway.stderr().includes("Runtime state:"), 20_000);
  const state = readGatewayRuntimeState(repo.dir, { ...process.env, ...env });
  expect(state?.url).toBeTruthy();
  const health = await fetch(`${state.url}/health`, { signal: AbortSignal.timeout(5_000) }).then((response) =>
    response.json(),
  );
  expect(health.ok).toBe(true);
  return gateway;
}

/**
 * Spawn a long-running `smithers gateway` without waiting for startup.
 *
 * @param {{ dir: string }} repo
 * @param {Record<string, string>} env
 * @param {string[]} [extraArgs]
 */
function spawnGateway(repo, env, extraArgs = []) {
  const child = spawn(process.execPath, ["run", CLI_ENTRY, "gateway", ...extraArgs], {
    cwd: repo.dir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
  onTestFinished(async () => {
    if (child.exitCode === null && !child.killed) {
      await stopProcess(child, closePromise);
    }
  });
  return { child, closePromise, stdout: () => stdout, stderr: () => stderr };
}

/**
 * Spawn a one-shot smithers command and capture stdout/stderr.
 *
 * @param {string[]} args
 * @param {{ cwd: string; env?: Record<string, string> }} options
 */
function spawnSmithers(args, options) {
  const child = spawn(process.execPath, ["run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
  onTestFinished(async () => {
    if (child.exitCode === null && !child.killed) {
      await stopProcess(child, closePromise);
    }
  });
  return { child, closePromise, stdout: () => stdout, stderr: () => stderr };
}

function writeBasicUi(repo) {
  repo.write(
    ".smithers/workflows/basic.tsx",
    [
      "/** @jsxImportSource smithers-orchestrator */",
      'import { createSmithers } from "smithers-orchestrator";',
      "",
      "const { Workflow, Task, UI, smithers } = createSmithers({});",
      "",
      "export default smithers(() => (",
      '  <Workflow name="basic">',
      '    <UI entry="../ui/basic.tsx" title="Basic" />',
      '    <Task id="done">{{ ok: true }}</Task>',
      "  </Workflow>",
      "));",
      "",
    ].join("\n"),
  );
  repo.write(
    ".smithers/ui/basic.tsx",
    [
      'import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";',
      "",
      "createGatewayReactRoot(<main>Basic UI</main>);",
      "",
    ].join("\n"),
  );
}

function writeWorkspacePack(repo) {
  repo.write(".smithers/smithers.config.ts", "export default {};\n");
}

async function findOpenPort(host = "127.0.0.1") {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate an open port");
  }
  return address.port;
}

// Cold CLI spawns page in the whole monorepo; under a full parallel
// `pnpm test` run that can take well over ten seconds.
async function waitFor(predicate, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for condition");
}

async function stopProcess(child, closePromise) {
  child.kill("SIGTERM");
  const closed = await Promise.race([
    closePromise.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
  ]);
  if (!closed) {
    child.kill("SIGKILL");
    await closePromise;
  }
}

function parseEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Expected a JSON envelope on stdout but got nothing. stdout=${JSON.stringify(stdout)}`);
  }
  const candidates = [trimmed];
  const lastObjectStart = trimmed.lastIndexOf("\n{");
  if (lastObjectStart >= 0) candidates.push(trimmed.slice(lastObjectStart + 1));
  const firstObjectStart = trimmed.indexOf("{");
  if (firstObjectStart > 0) candidates.push(trimmed.slice(firstObjectStart));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  throw new Error(`Could not parse a JSON envelope from stdout. stdout=${JSON.stringify(stdout)}`);
}

function listenerPidsOnPort(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  return (result.stdout ?? "")
    .split(/\s+/)
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function stopGatewayOnPort(port) {
  const pids = listenerPidsOnPort(port);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (pids.length === 0) return;
  await waitFor(() => listenerPidsOnPort(port).length === 0, 2_000).catch(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
}

test("gateway help distinguishes the multi-run Gateway from up --serve", () => {
  const repo = createTempRepo();
  const result = runSmithers(["gateway", "--help"], {
    cwd: repo.dir,
    format: null,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("multi-run Gateway RPC/WS control plane");
  expect(result.stdout).toContain("unlike up --serve");
});

test("gateway starts for an initialized workspace with no existing DB and listRuns is empty", async () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
  const dbPath = repo.path("smithers.db");
  expect(existsSync(dbPath)).toBe(false);

  const port = await findOpenPort();
  const child = spawn(process.execPath, ["run", CLI_ENTRY, "gateway", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.dir,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
  try {
    await waitFor(() => stderr.includes("Registered workflows:"));
    expect(stderr).toContain(`Workspace: ${repo.dir}`);
    expect(stderr).toContain(`Database: ${dbPath}`);
    expect(stderr).toContain("Registered workflows: basic");
    expect(existsSync(dbPath)).toBe(true);

    const response = await fetch(`http://127.0.0.1:${port}/v1/rpc/listRuns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(3_000),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.payload).toEqual([]);
  } finally {
    await stopProcess(child, closePromise);
  }
  expect(stdout).toBe("");
}, 15_000);

test("gateway is live while a workflow import is blocked and waits for an early launch", async () => {
  const repo = createTempRepo();
  const releaseFile = repo.path(".smithers/release-workflow");
  repo.write(
    ".smithers/workflows/blocked.tsx",
    [
      'import { existsSync } from "node:fs";',
      "while (!existsSync(" +
        JSON.stringify(releaseFile) +
        ")) await new Promise((resolve) => setTimeout(resolve, 10));",
      "/** @jsxImportSource smithers-orchestrator */",
      'import { createSmithers } from "smithers-orchestrator";',
      "const { Workflow, Task, smithers } = createSmithers({});",
      'export default smithers(() => <Workflow name="blocked"><Task id="done">{{ ok: true }}</Task></Workflow>);',
      "",
    ].join("\n"),
  );
  const { env } = makeStateDirEnv();
  const port = await findOpenPort();
  const gateway = spawnGateway(repo, env, ["--port", String(port)]);
  try {
    await waitFor(() => gateway.stderr().includes("Runtime state:"), 20_000);
    const healthBefore = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    expect(healthBefore.ok).toBe(true);
    expect(healthBefore.workflowsLoaded).toBeLessThan(healthBefore.workflowsTotal);

    const statusBefore = runSmithers(["gateway", "status"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
    expect(statusBefore.exitCode).toBe(0);
    const statusFields = Object.keys(statusBefore.json).sort();
    expect(statusBefore.json).toMatchObject({ running: true, port });

    const workflowList = fetch(`http://127.0.0.1:${port}/workflows`);
    const rpcWorkflowList = fetch(`http://127.0.0.1:${port}/v1/rpc/listWorkflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "workflow-list", method: "listWorkflows", params: {} }),
    });
    const aggregateUnresolved = await Promise.race([
      Promise.all([workflowList, rpcWorkflowList]).then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 100)),
    ]);
    expect(aggregateUnresolved).toBe(true);

    const launch = fetch(`http://127.0.0.1:${port}/v1/rpc/launchRun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "blocked-launch", method: "launchRun", params: { workflow: "blocked", input: {} } }),
    });
    const unresolved = await Promise.race([
      launch.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 100)),
    ]);
    expect(unresolved).toBe(true);

    writeFileSync(releaseFile, "released\n");
    const launchBody = await (await launch).json();
    expect(launchBody.ok).toBe(true);
    const [workflowListResponse, rpcWorkflowListResponse] = await Promise.all([workflowList, rpcWorkflowList]);
    expect((await workflowListResponse.json()).workflows.map((workflow) => workflow.key)).toContain("blocked");
    expect((await rpcWorkflowListResponse.json()).payload.map((workflow) => workflow.key)).toContain("blocked");
    const healthAfter = await waitFor(async () => {
      const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
      return health.workflowsLoaded === health.workflowsTotal ? health : null;
    }, 20_000);
    expect(healthAfter.workflowsTotal).toBe(1);
    const statusAfter = runSmithers(["gateway", "status"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
    expect(Object.keys(statusAfter.json).sort()).toEqual(statusFields);
  } finally {
    await stopProcess(gateway.child, gateway.closePromise);
  }
}, 60_000);

test("a discovered workspace workflow overrides the built-in fallback", async () => {
  const repo = createTempRepo();
  const releaseFile = repo.path(".smithers/release-workspace");
  repo.write(
    ".smithers/workflows/workspace.tsx",
    [
      'import { existsSync } from "node:fs";',
      "while (!existsSync(" +
        JSON.stringify(releaseFile) +
        ")) await new Promise((resolve) => setTimeout(resolve, 10));",
      "/** @jsxImportSource smithers-orchestrator */",
      'import { createSmithers } from "smithers-orchestrator";',
      "const { Workflow, Task, smithers } = createSmithers({});",
      'export default smithers(() => <Workflow name="Workspace override"><UI entry="../ui/workspace.tsx" title="Workspace override" /><Task id="done">{{ ok: true }}</Task></Workflow>);',
      "",
    ].join("\n"),
  );
  repo.write(
    ".smithers/ui/workspace.tsx",
    [
      'import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";',
      "createGatewayReactRoot(<main>Workspace override</main>);",
      "",
    ].join("\n"),
  );
  const { env } = makeStateDirEnv();
  const port = await findOpenPort();
  const gateway = spawnGateway(repo, env, ["--port", String(port)]);
  try {
    await waitFor(() => gateway.stderr().includes("Runtime state:"), 20_000);
    const list = fetch(`http://127.0.0.1:${port}/v1/rpc/listWorkflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "workspace-list", method: "listWorkflows", params: {} }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gateway.stderr()).not.toContain("Registered workflows: workspace");
    writeFileSync(releaseFile, "released\n");
    const body = await (await list).json();
    const workspace = body.payload.find((workflow) => workflow.key === "workspace");
    expect(workspace?.uiPath).toBe("/workflows/workspace");
    const ui = await fetch(`http://127.0.0.1:${port}/workflows/workspace`);
    expect(ui.status).toBe(200);
  } finally {
    await stopProcess(gateway.child, gateway.closePromise);
  }
}, 60_000);

test("a discovered oneshot workflow overrides the built-in fallback", async () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/oneshot.tsx");
  const { env } = makeStateDirEnv();
  const port = await findOpenPort();
  const gateway = await startGateway(repo, env, ["--port", String(port)]);
  try {
    await waitFor(() => gateway.stderr().includes("Registered workflows:"));
    const response = await fetch(`http://127.0.0.1:${port}/v1/rpc/listWorkflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    const oneshot = body.payload.find((workflow) => workflow.key === "oneshot");
    expect(oneshot).toBeDefined();
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((result) => result.json());
    expect(health.workflowsLoaded).toBe(health.workflowsTotal);
  } finally {
    await stopProcess(gateway.child, gateway.closePromise);
  }
}, 45_000);

test("gateway skips a broken workflow and still registers the valid ones", async () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/aaa.tsx");
  writeTestWorkflow(repo, ".smithers/workflows/zzz.tsx");
  // A top-level throw guarantees loadWorkflow's dynamic import rejects,
  // landing in the concurrent loader's loadError branch. Frontmatter-only
  // discovery still enumerates it, so boot must skip it without failing.
  repo.write(".smithers/workflows/mmm.tsx", 'throw new Error("boom");\n');

  const port = await findOpenPort();
  const child = spawn(process.execPath, ["run", CLI_ENTRY, "gateway", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.dir,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
  try {
    await waitFor(() => stderr.includes("Registered workflows:"));
    expect(stderr).toContain("Skipping workflow mmm");
    const line = stderr.split("\n").find((l) => l.includes("Registered workflows:"));
    expect(line).toContain("aaa");
    expect(line).toContain("zzz");
    expect(line).not.toContain("mmm");
  } finally {
    await stopProcess(child, closePromise);
  }
}, 45_000);

// A workspace with NO local .smithers pack must still serve the global
// (~/.smithers, here $SMITHERS_HOME) pack's workflow-owned UIs. The workflow's
// <UI entry="../ui/<id>.tsx" /> resolves against the pack the workflow was
// discovered in, not only the workspace. This is the sandbox-VM shape — a bare
// cloned repo served entirely from a `smithers init --global` pack.
test("gateway discovers a global-pack workflow-owned UI when the workspace has no local pack", async () => {
  const globalHome = createTempRepo();
  const smithersHome = join(globalHome.dir, ".smithers");
  globalHome.write(
    ".smithers/workflows/globping.tsx",
    [
      "/** @jsxImportSource smithers-orchestrator */",
      'import { createSmithers } from "smithers-orchestrator";',
      'import { z } from "zod/v4";',
      "",
      "const { Workflow, Task, UI, smithers, outputs } = createSmithers({",
      "  output: z.object({ ok: z.boolean() }),",
      "});",
      "",
      "export default smithers(() => (",
      '  <Workflow name="globping">',
      '    <UI entry="../ui/globping.tsx" title="Global Ping" />',
      '    <Task id="output" output={outputs.output}>{{ ok: true }}</Task>',
      "  </Workflow>",
      "));",
      "",
    ].join("\n"),
  );
  globalHome.write(
    ".smithers/ui/globping.tsx",
    [
      'import React from "react";',
      'import { createGatewayReactRoot } from "smithers-orchestrator/gateway-react";',
      "",
      "function GlobPingUi() {",
      "  return <main>Global Ping UI</main>;",
      "}",
      "",
      "createGatewayReactRoot(<GlobPingUi />);",
      "",
    ].join("\n"),
  );

  const repo = createTempRepo();
  const port = await findOpenPort();
  const child = spawn(process.execPath, ["run", CLI_ENTRY, "gateway", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.dir,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      SMITHERS_HOME: smithersHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
  try {
    await waitFor(() => stderr.includes("Registered workflows:"));
    expect(stderr).toContain("globping");

    const response = await fetch(`http://127.0.0.1:${port}/v1/rpc/listWorkflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(3_000),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    const globping = body.payload.find((workflow) => workflow.key === "globping");
    expect(globping).toBeDefined();
    expect(globping.hasUi).toBe(true);
    expect(globping.uiPath).toBe("/workflows/globping");
  } finally {
    await stopProcess(child, closePromise);
  }
}, 30_000);

// Security regression: the Gateway control plane (launch/cancel/inspect every
// run) was constructed with no auth, so it authenticated every request as
// role=operator scopes=["*"]. `--host` accepted 0.0.0.0 unvalidated, so
// `smithers gateway --host 0.0.0.0` exposed that full-control, unauthenticated
// plane to the network. A non-loopback bind now requires a token (or --insecure).
test("gateway refuses to bind a non-loopback host with no auth", () => {
  const repo = createTempRepo();
  // Force SMITHERS_API_KEY empty so a token in the test runner's env can't
  // satisfy the guard and leave the server actually binding (and hanging).
  const result = runSmithers(["gateway", "--host", "0.0.0.0"], {
    cwd: repo.dir,
    format: "json",
    env: { SMITHERS_API_KEY: "" },
    timeoutMs: 30_000,
  });
  expect(result.exitCode).not.toBe(0);
  const all = `${result.stdout}\n${result.stderr}`;
  expect(all).toContain("non-loopback");
  expect(all).toMatch(/auth-token|insecure/);
}, 30_000);

test("gateway refuses a routable LAN host with no auth", () => {
  const repo = createTempRepo();
  const result = runSmithers(["gateway", "--host", "192.168.1.50"], {
    cwd: repo.dir,
    format: "json",
    env: { SMITHERS_API_KEY: "" },
    timeoutMs: 30_000,
  });
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("non-loopback");
}, 30_000);

// Singleton lifecycle (spec: .smithers/specs/singleton-gateway.md, G1): the
// daemon records where it listens in a per-workspace runtime state file;
// `status` reports it, a second start refuses, `stop` tears it down.
for (const backend of ["sqlite", "pglite"]) {
  test(`gateway writes runtime state, enforces the singleton, and status/stop manage it (${backend})`, async () => {
    const repo = createTempRepo();
    if (backend === "sqlite") {
      writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
    } else {
      writeWorkspacePack(repo);
    }
    const { stateDir, env } = makeStateDirEnv();
    const stateEnv = { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
    const port = await findOpenPort();
    const backendArgs = backend === "sqlite" ? [] : ["--backend", backend];

    const gateway = await startGateway(repo, env, ["--port", String(port), ...backendArgs]);
    const state = readGatewayRuntimeState(repo.dir, stateEnv);
    expect(state?.port).toBe(port);
    expect(state?.pid).toBe(gateway.child.pid);
    expect(state?.backend).toBe(backend);
    expect(state?.token).toBeNull();
    expect(gateway.stderr()).toContain("Runtime state:");
    await waitFor(() => gateway.stderr().includes("Registered workflows:"));
    expect(gateway.stderr()).toContain(`Registered workflows: ${backend === "sqlite" ? "basic" : "workspace"}`);

    // /health advertises the workspace identity clients verify against.
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) =>
      r.json(),
    );
    expect(health.identity.pid).toBe(gateway.child.pid);
    expect(health.identity.backend).toBe(backend);
    expect(existsSync(health.identity.workspaceRoot)).toBe(true);

    // Second start against a healthy incumbent refuses.
    const second = runSmithers(["gateway", "--port", String(await findOpenPort()), ...backendArgs], {
      cwd: repo.dir,
      format: "json",
      env,
      timeoutMs: 30_000,
    });
    expect(second.exitCode).not.toBe(0);
    expect(`${second.stdout}\n${second.stderr}`).toContain("already running");

    // status reports the running daemon.
    const status = runSmithers(["gateway", "status"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
    expect(status.exitCode).toBe(0);
    expect(status.json?.running).toBe(true);
    expect(status.json?.pid).toBe(gateway.child.pid);
    expect(status.json?.backend).toBe(backend);

    // stop tears it down and clears the state file.
    const stop = runSmithers(["gateway", "stop"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
    expect(stop.exitCode).toBe(0);
    expect(stop.json?.stopped).toBe(true);
    await gateway.closePromise;
    expect(readGatewayRuntimeState(repo.dir, stateEnv)).toBeNull();

    const statusAfter = runSmithers(["gateway", "status"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
    expect(statusAfter.exitCode).toBe(0);
    expect(statusAfter.json?.running).toBe(false);
  }, 90_000);
}

test("concurrent ui autostarts converge on one workspace gateway", async () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
  writeBasicUi(repo);
  const { stateDir, env } = makeStateDirEnv();
  const stateEnv = { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
  const port = await findOpenPort();
  let state;
  try {
    const args = ["ui", "--workflow", "basic", "--port", String(port), "--no-open", "--format", "json"];
    const first = spawnSmithers(args, { cwd: repo.dir, env });
    const second = spawnSmithers(args, { cwd: repo.dir, env });
    const results = await Promise.all(
      [first, second].map(async (client) => {
        const exitCode = await client.closePromise;
        return {
          exitCode,
          stdout: client.stdout(),
          stderr: client.stderr(),
          json: exitCode === 0 ? parseEnvelope(client.stdout()) : null,
        };
      }),
    );
    for (const result of results) {
      expect(result.exitCode).toBe(0);
      expect(result.json?.opened).toBe(false);
      expect(result.json?.workflow).toBe("basic");
    }
    state = await waitFor(() => readGatewayRuntimeState(repo.dir, stateEnv), 60_000);
    expect(state?.port).toBeGreaterThan(0);
    expect(state?.pid).toBeGreaterThan(0);
    const expectedStateFile = basename(gatewayRuntimePaths(repo.dir, stateEnv).stateFile);
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".json"))).toEqual([expectedStateFile]);
    const listenerPids = await waitFor(() => {
      const pids = listenerPidsOnPort(state.port);
      return pids.length === 1 ? pids : null;
    }, 10_000);
    expect(listenerPids).toEqual([state.pid]);
    const urls = results.map((result) => result.json?.url);
    expect(new Set(urls)).toEqual(new Set([`${state.url}/workflows/basic`]));
    for (const url of urls) {
      const health = await fetch(`${new URL(url).origin}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) =>
        r.json(),
      );
      expect(health.identity.pid).toBe(state.pid);
    }
  } finally {
    const latest = state ?? readGatewayRuntimeState(repo.dir, stateEnv);
    if (latest?.port) {
      runSmithers(["gateway", "stop"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
      await stopGatewayOnPort(latest.port);
    } else {
      await stopGatewayOnPort(port);
    }
  }
}, 120_000);

test("ui autostart keeps two workspaces isolated on different ports", async () => {
  const firstRepo = createTempRepo();
  const secondRepo = createTempRepo();
  for (const repo of [firstRepo, secondRepo]) {
    writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
    writeBasicUi(repo);
  }
  const { env } = makeStateDirEnv();
  const stateEnv = { ...process.env, ...env };
  const port = await findOpenPort();
  let firstState;
  let secondState;
  try {
    const args = ["ui", "--workflow", "basic", "--port", String(port), "--no-open"];
    const first = runSmithers(args, { cwd: firstRepo.dir, format: "json", env, timeoutMs: 60_000 });
    expect(first.exitCode).toBe(0);
    firstState = readGatewayRuntimeState(firstRepo.dir, stateEnv);
    expect(firstState).not.toBeNull();
    expect(first.json?.url).toBe(`${firstState.url}/workflows/basic`);

    const second = runSmithers(args, { cwd: secondRepo.dir, format: "json", env, timeoutMs: 60_000 });
    expect(second.exitCode).toBe(0);
    secondState = readGatewayRuntimeState(secondRepo.dir, stateEnv);
    expect(secondState).not.toBeNull();
    expect(second.json?.url).toBe(`${secondState.url}/workflows/basic`);
    expect(secondState.port).not.toBe(firstState.port);
    expect(secondState.pid).not.toBe(firstState.pid);

    const firstHealth = await fetch(`${firstState.url}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) =>
      r.json(),
    );
    const secondHealth = await fetch(`${secondState.url}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) =>
      r.json(),
    );
    expect(firstHealth.identity.workspaceRoot).toBe(firstState.workspaceRoot);
    expect(secondHealth.identity.workspaceRoot).toBe(secondState.workspaceRoot);
  } finally {
    for (const [repo, state] of [
      [firstRepo, firstState],
      [secondRepo, secondState],
    ]) {
      if (state?.port) {
        runSmithers(["gateway", "stop"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
        await stopGatewayOnPort(state.port);
      }
    }
  }
}, 120_000);

test("gateway stop removes a stale runtime state file for a dead daemon", async () => {
  const repo = createTempRepo();
  writeWorkspacePack(repo);
  const { stateDir, env } = makeStateDirEnv();
  const stateEnv = { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
  const port = await findOpenPort();
  writeGatewayRuntimeState(
    repo.dir,
    {
      pid: 999999999,
      host: "127.0.0.1",
      port,
      url: `http://127.0.0.1:${port}`,
      token: null,
      workspaceRoot: repo.dir,
      backend: "sqlite",
      version: "0.0.0-test",
      protocol: 1,
      startedAtMs: Date.now(),
    },
    stateEnv,
  );

  const result = runSmithers(["gateway", "stop"], {
    cwd: repo.dir,
    format: "json",
    env,
    timeoutMs: 30_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.json?.cleanedStaleState).toBe(true);
  expect(result.json?.running).toBe(false);
  expect(readGatewayRuntimeState(repo.dir, stateEnv)).toBeNull();
}, 30_000);

test("gateway records a bracketed IPv6 loopback URL in runtime state", async () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
  const { stateDir, env } = makeStateDirEnv();
  let port;
  try {
    port = await findOpenPort("::1");
  } catch {
    return;
  }
  const gateway = await startGateway(repo, env, ["--host", "::1", "--port", String(port)]);
  const stateEnv = { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
  const state = readGatewayRuntimeState(repo.dir, stateEnv);
  expect(state?.url).toBe(`http://[::1]:${port}`);
  expect(new URL(state.url).hostname).toBe("[::1]");
  const health = await fetch(state.url + "/health", { signal: AbortSignal.timeout(3_000) }).then((r) => r.json());
  expect(health.identity.pid).toBe(gateway.child.pid);
  const status = runSmithers(["gateway", "status"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
  expect(status.exitCode).toBe(0);
  expect(status.json?.running).toBe(true);
  const stop = runSmithers(["gateway", "stop"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
  expect(stop.exitCode).toBe(0);
  await gateway.closePromise;
}, 60_000);

test("concurrent gateway starts serialize before workflow boot and only one daemon survives", async () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
  const { stateDir, env } = makeStateDirEnv();
  const firstPort = await findOpenPort();
  let secondPort = await findOpenPort();
  while (secondPort === firstPort) {
    secondPort = await findOpenPort();
  }
  const first = spawnGateway(repo, env, ["--port", String(firstPort)]);
  const second = spawnGateway(repo, env, ["--port", String(secondPort)]);
  const gateways = [first, second];
  try {
    await waitFor(() => {
      const listening = gateways.filter((gateway) => gateway.stderr().includes("Gateway listening on"));
      const closed = gateways.filter((gateway) => gateway.child.exitCode !== null);
      return listening.length >= 1 && listening.length + closed.length >= 2;
    }, 60_000);
    const listening = gateways.filter((gateway) => gateway.stderr().includes("Gateway listening on"));
    const live = gateways.filter((gateway) => gateway.child.exitCode === null);
    expect(listening).toHaveLength(1);
    expect(live).toHaveLength(1);
    const winner = listening[0];
    const loser = gateways.find((gateway) => gateway !== winner);
    expect(loser).toBeDefined();
    if (!loser) throw new Error("Expected one losing gateway process");
    expect(`${loser.stdout()}\n${loser.stderr()}`).toContain("already");
    const state = readGatewayRuntimeState(repo.dir, { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir });
    expect(state).not.toBeNull();
    if (!state) throw new Error("Expected runtime state for winning gateway");
    expect(state.pid).toBe(winner.child.pid);
    expect([firstPort, secondPort]).toContain(state.port);
    const health = await fetch(`${state.url}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json());
    expect(health.identity.pid).toBe(winner.child.pid);
  } finally {
    for (const gateway of gateways) {
      if (gateway.child.exitCode === null && !gateway.child.killed) {
        await stopProcess(gateway.child, gateway.closePromise);
      }
    }
  }
}, 90_000);

test("gateway stop refuses an untrusted runtime state directory", () => {
  if (typeof process.getuid !== "function") return;
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
  const { stateDir, env } = makeStateDirEnv();
  const { stateFile } = gatewayRuntimePaths(repo.dir, { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir });
  writeFileSync(
    stateFile,
    `${JSON.stringify({
      pid: process.pid,
      host: "127.0.0.1",
      port: 1,
      url: "http://127.0.0.1:1",
      token: null,
      workspaceRoot: repo.dir,
      backend: "sqlite",
      version: "0.0.0-test",
      protocol: 1,
      startedAtMs: Date.now(),
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(stateDir, 0o777);
  onTestFinished(() => {
    try {
      chmodSync(stateDir, 0o700);
    } catch {
      // The shared temp-dir cleanup may already have removed it.
    }
  });
  const result = runSmithers(["gateway", "stop"], {
    cwd: repo.dir,
    format: "json",
    env,
    timeoutMs: 30_000,
  });
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("GATEWAY_STATE_UNTRUSTED");
}, 30_000);

// Decision 6: the preferred port being taken by ANOTHER process must not
// crash the daemon (EADDRINUSE used to surface as an unhandled 'error'
// event); it falls back to an ephemeral port recorded in the state file.
test("gateway falls back to an ephemeral port when the preferred port is taken", async () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
  const { stateDir, env } = makeStateDirEnv();

  const squatter = createServer();
  await new Promise((resolvePromise, reject) => {
    squatter.once("error", reject);
    squatter.listen(0, "127.0.0.1", resolvePromise);
  });
  const takenPort = squatter.address().port;
  onTestFinished(() => new Promise((resolvePromise) => squatter.close(resolvePromise)));

  const gateway = await startGateway(repo, env, ["--port", String(takenPort)]);
  expect(gateway.stderr()).toContain("ephemeral port");
  const stateEnv = { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
  const state = readGatewayRuntimeState(repo.dir, stateEnv);
  expect(state?.port).toBeGreaterThan(0);
  expect(state?.port).not.toBe(takenPort);
  const health = await fetch(`${state.url}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json());
  expect(health.ok).toBe(true);
  expect(health.identity.pid).toBe(gateway.child.pid);
}, 60_000);

// --mint-token: requests without the bearer are rejected; the token lives
// only in the 0600 state file (and the daemon's own stderr).
test("gateway --mint-token requires the minted bearer", async () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
  const { stateDir, env } = makeStateDirEnv();
  const port = await findOpenPort();

  const gateway = await startGateway(repo, { ...env, SMITHERS_API_KEY: "" }, ["--port", String(port), "--mint-token"]);
  const stateEnv = { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
  const state = readGatewayRuntimeState(repo.dir, stateEnv);
  expect(state?.token).toHaveLength(64);
  await waitFor(() => gateway.stderr().includes("Minted bearer token"));
  expect(gateway.stderr()).toContain("Minted bearer token");

  const { stateFile } = gatewayRuntimePaths(repo.dir, stateEnv);
  expect(readFileSync(stateFile, "utf8")).toContain(state.token);

  const unauthenticated = await fetch(`${state.url}/v1/rpc/listRuns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(3_000),
  });
  expect(unauthenticated.status).toBe(401);

  const authenticated = await fetch(`${state.url}/v1/rpc/listRuns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
    body: "{}",
    signal: AbortSignal.timeout(3_000),
  });
  expect(authenticated.status).toBe(200);
  const body = await authenticated.json();
  expect(body.ok).toBe(true);
}, 60_000);

// An operator-supplied --auth-token (or SMITHERS_API_KEY) is a durable, possibly
// org-wide secret: it must NOT be copied to the on-disk state file. The daemon
// mints a SEPARATE session-only bearer for the state file (so cross-shell clients
// discover a working token), registers BOTH, and never persists the explicit one.
test("gateway --auth-token keeps the operator token out of the state file but still authenticates", async () => {
  const repo = createTempRepo();
  writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
  const { stateDir, env } = makeStateDirEnv();
  const port = await findOpenPort();
  const explicitToken = "operator-durable-secret-abc123";

  const gateway = await startGateway(repo, { ...env, SMITHERS_API_KEY: "" }, [
    "--port",
    String(port),
    "--auth-token",
    explicitToken,
  ]);
  const stateEnv = { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir };
  const state = readGatewayRuntimeState(repo.dir, stateEnv);
  // The persisted token is a freshly minted session token, not the operator's.
  expect(state?.token).toHaveLength(64);
  expect(state?.token).not.toBe(explicitToken);

  const { stateFile } = gatewayRuntimePaths(repo.dir, stateEnv);
  const fileContents = readFileSync(stateFile, "utf8");
  expect(fileContents).toContain(state.token);
  expect(fileContents).not.toContain(explicitToken);

  // No bearer → rejected.
  const unauthenticated = await fetch(`${state.url}/v1/rpc/listRuns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(3_000),
  });
  expect(unauthenticated.status).toBe(401);

  // The session token from the state file authenticates (cross-shell clients).
  const withSession = await fetch(`${state.url}/v1/rpc/listRuns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
    body: "{}",
    signal: AbortSignal.timeout(3_000),
  });
  expect(withSession.status).toBe(200);

  // The operator's own explicit token still authenticates too.
  const withExplicit = await fetch(`${state.url}/v1/rpc/listRuns`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${explicitToken}` },
    body: "{}",
    signal: AbortSignal.timeout(3_000),
  });
  expect(withExplicit.status).toBe(200);

  // status still reports auth as active (derived from the persisted token).
  const status = runSmithers(["gateway", "status"], { cwd: repo.dir, format: "json", env, timeoutMs: 30_000 });
  expect(status.exitCode).toBe(0);
  expect(status.json?.auth).toBe("token");
}, 60_000);

test("gateway registers the evals extension (ext.evals.listSuites/saveSuite/listCases)", async () => {
  const repo = createTempRepo();
  const { env } = makeStateDirEnv();
  const port = await findOpenPort();
  // Spawn (not the shared `startGateway`, which hardcodes a 20s boot wait)
  // with a generous wait: this machine's boot time varies a lot under load
  // and this test needs no custom workflow, so it stays as light as the CLI
  // itself allows.
  const gateway = spawnGateway(repo, env, ["--port", String(port)]);
  try {
    await waitFor(() => gateway.stderr().includes("Runtime state:"), 60_000);

    // A booted gateway serves the "evals" namespace — not a typed
    // EXTENSION_METHOD_NOT_FOUND — proving runGatewayCommand really calls
    // gateway.extend("evals", createEvalsExtension(...)).
    const listSuites = await fetch(`http://127.0.0.1:${port}/v1/rpc/ext.evals.listSuites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    });
    expect(listSuites.status).toBe(200);
    const listSuitesBody = await listSuites.json();
    expect(listSuitesBody.ok).toBe(true);
    expect(listSuitesBody.payload).toEqual([]);

    // Unknown workflowKey → honest INVALID_INPUT (proves resolveWorkflowKey
    // is wired to the booted gateway's real discovered-workflow index).
    const badSave = await fetch(`http://127.0.0.1:${port}/v1/rpc/ext.evals.saveSuite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "smoke", workflowKey: "does-not-exist", datasetText: '[{"id":"a","input":{}}]' }),
      signal: AbortSignal.timeout(5_000),
    });
    const badSaveBody = await badSave.json();
    expect(badSaveBody.ok).toBe(false);
    expect(badSaveBody.error?.code).toBe("INVALID_INPUT");

    const listCases = await fetch(`http://127.0.0.1:${port}/v1/rpc/ext.evals.listCases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evalRunId: "no-such-run" }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(listCases.status).toBe(200);
    const listCasesBody = await listCases.json();
    expect(listCasesBody.ok).toBe(true);
    expect(listCasesBody.payload).toEqual([]);
  } finally {
    await stopProcess(gateway.child, gateway.closePromise);
  }
}, 75_000);

test("eval suites accept a workflow added after gateway startup", async () => {
  const repo = createTempRepo();
  const { env } = makeStateDirEnv();
  const port = await findOpenPort();
  const gateway = await startGateway(repo, env, ["--port", String(port)]);
  try {
    writeTestWorkflow(repo, ".smithers/workflows/hot-added.tsx");
    const launch = await fetch(`http://127.0.0.1:${port}/v1/rpc/launchRun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "hot-added-launch",
        method: "launchRun",
        params: { workflow: "hot-added", input: {} },
      }),
    });
    expect((await launch.json()).ok).toBe(true);
    const save = await fetch(`http://127.0.0.1:${port}/v1/rpc/ext.evals.saveSuite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "hot", workflowKey: "hot-added", datasetText: '[{"id":"case-1","input":{}}]' }),
    });
    const body = await save.json();
    expect(body.ok).toBe(true);
    expect(body.payload.suiteId).toBeString();
  } finally {
    await stopProcess(gateway.child, gateway.closePromise);
  }
}, 45_000);
