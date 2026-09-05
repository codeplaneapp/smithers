import { describe, expect, it } from "vitest"
import * as Scheduling from "../src/Scheduling.ts"

const candidate = (id: string, order: number, priority = 0, waited = 0, kind: "step" | "agent" | "merge" = "step") => ({
  node: { id, priority, kind },
  order,
  waited
})
const idle = { steps: 0, agents: 0 }
const ids = (candidates: ReadonlyArray<Scheduling.Candidate<ReturnType<typeof candidate>["node"]>>) =>
  candidates.map(({ node }) => node.id)

describe("shared scheduling policy", () => {
  it("orders equal effective priorities by plan position, independent of arrival", () => {
    const ready = [candidate("later", 2, 1), candidate("aged", 1, -1, 2), candidate("first", 0, 1)]
    expect(ids(Scheduling.make().admit(ready, idle).admitted)).toEqual(["first", "aged", "later"])
    expect(ready.map(({ node }) => node.id)).toEqual(["later", "aged", "first"])
  })

  it("compares the exact sum when priority plus age is outside the safe-number range", () => {
    const ready = [
      candidate("lower", 0, Number.MAX_SAFE_INTEGER - 1, 2),
      candidate("higher", 1, Number.MAX_SAFE_INTEGER, 2)
    ]
    const result = Scheduling.make({ steps: 1 }).admit(ready, idle)
    expect(ids(result.admitted)).toEqual(["higher"])
    expect(result.deferred[0]!.waited).toBe(3)
  })

  it("admits ordinary work around a blocked agent without exceeding either cap", () => {
    const result = Scheduling.make({ steps: 3, agents: 1 }).admit([
      candidate("agent", 0, 10, 0, "agent"),
      candidate("step", 1),
      candidate("merge", 2, 0, 0, "merge")
    ], { steps: 1, agents: 1 })
    expect(ids(result.admitted)).toEqual(["step", "merge"])
    expect(ids(result.deferred)).toEqual(["agent"])
    expect(result.agents).toBe(0)
  })

  it("an agent consumes both a step permit and an agent permit", () => {
    const ready = [candidate("a", 0, 0, 0, "agent"), candidate("b", 1, 0, 0, "agent"), candidate("c", 2)]
    const result = Scheduling.make({ steps: 2, agents: 1 }).admit(ready, idle)
    expect(ids(result.admitted)).toEqual(["a", "c"])
    expect(result.agents).toBe(1)
    expect(ids(result.deferred)).toEqual(["b"])
  })

  it("ages only deferred work, snapshots limits, and never mutates caller state", () => {
    const limits = { steps: 1, agents: 1 }
    const policy = Scheduling.make(limits)
    limits.steps = 100
    const ready = Object.freeze([Object.freeze(candidate("a", 0, 0, 4)), Object.freeze(candidate("b", 1, 0, 4))])
    const result = policy.admit(ready, Object.freeze(idle))
    expect(result.admitted[0]!.waited).toBe(4)
    expect(result.deferred[0]!.waited).toBe(5)
    expect(ready[1]!.waited).toBe(4)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.limits)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.admitted)).toBe(true)
    expect(Object.isFrozen(result.deferred)).toBe(true)
    expect(Object.isFrozen(result.deferred[0])).toBe(true)
    expect(Object.isFrozen(ready[0]!.node)).toBe(false)
  })

  it("saturates age rather than producing invalid subsequent scheduling state", () => {
    const policy = Scheduling.make({ steps: 1 })
    const ready = [candidate("a", 0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)]
    const result = policy.admit(ready, { steps: 1, agents: 0 })
    expect(result.admitted).toEqual([])
    expect(result.deferred[0]!.waited).toBe(Number.MAX_SAFE_INTEGER)
    expect(ids(policy.admit(result.deferred, idle).admitted)).toEqual(["a"])
  })

  it("handles empty readiness and already-held capacity", () => {
    expect(Scheduling.make().admit([], idle)).toEqual({ admitted: [], deferred: [], agents: 0 })
    const result = Scheduling.make({ steps: 1 }).admit([candidate("a", 0)], { steps: 2, agents: 0 })
    expect(result.admitted).toEqual([])
    expect(result.deferred[0]!.waited).toBe(1)
  })

  it("refuses invalid limits, permit counts, and candidates before a decision", () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => Scheduling.make({ steps: value })).toThrow(/concurrency.steps/)
      expect(() => Scheduling.make({ agents: value })).toThrow(/concurrency.agents/)
    }
    const policy = Scheduling.make()
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => policy.admit([], { steps: value, agents: 0 })).toThrow(/active.steps/)
      expect(() => policy.admit([], { steps: 0, agents: value })).toThrow(/active.agents/)
      expect(() => policy.admit([candidate("a", value)], idle)).toThrow(/candidate.order/)
      expect(() => policy.admit([candidate("a", 0, 0, value)], idle)).toThrow(/candidate.waited/)
    }
    for (const value of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => policy.admit([candidate("a", 0, value)], idle)).toThrow(/candidate.priority/)
    }
    expect(() => policy.admit([], { steps: 1, agents: 2 })).toThrow(/cannot exceed/)
    expect(() => policy.admit([candidate("a", 0, 0, 0, "other" as never)], idle)).toThrow(/invalid candidate kind/)
    expect(() => policy.admit([candidate("", 0)], idle)).toThrow(/non-empty/)
    expect(() => policy.admit([candidate(undefined as never, 0)], idle)).toThrow(/non-empty/)
    expect(() => policy.admit([candidate("a", 0), candidate("a", 1)], idle)).toThrow(/unique/)
    expect(() => policy.admit([candidate("a", 0), candidate("b", 0)], idle)).toThrow(/positions must be unique/)
  })

  it("matches an independent exhaustive admission oracle across priorities, caps, and active permits", () => {
    for (let steps = 1; steps <= 3; steps++) {
      for (let agents = 1; agents <= 3; agents++) {
        for (let activeSteps = 0; activeSteps <= steps; activeSteps++) {
          for (let activeAgents = 0; activeAgents <= Math.min(activeSteps, agents); activeAgents++) {
            for (const priority of [Number.MIN_SAFE_INTEGER, -1, 0, Number.MAX_SAFE_INTEGER]) {
              const ready = [
                candidate("a", 0, priority, 2, "agent"),
                candidate("b", 1, 0, 1),
                candidate("c", 2, 1, 0, "agent")
              ]
              const expected: Array<string> = []
              let availableSteps = steps - activeSteps
              let availableAgents = agents - activeAgents
              // Select the best remaining eligible candidate one at a time;
              // independent of the production sorted-scan implementation.
              const remaining = [...ready].reverse()
              while (availableSteps > 0) {
                let best: typeof ready[number] | undefined
                for (const next of remaining) {
                  if (next.node.kind === "agent" && availableAgents === 0) continue
                  const score = BigInt(next.node.priority) + BigInt(next.waited)
                  const previous = best === undefined ? undefined : BigInt(best.node.priority) + BigInt(best.waited)
                  if (best === undefined || score > previous! || (score === previous && next.order < best.order)) {
                    best = next
                  }
                }
                if (best === undefined) break
                expected.push(best.node.id)
                remaining.splice(remaining.indexOf(best), 1)
                availableSteps--
                if (best.node.kind === "agent") availableAgents--
              }
              const actual = Scheduling.make({ steps, agents }).admit(ready, {
                steps: activeSteps,
                agents: activeAgents
              })
              expect(ids(actual.admitted)).toEqual(expected)
              expect(new Set([...ids(actual.admitted), ...ids(actual.deferred)]).size).toBe(ready.length)
            }
          }
        }
      }
    }
  })
})
