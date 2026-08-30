import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/25-agent-tools-in-sandbox.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("runs the model's cell in the sandbox and lets it reach real files", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "audit.sqlite"), join(directory, "repo"))

    // The answer is schema-typed all the way out: no caller parses model text.
    expect(summary.tally.totalLines).toBe(3)
    expect(summary.tally.wrotePath).toBe(join(directory, "repo", "line-count.txt"))
    expect(summary.tally.bytesWritten).toBe(2)

    // The cell's write landed on the real disk, which is the point of binding a
    // real FileSystem rather than a fake one.
    expect(summary.written).toBe("3\n")

    // The paths reached the model through the prompt rather than being baked
    // into the script.
    expect(summary.asked).toEqual([
      `${join(directory, "repo", "notes.md")} -> ${join(directory, "repo", "line-count.txt")}`
    ])

    expect(summary.eventTypes).toContain("flows.engine.attempt-started")
  }), { timeout: 60_000 })
