import { FastCheck, TestSchema } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Entry, Input, makeEventId, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

describe("JournalEvent properties", () => {
  it("Entry survives encode-then-decode for arbitrary envelopes", async () => {
    const asserts = new TestSchema.Asserts(Entry)
    await asserts.verifyLosslessTransformation({ params })
  })

  it("Input survives encode-then-decode for arbitrary submissions", async () => {
    const asserts = new TestSchema.Asserts(Input)
    await asserts.verifyLosslessTransformation({ params })
  })

  it("makeEventId keeps distinct (runId, sourceId, sourceSeq) tuples distinct", () => {
    // The id concatenates the tuple, so identifiers containing the separator
    // or digits are exactly where a naive scheme collides ("b"+"12" versus
    // "b1"+"2"). The length prefixes must keep every boundary recoverable.
    const identifier = FastCheck.oneof(
      FastCheck.string({ unit: "binary" }),
      FastCheck.array(FastCheck.constantFrom("0", "1", "9", ":", "flows", "event", ""), { maxLength: 6 })
        .map((parts) => parts.join(""))
    )
    const seq = FastCheck.nat({ max: 1_000_000 })
    FastCheck.assert(
      FastCheck.property(identifier, identifier, seq, identifier, identifier, seq, (
        runA,
        sourceA,
        seqA,
        runB,
        sourceB,
        seqB
      ) => {
        const left = makeEventId(runId(runA), sourceId(sourceA), sourceSeq(seqA))
        const right = makeEventId(runId(runB), sourceId(sourceB), sourceSeq(seqB))
        if (runA === runB && sourceA === sourceB && seqA === seqB) {
          // Determinism: a producer retry regenerates the same durable id.
          expect(left).toBe(right)
        } else {
          expect(left).not.toBe(right)
        }
      }),
      {
        ...params,
        examples: [
          ["a", "b", 12, "a", "b1", 2],
          ["a", "1:b", 0, "a:1", "b", 0],
          ["ab", "c", 0, "a", "bc", 0],
          ["1", "", 10, "", "1", 10],
          ["flows:event:1:", "", 0, "", "flows:event:1:", 0],
          ["a", "b", 1, "a", "b", 1]
        ]
      }
    )
  })

  it("pins makeEventId's persisted wire format", () => {
    // `event_id` is written to `flows_journal_events` under a UNIQUE
    // constraint and is looked up verbatim by `selectExisting`, and
    // `@smthrs/time-travel` synthesizes forked rows as
    // `'fork:' || run_id || ':' || event_id`. Changing the prefix, the
    // separator, or the length prefixes orphans every persisted row, and the
    // injectivity property above would stay green while it happened. These
    // literals are a persisted wire format: they cannot change without a
    // migration.
    expect(makeEventId(runId("run"), sourceId("source"), sourceSeq(3))).toBe("flows:event:3:run6:source3")
    expect(makeEventId(runId("a:1"), sourceId("b:2"), sourceSeq(10))).toBe("flows:event:3:a:13:b:210")
    expect(makeEventId(runId(""), sourceId(""), sourceSeq(0))).toBe("flows:event:0:0:0")
  })
})
