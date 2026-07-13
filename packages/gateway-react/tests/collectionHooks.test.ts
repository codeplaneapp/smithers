// Drives every collection-backed gateway hook through React's real reconciler
// under happy-dom against a REAL in-memory Smithers gateway (sqlite). No hook
// logic is faked: the collections registry, the SSE stream, and the domain API
// are the genuine implementations. This is the "real provider backed by a real
// in-memory gateway" pattern the collection hooks are meant to be tested with.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try { GlobalRegistrator.register(); } catch { /* already registered */ }
(globalThis as { happyDOM?: { settings?: { fetch?: { disableSameOriginPolicy?: boolean } } } })
  .happyDOM!.settings!.fetch!.disableSameOriginPolicy = true;

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import React, { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";
import { Gateway } from "@smithers-orchestrator/server";
import { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import { createSmithers } from "smithers-orchestrator";
import {
  SmithersGatewayProvider,
  useGatewayActions,
  useGatewayApprovals,
  useGatewayConnectionStatus,
  useGatewayCrons,
  useGatewayMemoryFacts,
  useGatewayMutation,
  useGatewayNodeOutput,
  useGatewayPrompts,
  useGatewayRun,
  useGatewayRunEvents,
  useGatewayRunTree,
  useGatewayRuns,
  useGatewayScores,
  useGatewayTickets,
  useGatewayWorkflows,
  useSmithersCollections,
} from "../src/index.ts";

setDefaultTimeout(120_000);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void | boolean | Promise<void | boolean>, label = "assertion", timeoutMs = 20_000) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await assertion();
      if (result !== false) return;
    } catch (error) {
      lastError = error;
    }
    await act(async () => {
      await sleep(25);
    });
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out waiting for: ${label}`);
}

function getPort(server: import("node:http").Server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Gateway server did not expose a port");
  return addr.port;
}

function makeDbPath(name: string) {
  return join(mkdtempSync(join(tmpdir(), `gwreact-collhooks-${name}-`)), "store.db");
}

async function bootGateway() {
  const schemas = { result: z.object({ value: z.number() }) };
  const dbPath = makeDbPath("sqlite");
  const api = createSmithers(schemas, { dbPath });
  cleanups.push(async () => {
    try {
      api.db.$client?.run?.("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    await api.db.$client?.close?.();
    try {
      rmSync(dirname(dbPath), { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    } catch {}
  });
  const gateway = new Gateway({
    auth: {
      mode: "token",
      tokens: { "operator-token": { role: "admin", scopes: ["*"], userId: "user:operator" } },
    },
  });
  gateway.register("value", api.smithers((ctx: any) =>
    React.createElement(
      api.Workflow,
      { name: "collections-value" },
      React.createElement(api.Task, { id: "task1", output: api.outputs.result }, { value: Number(ctx.input.value ?? 1) }),
    ),
  ));
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => gateway.close());
  return { baseUrl: `http://127.0.0.1:${getPort(server)}` };
}

function makeClient(baseUrl: string) {
  return new SmithersGatewayClient({ baseUrl, token: "operator-token", fetch: Bun.fetch });
}

async function launchRun(baseUrl: string, value: number) {
  const response = await fetch(`${baseUrl}/v1/api/runs`, {
    method: "POST",
    headers: { authorization: "Bearer operator-token", "content-type": "application/json" },
    body: JSON.stringify({ workflow: "value", input: { value } }),
  });
  const json = await response.json();
  expect(response.status).toBe(200);
  return String(json.data.runId);
}

type Harness = {
  render: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
};

