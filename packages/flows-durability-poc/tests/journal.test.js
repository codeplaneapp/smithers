import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as BunSqliteDatabase } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFlowsBoundary } from "../src/index.js"
import { createJournalShim } from "../src/journal-shim.js"

let dir
let sqlite
let boundary
let journal

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "flows-poc-journal-"))
  sqlite = new BunSqliteDatabase(join(dir, "smithers.db"))
  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("PRAGMA busy_timeout = 30000")
  boundary = await createFlowsBoundary({ sqlite })
  journal = createJournalShim(boundary)
})

afterEach(async () => {
  await boundary.dispose()
  sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("step 4: journal events over flows_journal_events", () => {
  test("insertEventWithNextSeq allocates gapless per-run seq from zero", async () => {
    expect(await journal.insertEventWithNextSeq({ runId: "r1", timestampMs: 1, type: "run_started", payloadJson: "{}" })).toBe(0)
    expect(await journal.insertEventWithNextSeq({ runId: "r1", timestampMs: 2, type: "task_started", payloadJson: "{\"nodeId\":\"a\"}" })).toBe(1)
    expect(await journal.insertEventWithNextSeq({ runId: "r2", timestampMs: 3, type: "run_started", payloadJson: "{}" })).toBe(0)
    expect(await journal.getLastEventSeq("r1")).toBe(1)
    expect(await journal.getLastEventSeq("r2")).toBe(0)
    expect(await journal.getLastEventSeq("r3")).toBeUndefined()
  })

  test("exact content retry returns the original seq without a new row", async () => {
    const row = { runId: "r1", timestampMs: 10, type: "task_finished", payloadJson: "{\"nodeId\":\"b\"}" }
    expect(await journal.insertEventWithNextSeq(row)).toBe(0)
    expect(await journal.insertEventWithNextSeq(row)).toBe(0)
    expect(await journal.getLastEventSeq("r1")).toBe(0)
    expect(sqlite.query("SELECT COUNT(*) AS n FROM flows_journal_events").get().n).toBe(1)
  })

  test("listEventHistory honors afterSeq, types, nodeId, and limit", async () => {
    await journal.insertEventWithNextSeq({ runId: "r1", timestampMs: 1, type: "run_started", payloadJson: "{}" })
    await journal.insertEventWithNextSeq({ runId: "r1", timestampMs: 2, type: "task_started", payloadJson: "{\"nodeId\":\"a\"}" })
    await journal.insertEventWithNextSeq({ runId: "r1", timestampMs: 3, type: "task_finished", payloadJson: "{\"nodeId\":\"a\"}" })
    await journal.insertEventWithNextSeq({ runId: "r1", timestampMs: 4, type: "task_started", payloadJson: "{\"nodeId\":\"b\"}" })
    expect((await journal.listEventHistory("r1")).length).toBe(4)
    expect((await journal.listEventHistory("r1", { afterSeq: 1 })).map((e) => e.seq)).toEqual([2, 3])
    expect((await journal.listEventHistory("r1", { types: ["task_started"] })).map((e) => e.seq)).toEqual([1, 3])
    expect((await journal.listEventHistory("r1", { nodeId: "a" })).map((e) => e.seq)).toEqual([1, 2])
    expect((await journal.listEventHistory("r1", { limit: 2 })).map((e) => e.seq)).toEqual([0, 1])
    expect((await journal.listEventHistory("r1", { sinceTimestampMs: 3 })).map((e) => e.seq)).toEqual([2, 3])
    const event = (await journal.listEventHistory("r1", { limit: 1 }))[0]
    expect(event).toEqual({ runId: "r1", seq: 0, timestampMs: 1, type: "run_started", payloadJson: "{}" })
  })

  test("concurrent allocations from two boundaries over one handle cannot fork the seq clock", async () => {
    const boundary2 = await createFlowsBoundary({ sqlite, runMigrations: false })
    const journal2 = createJournalShim(boundary2)
    try {
      const results = await Promise.all([
        journal.insertEventWithNextSeq({ runId: "r1", timestampMs: 1, type: "a", payloadJson: "{\"i\":1}" }),
        journal2.insertEventWithNextSeq({ runId: "r1", timestampMs: 2, type: "b", payloadJson: "{\"i\":2}" }),
        journal.insertEventWithNextSeq({ runId: "r1", timestampMs: 3, type: "c", payloadJson: "{\"i\":3}" }),
        journal2.insertEventWithNextSeq({ runId: "r1", timestampMs: 4, type: "d", payloadJson: "{\"i\":4}" })
      ])
      expect(new Set(results).size).toBe(4)
      expect(await journal.getLastEventSeq("r1")).toBe(3)
    } finally {
      await boundary2.dispose()
    }
  })
})
