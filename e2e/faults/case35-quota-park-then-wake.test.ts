/**
 * Case 35 (flows migration, spec 1.5): a provider quota error parks the run
 * with a `wakeAt` and wakes through the durable clock — once per provider
 * family.
 *
 * flows' gap analysis §7 leaves exactly this out of core: "the classifier that
 * turns a provider quota error into a park with `wakeAt` and a wake via the
 * durable clock. Done = that classifier as an injected service at the wait/wake
 * seam, with one park-then-wake fault case; nothing new in core."
 *
 * Four families, four vocabularies for "you are out of quota" and, more to the
 * point, four ways of saying when it lifts:
 *
 * | family    | reset vocabulary exercised here                     |
 * | --------- | --------------------------------------------------- |
 * | anthropic | `resets 4pm (America/New_York)` wall clock in a zone |
 * | openai    | `usage_limit_reached` plus `retry after N seconds`   |
 * | google    | `RESOURCE_EXHAUSTED` plus `retry after N seconds`    |
 * | xai       | `rate limit exceeded` plus `retry after N seconds`   |
 *
 * REAL product path (no mocks): the provider text goes through the shipping
 * agent-layer classifier (`classifyQuotaError` in
 * `@smthrs/agents/BaseCliAgent`), is stored on a real attempt row through the
 * shipping `SmithersDb`, parks a real run row, and is woken by the shipping
 * `runsDueForQuotaResume` and the run driver's own sweep. Nothing about the
 * quota path is simulated except the passage of time, which is injected.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { classifyQuotaError } from "@smthrs/agents/BaseCliAgent/BaseCliAgent";
import { buildWaitingRunPatch, resolveQuotaWakeAt, runsDueForQuotaResume } from "@smthrs/engine/engine";
import { createWaitingSeam } from "@smthrs/engine/waiting/createWaitingSeam";
import { waitingAnnotationForWaitReason } from "@smthrs/engine/waiting/waitingTaxonomy";
import { waitingAnnotationFromRunRow } from "@smthrs/engine/waiting/readWaitingAnnotation";
import { createRunDriverSweep } from "@smthrs/engine/sweep/createRunDriverSweep";

/** A fixed clock so the wall-clock-in-a-zone banner resolves deterministically. */
const NOW = Date.parse("2026-08-19T10:00:00.000Z");

type Family = {
  id: "anthropic" | "openai" | "google" | "xai";
  engine: string;
  runId: string;
  nodeId: string;
  /** Verbatim provider text, as it arrives on the agent's stderr or stdout. */
  message: string;
};

const FAMILIES: Family[] = [
  {
    id: "anthropic",
    engine: "claude-code",
    runId: "run-case35-anthropic",
    nodeId: "claude-node",
    message:
      "You've hit your usage limit for Claude. Your limit will reset at 4pm (America/New_York).",
  },
  {
    id: "openai",
    engine: "codex",
    runId: "run-case35-openai",
    nodeId: "codex-node",
    message:
      'stream error: 429 Too Many Requests {"error":{"type":"usage_limit_reached"}} — retry after 900 seconds',
  },
  {
    id: "google",
    engine: "gemini",
    runId: "run-case35-google",
    nodeId: "gemini-node",
    message: "RESOURCE_EXHAUSTED: quota exceeded for generate_requests. retry after 120 seconds",
  },
  {
    id: "xai",
    engine: "grok",
    runId: "run-case35-xai",
    nodeId: "grok-node",
    message: "rate limit exceeded for grok-code; retry after 60 seconds",
  },
];

type Store = { sqlite: Database; adapter: SmithersDb; dir: string };

let store: Store;

function openStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "smithers-case35-"));
  const sqlite = new Database(join(dir, "smithers.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db), dir };
}

/**
 * Persist the run, its node, and the failed attempt exactly as the agent layer
 * would after a provider quota rejection.
 */
async function seedQuotaFailure(adapter: SmithersDb, family: Family): Promise<void> {
  const error = classifyQuotaError(family.message, family.engine, {
    agentId: family.nodeId,
    agentEngine: family.engine,
    agentModel: "test-model",
    nowMs: () => NOW,
  });
  if (!error) throw new Error(`the shipping classifier did not recognise ${family.id} quota text`);

  await Effect.runPromise(
    adapter.insertRun({
      runId: family.runId,
      workflowName: "case35-workflow",
      status: "running",
      createdAtMs: NOW - 1_000,
      startedAtMs: NOW - 1_000,
      heartbeatAtMs: NOW - 1_000,
      runtimeOwnerId: "pid:9001",
    }),
  );
  await Effect.runPromise(
    adapter.insertNode({
      runId: family.runId,
      nodeId: family.nodeId,
      iteration: 0,
      state: "failed",
      lastAttempt: 1,
      updatedAtMs: NOW,
      outputTable: `case35_${family.id}`,
    }),
  );
  await Effect.runPromise(
    adapter.insertAttempt({
      runId: family.runId,
      nodeId: family.nodeId,
      iteration: 0,
      attempt: 1,
      state: "failed",
      startedAtMs: NOW - 500,
      finishedAtMs: NOW,
      errorJson: JSON.stringify({ code: error.code, message: error.message, details: error.details }),
      metaJson: JSON.stringify({ kind: "agent" }),
    }),
  );
}

/**
 * Park the run the way `engine.js` `handleDriverWait` does for a `Quota` wait:
 * resolve the deadline through the injected classifier, build the annotation
 * from the taxonomy, and write the derived `waiting-quota` status.
 */
async function parkOnQuota(adapter: SmithersDb, family: Family): Promise<number | null> {
  const seam = createWaitingSeam({ nowMs: () => NOW });
  const attempt = await Effect.runPromise(adapter.getAttempt(family.runId, family.nodeId, 0, 1));
  const classification = seam.classifyError(attempt);
  expect(classification.kind).toBe("quota");
  expect(classification.providerFamily).toBe(family.id);

  // The scheduler's blocked sample, built the way `makeWorkflowSession` builds
  // it: the node id, the provider's own message, and the reset time the agent
  // layer already resolved out of that message. That last field is the whole
  // production data path — agent classifier to attempt row to scheduler to the
  // engine-side classifier — so the sample is assembled from the persisted
  // attempt rather than hand-written.
  const persisted = JSON.parse(String(attempt?.errorJson ?? "{}")) as {
    details?: { quotaResetAtMs?: number };
  };
  const waitReason = {
    _tag: "Quota" as const,
    quotaBlockedCount: 1,
    blocked: [
      {
        nodeId: family.nodeId,
        message: family.message,
        ...(persisted.details?.quotaResetAtMs != null
          ? { resetAtMs: persisted.details.quotaResetAtMs }
          : {}),
      },
    ],
  };
  const wakeAt = resolveQuotaWakeAt(waitReason, seam, NOW);
  const annotation = waitingAnnotationForWaitReason(waitReason, { quotaWakeAtMs: wakeAt ?? undefined });
  const declaration = await seam.declareAnnotation(annotation);
  expect(declaration.runStatus).toBe("waiting-quota");

  // The durable shape is built by the engine's own `buildWaitingRunPatch`, the
  // function `markRunWaiting` writes every park with, so this parks the run the
  // way the engine parks it rather than restating the columns.
  await Effect.runPromise(
    adapter.updateRun(
      family.runId,
      buildWaitingRunPatch(annotation, {
        quotaMetadataJson: JSON.stringify({ quotaBlockedCount: 1, blocked: waitReason.blocked }),
      }) as Parameters<SmithersDb["updateRun"]>[1],
    ),
  );
  return wakeAt;
}

beforeEach(() => {
  store = openStore();
});

afterEach(() => {
  try {
    store.sqlite.close();
  } catch {}
  rmSync(store.dir, { recursive: true, force: true });
});

describe("case35: quota park then wake, per provider family", () => {
  for (const family of FAMILIES) {
    test(`${family.id}: parks with a wakeAt and wakes on the durable clock`, async () => {
      await seedQuotaFailure(store.adapter, family);
      const wakeAt = await parkOnQuota(store.adapter, family);

      // The provider told us when the limit lifts, and the park carries it.
      expect(wakeAt).not.toBeNull();
      expect(wakeAt!).toBeGreaterThan(NOW);

      const parked = await Effect.runPromise(store.adapter.getRun(family.runId));
      expect(parked?.status).toBe("waiting-quota");
      expect(parked?.heartbeatAtMs ?? null).toBeNull();
      expect(waitingAnnotationFromRunRow(parked)).toEqual({ reason: "quota", wakeAt: wakeAt! });

      // Before the deadline the run is not due, on either reader.
      expect(await runsDueForQuotaResume(store.adapter, wakeAt! - 1)).toEqual([]);
      const early = createRunDriverSweep({
        adapter: store.adapter,
        nowMs: () => wakeAt! - 1,
        drive: async () => {
          throw new Error("woke a run that was not due");
        },
      });
      expect((await early.sweep()).driven).toEqual([]);

      // At the deadline it is due, and the run driver's own sweep picks it up.
      const due = await runsDueForQuotaResume(store.adapter, wakeAt!);
      expect(due.map((run) => run.runId)).toEqual([family.runId]);

      const woken: string[] = [];
      const sweep = createRunDriverSweep({
        adapter: store.adapter,
        nowMs: () => wakeAt!,
        drive: async (candidate) => {
          woken.push(candidate.runId);
          expect(candidate.kind).toBe("due-wake");
          expect(candidate.annotation).toEqual({ reason: "quota", wakeAt: wakeAt! });
        },
      });
      expect((await sweep.sweep()).driven).toHaveLength(1);
      expect(woken).toEqual([family.runId]);
    });

    test(`${family.id}: the quota failure never spends a retry`, async () => {
      await seedQuotaFailure(store.adapter, family);
      const seam = createWaitingSeam({ nowMs: () => NOW });
      const attempt = await Effect.runPromise(store.adapter.getAttempt(family.runId, family.nodeId, 0, 1));
      // Budget already exhausted: a transient failure would fail the task here.
      // A quota failure parks instead, so the retry it did not spend is still
      // there when the provider reset lands.
      expect(seam.resolveRetry(attempt, { attemptsUsed: 99, retries: 0 })).toMatchObject({
        action: "park",
        reason: "quota",
      });
    });
  }

  test("a quota park the provider gave no deadline for waits for an operator, not a hot loop", async () => {
    const family = FAMILIES[0]!;
    await Effect.runPromise(
      store.adapter.insertRun({
        runId: family.runId,
        workflowName: "case35-workflow",
        status: "waiting-quota",
        createdAtMs: NOW,
        startedAtMs: NOW,
        errorJson: JSON.stringify({ quotaBlockedCount: 1 }),
      }),
    );
    expect(await runsDueForQuotaResume(store.adapter, NOW + 86_400_000)).toEqual([]);
    const sweep = createRunDriverSweep({
      adapter: store.adapter,
      nowMs: () => NOW + 86_400_000,
      drive: async () => {
        throw new Error("woke a park with no deadline");
      },
    });
    expect((await sweep.sweep()).driven).toEqual([]);
  });
});
