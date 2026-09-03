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
 * The case has two halves because a credential can surface in two places.
 *
 * The journal is where the leak would be permanent: every committed row is
 * replayed to sync subscribers and to time travel, so redaction happens on the
 * write path and the first test reads what the write path left behind.
 *
 * The operator's terminal is the other place, and the second test reads the
 * child's whole stdout and stderr. release requirements makes case 22 a required
 * release parity test across the journal *and* the logs. That half was RED at
 * rc.0 and stayed in the matrix as a plain failing test rather than as prose,
 * because a matrix that is green while a live credential reaches the terminal
 * reports a truth the product does not have. The redaction
 * deliverable closed it: `@smthrs/journal` `RedactedLogger` puts every log
 * line through the same rules the journal applies on the write path, and
 * `packages/cli/src/bin.ts` and `packages/flows/src/NodeRuntime.ts` install
 * it. The assertion that was failing went green with no change to it, which is
 * what a plain failing test is for, and `e2e-faults` became a required CI job.
 * Two assertions were added afterwards, pinning that redaction rewrites the
 * line rather than swallowing it.
 *
 * Both halves are required gates now. Neither may be marked `.fails`, skipped,
 * or deleted; `scripts/repo-contract/fault-skips.test.mjs` refuses all three
 * and names this file.
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
    // The run really was recorded, so the absences below are about redaction
    // and not about an empty table.
    expect(committed).toContain("e2e/secret/deploy")
    expect(committed).toContain("succeeded")
    expect(committed).not.toContain(secret)
    // Structurally, by field name: the payload the run was created with.
    expect(committed).toContain('"apiKey":"[REDACTED]"')
    // And textually, in a value no field name covers: the action returned a
    // string with the credential spliced into it, which is the shape a
    // careless integration actually leaks.
    expect(committed).toContain("token=[REDACTED]")
  }, 120_000)

  // REQUIRED GATE. Case 22 covers the logs as well
  // as the journal. This was red until the redaction deliverable
  // landed `@smthrs/journal` `RedactedLogger`; before it, `Effect.logInfo`
  // wrote the credential straight to the child's stderr. It reads the real
  // binary's real output, so it is the only thing that proves the layer is
  // actually installed under `NodeRuntime.layerHost` rather than merely
  // exported.
  it("redacts the credential out of the operator's terminal", async () => {
    const filename = join(directory, "terminal.sqlite")
    const child = await runChild(filename, "case22-terminal")
    expect(child.code).toBe(0)
    expect(child.output).toContain("RESULT=ok")

    // The run really did execute, so the absence below is about redaction and
    // not about a child that never got as far as logging.
    expect(child.output).not.toContain(secret)
    // And the line survived: redaction rewrites the credential, it does not
    // swallow the log call, so an operator still sees what the run was doing.
    expect(child.output).toContain("https://example.test/deploy")
    expect(child.output).toContain("[REDACTED_API_KEY]")
  }, 120_000)
})
