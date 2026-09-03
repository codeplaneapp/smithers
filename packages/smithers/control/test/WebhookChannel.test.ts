/**
 * The webhook ingress is the one control-plane door a bearer holder reaches
 * with an arbitrary payload, so its bounds and its decoding failures are the
 * assertions worth pinning.
 *
 * `handler` used to materialize whatever arrived: `request.arrayBuffer` with no
 * size check anywhere in the package. The two tests that matter here are the
 * ones proving the declared length is refused BEFORE the body is read, and that
 * a caller who lies about the declared length gains nothing.
 */
import { Cause, Effect, Exit, Layer, Redacted, Schema } from "effect"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { describe, expect, it } from "vitest"
import * as Channels from "../src/Channels.ts"
import { InvalidInput, Unauthorized } from "../src/ControlError.ts"
import type { CredentialRef } from "../src/Credential.ts"
import * as WebhookChannel from "../src/WebhookChannel.ts"

const accepted = { _tag: "Accepted" as const, receiptId: "receipt" }

const credential: Redacted.Redacted<CredentialRef> = Redacted.make({ id: "cred", name: "webhook" })

/** A Channels service that records what reached it instead of ingesting. */
const recordingChannels = (seen: Array<Channels.IngestRequest>) =>
  Layer.succeed(
    Channels.Channels,
    Channels.Channels.of({
      register: () => Effect.void,
      lookup: () => Effect.die("unused"),
      ingest: (request) =>
        Effect.sync(() => {
          seen.push(request)
          return accepted
        }),
      project: () => Effect.die("unused")
    })
  )

/**
 * A minimal request. `arrayBuffer` is a thunk so a test can assert the body was
 * never pulled: an over-declared length must cost nothing to refuse.
 */
const request = (
  headers: Readonly<Record<string, string | undefined>>,
  body: () => Uint8Array
): Layer.Layer<HttpServerRequest.HttpServerRequest> =>
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    {
      headers,
      get arrayBuffer() {
        return Effect.sync(() => {
          const bytes = body()
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        })
      }
    } as unknown as HttpServerRequest.HttpServerRequest
  )

const bytes = (length: number): Uint8Array => new Uint8Array(length).fill(0x61)

/** The typed failure an exit carries, so an assertion reads the error, not its printed shape. */
const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a typed failure")
  return Cause.squash(exit.cause) as E
}

const runHandler = (
  headers: Readonly<Record<string, string | undefined>>,
  body: () => Uint8Array,
  seen: Array<Channels.IngestRequest>,
  options?: { readonly maximumBodyBytes?: number }
) =>
  Effect.runPromiseExit(
    WebhookChannel.handler("hook", "key", options).pipe(
      Effect.provide(Layer.mergeAll(recordingChannels(seen), request(headers, body)))
    )
  )

describe("WebhookChannel.handler bounds the request body", () => {
  it("accepts a body at exactly the limit", async () => {
    const seen: Array<Channels.IngestRequest> = []
    const exit = await runHandler({}, () => bytes(64), seen, { maximumBodyBytes: 64 })
    expect(exit._tag).toBe("Success")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.raw.body.byteLength).toBe(64)
    expect(seen[0]?.channel).toBe("hook")
    expect(seen[0]?.raw.idempotencyKey).toBe("key")
  })

  it("refuses a body one byte over the limit and never ingests it", async () => {
    const seen: Array<Channels.IngestRequest> = []
    const exit = await runHandler({}, () => bytes(65), seen, { maximumBodyBytes: 64 })
    expect(failure(exit)).toMatchObject({
      _tag: "/control/InvalidInput",
      code: "invalid_input",
      issue: "webhook body: 65 bytes exceeds the 64 byte limit"
    })
    expect(seen).toHaveLength(0)
  })

  it("refuses an over-declared content-length before reading the body", async () => {
    const seen: Array<Channels.IngestRequest> = []
    let pulled = false
    const exit = await runHandler(
      { "content-length": "5000" },
      () => {
        pulled = true
        return bytes(1)
      },
      seen,
      { maximumBodyBytes: 64 }
    )
    expect(failure(exit)).toMatchObject({
      _tag: "/control/InvalidInput",
      issue: "webhook body: declared 5000 bytes exceeds the 64 byte limit"
    })
    expect(pulled).toBe(false)
    expect(seen).toHaveLength(0)
  })

  it("refuses a body whose content-length lied low", async () => {
    const seen: Array<Channels.IngestRequest> = []
    const exit = await runHandler({ "content-length": "1" }, () => bytes(200), seen, { maximumBodyBytes: 64 })
    expect(failure(exit)).toMatchObject({ issue: "webhook body: 200 bytes exceeds the 64 byte limit" })
    expect(seen).toHaveLength(0)
  })

  it("reads a capitalised Content-Length the same way", async () => {
    const seen: Array<Channels.IngestRequest> = []
    const exit = await runHandler({ "Content-Length": "5000" }, () => bytes(1), seen, { maximumBodyBytes: 64 })
    expect(failure(exit)).toMatchObject({ issue: "webhook body: declared 5000 bytes exceeds the 64 byte limit" })
  })

  it("ignores a content-length it cannot trust", async () => {
    const seen: Array<Channels.IngestRequest> = []
    for (const value of ["not-a-number", "-1", "1.5", undefined]) {
      const exit = await runHandler({ "content-length": value, other: "x" }, () => bytes(8), seen, {
        maximumBodyBytes: 64
      })
      expect(exit._tag).toBe("Success")
    }
    expect(seen).toHaveLength(4)
  })

  it("applies the package default when a mount names no limit", async () => {
    const seen: Array<Channels.IngestRequest> = []
    expect(WebhookChannel.maximumBodyBytes).toBe(1024 * 1024)
    const exit = await runHandler(
      { "content-length": String(WebhookChannel.maximumBodyBytes + 1) },
      () => bytes(1),
      seen
    )
    expect(failure(exit)).toMatchObject({ _tag: "/control/InvalidInput" })
    const withinDefault = await runHandler({}, () => bytes(16), seen)
    expect(withinDefault._tag).toBe("Success")
  })
})

