import { describe, expect, it } from "bun:test";
import type { BenchmarkTask } from "./BenchmarkTask";
import type { Subscription } from "./Subscription";
import { headroomScore } from "./headroomScore";
import { planShards } from "./planShards";

const tasks = (n: number, benchmark = "swe-bench-pro"): BenchmarkTask[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${benchmark}:task-${String(i).padStart(3, "0")}`,
    benchmark,
  }));

const subs = (ids: string[], usage?: Subscription["usage"][]): Subscription[] =>
  ids.map((id, i) => ({ id, usage: usage?.[i] }));

describe("headroomScore", () => {
  it("is fully free when there is no usage data", () => {
    expect(headroomScore(undefined)).toBe(1);
    expect(headroomScore({})).toBe(1);
  });

  it("is governed by the most-constrained window", () => {
    expect(headroomScore({ fiveHourPct: 10, weeklyPct: 20, weeklyOpusPct: 90 })).toBeCloseTo(0.1);
  });

  it("clamps to [0,1]", () => {
    expect(headroomScore({ weeklyOpusPct: 150 })).toBe(0);
    expect(headroomScore({ weeklyOpusPct: -5 })).toBe(1);
  });
});

describe("planShards", () => {
  it("throws with no subscriptions", () => {
    expect(() => planShards(tasks(3), [])).toThrow();
  });

  it("round-robins evenly when no usage data is present", () => {
    const shards = planShards(tasks(6), subs(["a", "b", "c"]));
    expect(shards.map((s) => s.tasks.length)).toEqual([2, 2, 2]);
    // every task is placed exactly once
    const placed = shards.flatMap((s) => s.tasks.map((t) => t.id)).sort();
    expect(placed).toEqual(tasks(6).map((t) => t.id).sort());
  });

  it("keeps shards within one task of each other for uneven counts", () => {
    const shards = planShards(tasks(7), subs(["a", "b", "c"]));
    const counts = shards.map((s) => s.tasks.length).sort();
    expect(counts).toEqual([2, 2, 3]);
  });

  it("steers work away from a near-exhausted subscription", () => {
    const shards = planShards(
      tasks(20),
      subs(["fresh", "spent"], [{ weeklyOpusPct: 0 }, { weeklyOpusPct: 100 }]),
    );
    const fresh = shards.find((s) => s.subscriptionId === "fresh")!;
    const spent = shards.find((s) => s.subscriptionId === "spent")!;
    expect(fresh.tasks.length).toBeGreaterThan(spent.tasks.length);
    // a fully-spent sub should get at most a rounding sliver, never a real share
    expect(spent.tasks.length).toBeLessThanOrEqual(1);
  });

  it("splits proportionally to headroom", () => {
    // fresh has 2x the headroom of half, so ~2:1 split of 30 tasks
    const shards = planShards(
      tasks(30),
      subs(["fresh", "half"], [{ weeklyOpusPct: 0 }, { weeklyOpusPct: 50 }]),
    );
    const fresh = shards.find((s) => s.subscriptionId === "fresh")!.tasks.length;
    const half = shards.find((s) => s.subscriptionId === "half")!.tasks.length;
    expect(fresh).toBe(20);
    expect(half).toBe(10);
  });

  it("is deterministic across runs", () => {
    const s = subs(["a", "b", "c"], [{ fiveHourPct: 30 }, undefined, { weeklyOpusPct: 60 }]);
    const a = planShards(tasks(25), s);
    const b = planShards(tasks(25), s);
    expect(a).toEqual(b);
  });

  it("puts everything on a single subscription", () => {
    const shards = planShards(tasks(9), subs(["solo"]));
    expect(shards).toHaveLength(1);
    expect(shards[0].tasks).toHaveLength(9);
  });

  it("leaves extra subscriptions empty without crashing", () => {
    const shards = planShards(tasks(2), subs(["a", "b", "c", "d"]));
    expect(shards).toHaveLength(4);
    expect(shards.reduce((n, s) => n + s.tasks.length, 0)).toBe(2);
  });

  it("respects task weight so heavy tasks spread out", () => {
    const heavy: BenchmarkTask[] = [
      { id: "roadmapbench:big-1", benchmark: "roadmapbench", weight: 5 },
      { id: "swe:small-1", benchmark: "swe-bench-pro", weight: 1 },
      { id: "swe:small-2", benchmark: "swe-bench-pro", weight: 1 },
      { id: "swe:small-3", benchmark: "swe-bench-pro", weight: 1 },
      { id: "swe:small-4", benchmark: "swe-bench-pro", weight: 1 },
    ];
    const shards = planShards(heavy, subs(["a", "b"]));
    // the big task lands alone; the four light ones balance the other shard
    const weights = shards.map((s) => s.totalWeight).sort((x, y) => x - y);
    expect(weights).toEqual([4, 5]);
  });
});
