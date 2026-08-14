import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import {
  ACTIVITY_STRIP_LINES,
  buildActivityLinesFromEvents,
  formatActivityPlain,
  loadNodeActivity,
} from "../src/cockpit-activity.js";

function openTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-activity-"));
  const dbPath = join(dir, "smithers.db");
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  return {
    dir,
    dbPath,
    sqlite,
    adapter,
    close() {
      try {
        sqlite.close();
      } catch {
        /* ignore */
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function agentEventRow(seq, nodeId, event) {
  return {
    type: "AgentEvent",
    seq,
    timestampMs: 1_000 + seq,
    payloadJson: JSON.stringify({
      type: "AgentEvent",
      runId: "r1",
      nodeId,
      iteration: 0,
      attempt: 1,
      event,
      timestampMs: 1_000 + seq,
    }),
  };
}

describe("cockpit activity", () => {
  test("collapses action start/complete into last-N lines", () => {
    const rows = [
      agentEventRow(1, "intake", {
        type: "action",
        phase: "started",
        action: { id: "a1", kind: "tool", title: "Read", detail: { input: { path: "a.md" } } },
      }),
      agentEventRow(2, "intake", {
        type: "action",
        phase: "completed",
        action: { id: "a1", kind: "tool", title: "Read", detail: { output: "ok" } },
        ok: true,
      }),
      agentEventRow(3, "intake", {
        type: "action",
        phase: "started",
        action: { id: "a2", kind: "tool", title: "Bash", detail: { input: { command: "echo hi" } } },
      }),
      agentEventRow(4, "other", {
        type: "action",
        phase: "started",
        action: { id: "x", kind: "tool", title: "IgnoreMe", detail: {} },
      }),
      agentEventRow(5, "intake", {
        type: "action",
        phase: "started",
        action: { id: "a3", kind: "tool", title: "Write", detail: { input: { path: "b.md" } } },
      }),
      agentEventRow(6, "intake", {
        type: "action",
        phase: "completed",
        action: { id: "a3", kind: "tool", title: "Write", detail: {} },
        ok: true,
      }),
      agentEventRow(7, "intake", {
        type: "action",
        phase: "started",
        action: { id: "a4", kind: "tool", title: "Grep", detail: { input: { pattern: "x" } } },
      }),
      agentEventRow(8, "intake", {
        type: "action",
        phase: "completed",
        action: { id: "a4", kind: "tool", title: "Grep", detail: {} },
        ok: true,
      }),
      agentEventRow(9, "intake", {
        type: "action",
        phase: "started",
        action: { id: "a5", kind: "tool", title: "Edit", detail: { input: { path: "c.md" } } },
      }),
    ];
    const lines = buildActivityLinesFromEvents(rows, "intake", { limit: 4 });
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.title)).toEqual(["Bash", "Write", "Grep", "Edit"]);
    expect(lines[0]?.status).toBe("running"); // never completed
    expect(lines[1]?.status).toBe("done");
    expect(lines[3]?.status).toBe("running");
    expect(formatActivityPlain(lines[1])).toMatch(/✓ Write/);
    expect(formatActivityPlain(lines[3])).toMatch(/▸ Edit/);
  });

  test("accepts scripted tool_start/tool_end pairs", () => {
    const rows = [
      agentEventRow(1, "n1", { type: "tool_start", name: "Read", input: { path: "x" } }),
      agentEventRow(2, "n1", { type: "tool_end", name: "Read", output: "ok" }),
      agentEventRow(3, "n1", { type: "progress", message: "still going" }),
    ];
    const lines = buildActivityLinesFromEvents(rows, "n1", { limit: ACTIVITY_STRIP_LINES });
    expect(lines.some((l) => l.title === "Read" && l.status === "done")).toBe(true);
    expect(lines.some((l) => l.kind === "progress")).toBe(true);
  });

  test("loadNodeActivity reads recent AgentEvents from store", async () => {
    const repo = openTempDb();
    try {
      const now = Date.now();
      await repo.adapter.insertRun({
        runId: "r1",
        workflowName: "smithering",
        status: "running",
        createdAtMs: now,
        startedAtMs: now,
      });
      await repo.adapter.insertEvent({
        runId: "r1",
        seq: 0,
        timestampMs: now,
        type: "AgentEvent",
        payloadJson: JSON.stringify({
          type: "AgentEvent",
          runId: "r1",
          nodeId: "intake",
          iteration: 0,
          attempt: 1,
          event: {
            type: "action",
            phase: "started",
            action: {
              id: "t1",
              kind: "tool",
              title: "Bash",
              detail: { input: { command: "ls" } },
            },
          },
          timestampMs: now,
        }),
      });
      await repo.adapter.insertEvent({
        runId: "r1",
        seq: 1,
        timestampMs: now + 1,
        type: "AgentEvent",
        payloadJson: JSON.stringify({
          type: "AgentEvent",
          runId: "r1",
          nodeId: "intake",
          iteration: 0,
          attempt: 1,
          event: {
            type: "action",
            phase: "completed",
            action: { id: "t1", kind: "tool", title: "Bash", detail: {} },
            ok: true,
          },
          timestampMs: now + 1,
        }),
      });
      const lines = await loadNodeActivity(repo.adapter, "r1", "intake", { limit: 4 });
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines[0]?.title).toBe("Bash");
      expect(lines[0]?.status).toBe("done");
    } finally {
      repo.close();
    }
  });
});
