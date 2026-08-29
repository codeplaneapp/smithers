/**
 * Turning the script the model just ran into a saved flow.
 *
 * The two bindings are one move split in half: `flows/show-script` hands the
 * model its own turn back together with the rules a saved flow has to follow,
 * and `flows/write-flow` writes the files that come back. These cases fix what
 * each half promises — the script is the turn's, the rules are the host's, an
 * unroutable id is refused before anything is written, and a registry that is
 * in context rescans so the new flow is callable on the next frame.
 */
import * as Cell from "@smthrs/harness/Cell"
import * as CellHistory from "@smthrs/harness/CellHistory"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import type { HarnessError } from "@smthrs/harness/HarnessError"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as FlowStore from "../src/FlowStore.ts"
import * as PromoteFlows from "../src/PromoteFlows.ts"

const call = (flowName: string, input: unknown): Cell.Call =>
  new Cell.Call({
    flowName,
    input: input as typeof Schema.Json.Type,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({
      session: "session-1",
      frame: 2,
      cell: "cell-digest",
      ordinal: 0,
      declaration: "declaration-digest",
      layers: []
    })
  })

const services = (
  history: CellHistory.Service,
  store: FlowStore.Service
): Context.Context<CellHistory.CellHistory | FlowStore.FlowStore> =>
  Context.add(Context.make(CellHistory.CellHistory, history), FlowStore.FlowStore, store)

/** Invokes one binding of a source the way the controller would. */
const invoke = (
  source: FlowBinding.Source,
  flowName: string,
  input: unknown
): Effect.Effect<Cell.CallResult, HarnessError> =>
  Effect.flatMap(source.bindings(), (bindings) => {
    const binding = bindings.find((candidate) => candidate.descriptor.name === flowName)
    return binding === undefined
      ? Effect.die(`no binding named ${flowName}`)
      : binding.run(call(flowName, input))
  })

const saved = (id: string) => ({
  id,
  description: `Digest the week's ${id}.`,
  flowSource: `export default Flow.make({ name: "${id}" })`,
  testSource: `it("runs ${id}", () => {})`,
  fixtureJson: `{ "calls": [] }`
})

const ran = (...sources: ReadonlyArray<string>): CellHistory.Service =>
  CellHistory.makeCells(sources.map((source, ordinal) => ({ ordinal, source })))

describe("PromoteFlows.source", () => {
  it("binds both halves of the move under one source name", async () => {
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory()))

    const bindings = await Effect.runPromise(source.bindings())

    expect(source.name).toBe("flows")
    expect(bindings.map((binding) => binding.descriptor.name)).toEqual(["flows/show-script", "flows/write-flow"])
  })
})

describe("flows/show-script", () => {
  it("hands back the source of every cell this turn ran, in order", async () => {
    const source = PromoteFlows.source(services(ran("ctx.done(1)", "ctx.done(2)"), FlowStore.makeMemory()))

    const result = await Effect.runPromise(invoke(source, "flows/show-script", {}))

    expect(result.outcome).toBe("success")
    expect(result.value).toMatchObject({
      cells: [{ ordinal: 0, source: "ctx.done(1)" }, { ordinal: 1, source: "ctx.done(2)" }],
      bestPractices: PromoteFlows.bestPractices,
      template: PromoteFlows.flowTemplate
    })
  })

  it("reports an empty script for a host that records nothing", async () => {
    const source = PromoteFlows.source(services(CellHistory.makeNoop(), FlowStore.makeMemory()))

    const result = await Effect.runPromise(invoke(source, "flows/show-script", {}))

    expect(result.value).toMatchObject({ cells: [] })
  })

  it("appends the caller's extra guidance after the house rules", async () => {
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory()))

    const result = await Effect.runPromise(
      invoke(source, "flows/show-script", { bestPractices: "Name the flow after the outcome." })
    )

    expect((result.value as { bestPractices: string }).bestPractices).toBe(
      `${PromoteFlows.bestPractices}\nName the flow after the outcome.`
    )
  })

  it("teaches the host's own rules and template when it has them", async () => {
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory()), {
      bestPractices: "One rule: the payload carries everything.",
      template: "export const Flow = defineFlow({})\n"
    })

    const result = await Effect.runPromise(invoke(source, "flows/show-script", {}))

    expect(result.value).toMatchObject({
      bestPractices: "One rule: the payload carries everything.",
      template: "export const Flow = defineFlow({})\n"
    })
  })
})

describe("flows/write-flow", () => {
  it("writes the flow, its test, and its fixture under the flow's id", async () => {
    const written = new Map<string, string>()
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory(written)))

    const result = await Effect.runPromise(invoke(source, "flows/write-flow", saved("weekly-digest")))

    expect(result.outcome).toBe("success")
    expect(result.value).toEqual({
      files: [
        "flows/weekly-digest/flow.ts",
        "flows/weekly-digest/flow.e2e.ts",
        "flows/weekly-digest/fixtures/weekly-digest.json"
      ]
    })
    expect(written.get("flows/weekly-digest/flow.e2e.ts")).toBe(`it("runs weekly-digest", () => {})`)
  })

  it("refuses an unroutable id as a correctable failure and writes nothing", async () => {
    const written = new Map<string, string>()
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory(written)))

    const result = await Effect.runPromise(
      invoke(source, "flows/write-flow", { ...saved("weekly-digest"), id: "Weekly Digest" })
    )

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("lowercase letters")
    expect(written.size).toBe(0)
  })

  it("reports a store that refuses the write rather than claiming a save", async () => {
    const source = PromoteFlows.source(services(ran(), FlowStore.makeNoop()))

    const result = await Effect.runPromise(invoke(source, "flows/write-flow", saved("weekly-digest")))

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("no flow was saved")
  })

  it("refreshes a registry that is in context so the flow is callable next frame", async () => {
    let refreshes = 0
    const registry = Registry.makeNoop({
      refresh: () =>
        Effect.sync(() => {
          refreshes += 1
        })
    })
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory()))

    const result = await Effect.runPromise(
      invoke(source, "flows/write-flow", saved("weekly-digest")).pipe(
        Effect.provideService(Registry.Registry, registry)
      )
    )

    expect(result.outcome).toBe("success")
    expect(refreshes).toBe(1)
  })

  it("does not refresh a registry when the write was refused", async () => {
    let refreshes = 0
    const registry = Registry.makeNoop({
      refresh: () =>
        Effect.sync(() => {
          refreshes += 1
        })
    })
    const source = PromoteFlows.source(services(ran(), FlowStore.makeNoop()))

    await Effect.runPromise(
      invoke(source, "flows/write-flow", saved("weekly-digest")).pipe(
        Effect.provideService(Registry.Registry, registry)
      )
    )

    expect(refreshes).toBe(0)
  })

  it("saves without a registry in context", async () => {
    const written = new Map<string, string>()
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory(written)))

    const result = await Effect.runPromise(invoke(source, "flows/write-flow", saved("weekly-digest")))

    expect(result.outcome).toBe("success")
    expect(written.size).toBe(3)
  })
})
