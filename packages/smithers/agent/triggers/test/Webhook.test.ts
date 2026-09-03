import * as ControlChannels from "@smthrs/control/Channels"
import * as Control from "@smthrs/control/Control"
import { InvalidInput } from "@smthrs/control/ControlError"
import type { CredentialRef } from "@smthrs/control/Credential"
import { Cause, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { TriggerError } from "../src/TriggerError.ts"
import * as Webhook from "../src/Webhook.ts"

const Payload = Schema.Union([
  Schema.TaggedStruct("start", {
    flowId: Schema.String,
    input: Schema.Unknown
  }),
  Schema.TaggedStruct("signal", {
    runId: Schema.String,
    stepId: Schema.String,
    value: Schema.Json
  })
])

type Payload = typeof Payload.Type

const raw = (
  body: unknown,
  idempotencyKey: string,
  signature = "valid"
) => ({
  body: new TextEncoder().encode(JSON.stringify(body)),
  headers: { "x-signature": signature },
  idempotencyKey
})

const credential = Redacted.make<CredentialRef>({ id: "events-secret", name: "events" })

const declaration = (
  calls: Array<string>,
  onInbound: () => void = () => undefined
) => ({
  name: "events",
  schema: Payload,
  credential,
  verify: Webhook.makeSignatureVerifier({
    header: "x-signature",
    expected: (body: Uint8Array, ref: Redacted.Redacted<CredentialRef>) => {
      calls.push(`verify:${Redacted.value(ref).id}:${new TextDecoder().decode(body)}`)
      return Effect.succeed(new TextEncoder().encode("valid"))
    }
  }),
  inbound: (payload: Payload) => {
    onInbound()
    return payload._tag === "start"
      ? { start: { flowId: payload.flowId, input: payload.input } }
      : {
        signal: {
          runId: payload.runId,
          stepId: payload.stepId,
          value: payload.value
        }
      }
  }
})

const controlLayer = (calls: Array<string>) =>
  Layer.succeed(
    Control.Control,
    Control.make({
      plan: (input) =>
        Effect.sync(() => {
          calls.push(`plan:${input.flowId}`)
          return {
            planId: "plan-1",
            flowId: input.flowId,
            digest: "digest",
            inputSummary: "input",
            envelope: { capabilities: [], flows: [], budget: {} },
            deployClass: false,
            nodes: [],
            approval: {
              target: {
                _tag: "Plan" as const,
                planId: "plan-1",
                digest: "digest",
                envelope: { capabilities: [], flows: [], budget: {} }
              },
              scope: "run" as const,
              idempotencyKey: "approval"
            }
          }
        }),
      run: () =>
        Effect.sync(() => {
          calls.push("run")
          return {
            _tag: "Accepted" as const,
            receiptId: "started",
            runId: "run-1"
          }
        }),
      approve: () => Effect.die("unused"),
      deny: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
      signal: (input) =>
        Effect.sync(() => {
          calls.push(`signal:${input.runId}:${input.signal.name}`)
          return { _tag: "Accepted" as const, receiptId: "signalled" }
        }),
      cancel: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      watch: () => Stream.empty
    })
  )

const run = <A, E>(
  effect: Effect.Effect<A, E, ControlChannels.Channels>,
  calls: Array<string>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(ControlChannels.layerMemory.pipe(Layer.provide(controlLayer(calls))))
    )
  )

