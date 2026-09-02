/**
 * The in-memory `ControlRuntime` at the edges the shared contract does not
 * reach: refusals, the idempotency seams, and every state a released fence
 * leaves behind.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  AlreadyResolved,
  ClaimLost,
  EnvelopeMismatch,
  FlowNotFound,
  InvalidInput,
  PlanDenied,
  PlanDigestMismatch,
  PlanNotFound,
  RunNotFound
} from "../src/ControlError.ts"
import { ControlRuntime, type MemoryOptions, type Service } from "../src/ControlRuntime.ts"
import type { Envelope, Principal } from "../src/ControlSchema.ts"
import { memoryRuntime } from "./TestStack.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }
const principal: Principal = { id: "operator", kind: "test", stampedAt: 0 }

const withRuntime = <A, E>(
  use: (runtime: Service) => Effect.Effect<A, E>,
  options?: MemoryOptions
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      return yield* use(runtime)
    }).pipe(Effect.provide(memoryRuntime(options)), Effect.scoped, Effect.orDie)
  )

/** Plans, approves, and launches one run through the port itself. */
const start = (runtime: Service) =>
  Effect.gen(function*() {
    const { card } = yield* runtime.plan({ flowId: "system/test", input: { suite: "memory" } })
    const token = yield* runtime.lookupApproval(card.approval.target)
    yield* runtime.installBulkGrant(token, card.envelope, "run")
    yield* runtime.resolveApproval(token, "approved", principal)
    const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
    if (launched._tag !== "Started") return yield* Effect.die("expected a started run")
    return { card, run: launched.run }
  })

