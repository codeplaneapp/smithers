import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  SmithersGatewayContext,
  SmithersGatewayProvider,
  createGatewayReactRoot,
  useGatewayActions,
  useGatewayNodeOutput,
  useGatewayRpc,
  useSmithersGateway,
} from "../src/index.ts";
import type { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";

function createSpyClient() {
  const calls: string[] = [];
  const client = {
    baseUrl: "http://gateway.test",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      return Response.json({ ok: true, data: { runId: "run-1", status: "ok" } });
    },
  } as unknown as SmithersGatewayClient;
  return { client, calls };
}

function createRpcClient() {
  const calls: unknown[] = [];
  const client = {
    rpc: (method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.resolve({ ok: true });
    },
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: `${init?.method ?? "GET"} ${url.pathname}`, params: Object.fromEntries(url.searchParams) });
      return Response.json({ ok: true, data: { ok: true } });
    },
    streamRunEvents: async function* () {},
    streamRunEventsResilient: async function* () {},
  } as unknown as SmithersGatewayClient;
  return { client, calls };
}

function createRejectingRpcClient(cause: unknown) {
  const calls: unknown[] = [];
  const client = {
    rpc: (method: string, params: unknown) => {
      calls.push({ method, params });
      return Promise.reject(cause);
    },
    streamRunEvents: async function* () {},
    streamRunEventsResilient: async function* () {},
  } as unknown as SmithersGatewayClient;
  return { client, calls };
}

describe("SmithersGatewayProvider", () => {
  test("provides an explicit client through context", () => {
    const { client } = createSpyClient();
    let observed: SmithersGatewayClient | null = null;

    renderToString(
      createElement(
        SmithersGatewayProvider,
        { client },
        createElement(SmithersGatewayContext.Consumer, {
          children: (value: SmithersGatewayClient | null) => {
            observed = value;
            return null;
          },
        }),
      ),
    );

    expect(observed).toBe(client);
  });
});

describe("createGatewayReactRoot", () => {
  test("throws when the configured root element is missing", () => {
    const global = globalThis as typeof globalThis & { document?: Document };
    const originalDocument = global.document;
    global.document = {
      getElementById: (id: string) => {
        expect(id).toBe("missing-root");
        return null;
      },
    } as unknown as Document;

    try {
      expect(() => createGatewayReactRoot(createElement("div"), { rootId: "missing-root" })).toThrow(
        "Gateway React root element not found: missing-root",
      );
    } finally {
      if (originalDocument) {
        global.document = originalDocument;
      } else {
        delete global.document;
      }
    }
  });
});

describe("useSmithersGateway", () => {
  test("throws a clear error outside the provider", () => {
    function Probe() {
      useSmithersGateway();
      return null;
    }

    expect(() => renderToString(createElement(Probe))).toThrow(
      "useSmithersGateway() must be used inside <SmithersGatewayProvider>.",
    );
  });
});

describe("useGatewayActions", () => {
  test("exposes write helpers for the full stable gateway action surface", async () => {
    const { client, calls } = createSpyClient();
    let actions: ReturnType<typeof useGatewayActions> | undefined;

    function Probe() {
      actions = useGatewayActions();
      return null;
    }

    renderToString(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));

    expect(actions).toBeDefined();
    await actions?.launchRun({ workflow: "deploy" });
    await actions?.resumeRun({ runId: "run-1" });
    await actions?.cancelRun({ runId: "run-1" });
    await actions?.hijackRun({ runId: "run-1" });
    await actions?.rewindRun({ runId: "run-1", frameNo: 1, confirm: true });
    await actions?.submitApproval({
      runId: "run-1",
      nodeId: "approve",
      decision: { approved: true },
    });
    await actions?.submitSignal({ runId: "run-1", correlationKey: "signal-1" });
    await actions?.cronCreate({ workflow: "deploy", pattern: "* * * * *" });
    await actions?.cronDelete({ cronId: "cron-1" });
    await actions?.cronRun({ workflow: "deploy" });

    expect(calls).toEqual([
      "POST /v1/api/runs",
      "POST /v1/api/runs/run-1/resume",
      "POST /v1/api/runs/run-1/cancel",
      "POST /v1/api/runs/run-1/hijack",
      "POST /v1/api/runs/run-1/rewind",
      "POST /v1/api/approvals/run-1%3Aapprove%3A0",
      "POST /v1/api/signals",
      "POST /v1/api/crons",
      "DELETE /v1/api/crons/cron-1",
      "POST /v1/api/crons/run",
    ]);
  });
});

