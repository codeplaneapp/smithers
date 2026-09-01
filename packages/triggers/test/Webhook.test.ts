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
})
