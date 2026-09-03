/**
 * The boundary a channel request crosses before anything else in the control
 * plane sees it, and the process-local coordinator adapter authors test with.
 *
 * `Channels.ingest` receives an object a webhook host built, so it copies the
 * request before it verifies, decodes, or reaches `Control`: only enumerable
 * own data properties cross, the body is copied through the `%TypedArray%`
 * accessors rather than read off the caller's object, and header names are
 * folded once so a second casing cannot shadow the first. Each refusal below
 * is a distinct `InvalidInput` sentence naming the offending path, because an
 * adapter author reading "must be a plain record" cannot act on it without one.
 *
 * `makeMemory` is the same coordinator over a process-local receipt map. It has
 * no restart guarantee by design, so what it must still get right is the
 * idempotency answer: a redelivery of the same body replays the first receipt,
 * and a different body under the same key is a conflict rather than a silent
 * second execution.
 */
import * as Sha256 from "@smthrs/crypto/Sha256"
import { Effect, Layer, Schema, Stream } from "effect"
import * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import * as Channels from "../src/Channels.ts"
import * as Control from "../src/Control.ts"
import { InvalidInput, Unavailable } from "../src/ControlError.ts"
import type { Receipt } from "../src/ControlSchema.ts"

const body = new TextEncoder().encode("{\"kind\":\"start\"}")

const channelOf = (overrides: Partial<Channels.Channel> = {}): Channels.Channel => ({
  name: "hook",
  schema: Schema.Unknown,
  verify: () => Effect.void,
  decode: () => Effect.succeed(null),
  map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
  project: () => ({ cursor: "1", operation: "post", message: {} }),
  ...overrides
})

/** A Control whose `run` answers whatever the case under test needs. */
const controlAnswering = (receipt: Receipt) =>
  Layer.succeed(
    Control.Control,
    Control.make({
      plan: () =>
        Effect.succeed({
          planId: "plan",
          flowId: "flow",
          digest: "digest",
          inputSummary: "input",
          envelope: { capabilities: [], flows: [], budget: {} },
          deployClass: false,
          nodes: [],
          approval: {
            target: {
              _tag: "Plan",
              planId: "plan",
              digest: "digest",
              envelope: { capabilities: [], flows: [], budget: {} }
            },
            scope: "run",
            idempotencyKey: "approve:plan"
          }
        }),
      run: () => Effect.succeed(receipt),
      approve: () => Effect.die("unused"),
      deny: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
      signal: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      watch: () => Stream.empty
    })
  )

const memoryChannels = (receipt: Receipt = { _tag: "Accepted", receiptId: "receipt", runId: "run-1" }) =>
  Channels.layerMemory.pipe(
    Layer.provide(controlAnswering(receipt)),
    Layer.provide(Layer.succeed(Crypto.Crypto, Sha256.syncCrypto))
  )

const withChannels = <A, E>(
  effect: (channels: Channels.Channels) => Effect.Effect<A, E>,
  layer = memoryChannels()
) =>
  Effect.runPromise(
    Effect.flatMap(Channels.Channels, effect).pipe(Effect.provide(layer)) as Effect.Effect<A, E>
  )

/** The refusal `ingest` answered, or a failure if it did not refuse. */
const refusal = (request: unknown, layer = memoryChannels()): Promise<string> =>
  withChannels((channels) =>
    Effect.gen(function*() {
      yield* channels.register(channelOf())
      const result = yield* Effect.result(
        channels.ingest(request as Channels.IngestRequest)
      )
      if (result._tag === "Success") return "the boundary accepted the request"
      const error = result.failure
      return error instanceof InvalidInput ? error.issue : `unexpected failure: ${String(error)}`
    }), layer)

const wellFormed = { channel: "hook", raw: { body, headers: {}, idempotencyKey: "delivery-1" } }

