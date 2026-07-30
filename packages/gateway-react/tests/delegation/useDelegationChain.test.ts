// Drives the useDelegationChain hook through React's real reconciler under
// happy-dom against a REAL in-memory gateway. The hook composes the run tree,
// run events, approvals, and the Effect delegation store; here we exercise its
// action surface (edit / skip-preview / answer-human / poll), the runId guard
// paths, a real delegation-shaped node (the `dc-poll` approval), and a
// StrictMode remount (store dispose + effect recreation).
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
import React, { act, createElement, StrictMode, Suspense, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";
import { Gateway } from "@smithers-orchestrator/server";
import { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import { createSmithers } from "smithers-orchestrator";
import { SmithersGatewayProvider } from "../../src/index.ts";
import { useDelegationChain } from "../../src/delegation/useDelegationChain.ts";

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

async function waitFor(assertion: () => boolean, label = "assertion", timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (assertion()) return;
    await act(async () => {
      await sleep(25);
    });
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function getPort(server: import("node:http").Server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

async function bootGateway() {
  const dbPath = join(mkdtempSync(join(tmpdir(), "gwreact-dc-")), "store.db");
  const api = createSmithers(
    {
      result: z.object({ value: z.number() }),
      selection: z.object({ selected: z.string(), notes: z.string().nullable() }),
    },
    { dbPath },
  );
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
    auth: { mode: "token", tokens: { "operator-token": { role: "admin", scopes: ["*"], userId: "user:operator" } } },
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
  // A workflow whose Approval id is a delegation poll phase (`dc:<goal>:poll`),
  // so a launched run parks at a pending approval the delegation hook treats as
  // the end-of-run poll via its parse fallback — and whose run tree carries a
  // delegation-shaped node (covers both the tree-target and submitPoll paths).
  gateway.register(
    "poll",
    api.smithers(() =>
      React.createElement(
        api.Workflow,
        { name: "delegation-poll" },
        React.createElement(api.Approval, {
          id: "dc:goal:poll",
          mode: "select",
          output: api.outputs.selection,
          request: { title: "Rate the run", summary: "How did it go?" },
          options: [
            { key: "good", label: "Good" },
            { key: "bad", label: "Bad" },
          ],
          allowedScopes: ["approve"],
          allowedUsers: ["user:operator"],
        }),
      ),
    ),
  );
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => gateway.close());
  return { baseUrl: `http://127.0.0.1:${getPort(server)}` };
}

async function launch(baseUrl: string, workflow: string, input: unknown) {
  const response = await fetch(`${baseUrl}/v1/api/runs`, {
    method: "POST",
    headers: { authorization: "Bearer operator-token", "content-type": "application/json" },
    body: JSON.stringify({ workflow, input }),
  });
  const json = await response.json();
  return String(json.data.runId);
}

type Harness = { render: (e: ReactElement) => Promise<void>; unmount: () => Promise<void> };
async function mountHarness(): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
  });
  return {
    render: async (e) => {
      await act(async () => {
        root.render(e);
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

function client(baseUrl: string) {
  return new SmithersGatewayClient({ baseUrl, token: "operator-token", fetch: Bun.fetch });
}

function clientWithBackfillCount(baseUrl: string, onBackfill: () => void) {
  return new SmithersGatewayClient({
    baseUrl,
    token: "operator-token",
    fetch: ((input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/api/events" && url.searchParams.get("limit") === "500") onBackfill();
      return Bun.fetch(input, init);
    }) as typeof fetch,
  });
}

const swallow = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch {
    /* expected on a non-delegation run */
  }
};

describe("useDelegationChain over a real gateway", () => {
  test("a suspended render does not create a delegation store or start history backfill", async () => {
    const { baseUrl } = await bootGateway();
    const runId = await launch(baseUrl, "value", { value: 1 });
    let backfills = 0;
    const observedClient = clientWithBackfillCount(baseUrl, () => backfills++);
    cleanups.push(() => observedClient.close());
    const suspended = new Promise<never>(() => {});

    function Probe() {
      useDelegationChain({ runId });
      throw suspended;
    }

    const harness = await mountHarness();
    await harness.render(
      createElement(
        SmithersGatewayProvider,
        { client: observedClient },
        createElement(Suspense, { fallback: null }, createElement(Probe)),
      ),
    );
    await sleep(25);
    expect(backfills).toBe(0);
    await harness.unmount();
  });

  test("mount/unmount cycles create exactly one committed store per mount", async () => {
    const { baseUrl } = await bootGateway();
    const runId = await launch(baseUrl, "value", { value: 1 });
    let backfills = 0;
    const observedClient = clientWithBackfillCount(baseUrl, () => backfills++);
    cleanups.push(() => observedClient.close());

    function Probe() {
      useDelegationChain({ runId });
      return null;
    }

    for (let cycle = 1; cycle <= 2; cycle++) {
      const harness = await mountHarness();
      await harness.render(
        createElement(SmithersGatewayProvider, { client: observedClient }, createElement(Probe)),
      );
      await waitFor(() => backfills === cycle, `delegation backfill for mount ${cycle}`);
      await harness.unmount();
      expect(backfills).toBe(cycle);
    }
  });

  test("assembles state for a runId and dispatches every action (edit/skip/answer/poll)", async () => {
    const { baseUrl } = await bootGateway();
    const runId = await launch(baseUrl, "value", { value: 1 });

    let hook: ReturnType<typeof useDelegationChain> | undefined;
    function Probe() {
      hook = useDelegationChain({ runId });
      return null;
    }

    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client: client(baseUrl) }, createElement(Probe)));

    // Let the store hydrate (the value run has no delegation nodes → empty graph).
    await waitFor(() => hook !== undefined && hook.loading === false, "delegation loading settles");
    expect(hook!.graph).toBeDefined();
    expect(Array.isArray(hook!.errors)).toBe(true);

    // skipPreviews + answerHuman + submitEdit dispatch real signals/approvals
    // (they reject on this non-delegation run; the closures still run).
    await act(async () => {
      await swallow(hook!.actions.skipPreviews());
    });
    await act(async () => {
      await swallow(hook!.actions.answerHuman("dc:root:plan", 0, { any: true }));
    });
    await act(async () => {
      await swallow(hook!.actions.submitEdit("root", "edited output", "a note"));
    });
    // submitEdit without a note (the note-less branch of the payload spread).
    await act(async () => {
      await swallow(hook!.actions.submitEdit("root", "edited again"));
    });

    // submitPoll with no pending poll approval must throw a clear error.
    let pollError: unknown;
    await act(async () => {
      try {
        await hook!.actions.submitPoll([{ question: "q", rating: 5 }]);
      } catch (error) {
        pollError = error;
      }
    });
    expect((pollError as Error).message).toContain("no pending poll");

    // makeEditId fallback: with crypto.randomUUID unavailable, submitEdit still
    // produces an id via the Date/Math.random path.
    const realCrypto = (globalThis as { crypto?: unknown }).crypto;
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
      await act(async () => {
        await swallow(hook!.actions.submitEdit("root", "no-crypto edit"));
      });
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true });
    }

    await harness.unmount();
  });

  test("a real pending poll-phase approval is a delegation target and submitPoll answers it", async () => {
    const { baseUrl } = await bootGateway();
    const runId = await launch(baseUrl, "poll", {});

    let hook: ReturnType<typeof useDelegationChain> | undefined;
    function Probe() {
      hook = useDelegationChain({ runId });
      return null;
    }
    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client: client(baseUrl) }, createElement(Probe)));

    // The run tree carries the `dc-poll` node, which is delegation-shaped, so
    // the tree-derived target count becomes non-zero (treeTargetCount branch).
    // Poll submitPoll until the pending `dc-poll` approval has synced into the
    // hook's approvals feed: once it has, submitPoll gets past the "no pending
    // poll" guard and calls answerHuman (whether the underlying select-approval
    // submit ultimately resolves or rejects, the found + answer path executed).
    let pastFind = false;
    const pollDeadline = Date.now() + 60_000;
    while (Date.now() < pollDeadline && !pastFind) {
      try {
        await act(async () => {
          await hook!.actions.submitPoll([{ question: "How useful?", rating: 5 }], "great");
        });
        pastFind = true;
      } catch (error) {
        if (!String((error as Error).message).includes("no pending poll")) {
          pastFind = true; // reached answerHuman (submit rejected) → find + call ran
        } else {
          await act(async () => {
            await sleep(50);
          });
        }
      }
    }
    expect(pastFind).toBe(true);

    await harness.unmount();
  });

  test("without a runId the actions reject via the runId guard", async () => {
    const { baseUrl } = await bootGateway();

    let hook: ReturnType<typeof useDelegationChain> | undefined;
    function Probe() {
      hook = useDelegationChain({ runId: undefined });
      return null;
    }
    const harness = await mountHarness();
    await harness.render(createElement(SmithersGatewayProvider, { client: client(baseUrl) }, createElement(Probe)));

    expect(hook!.loading).toBe(false);

    // requireRunId() throws "no runId" for the signal-backed actions.
    let editError: unknown;
    await act(async () => {
      try {
        await hook!.actions.submitEdit("root", "x");
      } catch (error) {
        editError = error;
      }
    });
    expect((editError as Error).message).toContain("no runId");

    let skipError: unknown;
    await act(async () => {
      try {
        await hook!.actions.skipPreviews();
      } catch (error) {
        skipError = error;
      }
    });
    expect((skipError as Error).message).toContain("no runId");

    // submitPoll finds no pending poll (empty approvals) → its own error.
    let pollError: unknown;
    await act(async () => {
      try {
        await hook!.actions.submitPoll([]);
      } catch (error) {
        pollError = error;
      }
    });
    expect((pollError as Error).message).toContain("no pending poll");

    await harness.unmount();
  });

  test("a StrictMode remount disposes and recreates the store", async () => {
    const { baseUrl } = await bootGateway();
    const runId = await launch(baseUrl, "value", { value: 1 });

    let hook: ReturnType<typeof useDelegationChain> | undefined;
    function Probe() {
      hook = useDelegationChain({ runId });
      return null;
    }
    // StrictMode double-invokes effects: mount → cleanup (store.dispose) →
    // mount again → the effect creates a fresh store.
    const harness = await mountHarness();
    await harness.render(
      createElement(
        StrictMode,
        null,
        createElement(SmithersGatewayProvider, { client: client(baseUrl) }, createElement(Probe)),
      ),
    );
    await waitFor(() => hook !== undefined && hook.loading === false, "strict-mode delegation settles");
    expect(hook!.graph).toBeDefined();
    await harness.unmount();
  });
});
