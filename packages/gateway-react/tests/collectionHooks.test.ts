// Drives every collection-backed gateway hook through React's real reconciler
// under happy-dom against a REAL in-memory Smithers gateway (sqlite). No hook
// logic is faked: the collections registry, the SSE stream, and the domain API
// are the genuine implementations. This is the "real provider backed by a real
// in-memory gateway" pattern the collection hooks are meant to be tested with.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  /* already registered */
}
(
  globalThis as { happyDOM?: { settings?: { fetch?: { disableSameOriginPolicy?: boolean } } } }
).happyDOM!.settings!.fetch!.disableSameOriginPolicy = true;

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import React, { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";
import { Gateway, type GatewayTokenGrant } from "@smithers-orchestrator/server";
import { SmithersDb } from "@smithers-orchestrator/db";
import { SmithersGatewayClient, type SmithersDataClient } from "@smithers-orchestrator/gateway-client";
import { createSmithers } from "smithers-orchestrator";
import {
  SmithersCollectionsProvider,
  SmithersGatewayProvider,
  useGatewayActions,
  useGatewayApprovals,
  SmithersCollectionsContext,
  useGatewayConnectionStatus,
  useGatewayCrons,
  useGatewayMemoryFacts,
  useGatewayMutation,
  useGatewayNodeEvents,
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

async function waitFor(
  assertion: () => void | boolean | Promise<void | boolean>,
  label = "assertion",
  timeoutMs = 60_000,
) {
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
  const tokens: Record<string, GatewayTokenGrant> = {
    "operator-token": { role: "admin", scopes: ["*"], userId: "user:operator" },
  };
  const gateway = new Gateway({
    auth: {
      mode: "token",
      tokens,
    },
  });
  gateway.register(
    "value",
    api.smithers((ctx: any) =>
      React.createElement(
        api.Workflow,
        { name: "collections-value" },
        React.createElement(
          api.Task,
          { id: "task1", output: api.outputs.result },
          { value: Number(ctx.input.value ?? 1) },
        ),
      ),
    ),
  );
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => gateway.close());
  return {
    baseUrl: `http://127.0.0.1:${getPort(server)}`,
    api,
    grantToken(token: string) {
      tokens[token] = { role: "admin", scopes: ["*"], userId: `user:${token}` };
    },
  };
}

function makeClient(baseUrl: string, token = "operator-token") {
  return new SmithersGatewayClient({ baseUrl, token, fetch: Bun.fetch });
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
  test("keeps collection refetch callbacks stable across equal inline params", async () => {
    const { baseUrl } = await bootGateway();
    const captured: Record<string, any> = {};

    function Probe() {
      const [renderCount, setRenderCount] = React.useState(0);
      captured.approvals = useGatewayApprovals({ filter: { runId: "r1" } }).refetch;
      captured.runs = useGatewayRuns({}).refetch;
      captured.crons = useGatewayCrons({}).refetch;
      captured.tickets = useGatewayTickets({}).refetch;
      captured.workflows = useGatewayWorkflows({}).refetch;
      captured.rerender = () => setRenderCount((count) => count + 1);
      return createElement("span", { "data-render-count": renderCount });
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client: makeClient(baseUrl) }, createElement(Probe)));

    const firstRefetches = {
      approvals: captured.approvals,
      runs: captured.runs,
      crons: captured.crons,
      tickets: captured.tickets,
      workflows: captured.workflows,
    };
    await act(async () => {
      captured.rerender();
    });

    expect(captured.approvals).toBe(firstRefetches.approvals);
    expect(captured.runs).toBe(firstRefetches.runs);
    expect(captured.crons).toBe(firstRefetches.crons);
    expect(captured.tickets).toBe(firstRefetches.tickets);
    expect(captured.workflows).toBe(firstRefetches.workflows);
    await harness.unmount();
  });

  test("useGatewayNodeOutput refetches when matching work finishes", async () => {
    const runId = "event-invalidated-output";
    const nodeId = "task1";
    let produced = false;
    let eventRows: Array<{ runId: string; seq: number; event: string; payload: unknown }> = [];
    let eventCalls = 0;
    const outputCalls: Array<{ runId: string; nodeId: string; iteration?: number }> = [];
    const streamListeners = new Set<(event: { type: "change"; seq: number; collections: string[] }) => void>();
    const streamStatus = { status: "online" as const };
    const client = {
      mode: { kind: "local", apiBaseUrl: "http://gateway.test" },
      api: {
        getNodeOutput: async (params: { runId: string; nodeId: string; iteration?: number }) => {
          outputCalls.push(params);
          return produced ? { status: "produced", row: { value: 42 } } : { status: "pending" };
        },
        listRunEvents: async ({ afterSeq }: { afterSeq?: number }) => {
          eventCalls += 1;
          return eventRows.filter((row) => afterSeq === undefined || row.seq > afterSeq);
        },
      },
      stream: {
        subscribe(listener: (event: { type: "change"; seq: number; collections: string[] }) => void) {
          streamListeners.add(listener);
          return () => streamListeners.delete(listener);
        },
        subscribeStatus() {
          return () => {};
        },
        status: () => streamStatus,
        waitForSeq: async () => {},
      },
      close() {},
    } as unknown as SmithersDataClient;
    let snapshot: ReturnType<typeof useGatewayNodeOutput> | undefined;

    function Probe() {
      snapshot = useGatewayNodeOutput({ runId, nodeId, iteration: 0 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersCollectionsProvider, { client }, createElement(Probe)));
    await waitFor(() => snapshot?.data?.status === "pending", "initial pending node output");
    expect(outputCalls).toEqual([{ runId, nodeId, iteration: 0 }]);

    eventRows = [
      {
        runId,
        seq: 1,
        event: "NodeFinished",
        payload: { runId, nodeId: "other-task", iteration: 0 },
      },
    ];
    await act(async () => {
      for (const listener of streamListeners) {
        listener({ type: "change", seq: 1, collections: ["run_events", "node_outputs"] });
      }
    });
    await waitFor(() => eventCalls >= 2, "non-matching event cursor");
    expect(outputCalls).toHaveLength(1);

    produced = true;
    eventRows = [
      ...eventRows,
      {
        runId,
        seq: 2,
        event: "run.event",
        payload: {
          event: "node.finished",
          seq: 2,
          payload: { runId, nodeId, iteration: 0 },
        },
      },
    ];
    await act(async () => {
      for (const listener of streamListeners) {
        listener({ type: "change", seq: 2, collections: ["run_events", "node_outputs"] });
      }
    });

    await waitFor(() => snapshot?.data?.status === "produced", "event-invalidated node output");
    expect(snapshot?.data).toEqual({ status: "produced", row: { value: 42 } });
    expect(outputCalls).toEqual([
      { runId, nodeId, iteration: 0 },
      { runId, nodeId, iteration: 0 },
    ]);
    await harness.unmount();
  });

  test("useGatewayNodeOutput seeds invalidation from the shared run-event tail", async () => {
    const runId = "long-output-run";
    const nodeId = "task1";
    let produced = false;
    let eventRows = Array.from({ length: 2_501 }, (_, seq) => ({
      runId,
      seq,
      event: "OtherEvent",
      payload: { runId },
    }));
    const eventRequests: Array<{ afterSeq?: number; limit?: number }> = [];
    const outputCalls: Array<{ runId: string; nodeId: string; iteration?: number }> = [];
    const streamListeners = new Set<(event: { type: "change"; seq: number; collections: string[] }) => void>();
    const client = {
      mode: { kind: "local", apiBaseUrl: "http://gateway.test" },
      api: {
        getNodeOutput: async (params: { runId: string; nodeId: string; iteration?: number }) => {
          outputCalls.push(params);
          return produced ? { status: "produced" } : { status: "pending" };
        },
        listRunEvents: async (params: { afterSeq?: number; limit?: number }) => {
          eventRequests.push(params);
          return eventRows
            .filter((row) => params.afterSeq === undefined || row.seq > params.afterSeq)
            .slice(0, params.limit);
        },
      },
      stream: {
        subscribe(listener: (event: { type: "change"; seq: number; collections: string[] }) => void) {
          streamListeners.add(listener);
          return () => streamListeners.delete(listener);
        },
        subscribeStatus() {
          return () => {};
        },
        status: () => ({ status: "online" as const }),
        waitForSeq: async () => {},
      },
      close() {},
    } as unknown as SmithersDataClient;
    let snapshot: ReturnType<typeof useGatewayNodeOutput> | undefined;

    function Probe() {
      snapshot = useGatewayNodeOutput({ runId, nodeId });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersCollectionsProvider, { client }, createElement(Probe)));
    await waitFor(
      () => eventRequests.some((request) => request.afterSeq === 1_476 && request.limit === 1_024),
      "shared event tail",
    );
    expect(eventRequests.filter((request) => request.afterSeq === undefined)).toEqual([{ runId, limit: 1_024 }]);

    produced = true;
    eventRows = [...eventRows, { runId, seq: 2_501, event: "NodeFinished", payload: { runId, nodeId, iteration: 0 } }];
    await act(async () => {
      for (const listener of streamListeners) {
        listener({ type: "change", seq: 2_501, collections: ["run_events"] });
      }
    });

    await waitFor(() => snapshot?.data?.status === "produced", "tail-invalidated node output");
    expect(eventRequests.some((request) => request.afterSeq === 2_500 && request.limit === 1_000)).toBe(true);
    expect(outputCalls).toHaveLength(2);
    await harness.unmount();
  });

  test("useGatewayNodeOutput refetches when a change lands while the event tail is still loading", async () => {
    // A stream change that arrives during the seed preload may reference an
    // event at or before the seeded cursor, which the queued re-scan cannot
    // see — the hook must refetch the output once to cover that gap.
    let resolvePreload!: () => void;
    const preloadGate = new Promise<void>((resolve) => {
      resolvePreload = resolve;
    });
    let outputCalls = 0;
    const streamListeners = new Set<(event: { type: "change"; seq: number; collections: string[] }) => void>();
    const client = {
      api: {
        getNodeOutput: async () => {
          outputCalls += 1;
          return { status: "produced", calls: outputCalls };
        },
        listRunEvents: async () => [],
      },
      stream: {
        subscribe(listener: (event: { type: "change"; seq: number; collections: string[] }) => void) {
          streamListeners.add(listener);
          return () => streamListeners.delete(listener);
        },
      },
    } as unknown as SmithersDataClient;
    const collections = {
      connect() {},
      runEvents: () => ({ preload: () => preloadGate, toArray: [{ seq: 42 }] }),
    } as any;
    let snapshot: ReturnType<typeof useGatewayNodeOutput> | undefined;

    function Probe() {
      snapshot = useGatewayNodeOutput({ runId: "run-1", nodeId: "task-a", iteration: 0 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(
        SmithersCollectionsContext.Provider,
        { value: { client, collections, queryClient: {} as any } },
        createElement(Probe),
      ),
    );
    await waitFor(() => snapshot?.data !== undefined, "initial node output");
    expect(outputCalls).toBe(1);

    await act(async () => {
      for (const listener of streamListeners) {
        listener({ type: "change", seq: 42, collections: ["run_events"] });
      }
    });
    // The change queued behind the in-flight seed; resolving the preload must
    // trigger exactly one catch-up refetch, not a full-history event scan.
    await act(async () => {
      resolvePreload();
    });
    await waitFor(() => outputCalls === 2, "seed-gap refetch");
    expect(outputCalls).toBe(2);
    await harness.unmount();
  });

  test("useGatewayNodeOutput hides the previous node's row while the next node loads", async () => {
    let resolveNext!: (value: Record<string, unknown>) => void;
    const nextOutput = new Promise<Record<string, unknown>>((resolve) => {
      resolveNext = resolve;
    });
    const client = {
      api: {
        getNodeOutput: async ({ nodeId }: { nodeId: string }) =>
          nodeId === "task-a" ? { status: "produced", row: { value: "a" } } : nextOutput,
        listRunEvents: async () => [],
      },
      stream: {
        subscribe: () => () => {},
      },
    } as unknown as SmithersDataClient;
    const collections = {
      connect() {},
      runEvents: () => ({ preload: async () => {}, toArray: [] }),
    } as any;
    let snapshot: ReturnType<typeof useGatewayNodeOutput> | undefined;

    function Probe({ nodeId }: { nodeId: string }) {
      snapshot = useGatewayNodeOutput({ runId: "run-1", nodeId, iteration: 0 });
      return null;
    }

    const harness = await mountHarness();
    const renderProbe = (nodeId: string) =>
      createElement(
        SmithersCollectionsContext.Provider,
        { value: { client, collections, queryClient: {} as any } },
        createElement(Probe, { nodeId }),
      );
    await harness.render(renderProbe("task-a"));
    await waitFor(() => snapshot?.data?.row !== undefined, "first node output");

    await harness.render(renderProbe("task-b"));
    expect(snapshot?.data).toBeUndefined();

    await act(async () => {
      resolveNext({ status: "produced", row: { value: "b" } });
    });
    await waitFor(() => snapshot?.data?.row !== undefined, "second node output");
    expect(snapshot?.data).toEqual({ status: "produced", row: { value: "b" } });
    await harness.unmount();
  });

  test("useGatewayNodeOutput retains data during a matching-key refetch", async () => {
    let calls = 0;
    let resolveRefetch!: (value: Record<string, unknown>) => void;
    const refetchedOutput = new Promise<Record<string, unknown>>((resolve) => {
      resolveRefetch = resolve;
    });
    const client = {
      api: {
        getNodeOutput: async () => {
          calls += 1;
          return calls === 1 ? { status: "produced", row: { value: 1 } } : refetchedOutput;
        },
        listRunEvents: async () => [],
      },
      stream: {
        subscribe: () => () => {},
      },
    } as unknown as SmithersDataClient;
    const collections = {
      connect() {},
      runEvents: () => ({ preload: async () => {}, toArray: [] }),
    } as any;
    let snapshot: ReturnType<typeof useGatewayNodeOutput> | undefined;

    function Probe() {
      snapshot = useGatewayNodeOutput({ runId: "run-1", nodeId: "task-a", iteration: 0 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(
        SmithersCollectionsContext.Provider,
        { value: { client, collections, queryClient: {} as any } },
        createElement(Probe),
      ),
    );
    await waitFor(() => snapshot?.data?.row !== undefined, "initial node output");

    let refetch!: Promise<void>;
    await act(async () => {
      refetch = snapshot!.refetch();
      await Promise.resolve();
    });
    expect(snapshot?.data).toEqual({ status: "produced", row: { value: 1 } });

    await act(async () => {
      resolveRefetch({ status: "produced", row: { value: 2 } });
      await refetch;
    });
    expect(snapshot?.data).toEqual({ status: "produced", row: { value: 2 } });
    await harness.unmount();
  });

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

  test("keeps buffered run events when the stream disconnects", async () => {
    const runId = "buffered-offline-events";
    const rows = [{ runId, seq: 1, event: "NodeStarted", payload: { nodeId: "task1" } }];
    const statusListeners = new Set<() => void>();
    let streamStatus: ReturnType<SmithersDataClient["stream"]["status"]> = { status: "online" };
    const client = {
      mode: { kind: "local", apiBaseUrl: "http://gateway.test" },
      api: {
        listRunEvents: async () => rows,
      },
      stream: {
        subscribe() {
          return () => {};
        },
        subscribeStatus(listener: () => void) {
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
        status: () => streamStatus,
        waitForSeq: async () => {},
      },
      close() {},
    } as unknown as SmithersDataClient;
    let snapshot: ReturnType<typeof useGatewayRunEvents> | undefined;

    function Probe() {
      snapshot = useGatewayRunEvents(runId);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersCollectionsProvider, { client }, createElement(Probe)));
    await waitFor(() => snapshot?.events.length === 1, "buffered run event");
    const bufferedEvents = snapshot!.events;

    await act(async () => {
      streamStatus = { status: "offline" };
      for (const listener of statusListeners) listener();
    });

    expect(snapshot?.error?.message).toBe("Run event stream failed.");
    expect(snapshot?.events).toBe(bufferedEvents);
    expect(snapshot?.events[0]?.event).toBe("NodeStarted");
    await harness.unmount();
  });

  test("keeps node events stable across empty polls and merges new rows by sequence", async () => {
    const runId = "stable-node-events";
    const nodeId = "task1";
    let calls = 0;
    let pendingRows: Array<{ runId: string; seq: number; event: string; payload: unknown }> = [
      { runId, seq: 2, event: "NodeOutput", payload: { nodeId, text: "old" } },
      { runId, seq: 1, event: "NodeStarted", payload: { nodeId } },
      { runId, seq: 2, event: "NodeOutput", payload: { nodeId, text: "latest" } },
    ];
    const client = {
      api: {
        listRunEvents: async () => {
          calls += 1;
          const rows = pendingRows;
          pendingRows = [];
          return rows;
        },
      },
    } as unknown as SmithersDataClient;
    const collections = { connect() {} } as any;
    let snapshot: ReturnType<typeof useGatewayNodeEvents> | undefined;

    function Probe() {
      snapshot = useGatewayNodeEvents(runId, nodeId, { pollIntervalMs: 25 });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(
        SmithersCollectionsContext.Provider,
        { value: { client, collections, queryClient: {} as any } },
        createElement(Probe),
      ),
    );
    await waitFor(() => snapshot?.events.length === 2, "initial node events");
    expect(snapshot?.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(snapshot?.events[1]?.payload).toEqual({ nodeId, text: "latest" });

    const stableEvents = snapshot?.events;
    await waitFor(() => calls >= 2, "empty node event poll");
    expect(snapshot?.events).toBe(stableEvents);

    pendingRows = [
      { runId, seq: 4, event: "NodeFinished", payload: { nodeId } },
      { runId, seq: 3, event: "NodeOutput", payload: { nodeId, text: "first" } },
      { runId, seq: 3, event: "NodeOutput", payload: { nodeId, text: "replacement" } },
    ];
    await waitFor(() => snapshot?.events.length === 4, "incremental node events");
    expect(snapshot?.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(snapshot?.events[2]?.payload).toEqual({ nodeId, text: "replacement" });
    expect(snapshot?.events).not.toBe(stableEvents);
    await harness.unmount();
  });

  test("filters heartbeats by default and opts into ordered, capped heartbeat rows over HTTP", async () => {
    const { api, baseUrl } = await bootGateway();
    const db = new SmithersDb(api.db);
    const runId = "heartbeat-contract";
    const now = Date.now();
    await db.insertRun({ runId, workflowName: "value", status: "running", createdAtMs: now });
    for (const [index, event] of [
      "run.started",
      "run.heartbeat",
      "task.heartbeat",
      "TaskHeartbeat",
      "node.finished",
    ].entries()) {
      await db.insertEventWithNextSeq({
        runId,
        timestampMs: now + index,
        type: event,
        payloadJson: JSON.stringify({ event, index }),
      });
    }
    const captured: Record<string, any> = {};
    function Probe() {
      captured.default = useGatewayRunEvents(runId, { maxEvents: 10 });
      captured.included = useGatewayRunEvents(runId, {
        afterSeq: 1,
        maxEvents: 3,
        includeHeartbeats: true,
      });
      return null;
    }
    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client: makeClient(baseUrl) }, createElement(Probe)));
    await waitFor(() => captured.included?.events?.length === 3, "heartbeat event rows");
    expect(captured.default.events.map((frame: any) => frame.event)).toEqual(["run.started", "node.finished"]);
    expect(captured.default.lastHeartbeat?.event).toBe("TaskHeartbeat");
    expect(captured.included.events.map((frame: any) => frame.event)).toEqual([
      "task.heartbeat",
      "TaskHeartbeat",
      "node.finished",
    ]);
    expect(captured.included.lastHeartbeat?.event).toBe("TaskHeartbeat");
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
      captured.nodeEvents = useGatewayNodeEvents(runId, "task1", { pollIntervalMs: 25 });
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
    await waitFor(() => captured.nodeEvents.events.length > 0, "node-filtered events");
    // The isolation contract is "no OTHER node's events leak through the
    // server-side filter" — some node-scoped event payloads carry their id
    // nested (or not at all), so assert on foreign ids, and list any
    // offenders in the failure output.
    const foreignNodeEvents = captured.nodeEvents.events.filter((event: any) => {
      const eventNodeId = event.payload?.nodeId ?? event.payload?.payload?.nodeId;
      return eventNodeId !== undefined && eventNodeId !== "task1";
    });
    expect(foreignNodeEvents).toEqual([]);
    expect(captured.runEventsDisabled.streaming).toBe(false);
    expect(captured.runEventsDisabled.events).toEqual([]);

    // The run tree assembles nodes from the devtools snapshot.
    await waitFor(() => captured.runTree.nodes.length > 0, "run tree nodes");
    expect(captured.runTree.root).not.toBeNull();
    expect(captured.runTreeDisabled.nodes).toEqual([]);
    expect(captured.runTreeDisabled.root).toBeNull();

    // Node output: the hook fetched once on mount (before task1 existed → the
    // real "Node not found" error path). The matching completion event
    // automatically refetches the produced output.
    await waitFor(() => captured.run.data?.status === "finished", "run finished");
    await waitFor(
      () => captured.nodeOutput.loading === false && captured.nodeOutput.data !== undefined,
      "node output settled",
    );
    expect(captured.nodeOutput.data).toMatchObject({ status: "produced", row: { value: 3 } });
    expect(captured.nodeOutputDisabled.loading).toBe(false);

    // The read-only / empty collections still expose a stable async-state shape.
    for (const key of [
      "approvals",
      "crons",
      "memoryFacts",
      "memoryFactsNs",
      "prompts",
      "scores",
      "scoresNode",
      "tickets",
    ]) {
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
    const swallow = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* expected */
      }
    };
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

  test("collection async states surface real endpoint failures and refetch recovers", async () => {
    const { baseUrl, grantToken } = await bootGateway();
    const runId = await launchRun(baseUrl, 11);
    const captured: Record<string, any> = {};

    function Probe() {
      captured.runs = useGatewayRuns();
      captured.run = useGatewayRun(runId);
      captured.approvals = useGatewayApprovals({ filter: { runId } });
      captured.crons = useGatewayCrons();
      captured.memoryFacts = useGatewayMemoryFacts();
      captured.prompts = useGatewayPrompts();
      captured.scores = useGatewayScores(runId);
      captured.tickets = useGatewayTickets();
      captured.workflows = useGatewayWorkflows();
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(SmithersGatewayProvider, { client: makeClient(baseUrl, "recover-token") }, createElement(Probe)),
    );

    const keys = ["runs", "run", "approvals", "crons", "memoryFacts", "prompts", "scores", "tickets", "workflows"];
    await waitFor(
      () => keys.every((key) => captured[key]?.loading === false && captured[key]?.error instanceof Error),
      "collection load errors",
    );
    for (const key of keys) {
      expect(captured[key].error).toBeInstanceOf(Error);
    }
    expect(captured.runs.data).toEqual([]);
    expect(captured.run.data).toBeUndefined();

    grantToken("recover-token");
    await act(async () => {
      await Promise.all(keys.map((key) => captured[key].refetch()));
    });

    await waitFor(
      () => keys.every((key) => captured[key]?.loading === false && captured[key]?.error === undefined),
      "collection refetch recovery",
    );
    expect(captured.run.data?.runId).toBe(runId);
    expect((captured.runs.data as any[]).some((row) => row.runId === runId)).toBe(true);
    expect((captured.workflows.data as any[]).some((row) => row.key === "value")).toBe(true);

    await harness.unmount();
  });

  test("useGatewayRunEvents surfaces and recovers from its source fetch failure", async () => {
    const { baseUrl, grantToken } = await bootGateway();
    const runId = await launchRun(baseUrl, 11);
    const captured: Record<string, any> = {};

    function Probe() {
      captured.collections = useSmithersCollections();
      captured.runEvents = useGatewayRunEvents(runId);
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(
        SmithersGatewayProvider,
        { client: makeClient(baseUrl, "run-events-recover-token") },
        createElement(Probe),
      ),
    );

    await waitFor(
      () =>
        captured.runEvents?.error instanceof Error &&
        captured.runEvents.error.message !== "Run event stream failed." &&
        captured.runEvents?.streaming === false,
      "run event source fetch failure",
    );
    expect(captured.runEvents.events).toEqual([]);
    expect(captured.runEvents.error.message).not.toBe("Run event stream failed.");

    grantToken("run-events-recover-token");
    await act(async () => {
      await captured.collections.collections.invalidate(["runEvents"]);
    });

    await waitFor(
      () => captured.runEvents?.error === undefined && captured.runEvents?.events.length > 0,
      "run event source fetch recovery",
    );
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
    const methods = [
      "resumeRun",
      "cancelRun",
      "hijackRun",
      "rewindRun",
      "submitApproval",
      "submitSignal",
      "cronCreate",
      "cronDelete",
      "cronRun",
      "createTicket",
      "updateTicket",
      "deleteTicket",
    ];
    for (const method of methods) {
      await act(async () => {
        try {
          await hooks[method].mutate({
            runId: "missing",
            cronId: "x",
            frameNo: 1,
            confirm: true,
            workflow: "value",
            pattern: "* * * * *",
            correlationKey: "k",
            nodeId: "n",
            decision: { approved: true },
            kind: "ticket",
            title: "t",
            body: "b",
            id: "x",
            patch: {},
          });
        } catch {
          /* expected */
        }
      });
    }

    // An unsupported method rejects with a clear error via mutate().
    let bogusError: unknown;
    await act(async () => {
      try {
        await hooks.bogus.mutate({});
      } catch (error) {
        bogusError = error;
      }
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

  test("useGatewayMutation scopes invalidation to the configured collections", async () => {
    const invalidations: Array<readonly string[] | undefined> = [];
    const client = {
      api: {
        launchRun: async () => ({ data: { runId: "run-1" } }),
      },
    } as any;
    const collections = {
      connect() {},
      invalidate: async (names?: readonly string[]) => {
        invalidations.push(names);
      },
    } as any;
    const captured: { mutation?: any } = {};

    function Probe() {
      captured.mutation = useGatewayMutation("launchRun", { invalidate: ["runs"] });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(
        SmithersCollectionsContext.Provider,
        { value: { client, collections, queryClient: {} as any } },
        createElement(Probe),
      ),
    );

    await act(async () => {
      await captured.mutation!.mutate({ workflow: "value", input: {} });
    });

    expect(invalidations).toEqual([["runs"]]);
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
    await harness.render(
      createElement(SmithersGatewayProvider, { client: makeClient(baseUrl) }, createElement(DisabledProbe)),
    );
    await act(async () => {
      await disabled.refetch();
    });
    expect(disabled.loading).toBe(false);
    expect(disabled.data).toBeUndefined();

    await harness.unmount();
  });
});
