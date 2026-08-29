import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bank, main } from "../src/26-memory-recall.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("spells the policy namespace as the bank recall accepts", () => {
  expect(bank).toBe("flow-release-notes")
})

it.effect("recalls facts a previous connection wrote, and honours both refusals", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "memory.sqlite"))

    expect(summary.written).toEqual(["changelog-format", "release-cadence", "review-owner"])

    // Two of the three facts carry both query terms; the third mentions the
    // notes without the word "release", so the index leaves it out. The ranking
    // is FTS5's, not this example's: "release-cadence" says "release" twice, so
    // it scores above the entry that says it once.
    expect(summary.recalled).toEqual(["release-cadence", "changelog-format"])

    // A bank nothing was written to answers nothing: a namespace is a boundary,
    // not a hint.
    expect(summary.foreign).toEqual([])

    // `recall: "none"` is a refusal, so the request never reaches the service.
    expect(summary.refusedRecall).toEqual([])

    // `retain: "never"` still answers with the key the caller asked for, and
    // stores nothing.
    expect(summary.droppedWriteKey).toBe("never-stored")
    expect(summary.droppedWriteStored).toBe(false)
  }))
