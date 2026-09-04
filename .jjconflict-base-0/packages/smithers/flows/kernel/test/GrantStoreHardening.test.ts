import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { Deferred, Effect, Fiber } from "effect"
import * as GrantStore from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const safe = new Capability({ action: "fs:read", resource: "/workspace/safe.txt" })
const other = new Capability({ action: "fs:read", resource: "/workspace/other.txt" })
const outside = new Capability({ action: "fs:read", resource: "/outside/secret.txt" })
const safePattern = () => new CapabilityPattern({ action: "fs:read", resource: "/workspace/safe.txt" })
const workspacePattern = () => new CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
const deny = () => new Rule({ effect: "deny", pattern: new CapabilityPattern({ action: "net:get", resource: "none" }) })

const make = (options?: GrantStore.MakeOptions) =>
  GrantStore.make(options).pipe(Effect.provide(Workspace.layer("/workspace")))

const awaitPending = (
  store: GrantStore.Service,
  count: number
): Effect.Effect<ReadonlyArray<GrantStore.PendingRequest>> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending.length >= count
        ? Effect.succeed(pending)
        : Effect.yieldNow.pipe(Effect.andThen(awaitPending(store, count))))
  )

const invalidCheck = (
  store: GrantStore.Service,
  meta: Record<string, unknown>
) => Effect.flip(store.check(safe, meta))

describe("GrantStore immutable authority", () => {
  it.effect("does not retain constructor or envelope pattern objects", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const configured = safePattern()
        const configuredStore = yield* make({
          attended: false,
          rules: [new Rule({ effect: "allow", pattern: configured })]
        })
        expect(Reflect.set(configured, "resource", "/workspace/**")).toBe(true)
        yield* configuredStore.check(safe)
        expect((yield* Effect.flip(configuredStore.check(other))).code).toBe("permission_required")

        const envelope = safePattern()
        const envelopeStore = yield* make({ attended: false, planDigest: "plan-1" })
        yield* envelopeStore.grantEnvelope({ planDigest: "plan-1", patterns: [envelope] })
        expect(Reflect.set(envelope, "resource", "/workspace/**")).toBe(true)
        yield* envelopeStore.check(safe)
        expect((yield* Effect.flip(envelopeStore.check(other))).code).toBe("permission_required")
      })
    ))

  it.effect("parks and lists detached immutable capability and metadata snapshots", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const events: Array<unknown> = []
        const store = yield* make({
          persist: (event) => Effect.sync(() => events.push(event))
        })
        const capability = new Capability({ action: "fs:read", resource: "/workspace/safe.txt" })
        const meta = { nested: { mode: "safe" }, values: [1, 2] }
        const waiting = yield* store.check(capability, meta).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [listed] = yield* awaitPending(store, 1)

        expect(Reflect.set(capability, "resource", "/outside/secret.txt")).toBe(true)
        meta.nested.mode = "unsafe"
        meta.values[0] = 9
        expect(Reflect.set(listed!.capability, "resource", "/outside/other")).toBe(false)
        expect(Reflect.set(listed!.meta.nested as object, "mode", "listed-mutation")).toBe(false)
        expect(Reflect.set(listed!.meta.values as object, "0", 8)).toBe(false)

        const [again] = yield* store.list
        expect(again).toMatchObject({
          capability: { action: "fs:read", resource: "/workspace/safe.txt" },
          meta: { nested: { mode: "safe" }, values: [1, 2] }
        })
        expect(again).not.toBe(listed)
        expect(again!.capability).not.toBe(listed!.capability)

        yield* store.reply(again!.requestId, "once")
        yield* Fiber.join(waiting)
        expect(events).toMatchObject([{
          capability: { action: "fs:read", resource: "/workspace/safe.txt" }
        }])
      })
    ))
})

