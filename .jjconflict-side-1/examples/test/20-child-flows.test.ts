import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main, releaseRunId, toolRunId } from "../src/20-child-flows.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.live("joins two child runs and replays them on a re-driven parent", () =>
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
    // The tool call below compiles a second time, under its own run.
    expect(summary.dispatches).toEqual({ bundle: 2, sign: 1, report: 1 })

    // A model reached the same flow as a tool and got the flow's real answer.
    expect(summary.built).toBe("dist/server.js")

    // The tool call opened a durable run of its own, which completed.
    expect(summary.toolRunStatus).toBe("completed")
    expect(summary.toolRunId).toBe(toolRunId)

    // And it is a real child of the run the step was executing in: the engine
    // takes the edge from the execution the handler ran inside, so a flow
    // reached as a tool is linked without the handler saying so.
    expect(summary.toolRunParents).toEqual([summary.builderRunId])
  }), { timeout: 60_000 })
