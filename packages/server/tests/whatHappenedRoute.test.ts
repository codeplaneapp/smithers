/**
 * whatHappenedRoute: validation, run/node fact fallbacks, the injected
 * narrator seam, and the terminal-state summary cache.
 */
import { describe, expect, test } from "bun:test";
import { whatHappenedRoute, WhatHappenedRouteError } from "../src/gatewayRoutes/whatHappened.js";

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    workflowName: "deploy",
    status: "finished",
    createdAtMs: NOW - 10_000,
    startedAtMs: NOW - 9_000,
    finishedAtMs: NOW,
    errorJson: null,
    ...overrides,
  };
}

function makeAdapter(state: Record<string, unknown> = {}) {
  const data = {
    run: runRow(),
    nodes: [{ runId: "run-1", nodeId: "task", iteration: 0, state: "finished", lastAttempt: 1, updatedAtMs: NOW }],
    attempts: [{ attempt: 1, state: "finished", startedAtMs: NOW - 5_000, finishedAtMs: NOW - 1_000, errorJson: null }],
    ...state,
  };
  return {
    getRun: async () => data.run,
    listNodeIterations: async () => data.nodes,
    listAttempts: async () => data.attempts,
  };
}

function makeParams(overrides: Record<string, unknown> = {}) {
  const adapter = (overrides.adapter as ReturnType<typeof makeAdapter>) ?? makeAdapter();
  return {
    runId: "run-1",
    nodeId: undefined,
    iteration: undefined,
    resolveRun: async () => ({ workflow: {}, adapter }),
    now: () => NOW,
    ...overrides,
  } as Parameters<typeof whatHappenedRoute>[0];
}

describe("whatHappenedRoute validation", () => {
  test("rejects a malformed runId", async () => {
    await expect(whatHappenedRoute(makeParams({ runId: "NOT VALID!" }))).rejects.toBeInstanceOf(WhatHappenedRouteError);
    await expect(whatHappenedRoute(makeParams({ runId: "NOT VALID!" }))).rejects.toMatchObject({
      code: "InvalidRunId",
    });
  });

  test("rejects a malformed nodeId and iteration", async () => {
    await expect(whatHappenedRoute(makeParams({ nodeId: "bad node!" }))).rejects.toMatchObject({
      code: "InvalidNodeId",
    });
    await expect(whatHappenedRoute(makeParams({ nodeId: "task", iteration: -1 }))).rejects.toMatchObject({
      code: "InvalidIteration",
    });
  });

  test("accepts an engine-generated child runId", async () => {
    const runId = "parent:child:review-lane:2";
    const payload = await whatHappenedRoute(
      makeParams({
        runId,
        adapter: makeAdapter({
          run: runRow({ runId }),
          nodes: [{ runId, nodeId: "task", iteration: 0, state: "finished", lastAttempt: 1, updatedAtMs: NOW }],
        }),
      }),
    );
    expect(payload.runId).toBe(runId);
  });

  test("maps a missing run and node to RunNotFound / NodeNotFound", async () => {
    await expect(whatHappenedRoute(makeParams({ resolveRun: async () => null }))).rejects.toMatchObject({
      code: "RunNotFound",
    });
    await expect(
      whatHappenedRoute(makeParams({ adapter: makeAdapter({ nodes: [] }), nodeId: "task" })),
    ).rejects.toMatchObject({ code: "NodeNotFound" });
    await expect(whatHappenedRoute(makeParams({ nodeId: "task", iteration: 7 }))).rejects.toMatchObject({
      code: "IterationNotFound",
    });
  });
});