describe("GrantStore bounded input", () => {
  it.effect("rejects malformed store identities and policy collections", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const cases: ReadonlyArray<readonly [GrantStore.MakeOptions, string]> = [
          [{ runId: "" }, "runId is empty, malformed, or too long"],
          [{ runId: "\ud800" }, "runId is empty, malformed, or too long"],
          [{ runId: "\udc00" }, "runId is empty, malformed, or too long"],
          [
            { planDigest: "x".repeat(GrantStore.maximumIdentityLength + 1) },
            "planDigest is empty, malformed, or too long"
          ],
          [
            { rules: Array.from({ length: GrantStore.maximumRules + 1 }, deny) },
            `rules exceed ${GrantStore.maximumRules} entries`
          ],
          [
            { rules: [Array.from({ length: 600 }, deny), Array.from({ length: 600 }, deny)] },
            `rules exceed ${GrantStore.maximumRules} entries`
          ],
          [
            { runRules: Array.from({ length: GrantStore.maximumRules + 1 }, deny) },
            `runRules exceed ${GrantStore.maximumRules} entries`
          ],
          [
            { rules: Array.from({ length: 600 }, deny), runRules: Array.from({ length: 600 }, deny) },
            `rules exceed ${GrantStore.maximumRules} entries`
          ],
          [{ envelopeSignatures: "invalid" as never }, `envelopeSignatures exceed ${GrantStore.maximumRules} entries`],
          [{
            envelopeSignatures: Array.from({ length: GrantStore.maximumRules + 1 }, (_, index) => `signature-${index}`)
          }, `envelopeSignatures exceed ${GrantStore.maximumRules} entries`],
          [{ envelopeSignatures: [""] }, "envelopeSignatures[0] is malformed or too long"]
        ]
        for (const [options, message] of cases) {
          const failure = yield* Effect.flip(make(options))
          expect(failure).toMatchObject({ code: "invalid_resolution", message })
        }
      })
    ))

  it.effect("rejects malformed, cyclic, deep, wide, and oversized metadata", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const cycle: Record<string, unknown> = {}
        cycle.self = cycle
        let deep: Record<string, unknown> = {}
        for (let index = 0; index <= GrantStore.maximumMetadataDepth; index += 1) deep = { child: deep }
        const sparse = new Array(2)
        sparse[1] = "value"
        const wideArray = Array.from({ length: GrantStore.maximumMetadataMembers + 1 }, () => null)
        const accessor = Object.defineProperty({}, "value", {
          enumerable: true,
          get: () => "secret getter"
        })
        const arrayAccessor = ["value"]
        Object.defineProperty(arrayAccessor, "0", { enumerable: true, get: () => "getter" })
        class NotPlain {
          readonly value = "x"
        }
        const wide = Object.fromEntries(
          Array.from({ length: GrantStore.maximumMetadataMembers + 1 }, (_, index) => [`k${index}`, index])
        )
        const invalid: ReadonlyArray<readonly [Record<string, unknown>, RegExp]> = [
          [{ value: Number.NaN }, /non-finite/],
          [{ value: "\ud800" }, /ill-formed/],
          [{ value: "x".repeat(GrantStore.maximumMetadataBytes + 1) }, /exceeds .* bytes/],
          [{ value: 1n }, /JSON data/],
          [cycle, /cycles/],
          [deep, /depth/],
          [{ values: sparse }, /dense data/],
          [{ values: wideArray }, /members/],
          [{ values: arrayAccessor }, /dense data/],
          [{ value: new NotPlain() }, /plain records/],
          [accessor, /well-formed data properties/],
          [wide, /members/],
          [{ value: "🙂".repeat(20_000) }, /exceeds .* bytes/]
        ]
        for (const [meta, message] of invalid) {
          const failure = yield* invalidCheck(store, meta)
          expect(failure).toMatchObject({ code: "invalid_resolution" })
          expect(failure.message).toMatch(message)
        }

        const hostile = new Proxy({}, {
          ownKeys: () => ["value"],
          getOwnPropertyDescriptor: () => {
            throw new Error("hidden getter value")
          }
        })
        expect(yield* invalidCheck(store, hostile)).toMatchObject({
          code: "invalid_resolution",
          message: "permission request is invalid"
        })
        expect(yield* invalidCheck(store, [] as never)).toMatchObject({
          code: "invalid_resolution",
          message: "metadata must be a record"
        })
      })
    ))

  it.effect("accepts the metadata boundary without retaining optional members", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const meta = Object.create(null) as Record<string, unknown>
        meta.null = null
        meta.boolean = true
        meta.number = 1
        meta.text = "ok"
        meta.optional = undefined
        Object.defineProperty(meta, "hidden", { enumerable: false, value: "ignored" })
        meta.values = Array.from({ length: GrantStore.maximumMetadataMembers - 6 }, () => null)
        const waiting = yield* store.check(safe, meta).pipe(Effect.forkChild({ startImmediately: true }))
        const [pending] = yield* awaitPending(store, 1)
        expect(pending!.meta).toMatchObject({ null: null, boolean: true, number: 1, text: "ok" })
        expect(pending!.meta).not.toHaveProperty("optional")
        expect(pending!.meta).not.toHaveProperty("hidden")
        yield* store.reply(pending!.requestId, "once")
        yield* Fiber.join(waiting)
      })
    ))

  it.effect("bounds envelope inputs, durable events, rules, and envelope signatures", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ planDigest: "plan-1" })
        const tooMany = Array.from(
          { length: GrantStore.maximumEnvelopePatterns + 1 },
          (_, index) => new CapabilityPattern({ action: "fs:read", resource: `/workspace/${index}` })
        )
        expect(yield* Effect.flip(store.grantEnvelope({ planDigest: "plan-1", patterns: tooMany }))).toMatchObject({
          code: "invalid_resolution",
          message: `patterns exceed ${GrantStore.maximumEnvelopePatterns} entries`
        })
        expect(
          yield* Effect.flip(store.grantEnvelope({
            planDigest: "plan-1",
            patterns: "invalid" as never
          }))
        ).toMatchObject({
          code: "invalid_resolution",
          message: "patterns must be an array"
        })
        expect(
          yield* Effect.flip(store.grantEnvelope({
            planDigest: "",
            patterns: [safePattern()]
          }))
        ).toMatchObject({
          code: "invalid_resolution",
          message: "planDigest is empty, malformed, or too long"
        })
        const authorityFree = yield* make()
        yield* authorityFree.grantEnvelope({ planDigest: "", patterns: [] })

        const large = Array.from(
          { length: GrantStore.maximumEnvelopePatterns },
          (_, index) =>
            new CapabilityPattern({
              action: "fs:read",
              resource: `/workspace/${index}/${"x".repeat(2_000)}`
            })
        )
        expect(yield* Effect.flip(store.grantEnvelope({ planDigest: "plan-1", patterns: large }))).toMatchObject({
          code: "invalid_resolution",
          message: `grant event exceeds ${GrantStore.maximumEventBytes} bytes`
        })

        const fullRules = yield* make({
          planDigest: "plan-1",
          rules: Array.from({ length: GrantStore.maximumRules }, deny)
        })
        expect(
          yield* Effect.flip(fullRules.grantEnvelope({
            planDigest: "plan-1",
            patterns: [safePattern()]
          }))
        ).toMatchObject({
          code: "invalid_resolution",
          message: `rules exceed ${GrantStore.maximumRules} entries`
        })

        const fullSignatures = yield* make({
          planDigest: "plan-1",
          envelopeSignatures: Array.from({ length: GrantStore.maximumRules }, (_, index) => `signature-${index}`)
        })
        expect(
          yield* Effect.flip(fullSignatures.grantEnvelope({
            planDigest: "plan-1",
            patterns: [safePattern()]
          }))
        ).toMatchObject({
          code: "invalid_resolution",
          message: `grant envelopes exceed ${GrantStore.maximumRules} entries`
        })
      })
    ))

  it.effect("refuses a permission request beyond the parked-request limit", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        for (let index = 0; index < GrantStore.maximumPendingRequests; index += 1) {
          yield* store.check(
            new Capability({
              action: "fs:read",
              resource: `/workspace/pending-${index}`
            })
          ).pipe(Effect.forkChild({ startImmediately: true }))
        }
        yield* awaitPending(store, GrantStore.maximumPendingRequests)
        const failure = yield* Effect.flip(store.check(other))
        expect(failure).toMatchObject({
          code: "invalid_resolution",
          message: `pending requests exceed ${GrantStore.maximumPendingRequests} entries`
        })
      })
    ))

  it.effect("refuses run and remembered rules once the policy is full", () =>
    Effect.scoped(
      Effect.gen(function*() {
        for (const resolution of ["run", "remembered"] as const) {
          const store = yield* make({
            planDigest: "plan-1",
            rules: Array.from({ length: GrantStore.maximumRules }, deny)
          })
          const waiting = yield* store.check(safe).pipe(Effect.forkChild({ startImmediately: true }))
          const [pending] = yield* awaitPending(store, 1)
          expect(yield* Effect.flip(store.reply(pending!.requestId, resolution))).toMatchObject({
            code: "invalid_resolution",
            message: `rules exceed ${GrantStore.maximumRules} entries`
          })
          yield* store.reply(pending!.requestId, "once")
          yield* Fiber.join(waiting)
        }
      })
    ))
})
