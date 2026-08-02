import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { buildHumanRequestId } from "@smthrs/engine/human-requests";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const COMMAND_TIMEOUT_MS = 120_000;

/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
  pinSqliteBackend(repo.dir);
  const sqlite = new Database(repo.path("smithers.db"));
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {Record<string, unknown>} [overrides]
 */
async function insertRun(adapter, runId, overrides = {}) {
  const now = Date.now();
  await adapter.insertRun({
    runId,
    workflowName: "cli-command-fixture",
    workflowPath: ".smithers/workflows/fixture.tsx",
    status: "finished",
    createdAtMs: now - 10_000,
    startedAtMs: now - 9_000,
    finishedAtMs: now - 1_000,
    heartbeatAtMs: null,
    ...overrides,
  });
}

/**
 * @param {Partial<import("@smthrs/db/adapter").HumanRequestRow>} overrides
 */
function humanRequestRow(overrides) {
  const now = Date.now();
  return {
    requestId: buildHumanRequestId("human-run", "review", 0),
    runId: "human-run",
    nodeId: "review",
    iteration: 0,
    kind: "json",
    status: "pending",
    prompt: "Return the review decision as JSON.",
    schemaJson: JSON.stringify({
      type: "object",
      properties: { approved: { type: "boolean" } },
      required: ["approved"],
    }),
    optionsJson: null,
    responseJson: null,
    requestedAtMs: now - 1_000,
    answeredAtMs: null,
    answeredBy: null,
    timeoutAtMs: now + 60_000,
    ...overrides,
  };
}

/**
 * @param {string} stdout
 * @returns {Array<Record<string, unknown>>}
 */
