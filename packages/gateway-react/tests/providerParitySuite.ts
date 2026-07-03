import { expect } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createSmithersCollections,
  createSmithersDataClient,
  type GatewayCronRow,
  type WorkspaceMode,
} from "@smithers-orchestrator/gateway-client";

type SmithersDataClient = ReturnType<typeof createSmithersDataClient>;

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
  throw new Error("Timed out waiting for provider parity assertion.");
}

async function waitForApprovalNodeReady(
  client: SmithersDataClient,
  runId: string,
  nodeId: string,
  iteration = 0,
) {
  await waitFor(async () => {
    const nodes = await client.api.getRunTree({ runId });
    return nodes.some(
      (node) =>
        node.id === nodeId &&
        (node.iteration ?? 0) === iteration &&
        node.status === "waiting",
    );
  });
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

export async function runProviderParitySuite(mode: WorkspaceMode) {
  const queryClient = new QueryClient();
  const client = createSmithersDataClient({ mode });
  const collections = await Promise.resolve(createSmithersCollections(client, queryClient));
  const streamCollections: string[][] = [];
  const unsubscribe = client.stream.subscribe((event) => {
    if (event.type === "change") streamCollections.push(event.collections);
  });
  collections.connect();
  try {
    await waitFor(() => client.stream.status().status === "online", 5_000);
    const runs = collections.runs();
    await runs.preload();
    const launched = await client.api.launchRun({ workflow: "value", input: { value: 3 } });
    const runId = launched.data.runId;
    await waitFor(() => runs.has(runId));
    expect(runs.get(runId)?.workflowKey).toBe("value");

    const events = collections.runEvents(runId);
    await events.preload();
    await waitFor(() => events.toArray.some((row) => row.runId === runId));
    expect(events.size).toBeLessThanOrEqual(1_024);

    const approvalRun = await client.api.launchRun({ workflow: "approval", input: {} });
    const approvalRunId = approvalRun.data.runId;
    const approvals = collections.approvals({ filter: { runId: approvalRunId } });
    await approvals.preload();
    await waitFor(() => approvals.toArray.length > 0);
    const approvalKey = `${approvalRunId}:pick-plan:0`;
    expect(approvals.has(approvalKey)).toBe(true);
    await waitForApprovalNodeReady(client, approvalRunId, "pick-plan");
    const approvalUpdate = approvals.update(approvalKey, (draft) => {
      (draft as { decision?: Record<string, unknown> }).decision = { selected: "balanced", notes: null };
    });
    await approvalUpdate.isPersisted.promise;

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

    const rejected = crons.insert(cronRow({ cronId: "cron-rejected", workflow: "missing-workflow" }));
    expect(crons.has("cron-rejected")).toBe(true);
    await expect(rejected.isPersisted.promise).rejects.toThrow();
    await waitFor(() => crons.has("cron-rejected") === false);
  } finally {
    unsubscribe();
    collections.close();
    client.close();
    queryClient.clear();
  }
}
