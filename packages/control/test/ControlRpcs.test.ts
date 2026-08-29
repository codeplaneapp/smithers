import { Effect, Layer, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"
import { isControlError } from "../src/ControlClient.ts"
import { PlanDigestMismatch, RunNotFound, TransportError, Unauthorized } from "../src/ControlError.ts"
import { bearerAuthenticator, ControlRpcs, layerNoopAuth } from "../src/ControlRpcs.ts"
import * as ControlServer from "../src/ControlServer.ts"
import * as TestControl from "../src/test/TestControl.ts"

const principal = { id: "server", kind: "test", stampedAt: 1 }

const layer = Layer.merge(ControlServer.layer, layerNoopAuth(principal)).pipe(
  Layer.provide(TestControl.layer({ principal: { id: principal.id, kind: principal.kind }, now: () => 1 }))
)

const makeClient = RpcTest.makeClient(ControlRpcs)
type ControlRpcClient = Effect.Success<typeof makeClient>

const client = <A, E>(
  effect: (client: ControlRpcClient) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const rpc = yield* makeClient
      return yield* effect(rpc)
    }).pipe(Effect.provide(layer))
  )

const plan = (rpc: ControlRpcClient) =>
  rpc.Plan({ flowId: "system/release", input: { release: true }, idempotencyKey: "plan" })

describe("ControlRpcs", () => {
  it("authenticates exactly the configured bearer token", async () => {
    const authenticator = bearerAuthenticator({
      token: "alpha-secret",
      principal: { id: "alpha", kind: "bearer" },
      now: () => 42
    })

    const authenticated = await Effect.runPromise(
      authenticator.authenticate({ Authorization: "bearer alpha-secret" })
    )
    const refused = await Promise.all([
      {},
      { authorization: "Basic alpha-secret" },
      { authorization: "Bearer " },
      { authorization: "Bearer alpha-secre" },
      { authorization: "Bearer alpha-secret!" },
      { authorization: "Bearer alpha-secrEt" },
      { authorization: "Bearer 🔐" }
    ].map((headers) => Effect.runPromise(authenticator.authenticate(headers).pipe(Effect.flip))))

    expect(authenticated).toEqual({ id: "alpha", kind: "bearer", stampedAt: 42 })
    expect(refused).toHaveLength(7)
    expect(refused.every((error) => error instanceof Unauthorized)).toBe(true)
  })

  it("fails closed when the configured bearer token is empty", async () => {
    const authenticator = bearerAuthenticator({
      token: "",
      principal: { id: "alpha", kind: "bearer" }
    })

    const refused = await Effect.runPromise(
      authenticator.authenticate({ authorization: "Bearer anything" }).pipe(Effect.flip)
    )

    expect(refused).toBeInstanceOf(Unauthorized)
  })

  it("classifies owned failures through the control error schema union", () => {
    expect(isControlError(new RunNotFound({ runId: "missing" }))).toBe(true)
    expect(isControlError(new TransportError({ message: "offline", retryable: true }))).toBe(true)
    expect(isControlError(new Error("transport failure"))).toBe(false)
  })

  it("round-trips plan, approve, and list", async () => {
    const result = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        const approval = yield* rpc.Approve({ ...card.approval, idempotencyKey: "approve" })
        const listed = yield* rpc.List({ _tag: "flows" })
        return { approval, listed }
      })
    ))

    expect(result.approval._tag).toBe("Accepted")
    expect(result.listed._tag).toBe("flows")
  })

  it("preserves domain failure tags", async () => {
    const error = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        return yield* rpc.Run({
          _tag: "Plan",
          planId: card.planId,
          digest: "not-the-plan-digest",
          envelope: card.envelope,
          idempotencyKey: "run"
        }).pipe(Effect.flip)
      })
    ))

    expect(error).toBeInstanceOf(PlanDigestMismatch)
  })

  it("streams journal events and supports client interruption", async () => {
    const events = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        yield* rpc.Approve({ ...card.approval, idempotencyKey: "stream-approve" })
        const receipt = yield* rpc.Run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "start"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return []
        return yield* rpc.Watch({ runId: receipt.runId }).pipe(Stream.take(1), Stream.runCollect)
      })
    ))

    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("control.run.accepted")
  })

  it("carries a cancel reason across the wire and refuses a caller-named principal", async () => {
    const result = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const card = yield* plan(rpc)
        yield* rpc.Approve({ ...card.approval, idempotencyKey: "cancel-approve" })
        const receipt = yield* rpc.Run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "cancel-start"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("no run")
        yield* rpc.Cancel({
          runId: receipt.runId,
          reason: "budget",
          idempotencyKey: "cancel",
          // A client naming its own principal is decoded away before the
          // handler, so the server's stamped identity is the one recorded.
          principal: { id: "attacker", kind: "attacker", stampedAt: 0 }
        } as never)
        const events = yield* rpc.Watch({ runId: receipt.runId, follow: false }).pipe(Stream.runCollect)
        return events.find((event) => event.kind === "control.run.cancel-requested")
      })
    ))

    expect(result?.payload).toMatchObject({ source: "control", reason: "budget" })
    expect((result?.payload as { readonly principal: { readonly id: string } }).principal.id).toBe("server")
  })

  it("rejects malformed payloads before handlers and ignores caller principal fields", async () => {
    const result = await Effect.runPromise(client((rpc) =>
      Effect.gen(function*() {
        const malformed = yield* Effect.exit(rpc.Plan({ flowId: 1, input: null } as never))
        const card = yield* plan(rpc)
        yield* rpc.Approve({
          ...card.approval,
          scope: "once",
          idempotencyKey: "auth",
          principal: { id: "attacker", kind: "attacker", stampedAt: 0 }
        } as never)
        return malformed
      })
    ))

    expect(result._tag).toBe("Failure")
  })
})
