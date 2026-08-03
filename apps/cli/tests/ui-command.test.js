import { afterEach, describe, expect, onTestFinished, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createSmithers } from "../../../packages/smithers/src/create.js";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";
import { canonicalWorkspacePath, gatewayRuntimePaths, writeGatewayRuntimeState } from "../src/gateway-runtime.js";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

const children = new Set();

afterEach(async () => {
  await Promise.all([...children].map((entry) => stopProcess(entry.child, entry.closePromise)));
  children.clear();
});

async function findOpenPort() {
  const server = createNetServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate an open port");
  }
  return address.port;
}

function rpcResponse(payload) {
  return { type: "res", ok: true, payload };
}

async function startFakeGateway(handler, options = {}) {
  const requests = [];
  const server = createHttpServer(async (req, res) => {
    if (req.url === "/health") {
      requests.push({ method: "health", body: null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...(options.identity ? { identity: options.identity } : {}) }));
      return;
    }
    const match = req.url?.match(/^\/v1\/rpc\/([^/?]+)/);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (options.bearer && req.headers.authorization !== `Bearer ${options.bearer}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const params = body ? JSON.parse(body) : {};
    const method = match[1];
    requests.push({ method, body: params, authorization: req.headers.authorization ?? null });
    const frame = handler(method, params);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(frame));
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake Gateway did not bind to a TCP port");
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

async function stopProcess(child, closePromise) {
  if (child.exitCode !== null || child.signalCode) {
    await closePromise;
    return;
  }
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

function makeStateDirEnv() {
  const stateDir = mkdtempSync(join(tmpdir(), "smithers-ui-gwstate-"));
  onTestFinished(() => rmSync(stateDir, { recursive: true, force: true }));
  return { stateDir, env: { NO_COLOR: "1", FORCE_COLOR: "0", SMITHERS_GATEWAY_STATE_DIR: stateDir } };
}

function seedLegacySqliteStore(repo) {
  repo.write(".smithers/smithers.config.ts", "export default {};\n");
  const api = createSmithers({}, { dbPath: repo.path("smithers.db"), backend: "sqlite" });
  ensureSmithersTables(api.db);
  api.db.$client.exec(`
        INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
          VALUES ('cli-ui-legacy-run', 'legacy', 'finished', 1);
    `);
  api.db.$client.close();
}

function seedConflictedWorkspace(repo) {
  repo.write(
    ".smithers/workflows/basic.tsx",
    [
      "/** @jsxImportSource smthrs */",
      'import { createSmithers } from "smthrs";',
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
      'import { createGatewayReactRoot } from "smthrs/gateway-react";',
      "",
      "createGatewayReactRoot(<main>Basic UI</main>);",
      "",
    ].join("\n"),
  );
  const api = createSmithers({}, { dbPath: repo.path("smithers.db"), backend: "sqlite" });
  ensureSmithersTables(api.db);
  api.db.$client.exec(`
        INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms)
          VALUES ('cli-ui-conflicted-run', 'basic', 'finished', 1);
        INSERT INTO _smithers_nodes
          (run_id, node_id, iteration, state, last_attempt, updated_at_ms, output_table, label)
          VALUES ('cli-ui-conflicted-run', 'done', 0, 'finished', 1, 2, 'basic_output', 'Done');
        CREATE TABLE basic_output (
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          iteration INTEGER NOT NULL,
          ok INTEGER
        );
        INSERT INTO basic_output (run_id, node_id, iteration, ok)
          VALUES ('cli-ui-conflicted-run', 'done', 0, 1);
    `);
  api.db.$client.close();
  repo.write(
    "package.json",
    [
      "{",
      '  "name": "smithers-conflicted-fixture",',
      "<<<<<<< conflict 1 of 5",
      '  "type": "module",',
      "%%%%%%%",
      '  "type": "commonjs",',
      ">>>>>>> conflict 1 of 5",
      '  "private": true',
      "}",
      "",
    ].join("\n"),
  );
}

function writeWorkflowWithUi(repo, key, label, declareUi = true, root = ".smithers") {
  repo.write(
    `${root}/workflows/${key}.tsx`,
    [
      "/** @jsxImportSource smthrs */",
      'import { createSmithers } from "smthrs";',
      'import { z } from "zod";',
      "",
      "const { Workflow, Task, UI, smithers, outputs } = createSmithers({",
      "  result: z.object({ ok: z.boolean() }),",
      "});",
      "",
      "export default smithers(() => (",
      `  <Workflow name=\"${key}\">`,
      ...(declareUi ? [`    <UI entry=\"../ui/${key}.tsx\" title=\"${label}\" />`] : []),
      '    <Task id="done" output={outputs.result}>{{ ok: true }}</Task>',
      "  </Workflow>",
      "));",
      "",
    ].join("\n"),
  );
  repo.write(
    `${root}/ui/${key}.tsx`,
    [
      "/** @jsxImportSource react */",
      'import { createGatewayReactRoot } from "smthrs/gateway-react";',
      "",
      `createGatewayReactRoot(<main>${label}</main>);`,
      "",
    ].join("\n"),
  );
}

