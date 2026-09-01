/**
 * Reading a Smithers 0.x database without adopting it.
 *
 * rc-contract section 6: rc.0 never loads, resumes, or migrates 0.x run state.
 * The one read it performs is this listing, and it must be read-only: the
 * refusal exists so an operator does not lose a run they could still finish on
 * 0.x.
 */
import { RunState } from "@smthrs/migrate"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as Legacy from "../src/Legacy.ts"

const staged: Array<string> = []

const directory = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-legacy-"))
  staged.push(root)
  return root
}

/** A 0.x database holding the runs named, in the 0.x schema's own shape. */
const legacyDatabase = (runs: ReadonlyArray<readonly [string, string]>): string => {
  const file = join(directory(), "smithers.db")
  const database = new DatabaseSync(file)
  database.exec(`CREATE TABLE _smithers_runs (
    run_id TEXT,
    workflow_name TEXT,
    workflow_path TEXT,
    status TEXT,
    heartbeat_at_ms INTEGER,
    runtime_owner_id TEXT,
    parent_run_id TEXT,
    pause_requested_at_ms INTEGER,
    cancel_requested_at_ms INTEGER
  )`)
  for (const [runId, status] of runs) {
    database.prepare("INSERT INTO _smithers_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runId, "review", null, status, null, null, null, null, null)
  }
  database.close()
  return file
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

describe("the migration reader", () => {
  it("uses the migration package's terminal-status contract", () => {
    expect(Legacy.terminalStatuses).toBe(RunState.terminalStatuses)
  })
})

describe("the migration refusal", () => {
  it("says nothing when every run has finished", () => {
    expect(Legacy.refusal([Legacy.read(legacyDatabase([["run-1", "finished"]]))])).toBeUndefined()
    expect(Legacy.refusal([])).toBeUndefined()
  })

  it("lists the runs that block the migration and how to clear them", () => {
    const refusal = Legacy.refusal([Legacy.read(legacyDatabase([["run-1", "running"], ["run-2", "paused"]]))])!

    expect(refusal).toContain("Refusing to migrate")
    expect(refusal).toContain("run-1 running (review)")
    expect(refusal).toContain("run-2 paused (review)")
    expect(refusal).toContain("bunx smthrs@0.35.0 ps")
    expect(refusal).toContain("https://smithers.sh/migration/1.0#run-data")
  })

  it("blocks on a database it could not read", () => {
    const file = join(directory(), "smithers.db")
    writeFileSync(file, "not a database")

    expect(Legacy.refusal([Legacy.read(file)])).toContain("unreadable")
  })
})
