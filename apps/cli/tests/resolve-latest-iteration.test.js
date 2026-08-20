import { describe, expect, test } from "bun:test";
import { resolveLatestIteration } from "../src/util/resolveLatestIteration.js";

/**
 * @param {Array<Record<string, unknown>>} iterations
 */
function adapterWith(iterations) {
  return {
    async listNodeIterations() {
      return iterations;
    },
  };
}

describe("resolveLatestIteration", () => {
  test("skips an in-flight round so a finished round's data stays readable", async () => {
    // A review loop that just queued round 2 while round 1 holds the output.
    const adapter = adapterWith([
      { iteration: 0, status: "finished" },
      { iteration: 1, status: "finished" },
      { iteration: 2, status: "in-progress" },
    ]);
    expect(await resolveLatestIteration(adapter, "run-1", "lane:review")).toBe(1);
  });

  test("prefers the newest settled round, not the first one found", async () => {
    const adapter = adapterWith([
      { iteration: 2, status: "finished" },
      { iteration: 0, status: "finished" },
      { iteration: 3, status: "pending" },
    ]);
    expect(await resolveLatestIteration(adapter, "run-1", "lane:review")).toBe(2);
  });

  test("reads failed and cancelled rounds, which explain what went wrong", async () => {
    const adapter = adapterWith([
      { iteration: 0, status: "failed" },
      { iteration: 1, status: "in-progress" },
    ]);
    expect(await resolveLatestIteration(adapter, "run-1", "lane:implement")).toBe(0);

    const cancelled = adapterWith([
      { iteration: 0, status: "cancelled" },
      { iteration: 1, status: "running" },
    ]);
    expect(await resolveLatestIteration(cancelled, "run-1", "lane:implement")).toBe(0);
  });

  test("falls back to the highest iteration when none has settled", async () => {
    const adapter = adapterWith([
      { iteration: 0, status: "pending" },
      { iteration: 1, status: "in-progress" },
    ]);
    expect(await resolveLatestIteration(adapter, "run-1", "lane:gate")).toBe(1);
  });

  test("treats a single finished node as iteration 0", async () => {
    const adapter = adapterWith([{ iteration: 0, status: "finished" }]);
    expect(await resolveLatestIteration(adapter, "run-1", "task-a")).toBe(0);
  });

  test("tolerates rows with a non-numeric iteration or missing status", async () => {
    const adapter = adapterWith([{ iteration: "bad", status: "finished" }, { iteration: 4 }]);
    expect(await resolveLatestIteration(adapter, "run-1", "task-a")).toBe(0);
  });

  test("returns null when the node has no iterations", async () => {
    expect(await resolveLatestIteration(adapterWith([]), "run-1", "task-a")).toBeNull();
  });

  test("returns null when the adapter throws", async () => {
    const adapter = {
      async listNodeIterations() {
        throw new Error("db is locked");
      },
    };
    expect(await resolveLatestIteration(adapter, "run-1", "task-a")).toBeNull();
  });
});
