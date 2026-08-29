/**
 * Case 22 — a credential handed to a run never reaches the journal.
 *
 * The run below is deliberately careless: its action logs the token and returns
 * a string with the token inside it, which is how integrations actually leak.
 * `@smthrs/journal`'s redaction is the thing under test, so the assertion reads
 * the SQLite file directly rather than any API that might redact on the way
 * out — a secret that is committed and merely hidden by a getter is still a
 * durable, broadly readable leak.
 *
 * The child's stdout and stderr are checked for the same reason: an operator's
 * terminal is a place a secret can end up.
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case22-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const runner = fileURLToPath(new URL("../fixtures/secretChild.ts", import.meta.url))
const secret = "sk-live-e2ecase22NEVERLOGTHIS"

const runChild = (filename: string, executionId: string): Promise<{ code: number | null; output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, filename, executionId, secret], {
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      output += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      output += chunk
    })
    child.once("error", reject)
    child.once("exit", (code) => resolve({ code, output }))
  })

/** Every text column of the journal table, concatenated. */
const journalText = (filename: string): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<Record<string, unknown>>`SELECT * FROM flows_journal_events`
      return rows.map((row) => Object.values(row).map((value) => String(value)).join(" ")).join("\n")
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename })),
      Effect.scoped,
      Effect.orDie
    ) as Effect.Effect<string>
  )

describe("case22 a secret never reaches the journal", () => {
  it("redacts the credential out of every committed journal row", async () => {
    const filename = join(directory, "journal.sqlite")
    const child = await runChild(filename, "case22-run")
    expect(child.code).toBe(0)
    expect(child.output).toContain("RESULT=ok")

    const committed = await journalText(filename)
    // The run really was recorded, so the absence below is about redaction and
    // not about an empty table.
    expect(committed).toContain("e2e/secret/deploy")
    expect(committed).not.toContain(secret)
    // And it is redacted rather than merely truncated away.
    expect(committed).toMatch(/\[REDACTED/)
  }, 120_000)

  /**
   * ADVISORY, and deliberately inverted.
   *
   * The journal redacts; the default logger does not, so a careless action that
   * logs a credential still puts it on the operator's terminal. That is a
   * Phase 5 deliverable (`docs/migration/rc-contract.md` §5.2, process and
   * child-agent containment) and it has not landed, so the expectation is
   * checked in as `it.fails`: it passes today BECAUSE the leak happens, and it
   * turns red the moment redaction reaches the log path — which is the signal
   * to delete this wrapper and fold the assertion into the case above.
   *
   * Pinned in `fault-gaps.md`.
   */
  it.fails("redacts the credential out of the operator's terminal", async () => {
    const filename = join(directory, "logs.sqlite")
    const child = await runChild(filename, "case22-logs")
    expect(child.code).toBe(0)
    expect(child.output).not.toContain(secret)
  }, 120_000)
})
