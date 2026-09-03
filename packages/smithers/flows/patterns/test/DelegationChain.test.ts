import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as DelegationChain from "../src/DelegationChain.ts"
import { PatternError } from "../src/PatternError.ts"
import type * as Trellis from "../src/Trellis.ts"

const stub = (name: string): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, never> =>
  Flow.make({
    name,
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: (input) => Node.succeed(input)
  })

const makeOptions: DelegationChain.MakeOptions = {
  refine: stub("refine"),
  plan: stub("plan"),
  derisk: stub("derisk"),
  execute: { weak: stub("weak"), strong: stub("strong") },
  review: stub("review"),
  settle: stub("settle"),
  tierOrder: ["weak", "strong"],
  maxDepth: 2,
  maxDeriskRounds: 2,
  maxAttempts: 3
}

const plan: Trellis.Plan = {
  sequence: [
    { agent: { goal: "a" } },
    { parallel: [{ agent: { goal: "b" } }, { agent: { goal: "c" } }] }
  ]
}

const bounds = { tierOrder: ["weak", "strong"], maxDepth: 3, maxDeriskRounds: 2, maxAttempts: 2 } as const

const budget: DelegationChain.Budget = { maxUsd: 5 }

const tagged = (name: string, capability: string): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, never> =>
  Flow.make({
    name,
    capabilities: [capability],
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: (input) => Node.succeed(input)
  })

const payload = (node: Graph.GraphNode): Record<string, unknown> =>
  (node.keyMaterial.inputs as ReadonlyArray<{ readonly _tag: string; readonly value?: unknown }>)
    .find((input) => input._tag === "Literal")?.value as Record<string, unknown>

const callsTagged = (graph: Graph.Graph, capability: string): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) =>
    node.kind === "FlowCall" &&
    ((node.keyMaterial.body as { readonly capabilities?: ReadonlyArray<string> }).capabilities ?? []).includes(
      capability
    )
  )

const keys = (value: Record<string, unknown>): ReadonlyArray<string> => Object.keys(value).sort()

