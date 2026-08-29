/**
 * What the local CLI answers when it finds a run owned by somebody else.
 *
 * `layerExecutor` declares `isAlive: () => false`: one engine process at a
 * time, so a `running` row whose heartbeat froze belongs to a dead owner and
 * may be reclaimed. That declaration is only observable through the engine's
 * stale-running sweep, so this case seeds a hard-killed run directly into the
 * execution database and watches the reclaim happen.
 */
import { Control } from "@smthrs/control"
import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const runId = "stale-run"

interface RunRow {
  readonly status: string
  readonly owner_host_id: string | null
}

const readRun = (file: string): RunRow => {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    return database.prepare("SELECT status, owner_host_id FROM flows_runs WHERE run_id = ?").get(
      runId
    ) as unknown as RunRow
  } finally {
    database.close()
  }
}

/** Writes the row a SIGKILLed owner leaves behind: running, heartbeat frozen. */
const seedHardKilledRun = (file: string, frozenAtMs: number): void => {
  const database = new DatabaseSync(file)
  try {
    database.prepare(
      `INSERT INTO flows_runs (
        run_id, status, created_at_ms, started_at_ms, owner_host_id, owner_pid, owner_nonce,
        heartbeat_at_ms, state_json
      ) VALUES (?, 'running', ?, ?, 'dead-host', 4242, 'dead-nonce', ?, ?)`
    ).run(
      runId,
      frozenAtMs,
      frozenAtMs,
      frozenAtMs,
      JSON.stringify({
        version: 1,
        flowName: "agent/run",
        payload: { runId, planId: "plan-1" }
      })
    )
  } finally {
    database.close()
  }
}

describe("NodeControl.layerExecutor liveness", () => {
  it("reclaims a run whose recorded owner stopped heartbeating", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cli-reclaim-"))
    try {
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const executor = NodeControl.layerExecutor(registry, engine, root, {})
      const composition = Application.layer({}, registry, engine, executor) as Layer.Layer<Control.Control>
      const open = <A, E>(use: Effect.Effect<A, E, Control.Control>) =>
        Effect.runPromise(use.pipe(Effect.provide(composition), Effect.scoped, Effect.orDie))

      // One process's worth of lifetime: enough to migrate the execution
      // database, then gone.
      await open(Effect.flatMap(Control.Control, (control) => control.list({ _tag: "runs" })))

      const file = NodeControl.executionDatabasePath(root)
      // Two minutes is well past the 30 s staleness cutoff, so the sweep sees
      // the row on its first tick.
      seedHardKilledRun(file, Date.now() - 120_000)
      expect(readRun(file)).toMatchObject({ status: "running", owner_host_id: "dead-host" })

      // A second process opens the same directory and its sweeper ticks once a
      // second. Poll rather than sleep a fixed span so a slow host cannot turn
      // the reclaim into a flake.
      const reclaimed = await open(
        Effect.gen(function*() {
          yield* Control.Control
          let owner = readRun(file).owner_host_id
          for (let attempt = 0; attempt < 40 && owner === "dead-host"; attempt++) {
            yield* Effect.sleep("250 millis")
            owner = readRun(file).owner_host_id
          }
          return owner
        })
      )

      // The steal only happens because this host answers that no recorded
      // owner is alive. Had it answered `true`, the driver would have recorded
      // `steal-refused-owner-alive` and left the row owned by `dead-host`.
      expect(reclaimed).not.toBe("dead-host")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