function parseNdjson(stdout) {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function seedHumanApproval(adapter, runId, nodeId) {
  const now = Date.now();
  await insertRun(adapter, runId, {
    status: "waiting-approval",
    finishedAtMs: null,
    heartbeatAtMs: now,
  });
  await adapter.insertNode({
    runId,
    nodeId,
    iteration: 0,
    state: "waiting-approval",
    lastAttempt: 1,
    updatedAtMs: now - 500,
    outputTable: "human_output",
    label: "Human review",
  });
  await adapter.insertOrUpdateApproval({
    runId,
    nodeId,
    iteration: 0,
    status: "requested",
    requestedAtMs: now - 900,
    decidedAtMs: null,
    note: null,
    decidedBy: null,
    requestJson: JSON.stringify({ title: "Review" }),
    decisionJson: null,
    autoApproved: false,
  });
}

describe("CLI events integration gaps", () => {
  test("events category filtering emits NDJSON and ignores grouping without human headers", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertRun(adapter, "events-filter-run");
      const now = Date.now();
      for (const [offset, type, payload] of [
        [4_000, "NodeStarted", { nodeId: "build", iteration: 0, attempt: 1 }],
        [3_000, "ToolCallStarted", { nodeId: "build", toolName: "bash", attempt: 1 }],
        [2_000, "ToolCallFinished", { nodeId: "build", toolName: "bash", exitCode: 0, attempt: 1 }],
        [1_000, "AgentEvent", { nodeId: "chat", engine: "codex", event: { type: "message" } }],
      ]) {
        await adapter.insertEventWithNextSeq({
          runId: "events-filter-run",
          timestampMs: now - offset,
          type,
          payloadJson: JSON.stringify(payload),
        });
      }

      const result = runSmithers(
        ["events", "events-filter-run", "--type", "tool", "--json", "--group-by", "node", "--limit", "10"],
        { cwd: repo.dir, format: null, timeoutMs: COMMAND_TIMEOUT_MS },
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("--group-by is ignored when --json is enabled");
      expect(result.stdout).not.toContain("node: build");
      const lines = parseNdjson(result.stdout);
      expect(lines.map((line) => line.type)).toEqual(["ToolCallStarted", "ToolCallFinished"]);
      expect(lines[0]).toMatchObject({
        runId: "events-filter-run",
        seq: 1,
        payload: { nodeId: "build", toolName: "bash" },
      });
    } finally {
      sqlite.close();
    }
  });

  test("events rejects an unknown category before querying the store", () => {
    const repo = createTempRepo();
    const result = runSmithers(["events", "missing-run", "--type", "definitely-not-a-category"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    expect(result.exitCode).toBe(4);
    expect(result.json?.code).toBe("INVALID_EVENT_TYPE_FILTER");
    expect(result.json?.message).toContain("definitely-not-a-category");
  });

  test("events caps unreasonable limits and groups real event history by attempt", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertRun(adapter, "events-run");
      await adapter.insertEventWithNextSeq({
        runId: "events-run",
        timestampMs: Date.now() - 2_000,
        type: "NodeStarted",
        payloadJson: JSON.stringify({ nodeId: "build", iteration: 0, attempt: 1 }),
      });
      await adapter.insertEventWithNextSeq({
        runId: "events-run",
        timestampMs: Date.now() - 1_000,
        type: "NodeFinished",
        payloadJson: JSON.stringify({ nodeId: "build", iteration: 0, attempt: 1 }),
      });

      const result = runSmithers(["events", "events-run", "--limit", "100001", "--group-by", "attempt"], {
        cwd: repo.dir,
        format: null,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("--limit capped at 100000 events");
      expect(result.stdout).toContain("node: build");
      expect(result.stdout).toContain("Attempt 1 (iteration 0)");
      expect(result.stdout).toContain("NodeStarted");
      expect(result.stdout).toContain("NodeFinished");
    } finally {
      sqlite.close();
    }
  });
});

describe("CLI signal integration gaps", () => {
  test("signal stores JSON payload, correlation id, and sender through the real CLI", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertRun(adapter, "signal-run", {
        status: "waiting-event",
        finishedAtMs: null,
        heartbeatAtMs: Date.now(),
      });

      const result = runSmithers(
        [
          "signal",
          "signal-run",
          "deploy.ready",
          "--data",
          JSON.stringify({ approved: true, count: 2 }),
          "--correlation",
          "ticket-42",
          "--by",
          "operator-a",
        ],
        { cwd: repo.dir, format: "json", timeoutMs: COMMAND_TIMEOUT_MS },
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.json).toMatchObject({
        runId: "signal-run",
        signalName: "deploy.ready",
        correlationId: "ticket-42",
        seq: 0,
        status: "signalled",
      });
      const signals = await adapter.listSignals("signal-run");
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        runId: "signal-run",
        seq: 0,
        signalName: "deploy.ready",
        correlationId: "ticket-42",
        receivedBy: "operator-a",
      });
      expect(JSON.parse(signals[0].payloadJson)).toEqual({ approved: true, count: 2 });
    } finally {
      sqlite.close();
    }
  });

  test("signal rejects invalid JSON without inserting a signal row", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertRun(adapter, "bad-signal-run", {
        status: "waiting-event",
        finishedAtMs: null,
        heartbeatAtMs: Date.now(),
      });

      const result = runSmithers(["signal", "bad-signal-run", "deploy.ready", "--data", "{not-json"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: COMMAND_TIMEOUT_MS,
      });

      expect(result.exitCode).toBe(4);
      expect(result.json?.code).toBe("INVALID_JSON");
      expect(await adapter.listSignals("bad-signal-run")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

describe("CLI workflow discovery integration gaps", () => {
  test("workflow list hides system workflows unless --system is requested", () => {
    const repo = createTempRepo();
    repo.write(".smithers/workflows/plain.tsx", "export default null;\n");
    repo.write(
      ".smithers/workflows/internal-reinit.tsx",
      ["// smithers-system: true", "// smithers-display-name: Internal Reinit", "export default null;", ""].join("\n"),
    );

    const hidden = runSmithers(["workflow", "list"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    expect(hidden.exitCode, `${hidden.stdout}\n${hidden.stderr}`).toBe(0);
    expect(hidden.json?.workflows.map((workflow) => workflow.id)).toEqual(["plain"]);

    const shown = runSmithers(["workflow", "list", "--system"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    expect(shown.exitCode, `${shown.stdout}\n${shown.stderr}`).toBe(0);
    expect(shown.json?.workflows.map((workflow) => workflow.id)).toEqual(["internal-reinit", "plain"]);
    expect(shown.json?.workflows.find((workflow) => workflow.id === "internal-reinit")).toMatchObject({
      displayName: "Internal Reinit",
      system: true,
    });
  });
});

describe("CLI human request integration gaps", () => {
  test("human answer validates JSON, answers the request, and resolves the paired approval", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await seedHumanApproval(adapter, "human-run", "review");
      const requestId = buildHumanRequestId("human-run", "review", 0);
      await adapter.insertHumanRequest(humanRequestRow({ requestId }));

      const result = runSmithers(
        ["human", "answer", requestId, "--value", JSON.stringify({ approved: true }), "--by", "tester"],
        { cwd: repo.dir, format: "json", timeoutMs: COMMAND_TIMEOUT_MS },
      );

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ requestId, status: "answered" });
      const request = await adapter.getHumanRequest(requestId);
      expect(request?.status).toBe("answered");
      expect(request?.responseJson).toBe(JSON.stringify({ approved: true }));
      expect(request?.answeredBy).toBe("tester");
      expect((await adapter.getApproval("human-run", "review", 0))?.status).toBe("approved");
      expect((await adapter.getNode("human-run", "review", 0))?.state).toBe("pending");
    } finally {
      sqlite.close();
    }
  });

  test("human answer rejects schema-invalid values without resolving the approval", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await seedHumanApproval(adapter, "human-run", "review");
      const requestId = buildHumanRequestId("human-run", "review", 0);
      await adapter.insertHumanRequest(humanRequestRow({ requestId }));

      const result = runSmithers(
        ["human", "answer", requestId, "--value", JSON.stringify({ approved: "yes" }), "--by", "tester"],
        { cwd: repo.dir, format: "json", timeoutMs: COMMAND_TIMEOUT_MS },
      );

      expect(result.exitCode).toBe(4);
      expect(result.json?.code).toBe("HUMAN_REQUEST_VALIDATION_FAILED");
      expect((await adapter.getHumanRequest(requestId))?.status).toBe("pending");
      expect((await adapter.getApproval("human-run", "review", 0))?.status).toBe("requested");
    } finally {
      sqlite.close();
    }
  });

  test("human cancel denies the paired approval and marks the request cancelled", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await seedHumanApproval(adapter, "cancel-human-run", "review");
      const requestId = buildHumanRequestId("cancel-human-run", "review", 0);
      await adapter.insertHumanRequest(
        humanRequestRow({
          requestId,
          runId: "cancel-human-run",
        }),
      );

      const result = runSmithers(["human", "cancel", requestId, "--by", "tester"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: COMMAND_TIMEOUT_MS,
      });

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ requestId, status: "cancelled" });
      expect((await adapter.getHumanRequest(requestId))?.status).toBe("cancelled");
      expect((await adapter.getApproval("cancel-human-run", "review", 0))?.status).toBe("denied");
      expect((await adapter.getNode("cancel-human-run", "review", 0))?.state).toBe("failed");
    } finally {
      sqlite.close();
    }
  });
});

