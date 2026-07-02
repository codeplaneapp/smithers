import { GlobalRegistrator } from "@happy-dom/global-registrator";

try { GlobalRegistrator.register(); } catch { /* already registered */ }
(globalThis as { happyDOM?: { settings?: { fetch?: { disableSameOriginPolicy?: boolean } } } })
  .happyDOM!.settings!.fetch!.disableSameOriginPolicy = true;

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { createElement, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";
import { QueryClient } from "@tanstack/react-query";
import {
  SmithersGatewayClient,
  createSmithersCollections,
  createSmithersDataClient,
  type GatewayCronRow,
} from "@smithers-orchestrator/gateway-client";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Gateway } from "@smithers-orchestrator/server";
import { createSmithers, createSmithersPostgres } from "smithers-orchestrator";
import { SmithersGatewayProvider, useGatewayRun } from "../src/index.ts";
import { runProviderParitySuite } from "./providerParitySuite.ts";

setDefaultTimeout(120_000);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PG_URL = process.env.SMITHERS_TEST_PG_URL;
const cleanups: Array<() => Promise<void> | void> = [];

type Backend = "sqlite" | "pglite" | "postgres";
type SmithersApi = Awaited<ReturnType<typeof createApi>>;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void | boolean | Promise<void | boolean>, timeoutMs = 5_000) {
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
  throw new Error("Timed out waiting for assertion.");
}

function getPort(server: import("node:http").Server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Gateway server did not expose a port");
  return addr.port;
}

