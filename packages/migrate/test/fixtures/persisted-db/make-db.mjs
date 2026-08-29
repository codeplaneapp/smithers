// Builds `<target>/.smithers/smithers.db` from `old-schema.sql`.
//
// This is the one place in the package that opens a Smithers 0.x database for
// writing. It runs against a temporary copy of the fixture, never against a
// real project, so the read-only guarantee the scanner makes stays testable:
// a test hashes the file this script wrote, runs the scanner, and hashes again.
//
// Usage: node make-db.mjs <target directory> [now-ms]
import { DatabaseSync } from "node:sqlite"
import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Builds the fixture database inside `target`.
 *
 * `now` is the clock the live run's heartbeat is written against. A test that
 * injects the same value into `RunState.scan` gets a deterministic verdict.
 */
export const build = (target, now = Date.now()) => {
  const path = join(target, ".smithers", "smithers.db")
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec(readFileSync(join(here, "old-schema.sql"), "utf8"))

    const run = db.prepare(
      `INSERT INTO _smithers_runs
         (run_id, workflow_name, workflow_path, workflow_hash, status, created_at_ms,
          started_at_ms, finished_at_ms, heartbeat_at_ms, runtime_owner_id, parent_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const day = 86_400_000
    run.run("run-finished", "simple-example", "simple-workflow.jsx", "hash-finished", "finished", now - 5 * day, now - 5 * day, now - 5 * day + 60_000, now - 5 * day + 60_000, null, null)
    run.run("run-failed", "simple-example", "simple-workflow.jsx", "hash-failed", "failed", now - 4 * day, now - 4 * day, now - 4 * day + 30_000, now - 4 * day + 30_000, null, null)
    run.run("run-parked", "simple-example", "simple-workflow.jsx", "hash-parked", "waiting-quota", now - 2 * day, now - 2 * day, null, now - 2 * day, "owner-parked", null)
    run.run("run-live", "simple-example", "simple-workflow.jsx", "hash-live", "running", now - 60_000, now - 60_000, null, now, "owner-live", null)

    const node = db.prepare(
      `INSERT INTO _smithers_nodes (run_id, node_id, iteration, state, last_attempt, updated_at_ms, output_table, label)
       VALUES (?, ?, 0, ?, 1, ?, ?, ?)`
    )
    node.run("run-live", "research", "running", now, "research", "Research")
    node.run("run-finished", "research", "finished", now - 5 * day + 30_000, "research", "Research")
    node.run("run-finished", "write", "finished", now - 5 * day + 60_000, "output", "Write")

    const attempt = db.prepare(
      `INSERT INTO _smithers_attempts (run_id, node_id, iteration, attempt, state, started_at_ms, finished_at_ms, heartbeat_at_ms)
       VALUES (?, ?, 0, 1, ?, ?, ?, ?)`
    )
    attempt.run("run-live", "research", "running", now - 60_000, null, now)
    attempt.run("run-finished", "research", "finished", now - 5 * day, now - 5 * day + 30_000, now - 5 * day + 30_000)

    const event = db.prepare(
      `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json) VALUES (?, ?, ?, ?, ?)`
    )
    event.run("run-live", 1, now - 60_000, "run.started", JSON.stringify({ runId: "run-live" }))
    event.run("run-finished", 1, now - 5 * day, "run.started", JSON.stringify({ runId: "run-finished" }))
    event.run("run-finished", 2, now - 5 * day + 60_000, "run.finished", JSON.stringify({ runId: "run-finished" }))

    const migration = db.prepare(
      `INSERT INTO _smithers_schema_migrations (id, name, applied_at_ms, checksum, destructive) VALUES (?, ?, ?, ?, 0)`
    )
    migration.run("0001_current_tables", "Create current Smithers tables", now - 30 * day, "checksum-0001")
    migration.run("0014_current_indexes", "Create current Smithers indexes", now - 30 * day, "checksum-0014")
    migration.run("0025_snapshot_contents", "Snapshot contents", now - 30 * day, "checksum-0025")
  } finally {
    db.close()
  }
  return path
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]
  if (target === undefined) {
    process.stderr.write("usage: node make-db.mjs <target directory> [now-ms]\n")
    process.exit(2)
  }
  const now = process.argv[3] === undefined ? Date.now() : Number(process.argv[3])
  process.stdout.write(`${build(resolve(target), now)}\n`)
}
