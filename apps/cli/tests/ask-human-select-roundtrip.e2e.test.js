import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { buildHumanRequestId } from "@smithers-orchestrator/engine/human-requests";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function seedDb(repo) {
  pinSqliteBackend(repo.dir);
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  sqlite.close();
}

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function readHumanRequests(repo) {
  const sqlite = new Database(repo.path("smithers.db"));
  try {
    // The concurrently running ask-human process briefly owns SQLite's
    // writer lock while creating/polling the durable request. Let this
    // real reader wait for that transaction instead of turning normal
    // lock contention into a CI-only test failure.
    sqlite.exec("PRAGMA busy_timeout = 5000");
    return sqlite
      .query(
        "SELECT request_id, run_id, status, kind, options_json, schema_json, response_json, answered_by FROM _smithers_human_requests",
      )
      .all();
  } finally {
    sqlite.close();
  }
}

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 * @param {(rows: Array<Record<string, unknown>>) => boolean} predicate
 */
async function waitForRequestRows(repo, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = readHumanRequests(repo);
    if (predicate(rows)) {
      return rows;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for human request rows: ${JSON.stringify(rows)}`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

describe("smithers ask-human --choices round-trip", () => {
  test(
    "a select-kind ask rejects an out-of-enum answer and resolves on a valid choice",
    async () => {
      const repo = createTempRepo();
      seedDb(repo);

      const child = spawn(
        process.execPath,
        [
          "run",
          CLI_ENTRY,
          "ask-human",
          "Which rollout strategy?",
          "--choices",
          "red,blue",
          "--run-id",
          "run-select",
          "--timeout",
          "60",
          "--poll",
          "0.3",
          "--format",
          "json",
        ],
        { cwd: repo.dir, stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = new Promise((resolveExit) => {
        child.once("exit", (code) => resolveExit(code));
      });
      try {
        const rows = await waitForRequestRows(repo, (candidates) => candidates.some((row) => row.status === "pending"));
        expect(rows).toHaveLength(1);
        const pending = rows[0];
        expect(pending.kind).toBe("select");
        expect(pending.run_id).toBe("run-select");
        expect(JSON.parse(String(pending.options_json))).toEqual(["red", "blue"]);
        // The stored schema constrains answers to the offered choices.
        expect(JSON.parse(String(pending.schema_json))).toEqual(expect.objectContaining({ enum: ["red", "blue"] }));
        const requestId = String(pending.request_id);

        // An answer outside the enum is rejected and the request stays pending.
        const invalid = runSmithers(["human", "answer", requestId, "--value", JSON.stringify("green"), "--by", "qa"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        expect(invalid.exitCode).toBe(4);
        expect(readHumanRequests(repo)[0]?.status).toBe("pending");

        // A valid choice answers the request and unblocks the waiting agent.
        const valid = runSmithers(["human", "answer", requestId, "--value", JSON.stringify("blue"), "--by", "qa"], {
          cwd: repo.dir,
          format: "json",
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        expect(valid.exitCode).toBe(0);

        const exitCode = await exited;
        expect(exitCode).toBe(0);

        const answered = readHumanRequests(repo)[0];
        expect(answered).toEqual(
          expect.objectContaining({
            status: "answered",
            response_json: JSON.stringify("blue"),
            answered_by: "qa",
          }),
        );
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
        }
      }
    },
    COMMAND_TIMEOUT_MS,
  );
});

describe("smithers human answer timeout enforcement", () => {
  test(
    "a pending request past its timeout is expired instead of answered",
    async () => {
      const repo = createTempRepo();
      pinSqliteBackend(repo.dir);
      const sqlite = new Database(repo.path("smithers.db"));
      const db = drizzle(sqlite);
      ensureSmithersTables(db);
      const adapter = new SmithersDb(db);
      const requestId = buildHumanRequestId("stale-run", "review", 0);
      const now = Date.now();
      await adapter.insertHumanRequest({
        requestId,
        runId: "stale-run",
        nodeId: "review",
        iteration: 0,
        kind: "json",
        status: "pending",
        prompt: "Too late to answer this.",
        schemaJson: null,
        optionsJson: null,
        responseJson: null,
        requestedAtMs: now - 60_000,
        answeredAtMs: null,
        answeredBy: null,
        timeoutAtMs: now - 1_000,
      });
      sqlite.close();

      const result = runSmithers(
        ["human", "answer", requestId, "--value", JSON.stringify({ ok: true }), "--by", "qa"],
        { cwd: repo.dir, format: "json", timeoutMs: COMMAND_TIMEOUT_MS },
      );
      // The stale sweep runs before any resolution: the answer is refused and
      // the durable row is flipped to expired, not answered.
      expect(result.exitCode).toBe(4);
      const row = readHumanRequests(repo)[0];
      expect(row).toEqual(
        expect.objectContaining({
          status: "expired",
          response_json: null,
          answered_by: null,
        }),
      );
    },
    COMMAND_TIMEOUT_MS,
  );
});
