import { describe, expect, test } from "bun:test";
import {
  buildRateModel,
  estimateInFlight,
  foldTokenUsage,
  formatTokenRange,
  formatTokens,
  nodeUsageBreakdown,
  predictNodeDurationMs,
  predictRunUsage,
  rateForNode,
  subtreeTokenTotals,
  tokenBurnBuckets,
  totalTokensOf,
  type RateModel,
  type TokenUsageEvent,
  type TreeNode,
} from "../src/monitor-ui/usagePrediction.ts";

describe("token usage folding", () => {
  test("sums every reported counter and treats missing fields as zero", () => {
    expect(
      totalTokensOf({
        nodeId: "build",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        reasoningTokens: 2,
      }),
    ).toBe(27);

    const fold = foldTokenUsage([
      { nodeId: "build", inputTokens: 10, outputTokens: 5 },
      {
        nodeId: "build",
        iteration: 1,
        attempt: 2,
        model: "model-a",
        agent: "codex",
        outputTokens: 4,
        cacheReadTokens: 6,
        cacheWriteTokens: 2,
        reasoningTokens: 3,
      },
      { nodeId: "test" },
    ]);

    expect(fold.grandTotal).toBe(30);
    expect(fold.eventCount).toBe(3);
    expect([...fold.perNode]).toEqual([
      ["build", 30],
      ["test", 0],
    ]);
    expect([...fold.perAgent]).toEqual([["codex", 15]]);
    expect([...fold.perModel]).toEqual([["model-a", 15]]);
    expect([...fold.perNodeAttempts.get("build")!]).toEqual([
      ["0:0", 15],
      ["1:2", 15],
    ]);
  });
});

describe("throughput rates", () => {
  test("uses the median completed-attempt rate instead of an outlier-sensitive mean", () => {
    const events: TokenUsageEvent[] = [10, 10, 1_000].map((outputTokens, iteration) => ({
      nodeId: "worker",
      iteration,
      attempt: 1,
      model: "model-a",
      outputTokens,
    }));
    const timings = [0, 1, 2].map((iteration) => ({
      nodeId: "worker",
      iteration,
      attempt: 1,
      startedAtMs: iteration * 2_000,
      finishedAtMs: iteration * 2_000 + 1_000,
    }));

    const rates = buildRateModel(events, timings);
    expect(rates.perNode.get("worker")).toEqual({
      outputTokensPerSecond: 10,
      totalTokensPerSecond: 10,
    });
    expect(rates.perModel.get("model-a")?.totalTokensPerSecond).toBe(10);
    expect(rates.global?.totalTokensPerSecond).toBe(10);
  });

  test("falls back from node to model to run-global throughput", () => {
    const rate = (totalTokensPerSecond: number) => ({
      outputTokensPerSecond: totalTokensPerSecond / 2,
      totalTokensPerSecond,
    });
    const rates: RateModel = {
      perNode: new Map([["node-specific", rate(3)]]),
      perModel: new Map([["shared-model", rate(2)]]),
      global: rate(1),
      modelByNode: new Map([
        ["node-specific", "shared-model"],
        ["model-only", "shared-model"],
      ]),
    };

    expect(rateForNode("node-specific", rates)?.totalTokensPerSecond).toBe(3);
    expect(estimateInFlight("node-specific", 3_000, rates)).toBe(9);
    expect(estimateInFlight("model-only", 3_000, rates)).toBe(6);
    expect(estimateInFlight("global-only", 3_000, rates)).toBe(3);
  });

  test("leaves in-flight spend unknown when no completed rate exists", () => {
    const rates = buildRateModel([{ nodeId: "live", outputTokens: 10 }], []);
    expect(rateForNode("live", rates)).toBeUndefined();
    expect(estimateInFlight("live", 5_000, rates)).toBeUndefined();
  });
});

describe("duration prediction", () => {
  test("requires at least two completed samples", () => {
    expect(
      predictNodeDurationMs("build", [
        { nodeId: "build", startedAtMs: 0, finishedAtMs: 1_000 },
        { nodeId: "build", startedAtMs: 2_000 },
      ]),
    ).toBeUndefined();
  });

  test("uses loop iterations as independent duration samples", () => {
    const timings = [1_000, 2_000, 3_000, 4_000].map((duration, iteration) => ({
      nodeId: "loop-body",
      iteration,
      startedAtMs: iteration * 10_000,
      finishedAtMs: iteration * 10_000 + duration,
    }));
    expect(predictNodeDurationMs("loop-body", timings)).toEqual({
      low: 1_750,
      median: 2_500,
      high: 3_250,
    });
  });
});

