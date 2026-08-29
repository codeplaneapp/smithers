import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main, releaseRunId } from "../src/20-child-flows.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("joins two child runs and replays them on a re-driven parent", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "release.sqlite"))

    expect(summary.report).toBe("dist/server.js + server.sig")
    expect(summary.replayed).toBe(summary.report)

    // Each child is a run of its own, linked to the parent in durable state.
    expect(summary.children).toHaveLength(2)
    for (const child of summary.children) {
      expect(child.parentId).toBe(releaseRunId)
      expect(child.parentExecutionId).toBe(releaseRunId)
      expect(child.status).toBe("completed")
      expect(child.runId).not.toBe(releaseRunId)
    }
    // Two children means two distinct execution ids, not one shared id.
    expect(new Set(summary.children.map((child) => child.runId)).size).toBe(2)

    // The second execution re-read every recorded result, so nothing ran twice.
    expect(summary.dispatches).toEqual({ bundle: 1, sign: 1, report: 1 })
  }))
