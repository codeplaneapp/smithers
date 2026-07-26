import { describe, expect, test } from "bun:test";
import { computeHmacSha256Hex } from "../src/core/verifySignature.js";
import { makeIntegrationRuntime } from "../src/core/IntegrationRuntime.js";
import { makeLinearWebhookSource } from "../src/linear/LinearWebhookSource.js";
import { createTestAdapter, seedWaitingEventRun } from "./helpers.js";

const SECRET = "linear-pipeline-secret";

/** @param {Record<string, any>} [overrides] */
function issueUpdateRequest(overrides = {}) {
  const payload = {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-uuid-42",
      identifier: "ENG-42",
      title: "Fix login button",
      team: { id: "team-eng-id", key: "ENG", name: "Engineering" },
      state: { id: "state-done", name: "Done", type: "completed" },
    },
    updatedFrom: { stateId: "state-in-progress" },
    url: "https://linear.app/acme/issue/ENG-42",
    organizationId: "org-1",
    webhookId: "webhook-config-1",
    webhookTimestamp: Date.now(),
    ...overrides,
  };
  const rawBody = JSON.stringify(payload);
  return {
    headers: { "linear-signature": computeHmacSha256Hex(rawBody, SECRET), "linear-delivery": "delivery-abc" },
    rawBody,
  };
}

/**
 * @param {import("@smithers-orchestrator/db/adapter").SmithersDb} adapter
 * @param {string} runId
 * @param {string} signalName
 */
async function waitForSignal(adapter, runId, signalName) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const signals = await adapter.listSignals(runId, { signalName });
    if (signals.length > 0) return signals;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return adapter.listSignals(runId, { signalName });
}

describe("Linear webhook → IntegrationRuntime → signal pipeline", () => {
  test("a signed issue.update delivery signals runs waiting on identifier and team key", async () => {
    const { adapter } = createTestAdapter();
    await seedWaitingEventRun(adapter, {
      runId: "run-issue",
      signalName: "integration:linear:issue.update",
      correlationId: "ENG-42",
    });
    await seedWaitingEventRun(adapter, {
      runId: "run-team",
      signalName: "integration:linear:issue.update",
      correlationId: "ENG",
    });
    await seedWaitingEventRun(adapter, {
      runId: "run-other-team",
      signalName: "integration:linear:issue.update",
      correlationId: "OPS",
    });
    const runtime = makeIntegrationRuntime({
      adapter,
      webhookSources: [makeLinearWebhookSource({ webhookSecret: SECRET })],
    });
    try {
      expect(runtime.hasWebhookSource("linear")).toBe(true);
      const result = await runtime.handleWebhook("linear", issueUpdateRequest());
      expect(result).toEqual({ accepted: 6 });
      const issueSignals = await waitForSignal(adapter, "run-issue", "integration:linear:issue.update");
      expect(issueSignals).toHaveLength(1);
      expect(issueSignals[0].receivedBy).toBe("integration:linear");
      expect(issueSignals[0].correlationId).toBe("ENG-42");
      const payload = JSON.parse(issueSignals[0].payloadJson);
      expect(payload.data.identifier).toBe("ENG-42");
      expect(payload.updatedFrom).toMatchObject({ stateId: "state-in-progress" });
      const teamSignals = await waitForSignal(adapter, "run-team", "integration:linear:issue.update");
      expect(teamSignals).toHaveLength(1);
      expect(teamSignals[0].correlationId).toBe("ENG");
      // Redelivery (same Linear-Delivery id) dedupes: no extra signals.
      await runtime.handleWebhook("linear", issueUpdateRequest());
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await adapter.listSignals("run-issue", { signalName: "integration:linear:issue.update" })).toHaveLength(1);
      // Unrelated team never signaled.
      expect(
        await adapter.listSignals("run-other-team", { signalName: "integration:linear:issue.update" }),
      ).toHaveLength(0);
    } finally {
      await runtime.shutdown();
    }
  });

  test("stale timestamps and bad signatures are rejected at ingress (no signal rows)", async () => {
    const { adapter } = createTestAdapter();
    await seedWaitingEventRun(adapter, {
      runId: "run-issue",
      signalName: "integration:linear:issue.update",
      correlationId: "ENG-42",
    });
    const runtime = makeIntegrationRuntime({
      adapter,
      webhookSources: [makeLinearWebhookSource({ webhookSecret: SECRET })],
    });
    try {
      const stale = issueUpdateRequest({ webhookTimestamp: Date.now() - 5 * 60_000 });
      await expect(runtime.handleWebhook("linear", stale)).rejects.toMatchObject({
        details: { reason: "invalid-signature" },
      });
      const tampered = issueUpdateRequest();
      tampered.rawBody = tampered.rawBody.replace("Fix login button", "Tampered title!!");
      await expect(runtime.handleWebhook("linear", tampered)).rejects.toMatchObject({
        details: { reason: "invalid-signature" },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await adapter.listSignals("run-issue", { signalName: "integration:linear:issue.update" })).toHaveLength(0);
    } finally {
      await runtime.shutdown();
    }
  });
});