describe("whatHappenedRoute fact fallback", () => {
  test("run scope answers from the run row with no narrator", async () => {
    const payload = await whatHappenedRoute(makeParams());
    expect(payload.scope).toBe("run");
    expect(payload.nodeId).toBeNull();
    expect(payload.iteration).toBeNull();
    expect(payload.source).toBe("facts");
    expect(payload.agentId).toBeNull();
    expect(payload.cached).toBe(false);
    expect(payload.generatedAtMs).toBe(NOW);
    expect(payload.summary).toContain("Run run-1 (deploy) finished");
  });

  test("node scope resolves the latest iteration and surfaces the attempt error", async () => {
    const adapter = makeAdapter({
      nodes: [
        { runId: "run-1", nodeId: "task", iteration: 0, state: "finished", lastAttempt: 1, updatedAtMs: NOW },
        { runId: "run-1", nodeId: "task", iteration: 2, state: "failed", lastAttempt: 3, updatedAtMs: NOW },
      ],
      attempts: [
        {
          attempt: 1,
          state: "failed",
          startedAtMs: NOW - 5_000,
          finishedAtMs: NOW - 4_000,
          errorJson: JSON.stringify({ message: "boom" }),
        },
      ],
    });
    const payload = await whatHappenedRoute(makeParams({ adapter, nodeId: "task" }));
    expect(payload.scope).toBe("node");
    expect(payload.iteration).toBe(2);
    expect(payload.summary).toContain('Node "task" failed after 1 attempt');
    expect(payload.summary).toContain("boom");
  });
});

describe("whatHappenedRoute narrator seam", () => {
  test("prefers the injected narrator and reports its agent", async () => {
    const payload = await whatHappenedRoute(
      makeParams({
        summarize: async () => ({ summary: "Everything shipped cleanly.", agentId: "luna", source: "agent" }),
      }),
    );
    expect(payload.source).toBe("agent");
    expect(payload.agentId).toBe("luna");
    expect(payload.summary).toBe("Everything shipped cleanly.");
  });

  test("a throwing or empty narrator degrades to the fact recap", async () => {
    const throwing = await whatHappenedRoute(
      makeParams({
        summarize: async () => {
          throw new Error("agent died");
        },
      }),
    );
    expect(throwing.source).toBe("facts");
    expect(throwing.summary).toContain("Run run-1");
    const empty = await whatHappenedRoute(makeParams({ summarize: async () => ({ summary: "  " }) }));
    expect(empty.source).toBe("facts");
  });
});

describe("whatHappenedRoute cache", () => {
  test("caches terminal targets per state fingerprint and skips the narrator on a hit", async () => {
    const cache = new Map();
    let calls = 0;
    const params = () =>
      makeParams({
        cache,
        summarize: async () => {
          calls += 1;
          return { summary: "Shipped.", agentId: "luna" };
        },
      });
    const first = await whatHappenedRoute(params());
    expect(first.cached).toBe(false);
    const second = await whatHappenedRoute(params());
    expect(second.cached).toBe(true);
    expect(second.summary).toBe("Shipped.");
    expect(calls).toBe(1);
  });

  test("does not cache a live target", async () => {
    const cache = new Map();
    let calls = 0;
    const adapter = makeAdapter({ run: runRow({ status: "running", finishedAtMs: null }) });
    const params = () =>
      makeParams({
        adapter,
        cache,
        summarize: async () => {
          calls += 1;
          return { summary: "Still going.", agentId: "luna" };
        },
      });
    await whatHappenedRoute(params());
    const second = await whatHappenedRoute(params());
    expect(second.cached).toBe(false);
    expect(calls).toBe(2);
    expect(cache.size).toBe(0);
  });

  test("caches a stalled node as a terminal target", async () => {
    const cache = new Map();
    let calls = 0;
    const adapter = makeAdapter({
      nodes: [{ runId: "run-1", nodeId: "task", iteration: 0, state: "stalled", lastAttempt: 3, updatedAtMs: NOW }],
    });
    const params = () =>
      makeParams({
        adapter,
        cache,
        nodeId: "task",
        summarize: async () => {
          calls += 1;
          return { summary: "The node repeated the same failure.", agentId: "luna" };
        },
      });
    expect((await whatHappenedRoute(params())).cached).toBe(false);
    expect((await whatHappenedRoute(params())).cached).toBe(true);
    expect(calls).toBe(1);
  });
});