describe("CLI pause integration gaps", () => {
  test("pause on a live run records a durable pause request without flipping status", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertRun(adapter, "pause-live", {
        status: "running",
        finishedAtMs: null,
        heartbeatAtMs: Date.now(),
      });

      const result = runSmithers(["pause", "pause-live"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: COMMAND_TIMEOUT_MS,
      });

      expect(result.exitCode).toBe(2);
      expect(result.json).toMatchObject({ runId: "pause-live", status: "pause-requested" });
      const run = await adapter.getRun("pause-live");
      expect(run?.status).toBe("running");
      expect(run?.pauseRequestedAtMs ?? 0).toBeGreaterThan(0);
    } finally {
      sqlite.close();
    }
  });

  test("pause rejects a stale running run and leaves the row untouched", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
      await insertRun(adapter, "pause-stale", {
        status: "running",
        finishedAtMs: null,
        heartbeatAtMs: Date.now() - 120_000,
      });

      const result = runSmithers(["pause", "pause-stale"], {
        cwd: repo.dir,
        format: "json",
        timeoutMs: COMMAND_TIMEOUT_MS,
      });

      expect(result.exitCode).toBe(4);
      expect(result.json?.code).toBe("RUN_NOT_ACTIVE");
      const run = await adapter.getRun("pause-stale");
      expect(run?.status).toBe("running");
      expect(run?.pauseRequestedAtMs ?? null).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

describe("CLI migrate failure-path integration gaps", () => {
  test("migrate to postgres preflights the URL before touching a corrupt SQLite source", () => {
    const repo = createTempRepo();
    repo.write("smithers.db", "not a sqlite database\n");

    const result = runSmithers(["migrate", "--to", "postgres"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    expect(result.exitCode).toBe(4);
    expect(result.json?.code).toBe("INVALID_INPUT");
    expect(result.json?.message).toContain("requires --url");
    expect(result.json?.message).not.toContain("corrupted");
    expect(result.json?.message).not.toContain("integrity_check");
  });

  test("migrate reports actionable guidance for a corrupt legacy SQLite source", () => {
    const repo = createTempRepo();
    repo.write("smithers.db", "not a sqlite database\n");

    const result = runSmithers(["migrate", "--to", "pglite"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    expect(result.exitCode).toBe(4);
    expect(result.json?.code).toBe("DB_QUERY_FAILED");
    expect(result.json?.message).toContain("appears to be corrupted");
    expect(result.json?.message).toContain("PRAGMA integrity_check");
    expect(result.json?.message).toContain("original file was left untouched");
    expect(repo.exists(".smithers/pg")).toBe(false);
  });

  test("migrate reports sidecar and permissions guidance for an unopenable SQLite source", () => {
    const repo = createTempRepo();
    mkdirSync(repo.path("smithers.db"));

    const result = runSmithers(["migrate", "--to", "pglite"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    expect(result.exitCode).toBe(4);
    expect(result.json?.code).toBe("DB_QUERY_FAILED");
    expect(result.json?.message).toContain("Could not open the legacy SQLite store");
    expect(result.json?.message).toContain("unreadable permissions");
    expect(result.json?.message).toContain("smithers.db-wal");
    expect(result.json?.message).toContain("original file was left untouched");
    expect(repo.exists(".smithers/pg")).toBe(false);
  });
});
