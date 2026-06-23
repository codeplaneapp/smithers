/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { Gateway } from "../src/gateway.js";
import { sleep } from "../../smithers/tests/helpers.js";

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Gateway server did not expose a port");
  }
  return addr.port;
}

function createValueWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers(
    { result: z.object({ ok: z.boolean() }) },
    { dbPath },
  );
  return smithers(() => (
    <Workflow name="gateway-ui-test">
      <Task id="task1" output={outputs.result}>{{ ok: true }}</Task>
    </Workflow>
  ));
}

function writeUiEntry(dir, label) {
  const entry = join(dir, "ui.jsx");
  writeFileSync(
    entry,
    [
      'import { createElement } from "react";',
      'import { createRoot } from "react-dom/client";',
      `createRoot(document.getElementById("root")).render(createElement("main", null, ${JSON.stringify(label)}));`,
    ].join("\n"),
  );
  return entry;
}

async function postRpc(port, method, body = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitFor(assertion, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  throw lastError;
}

describe("Gateway UI", () => {
  let gateway;
  let tempDir;
  let domRegistered = false;
  let cleanupDomRuntime = null;

  afterEach(async () => {
    if (cleanupDomRuntime) {
      cleanupDomRuntime();
      cleanupDomRuntime = null;
    }
    if (domRegistered) {
      await GlobalRegistrator.unregister();
      domRegistered = false;
    }
    if (gateway) {
      await gateway.close();
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    gateway = undefined;
    tempDir = undefined;
  });

  test("serves a gateway-level React UI and bundled asset", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-gateway-ui-"));
    const entry = writeUiEntry(tempDir, "Gateway Console");
    gateway = new Gateway({
      ui: {
        entry,
        path: "/console",
        title: "Operations Console",
        props: { section: "ops" },
      },
    });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const htmlResponse = await fetch(`http://127.0.0.1:${port}/console`);
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain("<title>Operations Console</title>");
    expect(html).toContain('"kind":"gateway"');
    expect(html).toContain('"mountPath":"/console"');
    expect(html).toContain('"section":"ops"');
    expect(html).toContain('/console/__smithers_ui/client.js');

    const assetResponse = await fetch(`http://127.0.0.1:${port}/console/__smithers_ui/client.js`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("content-type")).toContain("text/javascript");
    expect(await assetResponse.text()).toContain("Gateway Console");
  });

  test("serves the built-in operator console by default", async () => {
    gateway = new Gateway();
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const htmlResponse = await fetch(`http://127.0.0.1:${port}/console`);
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain("<title>Smithers Operator Console</title>");
    expect(html).toContain('"kind":"operator"');
    expect(html).toContain('"mountPath":"/console"');
    expect(html).toContain('/console/__smithers_ui/client.js');

    const assetResponse = await fetch(`http://127.0.0.1:${port}/console/__smithers_ui/client.js`);
    expect(assetResponse.status).toBe(200);
    const asset = await assetResponse.text();
    expect(() => new Function(asset)).not.toThrow();
    expect(asset).toContain("Smithers Console");
    expect(asset).toContain("Run Chronicle");
    expect(asset).toContain("sessionStorage");
    expect(asset).not.toContain("localStorage");
    expect(asset).toContain('rpc("listWorkflows"');
    expect(asset).toContain('rpc("listRuns"');
    expect(asset).toContain('rpc("listApprovals"');
    expect(asset).toContain('rpc("launchRun"');
    expect(asset).toContain('rpc("submitApproval"');
    expect(asset).toContain('rpcSocket("getNodeOutput"');
    expect(asset).toContain('rpcSocket("getNodeDiff"');
    expect(asset).toContain('"streamDevTools"');
    expect(asset).toContain('"streamRunEvents"');
    expect(asset).toContain("new WebSocket");
  });

  test("serves the built-in operator console from ui=true without a custom bundle", async () => {
    gateway = new Gateway({ ui: true });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const htmlResponse = await fetch(`http://127.0.0.1:${port}/console`);
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain("<title>Smithers Operator Console</title>");
    expect(html).toContain('"kind":"operator"');
    expect(html).toContain('"mountPath":"/console"');
    expect(html).toContain('/console/__smithers_ui/client.js');

    const assetResponse = await fetch(`http://127.0.0.1:${port}/console/__smithers_ui/client.js`);
    expect(assetResponse.status).toBe(200);
    const asset = await assetResponse.text();
    expect(asset).toContain("Smithers Console");
    expect(asset).toContain("listWorkflows");
    expect(asset).toContain("submitApproval");
    expect(asset).not.toContain("localStorage");
  });

  test("requires bearer auth for the built-in operator console when gateway auth is configured", async () => {
    gateway = new Gateway({
      ui: true,
      auth: {
        mode: "token",
        tokens: {
          "operator-token": {
            role: "operator",
            scopes: ["*"],
            userId: "user:operator",
          },
        },
      },
    });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const anonymous = await fetch(`http://127.0.0.1:${port}/console`);
    expect(anonymous.status).toBe(401);

    const authorized = await fetch(`http://127.0.0.1:${port}/console`, {
      headers: { authorization: "Bearer operator-token" },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toContain("<title>Smithers Operator Console</title>");

    const asset = await fetch(`http://127.0.0.1:${port}/console/__smithers_ui/client.js`, {
      headers: { authorization: "Bearer operator-token" },
    });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("Smithers Console");
  });

  test("built-in operator console loads and launches a real run in the browser", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-op-console-behavioral-"));
    const dbPath = join(tempDir, "op.db");
    const { smithers, Workflow, Task, outputs } = createSmithers(
      { result: z.object({ ok: z.boolean() }) },
      { dbPath },
    );
    const workflow = smithers(() => (
      <Workflow name="op-console-workflow">
        <Task id="step1" output={outputs.result}>{{ ok: true }}</Task>
      </Workflow>
    ));

    gateway = new Gateway();
    gateway.register("op-console-workflow", workflow);
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const htmlResponse = await fetch(`http://127.0.0.1:${port}/console`);
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    const bootJson = html.match(/__SMITHERS_GATEWAY_UI__=(.*?);<\/script>/)?.[1];
    expect(bootJson).toBeDefined();

    const assetResponse = await fetch(`http://127.0.0.1:${port}/console/__smithers_ui/client.js`);
    expect(assetResponse.status).toBe(200);
    const asset = await assetResponse.text();

    GlobalRegistrator.register({ url: `http://127.0.0.1:${port}/console` });
    domRegistered = true;
    const intervals = new Set();
    const sockets = new Set();
    const nativeSetInterval = globalThis.setInterval;
    const nativeClearInterval = globalThis.clearInterval;
    const NativeWebSocket = globalThis.WebSocket;
    globalThis.setInterval = (...args) => {
      const id = nativeSetInterval(...args);
      intervals.add(id);
      return id;
    };
    globalThis.clearInterval = (id) => {
      intervals.delete(id);
      return nativeClearInterval(id);
    };
    globalThis.WebSocket = class TrackedWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        sockets.add(this);
        this.addEventListener("close", () => sockets.delete(this));
      }
    };
    cleanupDomRuntime = () => {
      for (const interval of intervals) {
        nativeClearInterval(interval);
      }
      intervals.clear();
      for (const socket of sockets) {
        socket.close();
      }
      sockets.clear();
      globalThis.setInterval = nativeSetInterval;
      globalThis.clearInterval = nativeClearInterval;
      globalThis.WebSocket = NativeWebSocket;
    };
    document.body.innerHTML = '<div id="root"></div>';
    globalThis.__SMITHERS_GATEWAY_UI__ = JSON.parse(bootJson);
    new Function(asset)();

    await waitFor(() => {
      expect(document.querySelector(".brand")?.textContent).toBe("Smithers Console");
      expect(document.querySelector("#workflow")?.value).toBe("op-console-workflow");
      expect(document.body.textContent).toContain("1 workflows");
      expect(document.body.textContent).toContain("0 approvals");
      expect(document.body.textContent).toContain("No runs found.");
    });

    document.querySelector("#launch").dispatchEvent(new Event("submit", {
      bubbles: true,
      cancelable: true,
    }));

    const runId = await waitFor(async () => {
      const listRunsResponse = await postRpc(port, "listRuns");
      expect(listRunsResponse.status).toBe(200);
      const listRunsBody = await listRunsResponse.json();
      expect(listRunsBody.ok).toBe(true);
      const run = listRunsBody.payload.find((entry) => entry.workflowKey === "op-console-workflow");
      expect(run).not.toBeUndefined();
      return run.runId;
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Run Chronicle");
      expect(document.body.textContent).toContain(runId);
      expect(document.body.textContent).toContain("op-console-workflow");
    });

    const getRunResponse = await postRpc(port, "getRun", { runId });
    expect(getRunResponse.status).toBe(200);
    const getRunBody = await getRunResponse.json();
    expect(getRunBody.ok).toBe(true);
    expect(getRunBody.payload.workflowKey).toBe("op-console-workflow");
  }, 15000);

  test("allows the built-in operator console to be disabled", async () => {
    gateway = new Gateway({ operatorUi: false });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const response = await fetch(`http://127.0.0.1:${port}/console`);
    expect(response.status).toBe(404);
  });

  test("serves a workflow-level UI and exposes UI metadata through listWorkflows", async () => {
    tempDir = mkdtempSync(join(process.cwd(), ".smithers-workflow-ui-"));
    const dbPath = join(tempDir, "workflow.db");
    const entry = writeUiEntry(tempDir, "Workflow Console");
    gateway = new Gateway();
    gateway.register("deploy", createValueWorkflow(dbPath), {
      ui: {
        entry,
        title: "Deploy Workflow",
        props: { workflowKind: "deploy" },
      },
    });
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    const port = getPort(server);

    const htmlResponse = await fetch(`http://127.0.0.1:${port}/workflows/deploy`);
    expect(htmlResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain("<title>Deploy Workflow</title>");
    expect(html).toContain('"kind":"workflow"');
    expect(html).toContain('"workflowKey":"deploy"');
    expect(html).toContain('"mountPath":"/workflows/deploy"');

    const listedResponse = await postRpc(port, "listWorkflows", { filter: { hasUi: true } });
    expect(listedResponse.status).toBe(200);
    const listed = await listedResponse.json();
    expect(listed.payload).toEqual([
      expect.objectContaining({
        key: "deploy",
        hasUi: true,
        uiPath: "/workflows/deploy",
      }),
    ]);
  });
});
