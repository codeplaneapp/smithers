/**
 * Property tests for the sync wire contract: codec round-trips and decoder
 * totality against raw bytes and mutated frames.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as SyncProtocol from "../src/SyncProtocol.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  seed: Number(process.env.FC_SEED ?? 20260814),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

// TestSchema.Asserts#verifyLosslessTransformation is not usable here: its
// deepStrictEqual distinguishes the null-prototype objects TaggedStruct
// decoding produces from the generated samples, an upstream strictness that is
// not a wire-contract property. The round trip is asserted structurally.
const assertRoundTrip = <S extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>>(
  schema: S
): void => {
  const arbitrary = Schema.toArbitrary(schema)(FastCheck)
  const encode = Schema.encodeUnknownResult(schema)
  const decode = Schema.decodeUnknownResult(schema)
  FastCheck.assert(
    FastCheck.property(arbitrary, (value) => {
      const encoded = encode(value)
      expect(encoded._tag).toBe("Success")
      if (encoded._tag !== "Success") return
      const decoded = decode(encoded.success)
      expect(decoded._tag).toBe("Success")
      if (decoded._tag !== "Success") return
      expect(decoded.success).toEqual(value)
    }),
    params
  )
}

const decodeFrame = Schema.decodeUnknownResult(SyncProtocol.Frame)
const decodeFrameJson = Schema.decodeUnknownResult(Schema.fromJsonString(SyncProtocol.Frame))
const encodeFrameJson = Schema.encodeUnknownResult(Schema.fromJsonString(SyncProtocol.Frame))

describe("SyncProtocol properties", () => {
  it.each([
    ["Frame", SyncProtocol.Frame as Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>],
    ["ReadRequest", SyncProtocol.ReadRequest],
    ["ReadResponse", SyncProtocol.ReadResponse],
    ["SubscribeRequest", SyncProtocol.SubscribeRequest]
  ])("encode then decode is the identity for schema-generated %s values", (_name, schema) => {
    assertRoundTrip(schema)
  })

  it("frame decoding of raw bytes is total: a typed failure, never a throw or defect", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.uint8Array({ maxLength: 256 }), (bytes) => {
        // The bytes as an unknown wire value: a Uint8Array is never a frame.
        const direct = decodeFrame(bytes)
        expect(direct._tag).toBe("Failure")

        // The bytes as UTF-8 text through the JSON codec: either a typed
        // failure or, for the rare byte string that is valid frame JSON, a
        // success that re-encodes.
        const parsed = decodeFrameJson(new TextDecoder().decode(bytes))
        if (parsed._tag === "Success") {
          expect(encodeFrameJson(parsed.success)._tag).toBe("Success")
        } else {
          expect(parsed._tag).toBe("Failure")
        }
      }),
      params
    )
  })

  it("frame decoding of hostile JSON values is total and closed under re-encoding", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.jsonValue({ stringUnit: "binary" }), (value) => {
        const decoded = decodeFrame(value)
        if (decoded._tag === "Success") {
          expect(Schema.encodeUnknownResult(SyncProtocol.Frame)(decoded.success)._tag).toBe("Success")
        } else {
          expect(decoded._tag).toBe("Failure")
        }
      }),
      params
    )
  })

  it("truncated, duplicated, and reordered slices of valid frame JSON decode to typed results only", () => {
    const frameArbitrary = Schema.toArbitrary(SyncProtocol.Frame)(FastCheck)
    const mutationArb = FastCheck.constantFrom("truncate", "duplicate-slice", "swap-slices", "drop-bytes")
    FastCheck.assert(
      FastCheck.property(
        frameArbitrary,
        mutationArb,
        FastCheck.nat({ max: 4095 }),
        FastCheck.nat({ max: 4095 }),
        (frame, mutation, rawFirst, rawSecond) => {
          const encoded = encodeFrameJson(frame)
          expect(encoded._tag).toBe("Success")
          if (encoded._tag !== "Success") return
          const json = encoded.success as string
          const first = rawFirst % (json.length + 1)
          const second = rawSecond % (json.length + 1)
          const [from, to] = first <= second ? [first, second] : [second, first]
          const mutated = mutation === "truncate"
            ? json.slice(0, from)
            : mutation === "duplicate-slice"
            ? json.slice(0, to) + json.slice(from, to) + json.slice(to)
            : mutation === "swap-slices"
            ? json.slice(from, to) + json.slice(0, from) + json.slice(to)
            : json.slice(0, from) + json.slice(to)

          const decoded = decodeFrameJson(mutated)
          if (decoded._tag === "Success") {
            // A mutation may reproduce valid frame JSON (for example an empty
            // swap); totality only requires the result to stay in the codec.
            expect(encodeFrameJson(decoded.success)._tag).toBe("Success")
          } else {
            expect(decoded._tag).toBe("Failure")
          }
        }
      ),
      params
    )
  })
})
