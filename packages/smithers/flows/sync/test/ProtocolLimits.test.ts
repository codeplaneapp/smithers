/**
 * The protocol's own measurements and guards: the size function every ceiling
 * is built on, the cursor uniqueness rule both request paths enforce, and the
 * error guard that gates the client's reconnect and resync control flow.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import type { JournalEvent } from "@smthrs/journal"
import { SyncError } from "../src/SyncError.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"

const runId = (value: string) => value as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq

describe("SyncProtocol.encodedByteLength", () => {
  // Every caller is a size guard whose job is a typed `frame_too_large`
  // refusal, so the measurement is total: it never throws and never reports a
  // value as free when it is not.
  it("measures JSON text in UTF-8 bytes, including astral characters", () => {
    expect(SyncProtocol.encodedByteLength("ok")).toBe(4)
    // Four UTF-8 bytes for the astral pair plus the two quotes.
    expect(SyncProtocol.encodedByteLength("\u{1F680}")).toBe(6)
    expect(SyncProtocol.encodedByteLength({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length)
  })

  // A value with no JSON text used to measure ZERO, so an unencodable payload
  // passed every ceiling. It measures what it actually costs inside a frame.
  it("charges a value with no JSON text the bytes `null` occupies", () => {
    expect(SyncProtocol.encodedByteLength(undefined)).toBe(4)
    expect(SyncProtocol.encodedByteLength(() => {})).toBe(4)
    expect(SyncProtocol.encodedByteLength(Symbol("s"))).toBe(4)
  })

  // A cyclic value threw a `TypeError` out of code that otherwise only fails
  // typed. It now trips every ceiling instead of escaping as a defect.
  it("reports a value JSON refuses as infinitely large rather than throwing", () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(SyncProtocol.encodedByteLength(cyclic)).toBe(Number.POSITIVE_INFINITY)
    expect(SyncProtocol.encodedByteLength(1n)).toBe(Number.POSITIVE_INFINITY)
    expect(SyncProtocol.encodedByteLength(cyclic) > SyncProtocol.defaultMaxFrameBytes).toBe(true)
  })

  // The measurement is of the JSON text, so a `toJSON` participates. Stating
  // it here keeps the contract explicit rather than incidental.
  it("measures the JSON form a value chooses for itself", () => {
    expect(SyncProtocol.encodedByteLength({ toJSON: () => "x" })).toBe(3)
  })
})

describe("SyncProtocol cursor uniqueness", () => {
  it("names the first run a cursor set repeats, and nothing for a well-formed set", () => {
    expect(SyncProtocol.duplicateCursorRunId([])).toBeUndefined()
    expect(
      SyncProtocol.duplicateCursorRunId([
        { runId: runId("a"), afterSeq: seq(0) },
        { runId: runId("b"), afterSeq: seq(0) }
      ])
    ).toBeUndefined()
    expect(
      SyncProtocol.duplicateCursorRunId([
        { runId: runId("a"), afterSeq: seq(0) },
        { runId: runId("b"), afterSeq: seq(1) },
        { runId: runId("a"), afterSeq: seq(2) }
      ])
    ).toBe("a")
  })
})

describe("SyncError.is", () => {
  // The guard gates the client's reconnect schedule and its resync decision,
  // so what it accepts is control flow, not a convenience.
  it("accepts a schema-shaped value that lost its prototype, as a postMessage does", () => {
    const cloned = { _tag: "@smthrs/sync/SyncError", code: "transport_failed", message: "socket closed" }
    expect(SyncError.is(cloned)).toBe(true)
    expect(SyncError.is(new SyncError({ code: "closed", message: "done" }))).toBe(true)
  })

  it("refuses a value that only carries the tag", () => {
    expect(SyncError.is({ _tag: "@smthrs/sync/SyncError" })).toBe(false)
    expect(SyncError.is({ _tag: "@smthrs/sync/SyncError", code: "closed", message: 7 })).toBe(false)
    expect(SyncError.is({ _tag: "@smthrs/sync/SyncError", code: "made_up", message: "x" })).toBe(false)
    expect(SyncError.is({ _tag: "@smthrs/sync/SyncError", code: 1, message: "x" })).toBe(false)
    expect(SyncError.is({ _tag: "other" })).toBe(false)
    expect(SyncError.is(undefined)).toBe(false)
  })

  // The guard takes `unknown`, so ANY property read on the value may be a
  // throwing getter — the tag included, which is the first one read. It
  // decides whether a follow reconnects and whether a cursor moves past a
  // compaction floor, and a question about a value's shape must answer rather
  // than raise.
  it("answers false for a value whose own properties throw", () => {
    const throwing = (property: string) => ({
      _tag: "@smthrs/sync/SyncError",
      code: "closed",
      message: "closed",
      get [property](): never {
        throw new Error(`reading ${property} throws`)
      }
    })
    for (const property of ["_tag", "code", "message", "resync"]) {
      expect(() => SyncError.is(throwing(property))).not.toThrow()
      expect(SyncError.is(throwing(property))).toBe(false)
    }
  })

  // `resync` is the recovery instruction the client acts on, and it is only
  // meaningful alongside `compacted`.
  it("refuses a resync that does not belong to a compacted failure, or is malformed", () => {
    const resync = { runId: "r", checkpointSeq: 3 }
    expect(SyncError.is({ _tag: "@smthrs/sync/SyncError", code: "compacted", message: "x", resync })).toBe(true)
    expect(SyncError.is({ _tag: "@smthrs/sync/SyncError", code: "closed", message: "x", resync })).toBe(false)
    expect(
      SyncError.is({
        _tag: "@smthrs/sync/SyncError",
        code: "compacted",
        message: "x",
        resync: { runId: "r" }
      })
    ).toBe(false)
  })
})