const channel = (
  overrides: Partial<WebhookChannel.Config<{ readonly kind: string }>> = {}
): Channels.Channel<{ readonly kind: string }> =>
  WebhookChannel.make<{ readonly kind: string }>({
    name: "hook",
    schema: Schema.Struct({ kind: Schema.String }),
    credential,
    verify: () => Effect.void,
    map: (payload) => Effect.succeed({ _tag: "Start", flowId: payload.kind, input: {} }),
    project: () => ({ cursor: "1", operation: "post", message: {} }),
    ...overrides
  })

const raw = (body: string): Channels.RawInbound => ({
  body: new TextEncoder().encode(body),
  headers: {},
  idempotencyKey: "key"
})

describe("WebhookChannel.make", () => {
  it("hands the configured credential to the verifier with the raw bytes", async () => {
    let handed: Redacted.Redacted<CredentialRef> | undefined
    const built = channel({
      verify: (_raw, given) =>
        Effect.sync(() => {
          handed = given
        })
    })
    await Effect.runPromise(built.verify(raw("{\"kind\":\"start\"}")))
    expect(handed === undefined ? undefined : Redacted.value(handed)).toEqual({ id: "cred", name: "webhook" })
  })

  it("passes a rejected signature through unchanged", async () => {
    const built = channel({ verify: () => Effect.fail(new Unauthorized({ message: "bad signature" })) })
    const exit = await Effect.runPromiseExit(built.verify(raw("{}")))
    expect(failure(exit)).toMatchObject({ _tag: "/control/Unauthorized", message: "bad signature" })
  })

  it("decodes a valid payload", async () => {
    const decoded = await Effect.runPromise(channel().decode(raw("{\"kind\":\"start\"}")))
    expect(decoded).toEqual({ kind: "start" })
  })

  it("refuses malformed JSON as InvalidInput", async () => {
    const exit = await Effect.runPromiseExit(channel().decode(raw("{not json")))
    const error = failure(exit) as InvalidInput
    expect(error._tag).toBe("/control/InvalidInput")
    expect(error.issue).toContain("invalid webhook JSON")
  })

  it("refuses well-formed JSON that fails the declared schema", async () => {
    const exit = await Effect.runPromiseExit(channel().decode(raw("{\"kind\":7}")))
    const error = failure(exit) as InvalidInput
    expect(error._tag).toBe("/control/InvalidInput")
    expect(error.issue).toContain("kind")
  })

  it("keeps an InvalidInput a mapper raises", async () => {
    const built = channel({ map: () => Effect.fail(new InvalidInput({ issue: "unmapped event" })) })
    const exit = await Effect.runPromiseExit(built.map({ kind: "start" }))
    expect(failure(exit)).toMatchObject({ _tag: "/control/InvalidInput", issue: "unmapped event" })
  })

  it("carries declared fingerprint headers onto the channel and omits them otherwise", () => {
    expect(channel().fingerprintHeaders).toBeUndefined()
    expect(channel({ fingerprintHeaders: ["x-event-type"] }).fingerprintHeaders).toEqual(["x-event-type"])
  })

  it("exposes the configured projection", () => {
    expect(channel().project({ runId: "run" } as never, undefined)).toEqual({
      cursor: "1",
      operation: "post",
      message: {}
    })
  })
})
