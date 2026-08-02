import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { QueryClient } from "@tanstack/react-query";
import { createSmithersCollections, createSmithersDataClient, type GatewayCronRow } from "@smthrs/gateway-client";
import { Gateway } from "@smthrs/server";
import { createSmithersPostgres } from "smthrs";
import {
  createSmithersElectricProxy,
  serveSmithersElectricProxy,
  type SmithersElectricProxyServer,
} from "../../electric-proxy/src/index.js";
import {
  isDockerFixtureAvailable,
  startElectricFixture,
  type ElectricFixture,
} from "../../electric-proxy/tests/fixtures/electricFixture.ts";
import { runProviderParitySuite } from "./providerParitySuite.ts";

setDefaultTimeout(240_000);

const runElectricSuite = process.env.SMITHERS_TEST_ELECTRIC === "1";
const dockerAvailable = process.platform !== "win32" && isDockerFixtureAvailable();
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void | boolean | Promise<void | boolean>, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await assertion();
      if (result !== false) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  if (lastError) throw lastError;
  throw new Error("Timed out waiting for assertion.");
}

function getPort(server: import("node:http").Server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not expose a port");
  return addr.port;
}

function cronRow(overrides: Partial<GatewayCronRow> = {}): GatewayCronRow {
  return {
    cronId: "cron-electric-provider-parity",
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

function createApprovalWorkflow(api: Awaited<ReturnType<typeof createSmithersPostgres>>) {
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

async function bootRealElectricGateway(fixture: ElectricFixture) {
  const api = await createSmithersPostgres(
    {
      result: z.object({ value: z.number() }),
      selection: z.object({ selected: z.string(), notes: z.string().nullable() }),
    },
    { provider: "postgres", connectionString: fixture.postgresUrl },
  );
  cleanups.push(() => api.close());

  const gateway = new Gateway({
    auth: {
      mode: "token",
      tokens: {
        "operator-token": { role: "admin", scopes: ["*"], userId: "user:operator" },
      },
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
  gateway.register("approval", createApprovalWorkflow(api));
  const gatewayServer = await gateway.listen({ port: 0, host: "127.0.0.1" });
  cleanups.push(() => gateway.close());

  const proxy = createSmithersElectricProxy({
    electricUrl: fixture.shapeUrl,
    authenticate: () => ({
      principalId: "user:operator",
      userId: "user:operator",
      scopes: ["*"],
      unscoped: true,
    }),
  });
  const electricServer: SmithersElectricProxyServer = await serveSmithersElectricProxy({
    proxy,
    port: 0,
    host: "127.0.0.1",
  });
  cleanups.push(() => electricServer.close());

  return {
    apiBaseUrl: `http://127.0.0.1:${getPort(gatewayServer)}`,
    electricBaseUrl: `http://127.0.0.1:${electricServer.port}`,
  };
}

test.skipIf(!runElectricSuite)(
  "Smithers Electric provider parity skipped because SMITHERS_TEST_ELECTRIC is not set",
  () => {
    expect(runElectricSuite).toBe(true);
  },
);

test.skipIf(!runElectricSuite || !dockerAvailable)(
  "Smithers Electric provider parity skipped because Docker Electric fixture is unavailable",
  () => {
    expect(dockerAvailable).toBe(true);
  },
);

describe.skipIf(!runElectricSuite || !dockerAvailable)(
  "Smithers Electric provider parity over real Postgres + Electric + proxy",
  () => {
    test("shared provider parity passes over Electric", async () => {
      const fixture = await startElectricFixture();
      cleanups.push(() => fixture.teardown());
      const { apiBaseUrl, electricBaseUrl } = await bootRealElectricGateway(fixture);
      await runProviderParitySuite({
        kind: "multiplayer",
        apiBaseUrl,
        electricBaseUrl,
        workspaceId: "workspace-electric-provider-parity-shared",
        token: "operator-token",
      });
    }, 240_000);

    test("M2 provider parity passes over Electric and txid matching drops optimism without flicker", async () => {
      const fixture = await startElectricFixture();
      cleanups.push(() => fixture.teardown());
      const { apiBaseUrl, electricBaseUrl } = await bootRealElectricGateway(fixture);

      const queryClient = new QueryClient();
      const client = createSmithersDataClient({
        mode: {
          kind: "multiplayer",
          apiBaseUrl,
          electricBaseUrl,
          workspaceId: "workspace-electric-provider-parity",
          token: "operator-token",
        },
      });
      const collections = await createSmithersCollections(client, queryClient);
      cleanups.push(() => {
        collections.close();
        client.close();
        queryClient.clear();
      });

      const crons = collections.crons();
      await crons.preload();

      const snapshots: Array<{ exists: boolean; synced?: boolean; pattern?: string }> = [];
      const record = () => {
        const row = crons.get("cron-electric-provider-parity") as (GatewayCronRow & { $synced?: boolean }) | undefined;
        snapshots.push({ exists: Boolean(row), synced: row?.$synced, pattern: row?.pattern });
      };
      const timer = setInterval(record, 25);
      try {
        const insert = crons.insert(cronRow());
        record();
        expect(crons.get("cron-electric-provider-parity")?.pattern).toBe("* * * * *");
        expect((crons.get("cron-electric-provider-parity") as GatewayCronRow & { $synced?: boolean }).$synced).toBe(
          false,
        );
        await insert.isPersisted.promise;
        await waitFor(
          () =>
            (crons.get("cron-electric-provider-parity") as (GatewayCronRow & { $synced?: boolean }) | undefined)
              ?.$synced === true,
        );
        record();

        const update = crons.update("cron-electric-provider-parity", (draft) => {
          draft.pattern = "*/5 * * * *";
          draft.enabled = false;
        });
        expect((crons.get("cron-electric-provider-parity") as GatewayCronRow & { $synced?: boolean }).$synced).toBe(
          false,
        );
        await update.isPersisted.promise;
        await waitFor(() => {
          const row = crons.get("cron-electric-provider-parity") as
            | (GatewayCronRow & { $synced?: boolean })
            | undefined;
          return row?.pattern === "*/5 * * * *" && row.enabled === false && row.$synced === true;
        });
        record();

        const remove = crons.delete("cron-electric-provider-parity");
        await remove.isPersisted.promise;
        await waitFor(() => crons.has("cron-electric-provider-parity") === false);
      } finally {
        clearInterval(timer);
      }

      const firstSynced = snapshots.findIndex((snapshot) => snapshot.exists && snapshot.synced === true);
      const flickerAfterSynced = snapshots
        .slice(Math.max(0, firstSynced))
        .some((snapshot) => snapshot.exists && snapshot.pattern !== "* * * * *" && snapshot.pattern !== "*/5 * * * *");
      expect(snapshots.some((snapshot) => snapshot.exists && snapshot.synced === false)).toBe(true);
      expect(firstSynced).toBeGreaterThanOrEqual(0);
      expect(flickerAfterSynced).toBe(false);
    }, 240_000);
  },
);