describe("gateway query hooks", () => {
  test("shape RPC hook state during server render", () => {
    const { client } = createRpcClient();
    let enabledState: ReturnType<typeof useGatewayRpc<"listRuns">> | undefined;
    let disabledState: ReturnType<typeof useGatewayRpc<"getRun">> | undefined;

    function Probe() {
      enabledState = useGatewayRpc("listRuns", { limit: 5 });
      disabledState = useGatewayRpc("getRun", { runId: "" }, { enabled: false, deps: ["disabled"] });
      return null;
    }

    renderToString(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));

    expect(enabledState).toMatchObject({
      data: undefined,
      error: undefined,
      loading: true,
    });
    expect(disabledState).toMatchObject({
      data: undefined,
      error: undefined,
      loading: false,
    });
    expect(typeof enabledState?.refetch).toBe("function");
  });

  test("RPC refetch handles success, disabled state, and non-Error failures", async () => {
    const { client, calls } = createRpcClient();
    let enabledState: ReturnType<typeof useGatewayRpc<"listRuns">> | undefined;
    let disabledState: ReturnType<typeof useGatewayRpc<"getRun">> | undefined;

    function Probe() {
      enabledState = useGatewayRpc("listRuns", { limit: 2 });
      disabledState = useGatewayRpc("getRun", { runId: "run-disabled" }, { enabled: false });
      return null;
    }

    renderToString(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));

    await enabledState?.refetch();
    await disabledState?.refetch();
    expect(calls).toEqual([{ method: "listRuns", params: { limit: 2 } }]);

    const rejecting = createRejectingRpcClient("rpc exploded");
    let errorState: ReturnType<typeof useGatewayRpc<"listRuns">> | undefined;
    function ErrorProbe() {
      errorState = useGatewayRpc("listRuns", { limit: 1 });
      return null;
    }

    renderToString(createElement(SmithersGatewayProvider, { client: rejecting.client }, createElement(ErrorProbe)));
    await errorState?.refetch();
    expect(rejecting.calls).toEqual([{ method: "listRuns", params: { limit: 1 } }]);
  });

  // The collection-backed hooks and on-demand node output now run over the
  // Smithers domain API client.
  test("useGatewayNodeOutput reflects enabled / disabled state on the domain client", () => {
    const { client } = createRpcClient();
    const observed: Record<string, unknown> = {};

    function Probe() {
      observed.output = useGatewayNodeOutput({
        runId: "run-1",
        nodeId: "node-1",
        iteration: 3,
      });
      observed.disabledOutput = useGatewayNodeOutput({
        runId: undefined,
        nodeId: "node-1",
      });
      return null;
    }

    renderToString(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));

    expect(observed.output).toMatchObject({ loading: true });
    expect(observed.disabledOutput).toMatchObject({ loading: false });
  });

  test("useGatewayNodeOutput defaults iteration to zero", async () => {
    const { client, calls } = createRpcClient();
    let output: ReturnType<typeof useGatewayNodeOutput> | undefined;

    function Probe() {
      output = useGatewayNodeOutput({ runId: "run-1", nodeId: "ship" });
      return null;
    }

    renderToString(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));

    await output?.refetch();
    expect(calls).toEqual([{ method: "GET /v1/api/nodes/run-1/ship/output", params: { iteration: "0" } }]);
  });
});
