import { describe, expect, test } from "bun:test";
import { buildCacheScopeIdentity, isFreshCacheRow, normalizeCacheScope } from "../src/cache-policy.js";

const desc = {
  nodeId: "task-a",
  outputTableName: "output_task_a",
  cachePolicy: { key: "shared-key" },
};

describe("cache policy helpers", () => {
  test("normalizes cache scope with workflow as the default", () => {
    expect(normalizeCacheScope(undefined)).toBe("workflow");
    expect(normalizeCacheScope({ scope: "run" })).toBe("run");
    expect(normalizeCacheScope({ scope: "workflow" })).toBe("workflow");
    expect(normalizeCacheScope({ scope: "global" })).toBe("global");
    expect(normalizeCacheScope({ scope: "unknown" })).toBe("workflow");
  });

  test("builds scope identities without cross-scope collisions", () => {
    expect(buildCacheScopeIdentity("run", "run-1", "wf", desc)).toEqual({
      runId: "run-1",
      workflowName: "wf",
      taskKey: "shared-key",
      outputTableName: "output_task_a",
    });
    expect(buildCacheScopeIdentity("workflow", "run-1", "wf", desc)).toEqual({
      workflowName: "wf",
      taskKey: "shared-key",
      outputTableName: "output_task_a",
    });
    expect(buildCacheScopeIdentity("global", "run-1", "wf", desc)).toEqual({
      taskKey: "shared-key",
      outputTableName: "output_task_a",
    });
  });

  test("treats invalid or expired ttl rows as stale", () => {
    const now = Date.now();
    expect(isFreshCacheRow({ createdAtMs: now }, undefined)).toBe(true);
    expect(isFreshCacheRow({ createdAtMs: now }, { ttlMs: 10_000 })).toBe(true);
    expect(isFreshCacheRow({ createdAtMs: now - 20_000 }, { ttlMs: 10 })).toBe(false);
    expect(isFreshCacheRow({ createdAtMs: now }, { ttlMs: -1 })).toBe(false);
    expect(isFreshCacheRow({ createdAtMs: "now" }, { ttlMs: 10_000 })).toBe(false);
  });
});
