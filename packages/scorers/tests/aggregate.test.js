import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { aggregateScores } from "../src/aggregate.js";
import crypto from "node:crypto";
describe("aggregateScores", () => {
  let db;
  let adapter;
  let nextAttempt;
  beforeEach(() => {
    const sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    ensureSmithersTables(db);
    adapter = new SmithersDb(db);
    nextAttempt = 1;
  });
  /**
   * @param {Partial<{ id: string; runId: string; nodeId: string; iteration: number; attempt: number; scorerId: string; scorerName: string; source: string; score: number; reason: string | null; metaJson: string | null; inputJson: string | null; outputJson: string | null; latencyMs: number | null; scoredAtMs: number; durationMs: number | null; }>} [overrides]
   */
  async function insertScore(overrides = {}) {
    const row = {
      id: overrides.id ?? crypto.randomUUID(),
      runId: overrides.runId ?? "run-1",
      nodeId: overrides.nodeId ?? "task-1",
      iteration: overrides.iteration ?? 0,
      attempt: overrides.attempt ?? nextAttempt++,
      scorerId: overrides.scorerId ?? "test-scorer",
      scorerName: overrides.scorerName ?? "Test Scorer",
      source: overrides.source ?? "batch",
      score: overrides.score ?? 0.8,
      reason: overrides.reason ?? null,
      metaJson: overrides.metaJson ?? null,
      inputJson: overrides.inputJson ?? null,
      outputJson: overrides.outputJson ?? null,
      latencyMs: overrides.latencyMs ?? null,
      scoredAtMs: overrides.scoredAtMs ?? Date.now(),
      durationMs: overrides.durationMs ?? null,
    };
    await adapter.insertScorerResult(row);
    return row;
  }
  it("returns empty array when no scores exist", async () => {
    const result = await aggregateScores(adapter);
    expect(result).toEqual([]);
  });
  it("aggregates basic statistics for a single scorer", async () => {
    await insertScore({ score: 0.6 });
    await insertScore({ score: 0.8 });
    await insertScore({ score: 1.0 });
    const result = await aggregateScores(adapter);
    expect(result).toHaveLength(1);
    expect(result[0].scorerId).toBe("test-scorer");
    expect(result[0].count).toBe(3);
    expect(result[0].mean).toBeCloseTo(0.8, 1);
    expect(result[0].min).toBeCloseTo(0.6, 1);
    expect(result[0].max).toBeCloseTo(1.0, 1);
  });
  it("aggregates multiple scorers independently", async () => {
    await insertScore({ scorerId: "scorer-a", scorerName: "Scorer A", score: 0.9 });
    await insertScore({ scorerId: "scorer-a", scorerName: "Scorer A", score: 0.7 });
    await insertScore({ scorerId: "scorer-b", scorerName: "Scorer B", score: 0.5 });
    const result = await aggregateScores(adapter);
    expect(result).toHaveLength(2);
    const a = result.find((r) => r.scorerId === "scorer-a");
    const b = result.find((r) => r.scorerId === "scorer-b");
    expect(a?.count).toBe(2);
    expect(a?.mean).toBeCloseTo(0.8, 1);
    expect(b?.count).toBe(1);
    expect(b?.mean).toBeCloseTo(0.5, 1);
  });
  it("aggregates renamed scorers independently when they share an id", async () => {
    for (const score of [0.1, 0.2, 0.3]) {
      await insertScore({ scorerId: "quality", scorerName: "Relevancy", score });
    }
    for (const score of [0.8, 0.9]) {
      await insertScore({ scorerId: "quality", scorerName: "Answer Relevancy", score });
    }

    const result = await aggregateScores(adapter);
    const relevancy = result.find((row) => row.scorerName === "Relevancy");
    const answerRelevancy = result.find((row) => row.scorerName === "Answer Relevancy");

    expect(result).toHaveLength(2);
    expect(relevancy).toMatchObject({
      scorerId: "quality",
      scorerName: "Relevancy",
      count: 3,
      min: 0.1,
      max: 0.3,
    });
    expect(relevancy?.mean).toBeCloseTo(0.2, 10);
    expect(relevancy?.p50).toBeCloseTo(0.2, 10);
    expect(relevancy?.stddev).toBeCloseTo(Math.sqrt(1 / 150), 10);
    expect(answerRelevancy).toMatchObject({
      scorerId: "quality",
      scorerName: "Answer Relevancy",
      count: 2,
      min: 0.8,
      max: 0.9,
    });
    expect(answerRelevancy?.mean).toBeCloseTo(0.85, 10);
    expect(answerRelevancy?.p50).toBeCloseTo(0.85, 10);
    expect(answerRelevancy?.stddev).toBeCloseTo(0.05, 10);
  });
  it("filters by runId", async () => {
    await insertScore({ runId: "run-1", scorerId: "s", scorerName: "S", score: 0.9 });
    await insertScore({ runId: "run-2", scorerId: "s", scorerName: "S", score: 0.1 });
    const result = await aggregateScores(adapter, { runId: "run-1" });
    expect(result).toHaveLength(1);
    expect(result[0].mean).toBeCloseTo(0.9, 1);
  });
  it("filters by nodeId", async () => {
    await insertScore({ nodeId: "task-a", scorerId: "s", scorerName: "S", score: 1.0 });
    await insertScore({ nodeId: "task-b", scorerId: "s", scorerName: "S", score: 0.0 });
    const result = await aggregateScores(adapter, { nodeId: "task-a" });
    expect(result).toHaveLength(1);
    expect(result[0].mean).toBeCloseTo(1.0, 1);
  });
  it("filters by scorerId", async () => {
    await insertScore({ scorerId: "latency", scorerName: "Latency", score: 0.7 });
    await insertScore({ scorerId: "schema", scorerName: "Schema", score: 1.0 });
    const result = await aggregateScores(adapter, { scorerId: "latency" });
    expect(result).toHaveLength(1);
    expect(result[0].scorerName).toBe("Latency");
  });
  it("combines filters with bound SQL parameters", async () => {
    const calls = [];
    const mockAdapter = {
      rawQuery: async (sql, params) => {
        calls.push({ sql, params });
        if (calls.length === 1) {
          return [
            {
              scorer_id: "score-'id'",
              scorer_name: "Quoted",
              cnt: 1,
              mean: 0.5,
              min_score: 0.5,
              max_score: 0.5,
            },
          ];
        }
        return [];
      },
    };
    await aggregateScores(mockAdapter, {
      runId: "run-'quoted'",
      nodeId: "node-1",
      scorerId: "score-'id'",
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain("run_id = ?");
      expect(call.sql).toContain("node_id = ?");
      expect(call.sql).toContain("scorer_id = ?");
      expect(call.sql).not.toContain("run-'quoted'");
      expect(call.sql).not.toContain("score-'id'");
      expect(call.params).toEqual(["run-'quoted'", "node-1", "score-'id'"]);
    }
  });
  it("computes p50 (median) correctly", async () => {
    // Insert 5 scores: 0.1, 0.3, 0.5, 0.7, 0.9
    await insertScore({ score: 0.1 });
    await insertScore({ score: 0.3 });
    await insertScore({ score: 0.5 });
    await insertScore({ score: 0.7 });
    await insertScore({ score: 0.9 });
    const result = await aggregateScores(adapter);
    expect(result).toHaveLength(1);
    // Median of [0.1, 0.3, 0.5, 0.7, 0.9] is 0.5
    expect(result[0].p50).toBeCloseTo(0.5, 1);
  });
  it("computes even-length p50 and stddev from score rows", async () => {
    await insertScore({ score: 0.2 });
    await insertScore({ score: 0.4 });
    await insertScore({ score: 0.6 });
    await insertScore({ score: 0.8 });
    const result = await aggregateScores(adapter);
    expect(result).toHaveLength(1);
    expect(result[0].p50).toBeCloseTo(0.5, 5);
    expect(result[0].stddev).toBeCloseTo(Math.sqrt(0.05), 5);
  });
  it("defaults nullable aggregate columns and missing score rows to zero", async () => {
    let callCount = 0;
    const mockAdapter = {
      rawQuery: async () => {
        callCount++;
        if (callCount === 1) {
          return [
            {
              scorer_id: "nullable",
              scorer_name: "Nullable",
              cnt: 1,
              mean: null,
              min_score: null,
              max_score: null,
            },
          ];
        }
        return [];
      },
    };
    const result = await aggregateScores(mockAdapter);
    expect(result).toEqual([
      {
        scorerId: "nullable",
        scorerName: "Nullable",
        count: 1,
        mean: 0,
        min: 0,
        max: 0,
        p50: 0,
        stddev: 0,
      },
    ]);
  });
});