describe("run prediction", () => {
  test("combines running spend and pending interquartile ranges and brackets the median case", () => {
    const events: TokenUsageEvent[] = [
      { nodeId: "running", iteration: 0, attempt: 1, model: "m", outputTokens: 100 },
      { nodeId: "running", iteration: 1, attempt: 1, model: "m", outputTokens: 200 },
      { nodeId: "pending", iteration: 0, attempt: 1, model: "m", outputTokens: 300 },
      { nodeId: "pending", iteration: 1, attempt: 1, model: "m", outputTokens: 500 },
    ];
    const timings = [
      { nodeId: "running", iteration: 0, attempt: 1, startedAtMs: 0, finishedAtMs: 1_000 },
      { nodeId: "running", iteration: 1, attempt: 1, startedAtMs: 1_000, finishedAtMs: 3_000 },
      { nodeId: "pending", iteration: 0, attempt: 1, startedAtMs: 3_000, finishedAtMs: 6_000 },
      { nodeId: "pending", iteration: 1, attempt: 1, startedAtMs: 6_000, finishedAtMs: 11_000 },
      { nodeId: "running", iteration: 2, attempt: 1, startedAtMs: 12_000, status: "running" },
    ];
    const tree: TreeNode = {
      id: "root",
      kind: "sequence",
      status: "running",
      children: [
        { id: "running", kind: "task", status: "running", agent: { model: "m" } },
        { id: "pending", kind: "task", status: "pending", agent: { model: "m" } },
      ],
    };

    const prediction = predictRunUsage({ events, timings, tree, nowMs: 13_000 });
    const medianTokenCase = 1_100 + 100 + 400;
    const medianEtaCase = 500 + 4_000;

    expect(prediction.spentTokens).toBe(1_100);
    expect(prediction.inFlightTokens).toBe(100);
    expect(prediction.predictedTotalLow).toBe(1_550);
    expect(prediction.predictedTotalHigh).toBe(1_650);
    expect(prediction.predictedTotalLow).toBeLessThan(medianTokenCase);
    expect(prediction.predictedTotalHigh).toBeGreaterThan(medianTokenCase);
    expect(prediction.etaLowMs).toBe(3_750);
    expect(prediction.etaHighMs).toBe(5_250);
    expect(prediction.etaLowMs!).toBeLessThan(medianEtaCase);
    expect(prediction.etaHighMs!).toBeGreaterThan(medianEtaCase);
    expect(prediction.confidence).toBe("high");
    expect(prediction.perNode.get("running")).toEqual({
      spent: 300,
      inFlight: 100,
      predictedDurationMs: { low: 1_250, median: 1_500, high: 1_750 },
    });
  });

  test("uses exact 80% and 50% historical-coverage confidence thresholds", () => {
    const predictionAt = (sampled: number) => {
      const children: TreeNode[] = Array.from({ length: 5 }, (_, index) => ({
        id: `node-${index}`,
        kind: "task",
        status: "pending",
      }));
      const events = children.slice(0, sampled).map((node) => ({ nodeId: node.id!, outputTokens: 10 }));
      return predictRunUsage({
        events,
        timings: [],
        tree: { id: "root", kind: "parallel", children },
        nowMs: 10_000,
      }).confidence;
    };

    expect(predictionAt(4)).toBe("high");
    expect(predictionAt(3)).toBe("medium");
    expect(predictionAt(2)).toBe("low");
  });

  test("drops orphaned active timings once the run is terminal", () => {
    const prediction = predictRunUsage({
      events: [{ nodeId: "work", inputTokens: 10, outputTokens: 5 }],
      timings: [{ nodeId: "work", startedAtMs: 1_000, status: "running" }],
      tree: { id: "work", kind: "task", status: "running" },
      nowMs: 61_000,
      live: false,
    });

    expect(prediction.inFlightTokens).toBeUndefined();
    expect(prediction.predictedTotalLow).toBe(15);
    expect(prediction.predictedTotalHigh).toBe(15);
    expect(prediction.etaLowMs).toBeUndefined();
    expect(prediction.etaHighMs).toBeUndefined();
    expect(prediction.perNode.get("work")?.inFlight).toBeUndefined();
  });

  test("divides ETA by concurrency observed in overlapping timing windows", () => {
    const timings = [
      { nodeId: "a", iteration: 0, startedAtMs: 0, finishedAtMs: 1_000 },
      { nodeId: "b", iteration: 0, startedAtMs: 0, finishedAtMs: 1_000 },
      { nodeId: "a", iteration: 1, startedAtMs: 2_000, finishedAtMs: 3_000 },
      { nodeId: "b", iteration: 1, startedAtMs: 2_000, finishedAtMs: 3_000 },
    ];
    const prediction = predictRunUsage({
      events: [
        { nodeId: "a", iteration: 0, outputTokens: 10 },
        { nodeId: "b", iteration: 0, outputTokens: 10 },
      ],
      timings,
      tree: {
        id: "root",
        kind: "parallel",
        status: "running",
        children: [
          { id: "a", kind: "task", status: "pending" },
          { id: "b", kind: "task", status: "pending" },
        ],
      },
      nowMs: 4_000,
    });

    expect(prediction.etaLowMs).toBe(1_000);
    expect(prediction.etaHighMs).toBe(1_000);
  });
});

