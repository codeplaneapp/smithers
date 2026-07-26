import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { buildHumanRequestId } from "@smithers-orchestrator/db/buildHumanRequestId";
import { withTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { HumanTask } from "../src/components/index.js";
import { createTestSmithers } from "./helpers.js";

function baseHumanRequest(runId, nodeId, overrides = {}) {
  return {
    requestId: buildHumanRequestId(runId, nodeId, 0),
    runId,
    nodeId,
    iteration: 0,
    kind: "json",
    status: "pending",
    prompt: "answer",
    schemaJson: null,
    optionsJson: null,
    responseJson: null,
    requestedAtMs: 1,
    answeredAtMs: null,
    answeredBy: null,
    timeoutAtMs: null,
    ...overrides,
  };
}

function approvalWithNote(runId, nodeId, note) {
  return {
    runId,
    nodeId,
    iteration: 0,
    status: "approved",
    requestedAtMs: 1,
    decidedAtMs: 3,
    note,
    decidedBy: "bob",
    requestJson: null,
    decisionJson: null,
    autoApproved: false,
  };
}

describe("HumanTask attempt bounds", () => {
  test("maxAttempts=1 is the smallest accepted bound: zero retries, fixed zero-delay policy", () => {
    const el = HumanTask({ id: "human-once", output: "out", prompt: "Answer", maxAttempts: 1 });
    expect(el.props.retries).toBe(0);
    expect(el.props.retryPolicy).toEqual({ backoff: "fixed", initialDelayMs: 0 });
    expect(el.props.meta.maxAttempts).toBe(1);
  });

  test("defaults to 10 attempts (9 retries) when maxAttempts is unset", () => {
    const el = HumanTask({ id: "human-default", output: "out", prompt: "Answer" });
    expect(el.props.retries).toBe(9);
    expect(el.props.meta.maxAttempts).toBe(10);
  });

  test("maxAttempts=0 degrades to a single attempt: extraction clamps the negative retry budget to 0", async () => {
    // The element carries retries = maxAttempts - 1 = -1; graph extraction
    // must clamp that to 0 (one attempt, no retries) instead of producing a
    // task that fails without ever executing.
    const el = HumanTask({ id: "human-zero", output: "out", prompt: "Answer", maxAttempts: 0 });
    expect(el.props.retries).toBe(-1);
    const rendered = await new SmithersRenderer().render(el);
    expect(rendered.tasks[0].retries).toBe(0);
    expect(rendered.tasks[0].meta.maxAttempts).toBe(0);
  });

  test("a negative maxAttempts also clamps to a single attempt instead of blowing up", async () => {
    const rendered = await new SmithersRenderer().render(
      HumanTask({ id: "human-negative", output: "out", prompt: "Answer", maxAttempts: -3 }),
    );
    expect(rendered.tasks[0].retries).toBe(0);
  });
});

describe("HumanTask approval-note fallback does not resurrect resolved requests", () => {
  test("a cancelled request throws HUMAN_TASK_CANCELLED even when an approval note exists", async () => {
    const { db, cleanup } = createTestSmithers({});
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    try {
      await adapter.insertHumanRequest(baseHumanRequest("run", "human-cancel-note", { status: "cancelled" }));
      await adapter.insertOrUpdateApproval(
        approvalWithNote("run", "human-cancel-note", JSON.stringify({ answer: "stale" })),
      );
      const el = HumanTask({
        id: "human-cancel-note",
        output: z.object({ answer: z.string() }),
        prompt: "Answer",
      });
      await expect(
        withTaskRuntime({ db, runId: "run", nodeId: "human-cancel-note", iteration: 0 }, () =>
          el.props.__smithersComputeFn(),
        ),
      ).rejects.toThrow("was cancelled");
      const request = await adapter.getHumanRequest(buildHumanRequestId("run", "human-cancel-note", 0));
      expect(request?.status).toBe("cancelled");
      expect(request?.responseJson).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("an expired request throws HUMAN_TASK_NO_INPUT even when an approval note exists", async () => {
    const { db, cleanup } = createTestSmithers({});
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    try {
      await adapter.insertHumanRequest(baseHumanRequest("run", "human-expired-note", { status: "expired" }));
      await adapter.insertOrUpdateApproval(
        approvalWithNote("run", "human-expired-note", JSON.stringify({ answer: "stale" })),
      );
      const el = HumanTask({
        id: "human-expired-note",
        output: z.object({ answer: z.string() }),
        prompt: "Answer",
      });
      await expect(
        withTaskRuntime({ db, runId: "run", nodeId: "human-expired-note", iteration: 0 }, () =>
          el.props.__smithersComputeFn(),
        ),
      ).rejects.toThrow("No human input received");
      const request = await adapter.getHumanRequest(buildHumanRequestId("run", "human-expired-note", 0));
      expect(request?.status).toBe("expired");
      expect(request?.responseJson).toBeNull();
    } finally {
      cleanup();
    }
  });
});
