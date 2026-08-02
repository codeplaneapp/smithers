/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { Workflow, Task, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { isFreshCacheRow } from "../src/cache-policy.js";

const TIMEOUT_MS = 30_000;

function outputShape() {
  return {
    out: z.object({ v: z.number() }),
  };
}

function countingAgent(id) {
  let calls = 0;
  return {
    agent: {
      id,
      tools: {},
      generate: async () => {
        calls += 1;
        return { output: { v: calls } };
      },
    },
    get calls() {
      return calls;
    },
  };
}

// Pin the run to a VCS-free rootDir so the cache key's jj pointer is stable
// even when concurrent commits land in this repo while the test runs.
function stableRootDir() {
  return mkdtempSync(join(tmpdir(), "smithers-cache-root-"));
}

describe("negative explicit retries", () => {
  test(
    "retries={-1} behaves like retries={0}: one attempt, then the run fails",
    async () => {
      const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
      const adapter = new SmithersDb(db);
      try {
        let callCount = 0;
        const agent = {
          id: "negative-retries-agent",
          tools: {},
          async generate() {
            callCount += 1;
            throw new Error("always fails");
          },
        };
        const workflow = smithers(() => (
          <Workflow name="negative-retries">
            <Task id="neg" output={outputs.outputA} agent={agent} retries={-1}>
              Fail once.
            </Task>
          </Workflow>
        ));
        const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
        expect(result.status).toBe("failed");
        expect(callCount).toBe(1);
        const attempts = await adapter.listAttempts(result.runId, "neg", 0);
        expect(attempts).toHaveLength(1);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});

describe("cachePolicy ttlMs boundary", () => {
  test(
    "ttlMs=0 always misses: every run re-executes",
    async () => {
      const { smithers, outputs, cleanup } = createTestSmithers(outputShape());
      const counter = countingAgent("ttl-zero");
      const rootDir = stableRootDir();
      try {
        const workflow = smithers(() => (
          <Workflow name="ttl-zero-cache">
            <Task
              id="t"
              output={outputs.out}
              agent={counter.agent}
              cache={{ scope: "workflow", key: "ttl0", ttlMs: 0 }}
            >
              same prompt
            </Task>
          </Workflow>
        ));
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "ttl0-r1", rootDir }));
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "ttl0-r2", rootDir }));
        expect(counter.calls).toBe(2);
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );

  test("isFreshCacheRow treats ttlMs=0 and non-numeric ttlMs as stale", () => {
    const now = Date.now();
    expect(isFreshCacheRow({ createdAtMs: now - 1 }, { ttlMs: 0 })).toBe(false);
    expect(isFreshCacheRow({ createdAtMs: now }, { ttlMs: "10s" })).toBe(false);
    expect(isFreshCacheRow({ createdAtMs: now }, { ttlMs: Number.NaN })).toBe(false);
  });
});

describe("cachePolicy.by returning a non-serializable payload", () => {
  test(
    "a circular by payload disables caching without failing the run",
    async () => {
      const { smithers, outputs, dbPath, cleanup } = createTestSmithers(outputShape());
      const counter = countingAgent("by-circular");
      const rootDir = stableRootDir();
      try {
        const workflow = smithers(() => (
          <Workflow name="by-circular-cache">
            <Task
              id="t"
              output={outputs.out}
              agent={counter.agent}
              cache={{
                scope: "workflow",
                key: "by-circular",
                by: () => {
                  const payload = {};
                  payload.self = payload;
                  return payload;
                },
              }}
            >
              same prompt
            </Task>
          </Workflow>
        ));
        const first = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "by-circular-r1", rootDir }));
        const second = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "by-circular-r2", rootDir }));
        expect(first.status).toBe("finished");
        expect(second.status).toBe("finished");
        // JSON.stringify of the circular key throws inside the engine's
        // cache-key serialization, so caching is disabled: both runs
        // execute and no cache row is stored.
        expect(counter.calls).toBe(2);
        const { Database } = await import("bun:sqlite");
        const sqlite = new Database(dbPath);
        try {
          const rows = sqlite.query("SELECT cache_key FROM _smithers_cache").all();
          expect(rows).toHaveLength(0);
        } finally {
          sqlite.close();
        }
      } finally {
        cleanup();
      }
    },
    TIMEOUT_MS,
  );
});