async function stopGatewayOnPort(port) {
  const result = spawnSync("lsof", ["-ti", `tcp:${port}`], {
    encoding: "utf8",
  });
  const pids = (result.stdout ?? "")
    .split(/\s+/)
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (pids.length === 0) return;
  await waitFor(
    () =>
      pids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
    2_000,
  ).catch(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
}

function spawnSmithers(args, options) {
  const child = spawn(process.execPath, ["run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
  children.add({ child, closePromise });
  return { child, closePromise };
}

async function startWorkspaceGateway(repo, port, env) {
  const { child, closePromise } = spawnSmithers(["gateway", "--port", String(port)], { cwd: repo.dir, env });
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
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(
        `Gateway exited before becoming ready. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
      );
    }
    return fetch(`${base}/health`).then(
      (response) => response.ok,
      () => false,
    );
  });
  return {
    base,
    child,
    closePromise,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function runSmithersAsync(args, options) {
  const { child, closePromise } = spawnSmithers([...args, "--format", options.format ?? "json"], options);
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
  const exitCode = await closePromise;
  return {
    exitCode,
    stdout,
    stderr,
    json: options.format === null ? undefined : parseEnvelope(stdout),
  };
}

// In --format json the CLI prints the structured envelope as the final JSON
// value on stdout (human-readable lines go to stderr). Parse the LAST balanced
// JSON object on stdout rather than slicing from the first "{": that stays
// correct even if a future change prints a leading log line on stdout, instead
// of throwing an opaque "Unexpected EOF".
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

async function waitFor(predicate, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for condition");
}

describe("smithers ui", () => {
  test("resolves the latest run to its workflow UI and prints a deep link", async () => {
    const repo = createTempRepo();
    const gateway = await startFakeGateway((method, params) => {
      if (method === "listWorkflows") {
        return rpcResponse([{ key: "alpha", hasUi: true, uiPath: "/ui/alpha" }]);
      }
      if (method === "listRuns") {
        return rpcResponse([{ runId: "run-latest", workflowKey: "alpha" }]);
      }
      throw new Error(`Unexpected RPC ${method} ${JSON.stringify(params)}`);
    });
    try {
      const result = await runSmithersAsync(["ui", "--gateway", gateway.base, "--no-open"], {
        cwd: repo.dir,
        format: "json",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`"url": "${gateway.base}/ui/alpha?runId=run-latest"`);
      expect(result.json).toMatchObject({
        opened: false,
        url: `${gateway.base}/ui/alpha?runId=run-latest`,
        runId: "run-latest",
        workflow: "alpha",
      });
      expect(gateway.requests.map((request) => request.method)).toEqual(["health", "listWorkflows", "listRuns"]);
    } finally {
      await gateway.close();
    }
  }, 30_000);

  test("resolves an explicit run through getRun before opening its workflow UI", async () => {
    const repo = createTempRepo();
    const gateway = await startFakeGateway((method, params) => {
      if (method === "listWorkflows") {
        return rpcResponse([{ key: "beta", hasUi: true, uiPath: "/ui/beta" }]);
      }
      if (method === "getRun") {
        expect(params).toEqual({ runId: "run-explicit" });
        return rpcResponse({ runId: "run-explicit", workflowKey: "beta" });
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    try {
      const result = await runSmithersAsync(["ui", "run-explicit", "--gateway", gateway.base, "--no-open"], {
        cwd: repo.dir,
        format: "json",
      });
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        opened: false,
        url: `${gateway.base}/ui/beta?runId=run-explicit`,
        runId: "run-explicit",
        workflow: "beta",
      });
      expect(gateway.requests.map((request) => request.method)).toEqual(["health", "listWorkflows", "getRun"]);
    } finally {
      await gateway.close();
    }
  }, 30_000);

  test("fails instead of opening another workflow UI when the run workflow is unavailable", async () => {
    const repo = createTempRepo();
    const gateway = await startFakeGateway((method, params) => {
      if (method === "listWorkflows") {
        return rpcResponse([{ key: "audit", hasUi: true, uiPath: "/workflows/audit" }]);
      }
      if (method === "getRun") {
        expect(params).toEqual({ runId: "run-late" });
        return rpcResponse({
          runId: "run-late",
          workflowKey: "audit",
          workflowName: "workflow",
          workflowPath: "/workspace/.smithers/workflows/tdsweep-land.tsx",
          configJson: "{}",
        });
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    try {
      const result = await runSmithersAsync(["ui", "run-late", "--gateway", gateway.base, "--no-open"], {
        cwd: repo.dir,
        format: "json",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.json).toMatchObject({ code: "NO_UI" });
      expect(result.json?.message).toContain("tdsweep-land");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("/workflows/audit?runId=run-late");
    } finally {
      await gateway.close();
    }
  }, 30_000);

  test("a running gateway discovers and serves workflow UIs authored after startup", async () => {
    const repo = createTempRepo();
    writeWorkflowWithUi(repo, "audit", "Audit UI");
    const { env } = makeStateDirEnv();
    const port = await findOpenPort();
    const gateway = await startWorkspaceGateway(repo, port, env);

    writeWorkflowWithUi(repo, "tdsweep-land", "TDSweep Land UI", false);
    repo.write(".smithers/workflows/broken-late.tsx", 'throw new Error("broken late workflow");\n');

    const lateUi = await fetch(`${gateway.base}/workflows/tdsweep-land`);
    expect(lateUi.status).toBe(200);
    expect(await lateUi.text()).toContain('"workflowKey":"tdsweep-land"');
    const lateAsset = await fetch(`${gateway.base}/workflows/tdsweep-land/__smithers_ui/client.js`);
    expect(lateAsset.status).toBe(200);

    const brokenUi = await fetch(`${gateway.base}/workflows/broken-late`);
    expect(brokenUi.status).toBe(404);
    await waitFor(
      () =>
        gateway.stderr().includes("Skipping workflow broken-late") && gateway.stderr().includes("broken late workflow"),
    );
    const health = await fetch(`${gateway.base}/health`);
    expect(health.status).toBe(200);
  }, 60_000);

  test("ui resolves a late-authored run without falling back to an older workflow", async () => {
    const repo = createTempRepo();
    writeWorkflowWithUi(repo, "audit", "Audit UI");
    const { env } = makeStateDirEnv();
    const port = await findOpenPort();
    const gateway = await startWorkspaceGateway(repo, port, env);

    writeWorkflowWithUi(repo, "tdsweep-land", "TDSweep Land UI", false);
    const run = await runSmithersAsync(
      ["up", ".smithers/workflows/tdsweep-land.tsx", "--run-id", "run-late-authored"],
      {
        cwd: repo.dir,
        env,
        format: "json",
      },
    );
    if (run.exitCode !== 0) {
      throw new Error(
        `Late-authored fixture run failed. stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`,
      );
    }

    const result = await runSmithersAsync(
      ["ui", "run-late-authored", "--port", String(port), "--no-autostart", "--no-open"],
      {
        cwd: repo.dir,
        env,
        format: "json",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      opened: false,
      url: `${gateway.base}/workflows/tdsweep-land?runId=run-late-authored`,
      runId: "run-late-authored",
      workflow: "tdsweep-land",
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("/workflows/audit?runId=run-late-authored");
  }, 60_000);

  test("ui registers an explicit-path run's workflow from its recorded entry file (#1474)", async () => {
    const repo = createTempRepo();
    writeWorkflowWithUi(repo, "audit", "Audit UI");
    // Authored OUTSIDE every registry dir: only the run row knows the entry file.
    writeWorkflowWithUi(repo, "gtm-leads", "GTM Leads UI", true, "src");
    const { env } = makeStateDirEnv();
    const port = await findOpenPort();
    const gateway = await startWorkspaceGateway(repo, port, env);

    const run = await runSmithersAsync(["up", "src/workflows/gtm-leads.tsx", "--run-id", "run-explicit-path"], {
      cwd: repo.dir,
      env,
      format: "json",
    });
    if (run.exitCode !== 0) {
      throw new Error(
        `Explicit-path fixture run failed. stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`,
      );
    }

    const result = await runSmithersAsync(
      ["ui", "run-explicit-path", "--port", String(port), "--no-autostart", "--no-open"],
      {
        cwd: repo.dir,
        env,
        format: "json",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      opened: false,
      url: `${gateway.base}/workflows/gtm-leads?runId=run-explicit-path`,
      runId: "run-explicit-path",
      workflow: "gtm-leads",
    });
    const ui = await fetch(`${gateway.base}/workflows/gtm-leads`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('"workflowKey":"gtm-leads"');
  }, 60_000);

  test("emits a JSON error envelope when no Gateway is reachable and autostart is disabled", async () => {
    const repo = createTempRepo();
    const port = await findOpenPort();
    const result = runSmithers(["ui", "--port", String(port), "--no-autostart"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toBe("");
    const envelope = result.json;
    expect(envelope).toMatchObject({
      code: "GATEWAY_UNREACHABLE",
    });
    expect(envelope.message).toContain("No Smithers Gateway reachable for this workspace");
    expect(envelope.message).toContain("smithers gateway");
  }, 30_000);

  test("hands the browser a session URL when a state-file token protects the gateway", async () => {
    const repo = createTempRepo();
    repo.write(".smithers/smithers.config.ts", "export default {};\n");
    const token = "state-file-token";
    const gateway = await startFakeGateway(
      (method) => {
        if (method === "listWorkflows") {
          return rpcResponse([{ key: "alpha", hasUi: true, uiPath: "/ui/alpha" }]);
        }
        throw new Error(`Unexpected RPC ${method}`);
      },
      {
        bearer: token,
        identity: { workspaceRoot: repo.dir, backend: "sqlite", version: "test", pid: process.pid, startedAtMs: 1 },
      },
    );
    const { env } = makeStateDirEnv();
    const stateEnv = { ...process.env, ...env };
    try {
      writeGatewayRuntimeState(
        repo.dir,
        {
          pid: process.pid,
          host: "127.0.0.1",
          port: Number(new URL(gateway.base).port),
          url: gateway.base,
          token,
          workspaceRoot: canonicalWorkspacePath(repo.dir),
          backend: "sqlite",
          version: "0.0.0-test",
          protocol: 1,
          startedAtMs: Date.now(),
        },
        stateEnv,
      );
      const result = await runSmithersAsync(["ui", "--workflow", "alpha", "--no-open"], {
        cwd: repo.dir,
        format: "json",
        env,
      });
      expect(result.exitCode).toBe(0);
      const printed = new URL(result.json.url);
      expect(printed.pathname).toBe("/v1/auth/session");
      expect(printed.searchParams.get("token")).toBe(token);
      expect(printed.searchParams.get("next")).toBe("/ui/alpha");
      expect(result.json).toMatchObject({
        opened: false,
        workflow: "alpha",
      });
      expect(gateway.requests.find((request) => request.method === "listWorkflows")?.authorization).toBe(
        `Bearer ${token}`,
      );
    } finally {
      await gateway.close();
    }
  }, 30_000);

  test("autostart failure surfaces the gateway stderr tail instead of waiting for timeout", async () => {
    const repo = createTempRepo();
    seedLegacySqliteStore(repo);
    const { stateDir, env } = makeStateDirEnv();
    const port = await findOpenPort();
    const startedAt = Date.now();
    const result = runSmithers(["ui", "--workflow", "legacy", "--port", String(port), "--no-open"], {
      cwd: repo.dir,
      format: "json",
      env: { ...env, SMITHERS_BACKEND: "pglite" },
      timeoutMs: 20_000,
    });
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).not.toBe(143);
    expect(result.json?.code).toBe("GATEWAY_UNREACHABLE");
    expect(result.json?.message).toContain("Autostarted gateway exited before it became reachable");
    expect(result.json?.message).toContain("exit code");
    expect(result.json?.message).toContain("Gateway autostart log:");
    expect(result.json?.message).toContain(
      gatewayRuntimePaths(repo.dir, { ...process.env, SMITHERS_GATEWAY_STATE_DIR: stateDir }).logFile,
    );
    expect(result.json?.message).toContain("Last gateway stderr:");
    expect(result.json?.message).toContain("SMITHERS_MIGRATION_REQUIRED");
  }, 30_000);

  test("autostarts a local Gateway when no Gateway is already listening", async () => {
    const repo = createTempRepo();
    repo.write(
      ".smithers/workflows/basic.tsx",
      [
        "/** @jsxImportSource smthrs */",
        'import { createSmithers, Workflow, Task, UI } from "smthrs";',
        'import { z } from "zod";',
        "",
        "const { smithers, outputs } = createSmithers({",
        "  result: z.object({ ok: z.boolean() }),",
        "});",
        "",
        "export default smithers(() => (",
        '  <Workflow name="basic">',
        '    <UI entry="../ui/basic.tsx" title="Basic UI" />',
        '    <Task id="write-result" output={outputs.result}>{{ ok: true }}</Task>',
        "  </Workflow>",
        "));",
        "",
      ].join("\n"),
    );
    repo.write(
      ".smithers/ui/basic.tsx",
      [
        'import React from "react";',
        "",
        "export default function BasicUi() {",
        "  return <main>Basic UI</main>;",
        "}",
        "",
      ].join("\n"),
    );
    const port = await findOpenPort();
    try {
      const { child, closePromise } = spawnSmithers(
        ["ui", "--workflow", "basic", "--port", String(port), "--no-open", "--format", "json"],
        { cwd: repo.dir },
      );
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
      const exitCode = await Promise.race([closePromise, waitFor(() => stdout.includes("/ui/basic")).then(() => 0)]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("No gateway for");
      expect(stderr).toContain("starting one (smithers gateway)");
      expect(stdout).toContain(`http://127.0.0.1:${port}/workflows/basic`);
      const envelope = parseEnvelope(stdout);
      expect(envelope).toMatchObject({
        opened: false,
        url: `http://127.0.0.1:${port}/workflows/basic`,
        runId: null,
        workflow: "basic",
      });
    } finally {
      await stopGatewayOnPort(port);
    }
  }, 45_000);

  test("read-only commands and ui tolerate a jj-conflicted workspace package.json", async () => {
    const repo = createTempRepo();
    seedConflictedWorkspace(repo);
    const { stateDir, env } = makeStateDirEnv();
    const port = await findOpenPort();
    try {
      for (const args of [
        ["ps", "--backend", "sqlite"],
        ["inspect", "cli-ui-conflicted-run", "--backend", "sqlite"],
        ["output", "cli-ui-conflicted-run", "done"],
        ["memory", "list"],
      ]) {
        const result = await runSmithersAsync(args, {
          cwd: repo.dir,
          env,
          format: "json",
        });
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("contains unresolved jj conflict markers");
        // (bun 1.3.x itself prints a non-fatal "Unsupported syntax" resolver
        // complaint for the conflicted package.json; the smithers contract is
        // the warning above, exit 0, and intact output.)
      }

      const result = await runSmithersAsync(["ui", "cli-ui-conflicted-run", "--port", String(port), "--no-open"], {
        cwd: repo.dir,
        env,
        format: "json",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("contains unresolved jj conflict markers");
      // (bun 1.3.x itself prints a non-fatal "Unsupported syntax" resolver
      // complaint for the conflicted package.json; the smithers contract is
      // the warning above, exit 0, and intact output.)
      expect(result.json).toMatchObject({
        opened: false,
        url: `http://127.0.0.1:${port}/workflows/basic?runId=cli-ui-conflicted-run`,
        runId: "cli-ui-conflicted-run",
        workflow: "basic",
      });

      const uiUrl = new URL(result.json.url);
      const asset = await fetch(`${uiUrl.origin}${uiUrl.pathname}/__smithers_ui/client.js`, {
        signal: AbortSignal.timeout(30_000),
      });
      expect(asset.status).toBe(200);

      const { logFile } = gatewayRuntimePaths(repo.dir, {
        ...process.env,
        SMITHERS_GATEWAY_STATE_DIR: stateDir,
      });
      const gatewayLog = readFileSync(logFile, "utf8");
      expect(gatewayLog).toContain("contains unresolved jj conflict markers");
      expect(gatewayLog).toContain("Registered workflows: basic");
      // (bun 1.3.x's own resolver prints a non-fatal "Unsupported syntax"
      // complaint for the conflicted package.json; the contract is the
      // warning plus a fully registered gateway.)
    } finally {
      await stopGatewayOnPort(port);
    }
  }, 60_000);
});
