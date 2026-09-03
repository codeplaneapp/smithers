/**
 * Predicates on the sync wire contract.
 *
 * @since 0.1.0
 */
import type { JournalEvent } from "@smthrs/journal"
import { describe, expect, it } from "vitest"
import { SyncError, SyncGapError } from "../src/SyncError.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"

const runId = (value: string) => value as JournalEvent.RunId

describe("SyncProtocol.covers", () => {
  it("a workspace scope covers every run", () => {
    expect(SyncProtocol.covers({ _tag: "Workspace" }, runId("anything"))).toBe(true)
  })

  it("a run scope covers only its own run", () => {
    const scope = { _tag: "Run", runId: runId("mine") } as const
    expect(SyncProtocol.covers(scope, runId("mine"))).toBe(true)
    expect(SyncProtocol.covers(scope, runId("other"))).toBe(false)
  })
})

describe("SyncError.is", () => {
  it("recognises sync errors and rejects other values", () => {
    expect(SyncError.is(new SyncError({ code: "closed", message: "closed" }))).toBe(true)
    expect(
      SyncError.is(
        new SyncGapError({
          runId: runId("run"),
          expectedFrom: 0 as JournalEvent.Seq,
          receivedFrom: 3 as JournalEvent.Seq
        })
      )
    ).toBe(false)
    expect(SyncError.is(new Error("boom"))).toBe(false)
    expect(SyncError.is(undefined)).toBe(false)
  })

  // The argument is `unknown`, and this guard decides whether a follow
  // reconnects and whether a cursor moves past a compaction floor. A shape
  // question that raises instead of answering turns an adversarial value into
  // a defect in the client's control flow.
  it("answers false for a value whose fields throw when read", () => {
    expect(
      SyncError.is({
        _tag: "@smthrs/sync/SyncError",
        code: "closed",
        get message(): string {
          throw new Error("boom")
        }
      })
    ).toBe(false)
  })
})