describe("ControlRuntime.layerMemory", () => {
  it("refuses to plan a flow the catalog does not carry", async () => {
    const error = await withRuntime((runtime) => Effect.flip(runtime.plan({ flowId: "system/absent", input: {} })))

    expect(error).toBeInstanceOf(FlowNotFound)
    expect((error as FlowNotFound).flowId).toBe("system/absent")
  })

  it("refuses input with no canonical form, whether the fingerprint or the decode sees it first", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        // The fingerprint canonicalizes `{ flowId, input }`, so a non-finite
        // number inside the input fails there first.
        const fingerprint = yield* Effect.flip(runtime.plan({ flowId: "system/test", input: Number.NaN }))
        // `undefined` survives that wrapper — an absent member is dropped —
        // and is refused only when the input itself is canonicalized.
        const decode = yield* Effect.flip(runtime.plan({ flowId: "system/test", input: undefined }))
        return { fingerprint, decode }
      })
    )

    expect(observed.fingerprint).toBeInstanceOf(InvalidInput)
    // Canonical's public contract supplies stable codes and located paths. The
    // control boundary keeps those two fields and drops the rejected value.
    expect((observed.fingerprint as InvalidInput).issue).toBe("$.input: canonical_nan")
    expect(observed.decode).toBeInstanceOf(InvalidInput)
    expect((observed.decode as InvalidInput).issue).toBe("$: canonical_unsupported_value")
  })

  it("replays a plan for a repeated idempotency key and refuses a reused one", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const first = yield* runtime.plan({ flowId: "system/test", input: { a: 1 }, idempotencyKey: "plan:key" })
        const replay = yield* runtime.plan({ flowId: "system/test", input: { a: 1 }, idempotencyKey: "plan:key" })
        // The second ask under one key is a replay of the stored card, and it
        // says so: `Control.plan` journals a creation only when it created one.
        const reused = yield* Effect.flip(
          runtime.plan({ flowId: "system/test", input: { a: 2 }, idempotencyKey: "plan:key" })
        )
        const listed = yield* runtime.listPlanIds
        return { first, replay, reused, listed }
      })
    )

    expect(observed.first.created).toBe(true)
    expect(observed.replay).toEqual({ card: observed.first.card, created: false })
    expect(observed.reused).toBeInstanceOf(InvalidInput)
    expect((observed.reused as InvalidInput).issue).toBe("idempotency key plan:key was used for another plan")
    // The refused plan allocated nothing: one key, one stored plan.
    expect(observed.listed).toEqual([observed.first.card.planId])
  })

  it("reports a missing approval token against the identifier its target names", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const plan = yield* Effect.flip(runtime.lookupApproval({
          _tag: "Plan",
          planId: "plan-absent",
          digest: "digest",
          envelope
        }))
        const node = yield* Effect.flip(runtime.lookupApproval({
          _tag: "Node",
          runId: "run-absent",
          requestId: "ask-absent",
          digest: "digest",
          envelope
        }))
        return { plan, node }
      })
    )

    expect(observed.plan).toBeInstanceOf(PlanNotFound)
    expect((observed.plan as PlanNotFound).planId).toBe("plan-absent")
    // A node target names the run, not the request: that is the id an
    // operator can act on.
    expect(observed.node).toBeInstanceOf(RunNotFound)
    expect((observed.node as RunNotFound).runId).toBe("run-absent")
  })

  it("refuses to re-register an in-run approval under a different envelope", async () => {
    const error = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { run } = yield* start(runtime)
        const target = {
          _tag: "Node" as const,
          runId: run.runId,
          requestId: "ask-1",
          digest: "ask-digest",
          envelope
        }
        yield* runtime.registerApproval(target)
        return yield* Effect.flip(
          runtime.registerApproval({ ...target, envelope: { ...envelope, capabilities: ["fs:write"] } })
        )
      })
    )

    expect(error).toBeInstanceOf(EnvelopeMismatch)
    expect((error as EnvelopeMismatch).planId).toBe("ask-1")
  })

  it("scopes one request id to each run and records who resolved it", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const firstRun = (yield* start(runtime)).run
        const secondRun = (yield* start(runtime)).run
        const firstTarget = {
          _tag: "Node" as const,
          runId: firstRun.runId,
          requestId: "ask-shared",
          digest: "ask-digest",
          envelope
        }
        const secondTarget = { ...firstTarget, runId: secondRun.runId }
        const first = yield* runtime.registerApproval(firstTarget)
        const second = yield* runtime.registerApproval(secondTarget)

        yield* runtime.resolveApproval(first, "approved", principal)

        return {
          first,
          second,
          firstRunId: firstRun.runId,
          secondRunId: secondRun.runId,
          firstAfter: yield* runtime.registerApproval(firstTarget),
          secondAfter: yield* runtime.registerApproval(secondTarget)
        }
      })
    )

    expect(observed.first.target).toMatchObject({ _tag: "Node", runId: observed.firstRunId })
    expect(observed.firstAfter.target).toMatchObject({ _tag: "Node", runId: observed.firstRunId })
    expect(observed.second.target).toMatchObject({ _tag: "Node", runId: observed.secondRunId })
    expect(observed.secondAfter.target).toMatchObject({ _tag: "Node", runId: observed.secondRunId })
    expect(observed.firstRunId).not.toBe(observed.secondRunId)
    expect(observed.firstAfter).toMatchObject({ resolved: true, decisionPrincipal: principal })
    expect(observed.secondAfter).toMatchObject({ resolved: false })
    expect(observed.secondAfter.decisionPrincipal).toBeUndefined()
  })

  it("keeps colliding plan and node token strings as distinct approvals", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { card } = yield* runtime.plan({ flowId: "system/test", input: { collision: true } })
        const { run } = yield* start(runtime)
        const nodeTarget = {
          _tag: "Node" as const,
          runId: run.runId,
          requestId: card.planId,
          digest: card.digest,
          envelope: card.envelope
        }
        const node = yield* runtime.registerApproval(nodeTarget)
        yield* runtime.resolveApproval(node, "approved", principal)

        return {
          plan: yield* runtime.lookupApproval(card.approval.target),
          storedPlan: yield* runtime.getPlan(card.planId),
          node: yield* runtime.registerApproval(nodeTarget)
        }
      })
    )

    expect(observed.plan).toMatchObject({ resolved: false, target: { _tag: "Plan" } })
    expect(observed.storedPlan.decision).toBe("pending")
    expect(observed.node).toMatchObject({ resolved: true, target: { _tag: "Node" } })
  })

  it("still refuses a changed digest for one node approval identity", async () => {
    const error = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { run } = yield* start(runtime)
        const target = {
          _tag: "Node" as const,
          runId: run.runId,
          requestId: "ask-digest",
          digest: "first",
          envelope
        }
        yield* runtime.registerApproval(target)
        return yield* Effect.flip(runtime.registerApproval({ ...target, digest: "second" }))
      })
    )

    expect(error).toBeInstanceOf(PlanDigestMismatch)
  })

  it("installs one grant per token however often the same token is presented", async () => {
    const grants = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { card } = yield* start(runtime)
        const token = { tokenId: card.planId, target: card.approval.target, resolved: false }
        // A retried decision presents the same token; a second grant would
        // widen what one approval installed.
        yield* runtime.installBulkGrant(token, { ...envelope, capabilities: ["fs:write"] }, "remembered")
        return yield* runtime.grants
      })
    )

    expect(grants).toMatchObject([{ scope: "run", envelope: { capabilities: [] } }])
  })

  it("resolves a token exactly once and refuses one it never issued", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
        const token = { tokenId: card.planId, target: card.approval.target, resolved: false }
        yield* runtime.resolveApproval(token, "denied", principal)
        const again = yield* Effect.flip(runtime.resolveApproval(token, "approved", principal))
        const unknown = yield* Effect.flip(
          runtime.resolveApproval({ ...token, tokenId: "token-absent" }, "approved", principal)
        )
        const stored = yield* runtime.getPlan(card.planId)
        return { again, unknown, stored }
      })
    )

    expect(observed.again).toBeInstanceOf(AlreadyResolved)
    expect(observed.unknown).toBeInstanceOf(AlreadyResolved)
    expect((observed.unknown as AlreadyResolved).requestId).toBe("token-absent")
    expect(observed.stored.decision).toBe("denied")
  })

  it("refuses to launch an unknown plan, a mismatched envelope, or a denied decision", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const missing = yield* Effect.flip(runtime.launch("plan-absent", "digest", envelope))
        const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
        const widened = yield* Effect.flip(
          runtime.launch(card.planId, card.digest, { ...envelope, capabilities: ["fs:write"] })
        )
        const token = yield* runtime.lookupApproval(card.approval.target)
        yield* runtime.resolveApproval(token, "denied", principal)
        const denied = yield* Effect.flip(runtime.launch(card.planId, card.digest, card.envelope))
        return { card, missing, widened, denied }
      })
    )

    expect(observed.missing).toBeInstanceOf(PlanNotFound)
    expect((observed.missing as PlanNotFound).planId).toBe("plan-absent")
    expect(observed.widened).toBeInstanceOf(EnvelopeMismatch)
    expect(observed.denied).toBeInstanceOf(PlanDenied)
    expect((observed.denied as PlanDenied).planId).toBe(observed.card.planId)
  })

  it("refuses every owner-sensitive operation once a park has released the fence", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { run } = yield* start(runtime)
        const fence = yield* runtime.claimFence(run.runId)
        const parked = yield* runtime.writeStatus(run.runId, fence, "parked")
        const again = yield* Effect.flip(runtime.writeStatus(run.runId, fence, "parked"))
        const interrupted = yield* Effect.flip(runtime.interrupt(run.runId))
        const evicted = yield* Effect.flip(runtime.claimFence(run.runId))
        return { parked, again, interrupted, evicted }
      })
    )

    expect(observed.parked.status).toBe("parked")
    expect(observed.parked.ownerId).toBeUndefined()
    expect(observed.again).toBeInstanceOf(ClaimLost)
    expect(observed.interrupted).toBeInstanceOf(ClaimLost)
    expect(observed.evicted).toBeInstanceOf(ClaimLost)
  })

  it("rejoins a run it is already driving instead of taking a second fence", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        const { run } = yield* start(runtime)
        const fence = yield* runtime.claimFence(run.runId)
        const running = yield* runtime.writeStatus(run.runId, fence, "running")
        const rejoined = yield* runtime.resume(run.runId)
        const afterResume = yield* runtime.claimFence(run.runId)
        return { running, rejoined, fence, afterResume }
      })
    )

    expect(observed.running.status).toBe("running")
    expect(observed.rejoined).toEqual(observed.running)
    // Rejoining is a read, so the fence the caller already holds still writes.
    expect(observed.afterResume).toBe(observed.fence)
  })

  it("reports a key reused for a different mutation as a conflict, not a replay", async () => {
    const observed = await withRuntime((runtime) =>
      Effect.gen(function*() {
        yield* runtime.recordMutation("mutation:key", "cancel:run-1", { _tag: "Accepted", receiptId: "r" })
        const replay = yield* runtime.lookupMutation("mutation:key", "cancel:run-1")
        const conflict = yield* runtime.lookupMutation("mutation:key", "cancel:run-2")
        const absent = yield* runtime.lookupMutation("mutation:other", "cancel:run-1")
        return { replay, conflict, absent }
      })
    )

    expect(observed.replay).toEqual({ _tag: "AlreadyApplied", receiptId: "r" })
    expect(observed.conflict).toEqual({
      _tag: "Conflict",
      message: "idempotency key mutation:key was used for another mutation"
    })
    expect(observed.absent).toBeUndefined()
  })

  it("stamps a submitted principal over the composition's own, on its own clock", async () => {
    // The submitted identity is the one the server authenticated, and the
    // configured one is the composition's fallback for a caller that named
    // none. A composition default that won would silently rename every
    // authenticated operator to whatever the host was built with.
    const observed = await withRuntime(
      (runtime) =>
        Effect.gen(function*() {
          const submitted = yield* runtime.stampPrincipal({ id: "remote", kind: "bearer", stampedAt: 99 })
          const unnamed = yield* runtime.stampPrincipal()
          return { submitted, unnamed }
        }),
      { principal: { id: "server", kind: "operator" }, now: () => 7 }
    )
    const defaulted = await withRuntime((runtime) => runtime.stampPrincipal())
    const submitted = await withRuntime((runtime) =>
      runtime.stampPrincipal({ id: "cli", kind: "human", stampedAt: 99 })
    )

    expect(observed.submitted).toEqual({ id: "remote", kind: "bearer", stampedAt: 7 })
    expect(observed.unnamed).toEqual({ id: "server", kind: "operator", stampedAt: 7 })
    expect(defaulted).toMatchObject({ id: "memory", kind: "test" })
    // With nothing configured, a submitted identity is accepted but restamped.
    expect(submitted).toMatchObject({ id: "cli", kind: "human" })
    expect(submitted.stampedAt).not.toBe(99)
  })
})