describe("the channel ingress boundary", () => {
  it("accepts a well-formed request", async () => {
    const receipt = await withChannels((channels) =>
      Effect.gen(function*() {
        yield* channels.register(channelOf())
        return yield* channels.ingest(wellFormed)
      })
    )
    expect(receipt).toEqual({ _tag: "Accepted", receiptId: "delivery-1", runId: "run-1" })
  })

  it("refuses a request that is not a plain record", async () => {
    expect(await refusal(["hook"])).toBe("request: must be a plain record")
  })

  it("refuses a request carrying a prototype", async () => {
    class Request {
      readonly channel = "hook"
    }
    expect(await refusal(new Request())).toBe("request: must have a plain prototype")
  })

  it("refuses a channel name behind an accessor", async () => {
    expect(
      await refusal({
        get channel() {
          return "hook"
        },
        raw: wellFormed.raw
      })
    ).toBe(
      "request.channel: must be an own data property"
    )
  })

  it("refuses an empty channel name", async () => {
    expect(await refusal({ ...wellFormed, channel: "" })).toBe("request.channel: must be non-empty")
  })

  it("refuses an empty idempotency key", async () => {
    expect(await refusal({ ...wellFormed, raw: { ...wellFormed.raw, idempotencyKey: "" } })).toBe(
      "raw.idempotencyKey: must be non-empty"
    )
  })

  it("refuses a body that is not a typed array", async () => {
    expect(await refusal({ ...wellFormed, raw: { ...wellFormed.raw, body: "{}" } })).toBe(
      "raw.body: must be a Uint8Array"
    )
  })

  it("refuses symbol-keyed headers", async () => {
    const headers = { [Symbol("x-secret")]: "value" }
    expect(await refusal({ ...wellFormed, raw: { ...wellFormed.raw, headers } })).toBe(
      "raw.headers: symbol keys are not supported"
    )
  })

  it("refuses a header behind an accessor", async () => {
    const headers = {
      get signature() {
        return "sha256=..."
      }
    }
    expect(await refusal({ ...wellFormed, raw: { ...wellFormed.raw, headers } })).toBe(
      "raw.headers.signature: must be an enumerable data property"
    )
  })

  it("refuses a non-string header value", async () => {
    expect(await refusal({ ...wellFormed, raw: { ...wellFormed.raw, headers: { retries: 3 } } })).toBe(
      "raw.headers.retries: must be a string or undefined"
    )
  })

  it("refuses two headers that differ only in case", async () => {
    const headers = { "X-Signature": "a", "x-signature": "b" }
    expect(await refusal({ ...wellFormed, raw: { ...wellFormed.raw, headers } })).toBe(
      "raw.headers.x-signature: duplicate case-insensitive name"
    )
  })

  it("refuses a request whose own inspection throws, without repeating what it threw", async () => {
    const hostile = new Proxy({ channel: "hook", raw: wellFormed.raw }, {
      getOwnPropertyDescriptor: () => {
        throw new Error("sk-live-secret escaped through the descriptor trap")
      }
    })
    const issue = await refusal(hostile)
    expect(issue).toBe("channel request could not be inspected safely")
    expect(issue).not.toContain("sk-live-secret")
  })

  it("reports an unregistered channel as unavailable", async () => {
    const failure = await withChannels((channels) => Effect.flip(channels.ingest({ ...wellFormed, channel: "absent" })))
    expect(failure).toBeInstanceOf(Unavailable)
    expect((failure as Unavailable).feature).toBe("channel \"absent\" is not registered")
  })

  it("fingerprints a declared header that the delivery omitted", async () => {
    // A declared-but-absent header must be part of the identity, otherwise a
    // redelivery that ADDS it would replay the first receipt instead of being
    // recognised as a different request.
    const declaring = channelOf({ fingerprintHeaders: ["X-Event", "x-event"] })
    const receipts = await withChannels((channels) =>
      Effect.gen(function*() {
        yield* channels.register(declaring)
        const first = yield* channels.ingest(wellFormed)
        const second = yield* channels.ingest({
          ...wellFormed,
          raw: { ...wellFormed.raw, headers: { "x-event": "push" } }
        })
        return [first, second]
      })
    )
    expect(receipts[0]?._tag).toBe("Accepted")
    expect(receipts[1]?._tag).toBe("Conflict")
  })
})

describe("the process-local channel coordinator", () => {
  it("replays the first receipt for a redelivery of the same body", async () => {
    const receipts = await withChannels((channels) =>
      Effect.gen(function*() {
        yield* channels.register(channelOf())
        const first = yield* channels.ingest(wellFormed)
        const second = yield* channels.ingest(wellFormed)
        return [first, second]
      })
    )
    expect(receipts[0]).toEqual({ _tag: "Accepted", receiptId: "delivery-1", runId: "run-1" })
    expect(receipts[1]).toEqual({ _tag: "AlreadyApplied", receiptId: "delivery-1", runId: "run-1" })
  })

  it("replays a parked receipt without inventing a run id for it", async () => {
    const parked: Receipt = { _tag: "Parked", receiptId: "receipt", planId: "plan", status: "waiting-approval" }
    const receipts = await withChannels((channels) =>
      Effect.gen(function*() {
        yield* channels.register(channelOf())
        const first = yield* channels.ingest(wellFormed)
        const second = yield* channels.ingest(wellFormed)
        return [first, second]
      }), memoryChannels(parked))
    expect(receipts[0]).toEqual({ _tag: "Parked", receiptId: "delivery-1", planId: "plan", status: "waiting-approval" })
    expect(receipts[1]).toEqual({ _tag: "AlreadyApplied", receiptId: "delivery-1" })
    expect(Object.hasOwn(receipts[1] as object, "runId")).toBe(false)
  })

  it("refuses a different body under a key it has already answered", async () => {
    const receipt = await withChannels((channels) =>
      Effect.gen(function*() {
        yield* channels.register(channelOf())
        yield* channels.ingest(wellFormed)
        return yield* channels.ingest({
          ...wellFormed,
          raw: { ...wellFormed.raw, body: new TextEncoder().encode("{\"kind\":\"stop\"}") }
        })
      })
    )
    expect(receipt._tag).toBe("Conflict")
  })

  it("records nothing for a conflicting mutation, so a later delivery is still answered", async () => {
    const conflict: Receipt = { _tag: "Conflict", message: "another mutation owns this key" }
    const receipts = await withChannels((channels) =>
      Effect.gen(function*() {
        yield* channels.register(channelOf())
        const first = yield* channels.ingest(wellFormed)
        const second = yield* channels.ingest(wellFormed)
        return [first, second]
      }), memoryChannels(conflict))
    expect(receipts[0]?._tag).toBe("Conflict")
    expect(receipts[1]?._tag).toBe("Conflict")
  })
})
