import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";

function createAdapter() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

function humanRequestRow(extra = {}) {
  return {
    requestId: "req-1",
    runId: "run-1",
    nodeId: "human",
    iteration: 0,
    kind: "json",
    status: "pending",
    prompt: "Approve?",
    schemaJson: null,
    optionsJson: null,
    responseJson: null,
    requestedAtMs: 100,
    answeredAtMs: null,
    answeredBy: null,
    timeoutAtMs: null,
    ...extra,
  };
}

// The SQL predicate is `timeout_at_ms <= ?`, mirroring the JS helper
// isHumanRequestPastTimeout. Existing tests only exercise now-1 / far-future;
// this pins the exact boundary so the two layers cannot drift apart.
describe("expireStaleHumanRequests timeout boundary", () => {
  test("a timeout exactly at now expires; one millisecond later survives", async () => {
    const { adapter, sqlite } = createAdapter();
    try {
      const now = 10_000;
      await adapter.insertHumanRequest(humanRequestRow({ requestId: "at-now", timeoutAtMs: now }));
      await adapter.insertHumanRequest(humanRequestRow({ requestId: "after-now", timeoutAtMs: now + 1 }));

      await adapter.expireStaleHumanRequests(now);

      expect((await adapter.getHumanRequest("at-now"))?.status).toBe("expired");
      expect((await adapter.getHumanRequest("after-now"))?.status).toBe("pending");
    } finally {
      sqlite.close();
    }
  });

  test("a null timeout never expires, no matter how late the sweep runs", async () => {
    const { adapter, sqlite } = createAdapter();
    try {
      await adapter.insertHumanRequest(humanRequestRow({ requestId: "no-timeout", timeoutAtMs: null }));

      await adapter.expireStaleHumanRequests(Number.MAX_SAFE_INTEGER);

      expect((await adapter.getHumanRequest("no-timeout"))?.status).toBe("pending");
    } finally {
      sqlite.close();
    }
  });
});

describe("expireStaleHumanRequests only touches pending rows", () => {
  test("an answered request with a past timeout keeps its status and answer", async () => {
    const { adapter, sqlite } = createAdapter();
    try {
      await adapter.insertHumanRequest(humanRequestRow({ requestId: "answered", timeoutAtMs: 500 }));
      await adapter.answerHumanRequest("answered", '{"ok":true}', 400, "operator:alice");

      // The sweep runs after the timeout has long passed. It must not
      // flip the row to expired or wipe the operator's answer.
      await adapter.expireStaleHumanRequests(9_999);

      const row = await adapter.getHumanRequest("answered");
      expect(row?.status).toBe("answered");
      expect(row?.responseJson).toBe('{"ok":true}');
      expect(row?.answeredAtMs).toBe(400);
      expect(row?.answeredBy).toBe("operator:alice");
    } finally {
      sqlite.close();
    }
  });

  test("a cancelled request with a past timeout stays cancelled", async () => {
    const { adapter, sqlite } = createAdapter();
    try {
      await adapter.insertHumanRequest(humanRequestRow({ requestId: "cancelled", timeoutAtMs: 500 }));
      await adapter.cancelHumanRequest("cancelled");

      await adapter.expireStaleHumanRequests(9_999);

      expect((await adapter.getHumanRequest("cancelled"))?.status).toBe("cancelled");
    } finally {
      sqlite.close();
    }
  });

  test("expiry is idempotent: a second sweep leaves the expired row unchanged", async () => {
    const { adapter, sqlite } = createAdapter();
    try {
      await adapter.insertHumanRequest(humanRequestRow({ requestId: "stale", timeoutAtMs: 500 }));

      await adapter.expireStaleHumanRequests(1_000);
      const first = await adapter.getHumanRequest("stale");
      await adapter.expireStaleHumanRequests(2_000);
      const second = await adapter.getHumanRequest("stale");

      expect(first?.status).toBe("expired");
      expect(second).toEqual(first);
    } finally {
      sqlite.close();
    }
  });

  test("an expired request cannot be answered afterwards", async () => {
    const { adapter, sqlite } = createAdapter();
    try {
      await adapter.insertHumanRequest(humanRequestRow({ requestId: "too-late", timeoutAtMs: 500 }));
      await adapter.expireStaleHumanRequests(1_000);

      // answerHumanRequest guards on status = 'pending'; a late answer
      // against an expired request must be a no-op, not a resurrection.
      await adapter.answerHumanRequest("too-late", '{"ok":true}', 2_000, "operator:bob");

      const row = await adapter.getHumanRequest("too-late");
      expect(row?.status).toBe("expired");
      expect(row?.responseJson).toBeNull();
      expect(row?.answeredBy).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
