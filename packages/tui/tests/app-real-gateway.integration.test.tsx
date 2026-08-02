/** @jsxImportSource @opentui/react */
import { afterEach, expect, it, setDefaultTimeout } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { type ReactNode } from "react";
import { act } from "react";
import { useRenderer as useOpenTuiRenderer } from "@opentui/react";
import type { CliRenderer } from "@opentui/core";
import { SmithersGatewayClient } from "@smthrs/gateway-client";
import { SmithersGatewayProvider } from "@smthrs/gateway-react";
import { describeHeadlessRender, renderForTest } from "./renderHelpers.tsx";
import { App } from "../src/App.tsx";
import { Keybindings } from "../src/Keybindings.tsx";
import { RendererProvider } from "../src/RendererContext.tsx";

setDefaultTimeout(120_000);

const smithersModulePath = "../../smithers/src/index.js";
const serverModulePath = "../../server/src/gateway.js";
const { createSmithers, approvalDecisionSchema, approvalSelectionSchema } = (await import(smithersModulePath)) as any;
const { Gateway } = (await import(serverModulePath)) as any;

type RealGatewayHarness = {
  api: any;
  gateway: any;
  baseUrl: string;
  dbPath: string;
  stop: () => Promise<void>;
};

const activeHarnesses: RealGatewayHarness[] = [];

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0).reverse()) {
    await harness.stop();
  }
});

function dbPathFor(name: string): string {
  return join(tmpdir(), `smithers-tui-real-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function portOf(server: import("node:http").Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Gateway server did not expose a port");
  return addr.port;
}

function completeWorkflow(api: any) {
  return api.smithers(() =>
    React.createElement(
      api.Workflow,
      { name: "tui-real-complete" },
      React.createElement(
        api.Sequence,
        null,
        React.createElement(api.Task, { id: "prepare-real", output: api.outputs.result }, {
          approved: true,
          note: "prepared",
          decidedBy: null,
          decidedAt: null,
        } as any),
        React.createElement(api.Task, { id: "ship-real", output: api.outputs.result }, {
          approved: true,
          note: "shipped",
          decidedBy: null,
          decidedAt: null,
        } as any),
      ),
    ),
  );
}

function approvalWorkflow(api: any) {
  return api.smithers((ctx: any) => {
    const selection = ctx.outputMaybe("selection", { nodeId: "pick-plan" });
    return React.createElement(
      api.Workflow,
      { name: "tui-real-approval" },
      React.createElement(
        api.Sequence,
        null,
        React.createElement(api.Task, { id: "prepare-approval", output: api.outputs.result }, {
          approved: true,
          note: "prepared",
          decidedBy: null,
          decidedAt: null,
        } as any),
        React.createElement(api.Approval, {
          id: "pick-plan",
          mode: "select",
          output: api.outputs.selection,
          request: {
            title: "Pick deployment color",
            summary: "Choose the rollout lane that the real gateway will persist.",
          },
          options: [
            { key: "light", label: "Light" },
            { key: "balanced", label: "Balanced" },
          ],
          allowedScopes: ["approve"],
          allowedUsers: ["user:tui"],
        }),
        selection
          ? React.createElement(api.Task, { id: "record-selection", output: api.outputs.result }, {
              approved: selection.selected === "balanced",
              note: selection.selected,
              decidedBy: null,
              decidedAt: null,
            } as any)
          : null,
      ),
    );
  });
}

async function startRealGateway(name: string): Promise<RealGatewayHarness> {
  const dbPath = dbPathFor(name);
  const api = createSmithers({ result: approvalDecisionSchema, selection: approvalSelectionSchema }, { dbPath });
  const gateway = new Gateway({
    outOfProcessEventBridgePollMs: 25,
    auth: {
      mode: "token",
      tokens: {
        "tui-token": { role: "admin", scopes: ["*"], userId: "user:tui" },
      },
    },
  });
  gateway.register("complete", completeWorkflow(api));
  gateway.register("approval", approvalWorkflow(api));
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  const harness = {
    api,
    gateway,
    baseUrl: `http://127.0.0.1:${portOf(server)}`,
    dbPath,
    async stop() {
      await gateway.close();
      api.db?.$client?.close?.();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    },
  };
  activeHarnesses.push(harness);
  return harness;
}

