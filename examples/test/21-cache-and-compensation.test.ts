import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cached, compensated } from "../src/21-cache-and-compensation.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("serves a second run from the recorded row while the policy admits it", () =>
  Effect.gen(function*() {
    const summary = yield* cached(join(directory, "fresh.sqlite"), {
      ttlMs: 600_000,
      pauseMs: 0,
      prefix: join(directory, "fresh")
    })

    expect(summary.results[0]).toBe("dist/server.js?target=server")
    expect(summary.results[1]).toBe(summary.results[0])
    // One execution across two runs: the second dispatch read the row.
    expect(summary.executions).toBe(1)
    // And it said so durably, rather than leaving the hit invisible.
    expect(summary.verdicts).toEqual(["admitted"])
  }))

it.live("executes again once the declared time to live has aged the row out", () =>
  Effect.gen(function*() {
    const summary = yield* cached(join(directory, "stale.sqlite"), {
      ttlMs: 1,
      pauseMs: 30,
      prefix: join(directory, "stale")
    })

    expect(summary.executions).toBe(2)
    expect(summary.verdicts).toEqual(["expired"])
  }), { timeout: 60_000 })

it.effect("restores the pre-image before retrying a compensable step", () =>
  Effect.gen(function*() {
    const summary = yield* compensated(join(directory, "migrate.sqlite"), {
      workspace: join(directory, "workspace"),
      snapshots: join(directory, "snapshots")
    })

    expect(summary.result).toBe("0007-lane:applied")
    expect(summary.attempts).toEqual([1, 2])
    // Two pre-images per attempt, the dispatch's rollback boundary and the
    // attempt row's own, plus a post-image the boundary diffs against.
    expect(summary.snapshots).toEqual([
      "attempt-1-pre",
      "attempt-1-pre",
      "attempt-1-post",
      "attempt-2-pre",
      "attempt-2-pre",
      "attempt-2-post"
    ])
    // Both attempt-one pre-images went back before attempt two ran.
    expect(summary.restores).toEqual(["attempt-1-pre", "attempt-1-pre"])
    // The evidence: one migration on disk, not two.
    expect(summary.workspace).toBe("-- base\nALTER TABLE runs ADD COLUMN lane;\n")
  }))