function makeDbPath(name: string) {
  return join(tmpdir(), `smithers-collections-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function createApi(backend: Backend) {
  const schemas = {
    result: z.object({ value: z.number() }),
    selection: z.object({ selected: z.string(), notes: z.string().nullable() }),
  };
  if (backend === "sqlite") {
    const dbPath = makeDbPath("sqlite");
    const api = createSmithers(schemas, { dbPath });
    cleanups.push(async () => {
      api.db.$client?.close?.();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
    });
    return api;
  }
  if (backend === "pglite") {
    const api = await createSmithersPostgres(schemas, { provider: "pglite" });
    cleanups.push(() => api.close());
    return api;
  }
  if (!PG_URL) throw new Error("SMITHERS_TEST_PG_URL is required for postgres.");
  const pg = await import("pg");
  const admin = new pg.Client({ connectionString: PG_URL });
  const schema = `smithers_collections_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const url = new URL(PG_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const api = await createSmithersPostgres(schemas, { provider: "postgres", connectionString: url.toString() });
  cleanups.push(async () => {
    await api.close();
    const drop = new pg.Client({ connectionString: PG_URL });
    await drop.connect();
    await drop.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await drop.end();
  });
  return api;
}

function createValueWorkflow(api: SmithersApi) {
  return api.smithers((ctx: any) =>
    React.createElement(
      api.Workflow,
      { name: "collections-value" },
      React.createElement(
        api.Task,
        { id: "task1", output: api.outputs.result },
        { value: Number(ctx.input.value ?? 1) },
      ),
    ),
  );
}

function createApprovalWorkflow(api: SmithersApi) {
  return api.smithers((ctx: any) => {
    const selection = ctx.outputMaybe("selection", { nodeId: "pick-plan" });
    return React.createElement(
      api.Workflow,
      { name: "collections-approval" },
      React.createElement(
        api.Sequence,
        null,
        React.createElement(api.Approval, {
          id: "pick-plan",
          mode: "select",
          output: api.outputs.selection,
          request: { title: "Pick a plan", summary: "Choose the best option." },
          options: [
            { key: "light", label: "Light" },
            { key: "balanced", label: "Balanced" },
          ],
          allowedScopes: ["approve"],
          allowedUsers: ["user:operator"],
        }),
        selection
          ? React.createElement(
              api.Task,
              { id: "record", output: api.outputs.result },
              { value: selection.selected === "balanced" ? 2 : 1 },
            )
          : null,
      ),
    );
  });
}

async function bootGateway(backend: Backend) {
  const api = await createApi(backend);
  const gateway = new Gateway({
    auth: {
      mode: "token",
      tokens: {
        "operator-token": { role: "admin", scopes: ["*"], userId: "user:operator" },
      },
    },
  });
  gateway.register("value", createValueWorkflow(api));
  gateway.register("approval", createApprovalWorkflow(api));
  const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => gateway.close());
  return { api, baseUrl: `http://127.0.0.1:${getPort(server)}` };
}

async function launchRun(baseUrl: string, value: number) {
  const response = await fetch(`${baseUrl}/v1/api/runs`, {
    method: "POST",
    headers: { authorization: "Bearer operator-token", "content-type": "application/json" },
    body: JSON.stringify({ workflow: "value", input: { value } }),
  });
  const json = await response.json();
  expect(response.status).toBe(200);
  expect(json.ok).toBe(true);
  const runId = String(json.data.runId);
  await waitFor(async () => {
    const read = await fetch(`${baseUrl}/v1/api/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: "Bearer operator-token" },
    });
    if (read.status !== 200) return false;
  });
  return runId;
}

function cronRow(overrides: Partial<GatewayCronRow> = {}): GatewayCronRow {
  return {
    cronId: "cron-provider-parity",
    workflow: "value",
    workflowPath: "gateway:value",
    pattern: "* * * * *",
    enabled: true,
    createdAtMs: Date.now(),
    lastRunAtMs: null,
    nextRunAtMs: null,
    errorJson: null,
    ...overrides,
  };
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

const backends: Backend[] = PG_URL ? ["sqlite", "pglite", "postgres"] : ["sqlite", "pglite"];

for (const backend of backends) {
  describe(`Smithers QueryCollection provider parity (${backend})`, () => {
    test.skipIf(backend === "pglite" && process.platform === "win32")("shared provider parity passes over local mode", async () => {
      const { baseUrl } = await bootGateway(backend);
      await runProviderParitySuite({ kind: "local", apiBaseUrl: baseUrl, token: "operator-token" });
    }, 120_000);

    test.skipIf(backend === "pglite" && process.platform === "win32")("reads and confirms optimistic cron insert/update/delete through SSE", async () => {
      const { baseUrl } = await bootGateway(backend);
      const queryClient = new QueryClient();
      const client = createSmithersDataClient({
        mode: { kind: "local", apiBaseUrl: baseUrl, token: "operator-token" },
      });
      const collections = createSmithersCollections(client, queryClient);
      const streamCollections: string[][] = [];
      const unsubscribe = client.stream.subscribe((event) => {
        if (event.type === "change") streamCollections.push(event.collections);
      });
      collections.connect();
      cleanups.push(() => {
        unsubscribe();
        collections.close();
        client.close();
        queryClient.clear();
      });

      const crons = collections.crons();
      await crons.preload();
      expect(crons.toArray).toEqual([]);

      const insert = crons.insert(cronRow());
      expect(crons.get("cron-provider-parity")?.pattern).toBe("* * * * *");
      await insert.isPersisted.promise;
      await waitFor(() => crons.get("cron-provider-parity")?.workflow === "value");
      await waitFor(() => streamCollections.some((names) => names.includes("crons")));

      const update = crons.update("cron-provider-parity", (draft) => {
        draft.pattern = "*/5 * * * *";
        draft.enabled = false;
      });
      expect(crons.get("cron-provider-parity")?.pattern).toBe("*/5 * * * *");
      expect(crons.get("cron-provider-parity")?.enabled).toBe(false);
      await update.isPersisted.promise;
      await waitFor(() => crons.get("cron-provider-parity")?.enabled === false);

      const remove = crons.delete("cron-provider-parity");
      expect(crons.has("cron-provider-parity")).toBe(false);
      await remove.isPersisted.promise;
      await waitFor(() => crons.has("cron-provider-parity") === false);
      expect(streamCollections.filter((names) => names.includes("crons")).length).toBeGreaterThanOrEqual(3);
    }, 90_000);

    test.skipIf(backend === "pglite" && process.platform === "win32")("rolls back optimistic cron inserts rejected by the REST write", async () => {
      const { baseUrl } = await bootGateway(backend);
      const queryClient = new QueryClient();
      const client = createSmithersDataClient({
        mode: { kind: "local", apiBaseUrl: baseUrl, token: "operator-token" },
      });
      const collections = createSmithersCollections(client, queryClient);
      collections.connect();
      cleanups.push(() => {
        collections.close();
        client.close();
        queryClient.clear();
      });

      const crons = collections.crons();
      await crons.preload();
      const insert = crons.insert(cronRow({ cronId: "cron-rejected", workflow: "missing-workflow" }));
      expect(crons.has("cron-rejected")).toBe(true);
      await expect(insert.isPersisted.promise).rejects.toThrow();
      await waitFor(() => crons.has("cron-rejected") === false);
    }, 90_000);

    test.skipIf(backend === "pglite" && process.platform === "win32")("runEvents collection keeps the newest 1024 rows from a real gateway", async () => {
      const { api, baseUrl } = await bootGateway(backend);
      const adapter = new SmithersDb(api.db);
      const runId = `events-ring-${backend}`;
      const now = Date.now();
      await adapter.insertRun({
        runId,
        workflowName: "value",
        status: "running",
        createdAtMs: now,
        configJson: JSON.stringify({ gatewayWorkflowKey: "value" }),
      });
      for (let index = 0; index < 1_100; index += 1) {
        await adapter.insertEventWithNextSeq({
          runId,
          timestampMs: now + index,
          type: "test.event",
          payloadJson: JSON.stringify({ index }),
        });
      }

      const queryClient = new QueryClient();
      const client = createSmithersDataClient({
        mode: { kind: "local", apiBaseUrl: baseUrl, token: "operator-token" },
      });
      const collections = createSmithersCollections(client, queryClient);
      collections.connect();
      cleanups.push(() => {
        collections.close();
        client.close();
        queryClient.clear();
      });

      const events = collections.runEvents(runId, 5_000);
      await events.preload();
      const seqs = events.toArray.map((row) => Number(row.seq)).sort((left, right) => left - right);
      expect(events.size).toBeLessThanOrEqual(1_024);
      expect(seqs).toHaveLength(1_024);
      expect(seqs[0]).toBe(76);
      expect(seqs.at(-1)).toBe(1_099);
    }, 120_000);

    test.skipIf(backend === "pglite" && process.platform === "win32")("switching runId never renders the prior run row", async () => {
      const { baseUrl } = await bootGateway(backend);
      const firstRunId = await launchRun(baseUrl, 1);
      const secondRunId = await launchRun(baseUrl, 2);
      let seenRunId: string | undefined;

      function Probe(props: { runId: string }) {
        const run = useGatewayRun(props.runId);
        seenRunId = run.data?.runId as string | undefined;
        return null;
      }

      const client = new SmithersGatewayClient({ baseUrl, token: "operator-token" });
      const harness = await mountHarness();
      await harness.render(
        createElement(SmithersGatewayProvider, { client }, createElement(Probe, { runId: firstRunId })),
      );
      await waitFor(() => seenRunId === firstRunId);

      await harness.render(
        createElement(SmithersGatewayProvider, { client }, createElement(Probe, { runId: secondRunId })),
      );
      expect(seenRunId).not.toBe(firstRunId);
      await waitFor(() => seenRunId === secondRunId);
      await harness.unmount();
    }, 90_000);
  });
}

test.skipIf(Boolean(PG_URL))("Smithers QueryCollection provider parity postgres suite skipped because SMITHERS_TEST_PG_URL is not set", () => {
  expect(PG_URL).toBeUndefined();
});