async function apiRequest(harness: RealGatewayHarness, method: string, path: string, body?: unknown) {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: {
      authorization: "Bearer tui-token",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { response, json };
}

async function launchRun(harness: RealGatewayHarness, workflow: string, runId: string): Promise<string> {
  const { response, json } = await apiRequest(harness, "POST", "/v1/api/runs", { workflow, runId, input: {} });
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  expect(json.data.runId).toBe(runId);
  return runId;
}

async function waitForRun(
  harness: RealGatewayHarness,
  runId: string,
  predicate: (row: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 240; i += 1) {
    const { response, json } = await apiRequest(harness, "GET", `/v1/api/runs/${encodeURIComponent(runId)}`);
    if (response.status === 200 && json.ok && json.data && predicate(json.data)) return json.data;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${runId}`);
}

async function waitForApproval(harness: RealGatewayHarness, runId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 240; i += 1) {
    const { response, json } = await apiRequest(harness, "GET", `/v1/api/approvals?runId=${encodeURIComponent(runId)}`);
    if (response.status === 200 && json.ok && Array.isArray(json.data) && json.data.length > 0) return json.data[0];
    await delay(25);
  }
  throw new Error(`Timed out waiting for approval on ${runId}`);
}

async function nodeOutput(
  harness: RealGatewayHarness,
  runId: string,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const { response, json } = await apiRequest(
    harness,
    "GET",
    `/v1/api/nodes/${encodeURIComponent(runId)}/${encodeURIComponent(nodeId)}/output`,
  );
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  return json.data;
}

function Harness({ gateway, children }: { gateway: RealGatewayHarness; children: ReactNode }) {
  const renderer = useOpenTuiRenderer();
  const client = new SmithersGatewayClient({ baseUrl: gateway.baseUrl, token: "tui-token" });
  return (
    <RendererProvider value={renderer as unknown as CliRenderer}>
      <Keybindings>
        <SmithersGatewayProvider client={client}>{children}</SmithersGatewayProvider>
      </Keybindings>
    </RendererProvider>
  );
}

async function renderApp(gateway: RealGatewayHarness, runId: string) {
  return await renderForTest(
    <Harness gateway={gateway}>
      <App runId={runId} onExit={() => {}} />
    </Harness>,
    { width: 140, height: 32 },
  );
}

async function waitForFrame(
  r: Awaited<ReturnType<typeof renderApp>>,
  needle: string | RegExp,
  tries = 160,
): Promise<string> {
  let frame = "";
  for (let i = 0; i < tries; i += 1) {
    await r.waitForVisualIdle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    frame = r.captureCharFrame();
    if (typeof needle === "string" ? frame.includes(needle) : needle.test(frame)) return frame;
  }
  return frame;
}

async function delay(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function press(r: Awaited<ReturnType<typeof renderApp>>, key: string) {
  act(() => {
    r.mockInput.pressKey(key as never);
  });
  await r.flush();
  await r.waitForVisualIdle();
}

async function focusApprovalBanner(r: Awaited<ReturnType<typeof renderApp>>): Promise<string> {
  let frame = "";
  for (let i = 0; i < 12; i += 1) {
    frame = await waitForFrame(r, /Pick deployment color|\[a\] approve/i, 20);
    if (/\[a\] approve/i.test(frame)) return frame;
    await press(r, "j");
  }
  throw new Error(`Approval banner never focused:\n${frame}`);
}

describeHeadlessRender("App – real gateway integration", () => {
  it("renders real gateway run state across tree, graph, logs, timeline, and help overlay", async () => {
    const gateway = await startRealGateway("complete");
    const runId = "run-tui-real-complete";
    await launchRun(gateway, "complete", runId);
    await waitForRun(gateway, runId, (row) => row.status === "finished");

    const r = await renderApp(gateway, runId);
    try {
      let frame = await waitForFrame(r, "prepare-real");
      expect(frame).toContain("tui-real-complete");
      expect(frame).toContain(runId);
      expect(frame).toContain("[finished]");

      await press(r, "g");
      frame = await waitForFrame(r, /GRAPH.+node/i);
      expect(frame).toContain("ship-real");

      await press(r, "l");
      frame = await waitForFrame(r, /LOGS \[live\]\s+[1-9]\d*\/\d+ events/);
      expect(frame).toMatch(/node|task|run/i);

      await press(r, "t");
      frame = await waitForFrame(r, "TIMELINE");
      expect(frame).toContain("prepare-real");

      await press(r, "?");
      frame = await waitForFrame(r, "Keybindings");
      expect(frame).toContain("Keybindings");
    } finally {
      r.renderer.destroy();
    }
  });

  it("resolves a real select approval from the tree inspector and persists the decision", async () => {
    const gateway = await startRealGateway("approval");
    const runId = "run-tui-real-approval";
    await launchRun(gateway, "approval", runId);
    const approval = await waitForApproval(gateway, runId);
    expect(approval.nodeId).toBe("pick-plan");

    const r = await renderApp(gateway, runId);
    try {
      await waitForFrame(r, "prepare-approval");
      const banner = await focusApprovalBanner(r);
      expect(banner).toContain("Pick deployment color");
      expect(banner).toContain("Light");
      expect(banner).toContain("Balanced");

      await press(r, "]");
      await press(r, "a");
      await waitForRun(gateway, runId, (row) => row.status === "finished");

      const output = await nodeOutput(gateway, runId, "pick-plan");
      expect(output.status).toBe("produced");
      expect((output.row as Record<string, unknown>).selected).toBe("balanced");

      const pending = await apiRequest(gateway, "GET", `/v1/api/approvals?runId=${encodeURIComponent(runId)}`);
      expect(pending.response.status).toBe(200);
      expect(pending.json.data).toEqual([]);
    } finally {
      r.renderer.destroy();
    }
  });
});