async function mountHarness(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  return {
    render: async (element) => {
      await act(async () => {
        root.render(element);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("collection-backed gateway hooks over a real in-memory gateway", () => {
  test("keeps run event results stable across renders without new collection data", async () => {
    const { baseUrl } = await bootGateway();
    const runId = await launchRun(baseUrl, 3);
    const captured: { events?: any; rerender?: () => void } = {};

    function Probe() {
      const [renderCount, setRenderCount] = React.useState(0);
      captured.events = useGatewayRunEvents(runId).events;
      captured.rerender = () => setRenderCount((count) => count + 1);
      // Keep the state update observable to React while avoiding an unused
      // state variable in the regression harness.
      return createElement("span", { "data-render-count": renderCount });
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client: makeClient(baseUrl) }, createElement(Probe)));
    await waitFor(() => (captured.events?.length ?? 0) > 0, "run events");

    const firstEvents = captured.events;
    await act(async () => {
      captured.rerender!();
    });

    expect(captured.events).toBe(firstEvents);
    await harness.unmount();
  });

  test("every collection hook loads real data, refetches, and exposes the actions surface", async () => {
    const { baseUrl } = await bootGateway();
    const runId = await launchRun(baseUrl, 3);

    const captured: Record<string, any> = {};

    function Probe() {
      captured.collections = useSmithersCollections();
      captured.connection = useGatewayConnectionStatus();
      captured.runs = useGatewayRuns();
      captured.run = useGatewayRun(runId);
      captured.runDisabled = useGatewayRun(undefined);
      captured.runEvents = useGatewayRunEvents(runId, { maxEvents: 500 });
      captured.runEventsAfter = useGatewayRunEvents(runId, { afterSeq: 0 });
      captured.runEventsDisabled = useGatewayRunEvents(undefined);
      captured.runTree = useGatewayRunTree(runId);
      captured.runTreeDisabled = useGatewayRunTree(undefined);
      captured.approvals = useGatewayApprovals({ filter: { runId } });
      captured.crons = useGatewayCrons();
      captured.memoryFacts = useGatewayMemoryFacts();
      captured.memoryFactsNs = useGatewayMemoryFacts("some-namespace");
      captured.prompts = useGatewayPrompts();
      captured.scores = useGatewayScores(runId);
      captured.scoresNode = useGatewayScores(runId, "task1");
      captured.tickets = useGatewayTickets();
      captured.workflows = useGatewayWorkflows();
      captured.nodeOutput = useGatewayNodeOutput({ runId, nodeId: "task1", iteration: 0 });
      captured.nodeOutputDisabled = useGatewayNodeOutput({ runId: undefined, nodeId: undefined });
      captured.actions = useGatewayActions();
      captured.mutation = useGatewayMutation("launchRun");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client: makeClient(baseUrl) }, createElement(Probe)));

    // The runs collection should surface the launched run.
    await waitFor(() => (captured.runs.data as any[]).some((row) => row.runId === runId), "runs list");
    expect((captured.runs.data as any[]).some((row) => row.runId === runId)).toBe(true);

    // The single-run collection resolves the run row (getRun + streamRunEvents).
    await waitFor(() => captured.run.data?.runId === runId, "run row");
    expect(captured.run.data?.runId).toBe(runId);
    // The disabled variant stays empty and not loading.
    expect(captured.runDisabled.data).toBeUndefined();
    expect(captured.runDisabled.loading).toBe(false);

    // The workflows collection lists the registered workflow.
    await waitFor(() => (captured.workflows.data as any[]).some((row) => row.key === "value"), "workflows list");

    // Run events arrive from the real SSE-backed collection.
    await waitFor(() => captured.runEvents.events.length > 0, "run events");
    expect(captured.runEvents.streaming).toBe(true);
    expect(captured.runEventsDisabled.streaming).toBe(false);
    expect(captured.runEventsDisabled.events).toEqual([]);

    // The run tree assembles nodes from the devtools snapshot.
    await waitFor(() => captured.runTree.nodes.length > 0, "run tree nodes");
    expect(captured.runTree.root).not.toBeNull();
    expect(captured.runTreeDisabled.nodes).toEqual([]);
    expect(captured.runTreeDisabled.root).toBeNull();

    // Node output: the hook fetched once on mount (before task1 existed → the
    // real "Node not found" error path). Once the run completes, an explicit
    // refetch resolves the produced output (the success path).
    await waitFor(() => captured.run.data?.status === "finished", "run finished");
    await act(async () => { await captured.nodeOutput.refetch(); });
    await waitFor(() => captured.nodeOutput.loading === false && captured.nodeOutput.data !== undefined, "node output settled");
    expect(captured.nodeOutput.data).toMatchObject({ status: "produced", row: { value: 3 } });
    expect(captured.nodeOutputDisabled.loading).toBe(false);

    // The read-only / empty collections still expose a stable async-state shape.
    for (const key of ["approvals", "crons", "memoryFacts", "memoryFactsNs", "prompts", "scores", "scoresNode", "tickets"]) {
      expect(Array.isArray(captured[key].data)).toBe(true);
      expect(typeof captured[key].refetch).toBe("function");
    }

    // Connection status reflects the live transport.
    expect(["idle", "connecting", "online", "offline", "unauthorized"]).toContain(captured.connection.status);

    // refetch() re-pulls each collection (invalidate round-trips through the client).
    await act(async () => {
      await Promise.all([
        captured.runs.refetch(),
        captured.run.refetch(),
        captured.runDisabled.refetch(),
        captured.approvals.refetch(),
        captured.crons.refetch(),
        captured.memoryFacts.refetch(),
        captured.memoryFactsNs.refetch(),
        captured.prompts.refetch(),
        captured.scores.refetch(),
        captured.scoresNode.refetch(),
        captured.tickets.refetch(),
        captured.workflows.refetch(),
      ]);
    });
    await act(async () => {
      await captured.nodeOutputDisabled.refetch();
    });

    // The full action surface: launchRun succeeds; the rest are invoked so every
    // action closure executes (rejections on the finished/absent targets are
    // expected and swallowed — the point is that each closure runs).
    const actions = captured.actions;
    const launched = await actions.launchRun({ workflow: "value", input: { value: 7 } });
    expect(launched.runId).toBeDefined();
    const swallow = async (p: Promise<unknown>) => { try { await p; } catch { /* expected */ } };
    await swallow(actions.resumeRun({ runId }));
    await swallow(actions.cancelRun({ runId }));
    await swallow(actions.hijackRun({ runId }));
    await swallow(actions.rewindRun({ runId, frameNo: 1, confirm: true }));
    await swallow(actions.submitApproval({ runId, nodeId: "task1", decision: { approved: true } }));
    await swallow(actions.submitSignal({ runId, correlationKey: "sig" }));
    await swallow(actions.cronCreate({ workflow: "value", pattern: "* * * * *" }));
    await swallow(actions.cronRun({ workflow: "value" }));
    await swallow(actions.cronDelete({ cronId: "does-not-exist" }));
    await swallow(actions.createTicket({ kind: "ticket", title: "t", body: "b" } as any));
    await swallow(actions.updateTicket({ id: "missing", patch: {} } as any));
    await swallow(actions.deleteTicket({ id: "missing" } as any));

    await harness.unmount();
  });

  test("useGatewayMutation dispatches every domain method and reports the default/error path", async () => {
    const { baseUrl } = await bootGateway();

    const hooks: Record<string, any> = {};
    function Probe() {
      hooks.launchRun = useGatewayMutation("launchRun", { invalidate: ["runs"] });
      hooks.resumeRun = useGatewayMutation("resumeRun");
      hooks.cancelRun = useGatewayMutation("cancelRun");
      hooks.hijackRun = useGatewayMutation("hijackRun");
      hooks.rewindRun = useGatewayMutation("rewindRun");
      hooks.submitApproval = useGatewayMutation("submitApproval");
      hooks.submitSignal = useGatewayMutation("submitSignal");
      hooks.cronCreate = useGatewayMutation("cronCreate");
      hooks.cronDelete = useGatewayMutation("cronDelete");
      hooks.cronRun = useGatewayMutation("cronRun");
      hooks.createTicket = useGatewayMutation("createTicket");
      hooks.updateTicket = useGatewayMutation("updateTicket");
      hooks.deleteTicket = useGatewayMutation("deleteTicket");
      hooks.bogus = useGatewayMutation("nopeNotAMethod");
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client: makeClient(baseUrl) }, createElement(Probe)));

    // launchRun mutate() succeeds end to end (covers the success + invalidate path).
    let launchResult: any;
    await act(async () => {
      launchResult = await hooks.launchRun.mutate({ workflow: "value", input: { value: 5 } });
    });
    expect(launchResult.runId).toBeDefined();
    expect(hooks.launchRun.isLoading).toBe(false);
    expect(hooks.launchRun.error).toBeUndefined();

    // Every remaining domain method dispatches through the switch (rejections on
    // absent targets are expected; the switch arm still executes).
    const methods = ["resumeRun", "cancelRun", "hijackRun", "rewindRun", "submitApproval", "submitSignal", "cronCreate", "cronDelete", "cronRun", "createTicket", "updateTicket", "deleteTicket"];
    for (const method of methods) {
      await act(async () => {
        try { await hooks[method].mutate({ runId: "missing", cronId: "x", frameNo: 1, confirm: true, workflow: "value", pattern: "* * * * *", correlationKey: "k", nodeId: "n", decision: { approved: true }, kind: "ticket", title: "t", body: "b", id: "x", patch: {} }); } catch { /* expected */ }
      });
    }

    // An unsupported method rejects with a clear error via mutate().
    let bogusError: unknown;
    await act(async () => {
      try { await hooks.bogus.mutate({}); } catch (error) { bogusError = error; }
    });
    expect((bogusError as Error).message).toContain("Unsupported Gateway domain mutation: nopeNotAMethod");
    expect(hooks.bogus.error).toBeInstanceOf(Error);

    // mutateSafe swallows the same failure and resolves to undefined.
    let safeResult: unknown = "sentinel";
    await act(async () => {
      safeResult = await hooks.bogus.mutateSafe({});
    });
    expect(safeResult).toBeUndefined();

    await harness.unmount();
  });

  test("useGatewayNodeOutput surfaces an error from the domain API", async () => {
    const { baseUrl } = await bootGateway();
    const runId = await launchRun(baseUrl, 1);

    let snapshot: any;
    function Probe() {
      // A node id that never produced output → the domain API rejects.
      snapshot = useGatewayNodeOutput({ runId, nodeId: "does-not-exist", iteration: 0 });
      return null;
    }
    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client: makeClient(baseUrl) }, createElement(Probe)));

    await waitFor(() => snapshot.loading === false && snapshot.error !== undefined, "node output error");
    expect(snapshot.error).toBeInstanceOf(Error);
    expect(snapshot.data).toBeUndefined();

    // Calling refetch() while the params are disabled hits the early-return arm.
    let disabled: any;
    function DisabledProbe() {
      disabled = useGatewayNodeOutput({ runId: undefined, nodeId: undefined });
      return null;
    }
    await harness.render(createElement(SmithersGatewayProvider, { client: makeClient(baseUrl) }, createElement(DisabledProbe)));
    await act(async () => {
      await disabled.refetch();
    });
    expect(disabled.loading).toBe(false);
    expect(disabled.data).toBeUndefined();

    await harness.unmount();
  });
});