describe("Webhook", () => {
  it("rejects an invalid signature as verification_failed before decode or planning", async () => {
    const calls: Array<string> = []
    let inbound = false
    const webhook = Webhook.make(declaration(calls, () => {
      inbound = true
    }))
    const exit = await run(
      Effect.exit(
        webhook.register.pipe(Effect.andThen(webhook.ingest({
          body: new TextEncoder().encode("{not-json"),
          headers: { "x-signature": "invalid" },
          idempotencyKey: "delivery-1"
        })))
      ),
      calls
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.squash(exit.cause)
      expect(failure).toMatchObject({ code: "verification_failed" })
    }
    expect(inbound).toBe(false)
    expect(calls.some((call) => call.startsWith("plan:"))).toBe(false)
  })

  it("returns a typed decode failure after a valid signature", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    const exit = await run(
      Effect.exit(
        webhook.register.pipe(
          Effect.andThen(webhook.ingest(raw({ _tag: "start", flowId: 42, input: {} }, "delivery-2")))
        )
      ),
      calls
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(InvalidInput)
    }
    expect(calls.some((call) => call.startsWith("plan:"))).toBe(false)
  })

  it("deduplicates repeated deliveries and maps starts and signals through Control", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    await run(
      Effect.gen(function*() {
        yield* webhook.register
        yield* webhook.ingest(
          raw({ _tag: "start", flowId: "review", input: { pr: 42 } }, "start-1")
        )
        const replay = yield* webhook.ingest(
          raw({ _tag: "start", flowId: "review", input: { pr: 42 } }, "start-1")
        )
        expect(replay._tag).toBe("AlreadyApplied")
        yield* webhook.ingest(
          raw(
            {
              _tag: "signal",
              runId: "run-1",
              stepId: "approval",
              value: true
            },
            "signal-1"
          )
        )
      }),
      calls
    )

    expect(calls.filter((call) => call === "plan:review")).toHaveLength(1)
    expect(calls.filter((call) => call === "run")).toHaveLength(1)
    expect(calls.filter((call) => call === "signal:run-1:approval")).toHaveLength(1)
  })

  it("exposes no direct execution method", () => {
    const webhook = Webhook.make(declaration([]))
    expect(Object.keys(webhook).sort()).toEqual(["ingest", "name", "register"])
    expect("run" in webhook).toBe(false)
    expect("start" in webhook).toBe(false)
  })

  it("compares over the expected signature's length, never the supplied one", () => {
    const bytes = (text: string) => new TextEncoder().encode(text)
    expect(Webhook.constantTimeEqual(bytes("abc"), bytes("abc"))).toBe(true)
    expect(Webhook.constantTimeEqual(bytes("abc"), bytes("abd"))).toBe(false)
    expect(Webhook.constantTimeEqual(bytes("abc"), bytes("abcd"))).toBe(false)
    expect(Webhook.constantTimeEqual(bytes("abcd"), bytes("abc"))).toBe(false)
    expect(Webhook.constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true)
    expect(Webhook.constantTimeEqual(new Uint8Array(), bytes("a"))).toBe(false)
  })

  it("refuses an absent header and a header longer than the expected signature", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    for (
      const headers of [
        {},
        { "x-signature": "valid-and-then-some" },
        { "X-Signature": "wrong" }
      ]
    ) {
      const exit = await run(
        Effect.exit(
          webhook.register.pipe(Effect.andThen(webhook.ingest({
            body: new TextEncoder().encode("{}"),
            headers,
            idempotencyKey: `absent-${JSON.stringify(headers)}`
          })))
        ),
        calls
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toMatchObject({ code: "verification_failed" })
      }
    }
  })

  it("accepts the signature header under its declared casing", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make({
      ...declaration(calls),
      verify: Webhook.makeSignatureVerifier({
        header: "X-Signature",
        expected: () => Effect.succeed(new TextEncoder().encode("valid"))
      })
    })
    const receipt = await run(
      webhook.register.pipe(
        Effect.andThen(
          webhook.ingest({
            body: new TextEncoder().encode(JSON.stringify({ _tag: "start", flowId: "review", input: {} })),
            headers: { "X-Signature": "valid" },
            idempotencyKey: "cased-1"
          })
        )
      ),
      calls
    )
    expect(receipt._tag).toBe("Accepted")
  })

  // A verifier that cannot resolve its credential used to throw out of a
  // synchronous callback, which `Effect.suspend` turns into a defect that kills
  // the fiber rather than a refusal the caller can read.
  it("reports a failing expected() as a typed refusal, never a defect", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make({
      ...declaration(calls),
      verify: Webhook.makeSignatureVerifier({
        header: "x-signature",
        expected: () =>
          Effect.fail(
            new TriggerError({ code: "verification_failed", message: "credential could not be resolved" })
          )
      })
    })
    const exit = await run(
      Effect.exit(
        webhook.register.pipe(
          Effect.andThen(webhook.ingest(raw({ _tag: "start", flowId: "review", input: {} }, "unresolved-1")))
        )
      ),
      calls
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(TriggerError)
      expect(Cause.squash(exit.cause)).toMatchObject({
        code: "verification_failed",
        message: "credential could not be resolved"
      })
    }
  })

  it("hands the declared credential to the verifier on every request", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    await run(
      webhook.register.pipe(
        Effect.andThen(webhook.ingest(raw({ _tag: "start", flowId: "review", input: {} }, "credential-1")))
      ),
      calls
    )
    expect(calls.filter((call) => call.startsWith("verify:events-secret:"))).toHaveLength(1)
  })

  // `ingest` no longer registers: a channel nobody registered used to
  // self-register on first traffic, which defeats the failure that reports an
  // unknown door.
  it("refuses traffic to a channel that was never registered", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    const exit = await run(
      Effect.exit(webhook.ingest(raw({ _tag: "start", flowId: "review", input: {} }, "unregistered-1"))),
      calls
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "/control/Unavailable" })
    }
    expect(calls).toHaveLength(0)
  })

  // Verification, delivery fingerprinting, and decoding must all read one
  // private snapshot. Without it a verifier that edits the bytes it was handed
  // authenticates one payload and has another decoded.
  it("decodes the bytes it authenticated even when the verifier rewrites them", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make({
      ...declaration(calls),
      verify: Webhook.makeSignatureVerifier({
        header: "x-signature",
        expected: (body) =>
          Effect.sync(() => {
            body.fill(0)
            return new TextEncoder().encode("valid")
          })
      })
    })
    await run(
      webhook.register.pipe(
        Effect.andThen(webhook.ingest(raw({ _tag: "start", flowId: "review", input: { pr: 7 } }, "mutating-1")))
      ),
      calls
    )
    expect(calls).toContain("plan:review")
  })

  it("ignores a caller mutating its own request between building and running ingest", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    const request = raw({ _tag: "start", flowId: "review", input: {} }, "swapped-1")
    const pending = webhook.ingest(request)
    request.body.fill(0)
    request.headers["x-signature"] = "tampered"
    await run(webhook.register.pipe(Effect.andThen(pending)), calls)
    expect(calls).toContain("plan:review")
  })

  it("reports a signal payload that is not JSON as invalid input", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make({
      ...declaration(calls),
      schema: Schema.Struct({ runId: Schema.String }),
      inbound: (payload: { readonly runId: string }) => ({
        signal: { runId: payload.runId, stepId: "approval", value: () => undefined }
      })
    })
    const exit = await run(
      Effect.exit(
        webhook.register.pipe(Effect.andThen(webhook.ingest(raw({ runId: "run-1" }, "unserializable-1"))))
      ),
      calls
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(InvalidInput)
    }
    expect(calls.some((call) => call.startsWith("signal:"))).toBe(false)
  })

  it("projects run state outbound only when the declaration asks for it", async () => {
    const calls: Array<string> = []
    const summary = { runId: "run-1", status: "running", updatedAt: 42 } as never
    const projections = await run(
      Effect.gen(function*() {
        const channels = yield* ControlChannels.Channels
        const silent = Webhook.make(declaration(calls))
        const speaking = Webhook.make({
          ...declaration(calls),
          name: "loud",
          outbound: (projected: { readonly status: string }) => `status:${projected.status}`
        })
        yield* silent.register
        yield* speaking.register
        return {
          silent: yield* channels.project({ channel: "events", run: summary }),
          speaking: yield* channels.project({ channel: "loud", run: summary })
        }
      }),
      calls
    )
    expect(projections.silent).toMatchObject({ cursor: "42", operation: "noop", message: null })
    expect(projections.speaking).toMatchObject({
      cursor: "42",
      operation: "post",
      message: "status:running"
    })
  })

  it("registers the declared schema rather than an unknown one", async () => {
    const calls: Array<string> = []
    const webhook = Webhook.make(declaration(calls))
    const registered = await run(
      Effect.gen(function*() {
        const channels = yield* ControlChannels.Channels
        yield* webhook.register
        return yield* channels.lookup("events")
      }),
      calls
    )
    expect(registered.schema).toBe(Payload)
  })
})
