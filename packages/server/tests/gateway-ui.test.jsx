/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, test } from "bun:test";
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

describe("Gateway UI", () => {
  let gateway;
  let tempDir;

  afterEach(async () => {
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

  test("operator console RPC endpoints return real data (behavioral)", async () => {
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

    const listWorkflowsRes = await postRpc(port, "listWorkflows");
    expect(listWorkflowsRes.status).toBe(200);
    const listWorkflowsBody = await listWorkflowsRes.json();
    expect(listWorkflowsBody.ok).toBe(true);
    const workflows = listWorkflowsBody.payload;
    expect(Array.isArray(workflows)).toBe(true);
    const wf = workflows.find((w) => w.key === "op-console-workflow");
    expect(wf).toBeDefined();
    expect(wf.key).toBe("op-console-workflow");

    const launchRes = await postRpc(port, "launchRun", {
      workflow: "op-console-workflow",
      input: {},
    });
    expect(launchRes.status).toBe(200);
    const launchBody = await launchRes.json();
    expect(launchBody.ok).toBe(true);
    const { runId } = launchBody.payload;
    expect(typeof runId).toBe("string");

    let run;
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await postRpc(port, "getRun", { runId });
      const body = await res.json();
      if (body.ok && (body.payload.status === "finished" || body.payload.status === "failed")) {
        run = body.payload;
        break;
      }
      await sleep(25);
    }
    expect(run).toBeDefined();
    expect(run.status).toBe("finished");
    expect(run.workflowKey).toBe("op-console-workflow");

    const listRunsRes = await postRpc(port, "listRuns");
    expect(listRunsRes.status).toBe(200);
    const listRunsBody = await listRunsRes.json();
    expect(listRunsBody.ok).toBe(true);
    expect(Array.isArray(listRunsBody.payload)).toBe(true);
    const listedRun = listRunsBody.payload.find((r) => r.runId === runId);
    expect(listedRun).toBeDefined();

    const listApprovalsRes = await postRpc(port, "listApprovals");
    expect(listApprovalsRes.status).toBe(200);
    const listApprovalsBody = await listApprovalsRes.json();
    expect(listApprovalsBody.ok).toBe(true);
    expect(Array.isArray(listApprovalsBody.payload)).toBe(true);
  });

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
