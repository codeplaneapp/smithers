/**
 * `Cancellation.attribute` against an independent oracle.
 *
 * The fold is the only thing that turns an anonymous `cancel_requested_at_ms`
 * column into "who cancelled this run and why", and it is a graph walk: the
 * example-based tests beside it cover the shapes somebody thought of. This one
 * generates ancestry forests and checks the answer against a second
 * implementation written from the module's stated contract rather than from its
 * code, so a rewrite of the walk that changes an edge case is caught.
 *
 * `fast-check` is not a dependency of this repository, so the generator is a
 * seeded mulberry32: the same 300 cases run on every machine and a red run is
 * reproducible from the printed case.
 */
import { describe, expect, it } from "vitest"
import * as Cancellation from "../src/Cancellation.ts"
import type { Cancellation as CancellationSummary, Principal } from "../src/ControlSchema.ts"

/** Deterministic PRNG. A fixed seed keeps a failure reproducible. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * The contract, restated: a run's own attributed request wins; otherwise the
 * nearest cancelled ancestor makes it a cascade, carrying the principal and
 * reason of the nearest cancelled ancestor that carries a request at all;
 * otherwise the engine cancelled it on its own account.
 *
 * Written as "collect the chain, then classify" so it is not a transcription of
 * the production walk.
 */
const oracle = (input: Cancellation.Input): Map<string, CancellationSummary> => {
  const byId = new Map(input.runs.map((run) => [run.runId, run]))
  const isCancelled = (evidence: Cancellation.Evidence): boolean =>
    evidence.cancelRequestedAt !== undefined || evidence.cancelledAt !== undefined ||
    input.requests.has(evidence.runId)

  /** The ancestor ids above a run, nearest first, stopping at a repeat or a gap. */
  const chain = (run: Cancellation.Evidence): Array<string> => {
    const ids: Array<string> = []
    const seen = new Set<string>([run.runId])
    let current = run.parentRunId
    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      const ancestor = byId.get(current)
      if (ancestor === undefined) break
      ids.push(current)
      current = ancestor.parentRunId
    }
    return ids
  }

  const answers = new Map<string, CancellationSummary>()
  for (const run of input.runs) {
    if (!isCancelled(run)) continue
    const own = input.requests.get(run.runId)
    const requestedAt = own?.requestedAt ?? run.cancelRequestedAt ?? run.cancelledAt ?? 0
    if (own !== undefined) {
      answers.set(run.runId, {
        requestedAt,
        source: "control",
        ...(own.principal === undefined ? {} : { principal: own.principal }),
        ...(own.reason === undefined ? {} : { reason: own.reason })
      })
      continue
    }
    const cancelledAncestors = chain(run).filter((id) => isCancelled(byId.get(id)!))
    const nearest = cancelledAncestors[0]
    if (nearest === undefined) {
      answers.set(run.runId, { requestedAt, source: "engine" })
      continue
    }
    const origin = cancelledAncestors.map((id) => input.requests.get(id)).find((request) => request !== undefined)
    answers.set(run.runId, {
      requestedAt,
      source: "cascade",
      ...(origin?.principal === undefined ? {} : { principal: origin.principal }),
      ...(origin?.reason === undefined ? {} : { reason: origin.reason }),
      cascadedFrom: nearest
    })
  }
  return answers
}

const principal = (index: number): Principal => ({ id: `operator-${index}`, kind: "user" })

/** A forest of at most `size` runs, each with at most one parent already generated. */
const generate = (random: () => number): Cancellation.Input => {
  const size = 1 + Math.floor(random() * 12)
  const runs: Array<Cancellation.Evidence> = []
  const requests = new Map<string, Cancellation.Request>()
  for (let index = 0; index < size; index++) {
    const runId = `run-${index}`
    // A parent is any earlier run, so the ancestry is a forest of depth <= size.
    const parentRoll = random()
    const parentRunId = index > 0 && parentRoll < 0.75
      ? `run-${Math.floor(random() * index)}`
      : undefined
    const evidence: Cancellation.Evidence = {
      runId,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      ...(random() < 0.3 ? { cancelRequestedAt: 1_000 + index } : {}),
      ...(random() < 0.3 ? { cancelledAt: 2_000 + index } : {})
    }
    runs.push(evidence)
    if (random() < 0.3) {
      requests.set(runId, {
        requestedAt: 3_000 + index,
        ...(random() < 0.7 ? { principal: principal(index) } : {}),
        ...(random() < 0.7 ? { reason: `reason-${index}` } : {})
      })
    }
  }
  return { runs, requests }
}

describe("Cancellation.attribute matches an independent oracle", () => {
  it("agrees on 300 generated ancestry forests", () => {
    const random = mulberry32(0x5eed_1234)
    for (let round = 0; round < 300; round++) {
      const input = generate(random)
      const actual = Cancellation.attribute(input)
      const expected = oracle(input)
      const rendered = () =>
        JSON.stringify({ runs: input.runs, requests: [...input.requests] }, undefined, 1)
      // Compare as sorted entries so a failure prints the case, not a Map.
      const normalize = (value: ReadonlyMap<string, CancellationSummary>) =>
        [...value.entries()].sort(([left], [right]) => left.localeCompare(right))
      if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
        throw new Error(
          `round ${round} disagreed\ncase: ${rendered()}\nactual: ${JSON.stringify(normalize(actual))}\n` +
            `oracle: ${JSON.stringify(normalize(expected))}`
        )
      }
    }
  })

  it("survives a cyclic parent chain without hanging", () => {
    const answers = Cancellation.attribute({
      runs: [
        { runId: "a", parentRunId: "b", cancelRequestedAt: 1 },
        { runId: "b", parentRunId: "a" }
      ],
      requests: new Map()
    })
    expect(answers.get("a")).toEqual({ requestedAt: 1, source: "engine" })
    expect(answers.has("b")).toBe(false)
  })

  it("stops the ancestor walk at a parent the evidence does not contain", () => {
    // A listing scoped to one run reads only that run's chain, and retention
    // can delete a row mid-chain. A missing ancestor ends the walk; it must not
    // be read as a cancelled one.
    const answers = Cancellation.attribute({
      runs: [{ runId: "child", parentRunId: "gone", cancelledAt: 5 }],
      requests: new Map()
    })
    expect(answers.get("child")).toEqual({ requestedAt: 5, source: "engine" })
  })

  it("attributes a grandchild to the operator who cancelled the grandparent", () => {
    const answers = Cancellation.attribute({
      runs: [
        { runId: "root", cancelRequestedAt: 10 },
        { runId: "child", parentRunId: "root", cancelRequestedAt: 11 },
        { runId: "grandchild", parentRunId: "child", cancelledAt: 12 }
      ],
      requests: new Map([[
        "root",
        { requestedAt: 9, principal: principal(1), reason: "budget" }
      ]])
    })
    expect(answers.get("grandchild")).toEqual({
      requestedAt: 12,
      source: "cascade",
      principal: principal(1),
      reason: "budget",
      cascadedFrom: "child"
    })
  })
})