describe("DelegationChain", () => {
  it.effect("stops the derisk loop at the first approved round", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.sync(() => (calls.push("refine"), "goal")),
        plan: () => Effect.sync(() => (calls.push("plan"), plan)),
        derisk: () => Effect.sync(() => (calls.push("derisk"), { approved: true })),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      })

      expect(calls).toEqual(["refine", "plan", "derisk"])
    }))

  it.effect("revises the plan while derisk withholds approval", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: ({ round }) => Effect.sync(() => (calls.push(`plan-${round}`), { agent: { goal: "a" } })),
        derisk: ({ round }) => Effect.sync(() => (calls.push(`derisk-${round}`), { approved: round === 2 })),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ deriskExhausted, leaves }) => Effect.succeed({ deriskExhausted, leaves })
      })

      expect(calls).toEqual(["plan-1", "derisk-1", "plan-2", "derisk-2"])
      expect(settled).toEqual({ deriskExhausted: false, leaves: ["ok"] })
    }))

  it.effect("escalates a leaf that fails on the weakest tier and succeeds on the next", () =>
    Effect.gen(function*() {
      const attempted: Array<string> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ leaf }) =>
            Effect.suspend(() => {
              attempted.push(`weak:${leaf.path}`)
              return Effect.fail("weak tier gave up")
            }),
          strong: ({ leaf }) =>
            Effect.sync(() => {
              attempted.push(`strong:${leaf.path}`)
              return "strong result"
            })
        },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      })

      expect(attempted).toEqual(["weak:root", "weak:root", "strong:root"])
      expect(settled).toEqual(["strong result"])
    }))

  it.effect("escalates a leaf whose result the review rejects", () =>
    Effect.gen(function*() {
      const reviewed: Array<unknown> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("thin"), strong: () => Effect.succeed("thorough") },
        review: (request) =>
          Effect.sync(() => {
            if (request.stage === "leaf") reviewed.push(request.tier)
            return { approved: request.stage === "chain" || request.output === "thorough" }
          }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      })

      expect(reviewed).toEqual(["weak", "strong"])
      expect(settled).toEqual(["thorough"])
    }))

  it.effect("fails with the leaf path once every tier has spent maxAttempts", () =>
    Effect.gen(function*() {
      let attempts = 0
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: () => Effect.suspend(() => (attempts += 1, Effect.fail("weak failed"))),
          strong: () => Effect.suspend(() => (attempts += 1, Effect.fail("strong failed")))
        },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("leaf_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root.sequence[0]")
      expect((failure as DelegationChain.DelegationError).message).toBe(
        "No tier settled the leaf at root.sequence[0] within 2 attempts each"
      )
      expect((failure as DelegationChain.DelegationError & { readonly cause?: unknown }).cause).toEqual([
        { tier: "weak", error: "weak failed" },
        { tier: "strong", error: "strong failed" }
      ])
      expect(attempts).toBe(bounds.tierOrder.length * bounds.maxAttempts)
    }))

  it.effect("fails an exhausted rejected ladder without settling its leaf", () =>
    Effect.gen(function*() {
      const attempts = new Map<string, number>()
      const reviewed: Array<string> = []
      let settled = false
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ tier }) =>
            Effect.suspend(() => {
              const attempt = (attempts.get(tier) ?? 0) + 1
              attempts.set(tier, attempt)
              return attempt === bounds.maxAttempts ? Effect.succeed(`${tier}-candidate`) : Effect.fail("retry")
            }),
          strong: ({ tier }) =>
            Effect.suspend(() => {
              const attempt = (attempts.get(tier) ?? 0) + 1
              attempts.set(tier, attempt)
              return attempt === bounds.maxAttempts ? Effect.succeed(`${tier}-candidate`) : Effect.fail("retry")
            })
        },
        review: (request) =>
          Effect.sync(() => {
            if (request.stage === "leaf") reviewed.push(request.tier)
            return { approved: request.stage === "chain" }
          }),
        settle: ({ leaves }) => Effect.sync(() => (settled = true, leaves))
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("leaf_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root.sequence[0]")
      expect((failure as DelegationChain.DelegationError).message).toBe(
        "No tier settled the leaf at root.sequence[0] within 2 attempts each"
      )
      expect((failure as DelegationChain.DelegationError & { readonly cause?: unknown }).cause).toEqual([
        { tier: "weak", rejected: true },
        { tier: "strong", rejected: true }
      ])
      expect(attempts).toEqual(new Map([["weak", bounds.maxAttempts], ["strong", bounds.maxAttempts]]))
      expect(reviewed).toEqual(["weak", "strong"])
      expect(settled).toBe(false)
    }))

  it.effect("hands settle every leaf output in plan order", () =>
    Effect.gen(function*() {
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed(plan),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ leaf }) => Effect.succeed(leaf.goal.toUpperCase()),
          strong: () => Effect.succeed("unused")
        },
        review: () => Effect.succeed({ approved: true }),
        settle: (request) => Effect.succeed(request)
      })

      expect(settled).toMatchObject({
        goal: "goal",
        leaves: ["A", ["B", "C"]].flat(),
        deriskExhausted: false
      })
    }))

  it.effect("refuses a derisked plan that leaves the envelope", () =>
    Effect.gen(function*() {
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        maxDepth: 1,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toMatchObject({
        code: "depth_exceeded",
        path: "root.sequence[0]",
        message: "Plan depth 2 exceeds the envelope depth 1"
      })
    }))

  it.effect("refuses invalid concurrency before any callback runs", () =>
    Effect.gen(function*() {
      for (const concurrency of [0, -5, 1.5, Number.NaN]) {
        let callbacks = 0
        const called = <A>(value: A) => Effect.sync(() => (callbacks += 1, value))
        const failure = yield* Effect.flip(
          DelegationChain.run("ship it", {
            ...bounds,
            concurrency,
            refine: () => called("goal"),
            plan: () => called({ agent: { goal: "a" } }),
            derisk: () => called({ approved: true }),
            execute: { weak: () => called("ok"), strong: () => called("ok") },
            review: () => called({ approved: true }),
            settle: ({ leaves }) => called(leaves)
          })
        )

        expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
        expect((failure as DelegationChain.DelegationError).code).toBe("invalid_bounds")
        expect((failure as DelegationChain.DelegationError).path).toBe("root")
        expect((failure as DelegationChain.DelegationError).message).toBe(
          `Delegation concurrency must be a positive safe integer, received ${concurrency}`
        )
        expect(callbacks).toBe(0)
      }
    }))

  it.effect("wraps a derisk PatternError with the exact delegation refusal", () =>
    Effect.gen(function*() {
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.fail(new PatternError({ code: "invalid_decorator", message: "planner refused input" })),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("derisk_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root")
      expect((failure as DelegationChain.DelegationError).message).toBe("planner refused input")
    }))

  it.effect("wraps a leaf-review PatternError with the exact leaf refusal", () =>
    Effect.gen(function*() {
      const reviewFailure = new PatternError({ code: "invalid_decorator", message: "review unavailable" })
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("candidate"), strong: () => Effect.succeed("unused") },
        review: (request) =>
          request.stage === "leaf"
            ? Effect.fail(reviewFailure)
            : Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("leaf_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root")
      expect((failure as DelegationChain.DelegationError).message).toBe(
        "No tier settled the leaf at root within 2 attempts each"
      )
      expect((failure as DelegationChain.DelegationError & { readonly cause?: unknown }).cause).toBe(reviewFailure)
    }))

  it("declares the documented number of flow calls", () => {
    const chain = DelegationChain.make(makeOptions)
    const graph = Graph.build(chain, "ship it")
    const calls = Graph.nodes(graph).filter((node) => node.kind === "FlowCall")

    expect(Flow.isFlow(chain)).toBe(true)
    expect(calls).toHaveLength(DelegationChain.bound(makeOptions))
    // 4 fixed calls + 2 per derisk round + one escalation ladder per depth slot.
    expect(DelegationChain.bound(makeOptions)).toBe(22)
  })

  it.effect("settles with deriskExhausted when derisk never approves", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        maxDeriskRounds: 2,
        refine: () => Effect.succeed("goal"),
        plan: ({ round }) => Effect.sync(() => (calls.push(`plan-${round}`), { agent: { goal: "a" } })),
        derisk: ({ round }) => Effect.sync(() => (calls.push(`derisk-${round}`), { approved: false })),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("unused") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ deriskExhausted, leaves }) => Effect.succeed({ deriskExhausted, leaves })
      })

      expect(calls).toEqual(["plan-1", "derisk-1", "plan-2", "derisk-2"])
      expect(settled).toEqual({ deriskExhausted: true, leaves: ["ok"] })
    }))

  it.effect("declares the payloads it executes", () =>
    Effect.gen(function*() {
      const executed: Array<ReadonlyArray<string>> = []
      const reviewed: Array<ReadonlyArray<string>> = []
      let settlement: ReadonlyArray<string> = []
      yield* DelegationChain.run("ship it", {
        ...bounds,
        maxDepth: 2,
        budget,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: (work) => Effect.sync(() => (executed.push(keys(work as never)), "ok")),
          strong: () => Effect.succeed("unused")
        },
        review: (request) => Effect.sync(() => (reviewed.push(keys(request as never)), { approved: true })),
        settle: (request) => Effect.sync(() => (settlement = keys(request as never), request.leaves))
      })

      const graph = Graph.build(
        DelegationChain.make({
          ...makeOptions,
          budget,
          execute: { weak: tagged("weak", "tier/weak"), strong: tagged("strong", "tier/strong") },
          review: tagged("review", "chain/review"),
          settle: tagged("settle", "chain/settle")
        }),
        "ship it"
      )
      const declaredWork = callsTagged(graph, "tier/weak").map(payload)
      const declaredReviews = callsTagged(graph, "chain/review").map(payload)
      const declaredSettle = payload(callsTagged(graph, "chain/settle")[0] as Graph.GraphNode)

      // One tier call per slot, each carrying the tier it is and the run budget.
      expect(declaredWork).toHaveLength(makeOptions.maxDepth)
      expect(declaredWork.map(keys)).toEqual(declaredWork.map(() => executed[0]))
      expect(declaredWork.map((work) => work.tier)).toEqual(["weak", "weak"])
      expect(declaredWork.map((work) => work.budget)).toEqual([budget, budget])
      expect(declaredWork.map((work) => keys(work.leaf as Record<string, unknown>))).toEqual([
        ["goal", "path"],
        ["goal", "path"]
      ])
      expect(declaredWork.map((work) => (work.leaf as { readonly path: string }).path)).toEqual(["slot-0", "slot-1"])
      // The leaf review names the tier that produced the output, as run does.
      const leafReviews = declaredReviews.filter((request) => request.stage === "leaf")
      expect(leafReviews.map(keys)).toEqual(leafReviews.map(() => reviewed[0]))
      expect(leafReviews.map((request) => request.tier)).toEqual(["weak", "strong", "weak", "strong"])
      // Settle is declared with the keys run settles with.
      expect(keys(declaredSettle)).toEqual(settlement)
    }))

  it("refuses bounds and tiers it cannot honour", () => {
    expect(() => DelegationChain.make({ ...makeOptions, maxDepth: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_bounds",
        path: "root",
        message: "maxDepth, maxDeriskRounds, and maxAttempts must be positive safe integers"
      })
    )
    expect(() => DelegationChain.make({ ...makeOptions, tierOrder: [] })).toThrow(
      expect.objectContaining({
        code: "invalid_bounds",
        path: "root",
        message: "tierOrder must name at least one tier, weakest first"
      })
    )
    expect(() => DelegationChain.make({ ...makeOptions, tierOrder: ["absent"] })).toThrow(
      expect.objectContaining({
        code: "missing_tier",
        path: "root",
        message: "execute has no flow for tier absent"
      })
    )
  })
})
