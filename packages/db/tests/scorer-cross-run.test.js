import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";

let sqlite;

afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
});

function createDb() {
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return new SmithersDb(db);
}

describe("cross-run scorer persistence queries", () => {
  test("counts, filters, orders, pages, and reads exact persisted ids", async () => {
    const adapter = createDb();
    const now = 1_700_000_000_000;
    await adapter.insertRun({ runId: "r1", workflowName: "wf", status: "finished", createdAtMs: now });
    await adapter.insertRun({ runId: "r2", workflowName: "wf", status: "finished", createdAtMs: now + 1 });
    await adapter.insertScorerResult({
      id: "s1",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      attempt: 0,
      scorerId: "sc",
      scorerName: "Scorer",
      source: "live",
      score: 0.9,
      scoredAtMs: now,
      metaJson: '{"rubric":"quality"}',
    });
    await adapter.insertScorerResult({
      id: "s2",
      runId: "r2",
      nodeId: "n2",
      iteration: 0,
      attempt: 0,
      scorerId: "sc",
      scorerName: "Scorer",
      source: "live",
      score: 0.8,
      scoredAtMs: now + 1,
    });
    await adapter.insertScorerResult({
      id: "s3",
      runId: "r2",
      nodeId: "n1",
      iteration: 0,
      attempt: 0,
      scorerId: "other",
      scorerName: "Other",
      source: "batch",
      score: 0.7,
      scoredAtMs: now + 2,
    });

    expect(await adapter.countScorerResultsForRuns({ runIds: ["r1", "r2"] })).toBe(3);
    expect(
      await adapter.countScorerResultsForRuns({
        runIds: ["r1", "r2"],
        nodeId: "n1",
        scorerId: "sc",
        scorerName: "Scorer",
        source: "live",
      }),
    ).toBe(1);
    expect(await adapter.countScorerResultsForRuns({ runIds: [] })).toBe(0);

    const desc = await adapter.listScorerResultsForRuns({
      runIds: ["r1", "r2"],
      order: "scoredAtDesc",
      offset: 0,
      limit: 2,
    });
    expect(desc.map((row) => row.id)).toEqual(["s3", "s2"]);
    for (const detailColumn of ["metaJson", "inputJson", "outputJson", "groundTruthJson", "contextJson"]) {
      expect(desc[0]).not.toHaveProperty(detailColumn);
    }
    const page = await adapter.listScorerResultsForRuns({
      runIds: ["r1", "r2"],
      source: "live",
      order: "scoredAtAsc",
      offset: 1,
      limit: 1,
    });
    expect(page.map((row) => row.id)).toEqual(["s2"]);
    expect(await adapter.listScorerResultsForRuns({ runIds: [], order: "scoredAtAsc", offset: 0, limit: 1 })).toEqual(
      [],
    );
    expect((await adapter.getScorerResult("r1", "s1"))?.metaJson).toBe('{"rubric":"quality"}');
    expect(await adapter.getScorerResult("r2", "s1")).toBeUndefined();
  });
});
