import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Channels from "../src/Channels.ts"
import * as Control from "../src/Control.ts"
import { PersistenceError, Unauthorized } from "../src/ControlError.ts"
import * as WebhookChannel from "../src/WebhookChannel.ts"

const accepted = { _tag: "Accepted" as const, receiptId: "receipt" }

const run = <A, E>(effect: Effect.Effect<A, E, Channels.Channels>, calls: Array<string> = []) =>
  Effect.runPromise(effect.pipe(Effect.provide(Channels.layer.pipe(Layer.provide(recordingControl(calls))))))

const recordingControl = (calls: Array<string>) => {
  return Layer.succeed(
    Control.Control,
    Control.make({
      plan: () => {
        calls.push("plan")
        return Effect.succeed({
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
        })
      },
      run: () => {
        calls.push("run")
        return Effect.succeed(accepted)
      },
      approve: () => Effect.die("unused"),
      deny: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
      signal: () => {
        calls.push("signal")
        return Effect.succeed(accepted)
      },
      cancel: () => Effect.die("unused"),
      pause: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
      watch: () => Stream.empty
    })
  )
}

const raw = (idempotencyKey = "key"): Channels.RawInbound => ({
  body: new TextEncoder().encode("{\"kind\":\"start\"}"),
  headers: {},
  idempotencyKey
})

describe("Channels", () => {
  it("verifies before decoding or calling Control", async () => {
    const calls: Array<string> = []
    const channel: Channels.Channel = {
      name: "signed",
      schema: Schema.Unknown,
      verify: () =>
        Effect.gen(function*() {
          calls.push("verify")
          return yield* Effect.fail(new Unauthorized({ message: "bad" }))
        }),
      decode: () =>
        Effect.sync(() => {
          calls.push("decode")
          return null
        }),
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    const exit = await run(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        return yield* Effect.exit(channels.ingest({ channel: "signed", raw: raw() }))
      }),
      calls
    )
    expect(exit._tag).toBe("Failure")
    expect(calls).toEqual(["verify"])
  })

  it("turns invalid webhook schema data into InvalidInput", async () => {
    const webhook = WebhookChannel.make({
      name: "schema",
      schema: Schema.Struct({ count: Schema.Number }),
      credential: Redacted.make({ id: "connection", name: "connection" }),
      verify: () => Effect.void,
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    })
    const channel: Channels.Channel = {
      ...webhook,
      schema: Schema.Unknown,
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} })
    }
    const exit = await run(Effect.gen(function*() {
      const channels = yield* Channels.Channels
      yield* channels.register(channel)
      return yield* Effect.exit(channels.ingest({
        channel: "schema",
        raw: { ...raw(), body: new TextEncoder().encode("{\"count\":\"wrong\"}") }
      }))
    }))
    expect(exit._tag).toBe("Failure")
  })

  it("maps starts and signals through Control and deduplicates inbound keys", async () => {
    const calls: Array<string> = []
    const control = Layer.succeed(
      Control.Control,
      Control.make({
        plan: () =>
          Effect.sync(() => {
            calls.push("plan")
            return {
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
            }
          }),
        run: () =>
          Effect.sync(() => {
            calls.push("run")
            return accepted
          }),
        approve: () => Effect.die("unused"),
        deny: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        signal: () =>
          Effect.sync(() => {
            calls.push("signal")
            return accepted
          }),
        cancel: () => Effect.die("unused"),
        pause: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        watch: () => Stream.empty
      })
    )
    const channel: Channels.Channel = {
      name: "events",
      schema: Schema.Unknown,
      verify: () => Effect.void,
      decode: (request) => Effect.succeed(JSON.parse(new TextDecoder().decode(request.body)) as unknown),
      map: (payload) =>
        Effect.succeed(
          typeof payload === "object" &&
            payload !== null &&
            "kind" in payload &&
            payload.kind === "signal"
            ? { _tag: "Signal", runId: "run", signal: { name: "approved", payload: true } }
            : { _tag: "Start", flowId: "flow", input: {} }
        ),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        yield* channels.ingest({ channel: "events", raw: raw("start") })
        yield* channels.ingest({ channel: "events", raw: raw("start") })
        yield* channels.ingest({
          channel: "events",
          raw: { ...raw("signal"), body: new TextEncoder().encode("{\"kind\":\"signal\"}") }
        })
      }).pipe(Effect.provide(Channels.layer.pipe(Layer.provide(control))))
    )
    expect(calls).toEqual(["plan", "run", "signal"])
  })

  it("does not poison an inbound key when Control fails", async () => {
    let attempts = 0
    const retryingControl = Layer.succeed(
      Control.Control,
      Control.make({
        plan: () => Effect.die("unused"),
        run: () => Effect.die("unused"),
        approve: () => Effect.die("unused"),
        deny: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        signal: () =>
          Effect.suspend(() => {
            attempts += 1
            return attempts === 1
              ? Effect.fail(new PersistenceError({ operation: "signal", message: "transient" }))
              : Effect.succeed(accepted)
          }),
        cancel: () => Effect.die("unused"),
        pause: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        watch: () => Stream.empty
      })
    )
    const channel: Channels.Channel = {
      name: "retry",
      schema: Schema.Unknown,
      verify: () => Effect.void,
      decode: () => Effect.succeed(null),
      map: () => Effect.succeed({ _tag: "Signal", runId: "run", signal: { name: "retry", payload: null } }),
      project: () => ({ cursor: "1", operation: "post", message: {} })
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        const channels = yield* Channels.Channels
        yield* channels.register(channel)
        yield* Effect.exit(channels.ingest({ channel: "retry", raw: raw("retry-key") }))
        const receipt = yield* channels.ingest({ channel: "retry", raw: raw("retry-key") })
        expect(receipt._tag).toBe("Accepted")
      }).pipe(Effect.provide(Channels.layer.pipe(Layer.provide(retryingControl))))
    )
    expect(attempts).toBe(2)
  })

  it("retains delivery cursors for edit projections and redacts credentials", async () => {
    const deliveries: Array<Channels.Delivery | undefined> = []
    const channel: Channels.Channel = {
      name: "outbound",
      schema: Schema.Unknown,
      verify: () => Effect.void,
      decode: () => Effect.succeed(null),
      map: () => Effect.succeed({ _tag: "Start", flowId: "flow", input: {} }),
      project: (_run, previous) => {
        deliveries.push(previous)
        return previous === undefined
          ? { cursor: "1", messageId: "message", operation: "post", message: {} }
          : { cursor: "2", messageId: previous.messageId, operation: "edit", message: {} }
      }
    }
    await run(Effect.gen(function*() {
      const channels = yield* Channels.Channels
      yield* channels.register(channel)
      const run = { runId: "run", flowId: "flow", status: "running" as const, createdAt: 0, updatedAt: 0 }
      yield* channels.project({ channel: "outbound", run })
      yield* channels.project({ channel: "outbound", run })
    }))
    expect(deliveries).toEqual([undefined, { cursor: "1", messageId: "message" }])
    expect(JSON.stringify({ secret: Redacted.make("do-not-persist") })).not.toContain("do-not-persist")
  })
})
