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
    launchRun: () => calls.push("launchRun"),
    resumeRun: () => calls.push("resumeRun"),
    cancelRun: () => calls.push("cancelRun"),
    hijackRun: () => calls.push("hijackRun"),
    rewindRun: () => calls.push("rewindRun"),
    submitApproval: () => calls.push("submitApproval"),
    submitSignal: () => calls.push("submitSignal"),
    cronCreate: () => calls.push("cronCreate"),
    cronDelete: () => calls.push("cronDelete"),
    cronRun: () => calls.push("cronRun"),
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

    renderToString(createElement(
      SmithersGatewayProvider,
      { client },
      createElement(SmithersGatewayContext.Consumer, {
        children: (value: SmithersGatewayClient | null) => {
          observed = value;
          return null;
        },
      }),
    ));

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
      expect(() =>
        createGatewayReactRoot(createElement("div"), { rootId: "missing-root" }),
      ).toThrow("Gateway React root element not found: missing-root");
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
  test("exposes write helpers for the full stable gateway action surface", () => {
    const { client, calls } = createSpyClient();
    let actions: ReturnType<typeof useGatewayActions> | undefined;

    function Probe() {
      actions = useGatewayActions();
      return null;
    }

    renderToString(createElement(SmithersGatewayProvider, { client }, createElement(Probe)));

    expect(actions).toBeDefined();
    actions?.launchRun({ workflow: "deploy" });
    actions?.resumeRun({ runId: "run-1" });
    actions?.cancelRun({ runId: "run-1" });
    actions?.hijackRun({ runId: "run-1" });
    actions?.rewindRun({ runId: "run-1", frameNo: 1, confirm: true });
    actions?.submitApproval({
      runId: "run-1",
      nodeId: "approve",
      decision: { approved: true },
    });
    actions?.submitSignal({ runId: "run-1", correlationKey: "signal-1" });
    actions?.cronCreate({ workflow: "deploy", pattern: "* * * * *" });
    actions?.cronDelete({ cronId: "cron-1" });
    actions?.cronRun({ workflow: "deploy" });

    expect(calls).toEqual([
      "launchRun",
      "resumeRun",
      "cancelRun",
      "hijackRun",
      "rewindRun",
      "submitApproval",
      "submitSignal",
      "cronCreate",
      "cronDelete",
      "cronRun",
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
      disabledState = useGatewayRpc(
        "getRun",
        { runId: "" },
        { enabled: false, deps: ["disabled"] },
      );
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

  // The collection-backed hooks (useGatewayRuns / useGatewayRun /
  // useGatewayApprovals / useGatewayWorkflows / useGatewayRunEvents) now run over
  // the `SyncProvider` registry — see `tests/sync/sync.test.ts`. The on-demand
  // node-output hook stays on the legacy `SmithersGatewayContext` client.
  test("useGatewayNodeOutput reflects enabled / disabled state on the legacy client", () => {
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
    expect(calls).toEqual([
      { method: "getNodeOutput", params: { runId: "run-1", nodeId: "ship", iteration: 0 } },
    ]);
  });
});