describe("token formatting", () => {
  test("formats compact monitor labels", () => {
    expect(formatTokens(842)).toBe("842");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(3_200_000)).toBe("3.2M");
    expect(formatTokens(8_000_000_000)).toBe("8B");
  });

  test("formats ranges sharing the unit suffix once", () => {
    expect(formatTokenRange(260_000, 340_000)).toBe("260–340k");
    expect(formatTokenRange(1_200_000, 3_400_000)).toBe("1.2–3.4M");
    expect(formatTokenRange(800, 1_500)).toBe("800–1.5k");
    expect(formatTokenRange(260_000, 260_000)).toBe("260k");
    expect(formatTokenRange(300, 900)).toBe("300–900");
  });
});

describe("token burn buckets", () => {
  test("aligns per-bucket totals ending at the bucket containing nowMs", () => {
    const events: TokenUsageEvent[] = [
      { nodeId: "a", outputTokens: 10, timestampMs: 61_000 },
      { nodeId: "a", outputTokens: 5, cacheReadTokens: 5, timestampMs: 119_000 },
      { nodeId: "b", outputTokens: 30, timestampMs: 125_000 },
      { nodeId: "a", outputTokens: 99, timestampMs: 5_000 },
    ];
    const buckets = tokenBurnBuckets(events, 60_000, 130_000, 3);
    expect(buckets).toEqual([
      { startMs: 0, tokens: 99 },
      { startMs: 60_000, tokens: 20 },
      { startMs: 120_000, tokens: 30 },
    ]);
  });

  test("skips untimestamped events and events outside the window", () => {
    const buckets = tokenBurnBuckets(
      [
        { nodeId: "a", outputTokens: 50 },
        { nodeId: "a", outputTokens: 7, timestampMs: 190_000 },
      ],
      60_000,
      130_000,
      3,
    );
    expect(buckets.map((bucket) => bucket.tokens)).toEqual([0, 0, 0]);
  });

  test("returns no buckets for a non-positive bucket width", () => {
    expect(tokenBurnBuckets([{ nodeId: "a", outputTokens: 1, timestampMs: 0 }], 0, 10_000)).toEqual([]);
  });
});

describe("subtree token rollup", () => {
  test("sums per-node totals over each subtree, keyed by id with key fallback", () => {
    const tree: TreeNode = {
      id: "root",
      kind: "sequence",
      children: [
        {
          id: "branch",
          kind: "parallel",
          children: [
            { id: "leaf-a", kind: "task" },
            { key: "leaf-b-key", kind: "task" },
          ],
        },
        { id: "leaf-c", kind: "task" },
      ],
    };
    const totals = subtreeTokenTotals(
      tree,
      new Map([
        ["leaf-a", 10],
        ["leaf-b-key", 5],
        ["leaf-c", 3],
      ]),
    );
    expect(totals.get("leaf-a")).toBe(10);
    expect(totals.get("leaf-b-key")).toBe(5);
    expect(totals.get("branch")).toBe(15);
    expect(totals.get("root")).toBe(18);
  });

  test("tolerates an empty tree and unknown ids", () => {
    expect(subtreeTokenTotals(null, new Map([["a", 1]]))).toEqual(new Map());
    const totals = subtreeTokenTotals({ id: "solo", kind: "task" }, new Map([["other", 4]]));
    expect(totals.get("solo")).toBe(0);
  });
});

describe("node usage breakdown", () => {
  test("sums counters and groups per attempt with the observed model", () => {
    const events: TokenUsageEvent[] = [
      {
        nodeId: "build",
        iteration: 0,
        attempt: 1,
        model: "model-a",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
      },
      { nodeId: "build", iteration: 0, attempt: 1, model: "model-a", outputTokens: 3, reasoningTokens: 1 },
      { nodeId: "build", iteration: 0, attempt: 2, model: "model-b", outputTokens: 8, cacheWriteTokens: 4 },
      { nodeId: "other", outputTokens: 100 },
    ];
    const breakdown = nodeUsageBreakdown(events, "build")!;
    expect(breakdown.input).toBe(10);
    expect(breakdown.output).toBe(16);
    expect(breakdown.cacheRead).toBe(2);
    expect(breakdown.cacheWrite).toBe(4);
    expect(breakdown.reasoning).toBe(1);
    expect(breakdown.total).toBe(33);
    expect(breakdown.attempts).toEqual([
      { iteration: 0, attempt: 1, model: "model-a", total: 21 },
      { iteration: 0, attempt: 2, model: "model-b", total: 12 },
    ]);
  });

  test("orders attempts by iteration then attempt and stays undefined for unknown nodes", () => {
    const events: TokenUsageEvent[] = [
      { nodeId: "loop", iteration: 1, attempt: 1, outputTokens: 4 },
      { nodeId: "loop", iteration: 0, attempt: 2, outputTokens: 2 },
      { nodeId: "loop", iteration: 0, attempt: 1, outputTokens: 1 },
    ];
    const breakdown = nodeUsageBreakdown(events, "loop")!;
    expect(breakdown.attempts.map((attempt) => `${attempt.iteration}:${attempt.attempt}`)).toEqual([
      "0:1",
      "0:2",
      "1:1",
    ]);
    expect(nodeUsageBreakdown(events, "missing")).toBeUndefined();
    expect(nodeUsageBreakdown([], "loop")).toBeUndefined();
  });
});
