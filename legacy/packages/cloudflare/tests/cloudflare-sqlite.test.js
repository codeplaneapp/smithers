import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { createCloudflareDurableObjectSqliteDescriptor } from "../src/index.js";

function createFakeDurableObjectStorage() {
  const sqlite = new Database(":memory:");
  return {
    sql: {
      exec(statement, ...params) {
        const returnsRows = /^\s*(select|with|pragma|values)\b/i.test(statement) || /\breturning\b/i.test(statement);
        if (!returnsRows) {
          sqlite.run(statement, ...params);
          return {
            toArray() {
              return [];
            },
            raw() {
              return [];
            },
          };
        }
        const query = sqlite.query(statement);
        return {
          toArray() {
            return query.all(...params);
          },
          raw() {
            return query.values(...params);
          },
        };
      },
    },
    async transaction(operation) {
      sqlite.run("BEGIN IMMEDIATE");
      try {
        const result = await operation();
        sqlite.run("COMMIT");
        return result;
      } catch (error) {
        sqlite.run("ROLLBACK");
        throw error;
      }
    },
    close() {
      sqlite.close();
    },
  };
}

describe("Cloudflare SQLite descriptor", () => {
  test("backs SmithersDb with Durable Object SQL storage", async () => {
    const storage = createFakeDurableObjectStorage();
    try {
      const db = new SmithersDb(createCloudflareDurableObjectSqliteDescriptor(storage));
      await db.internalStorage.ensureSchema();
      await db.insertRun({
        runId: "run-1",
        workflowName: "cloudflare",
        status: "running",
        createdAtMs: 1,
      });

      expect(await db.getRun("run-1")).toMatchObject({
        runId: "run-1",
        workflowName: "cloudflare",
        status: "running",
      });
      expect(await db.rawQuery("SELECT run_id FROM _smithers_runs WHERE run_id = ?", ["run-1"])).toEqual([
        { run_id: "run-1" },
      ]);
    } finally {
      storage.close();
    }
  });

  test("serializes event sequence allocation without a Bun SQLite client", async () => {
    const storage = createFakeDurableObjectStorage();
    try {
      const db = new SmithersDb(createCloudflareDurableObjectSqliteDescriptor(storage));
      await db.internalStorage.ensureSchema();
      await db.insertRun({
        runId: "run-events",
        workflowName: "cloudflare",
        status: "running",
        createdAtMs: 1,
      });

      const seqs = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          db.insertEventWithNextSeq({
            runId: "run-events",
            timestampMs: index + 1,
            type: "test.event",
            payloadJson: JSON.stringify({ index }),
          }),
        ),
      );

      expect(seqs.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(await db.getLastEventSeq("run-events")).toBe(7);
    } finally {
      storage.close();
    }
  });
});
