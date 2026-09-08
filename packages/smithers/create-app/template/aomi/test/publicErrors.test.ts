import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as TevmSdk from "tevm"
import { describe, expect, test, vi } from "vitest"
import { promote } from "../tools/promote.ts"
import { layerTevm, Tevm, TevmError, tevmSource } from "../tools/tevm.ts"
import * as Ui from "../tools/ui.ts"

const invoke = async (source: FlowBinding.Source, name: string, input: Schema.Json) => {
  const bindings = await Effect.runPromise(source.bindings())
  const binding = bindings.find((entry) => entry.descriptor.name === name)!
  return Effect.runPromise(binding.run(
    new Cell.Call({
      flowName: name,
      input,
      capabilities: [],
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
      placement: Option.none(),
      identity: new Cell.CallIdentity({
        session: "test",
        frame: 0,
        cell: "cell",
        ordinal: 0,
        declaration: "test",
        layers: []
      })
    })
  ))
}

describe("template public UI refusals", () => {
  test("an unknown pane names the available pane and correction", async () => {
    const source = Ui.uiSource(
      Context.make(Ui.CardSink, Ui.makeCollecting([])).pipe(
        Context.add(Ui.PaneNames, Ui.makePanes([{ name: "balance", fullscreen: false }]))
      )
    )
    const result = await invoke(source, "ui/pane", { name: "missing", props: {} })
    expect(result.code).toBe("flow_failed")
    expect(result.message).toContain("Registered panes: balance")
    expect(result.message).toContain("Reissue ui/pane")
  })
})

test("an unroutable promoted flow id explains how to correct it", async () => {
  const result = await invoke(promote, "flows/write-flow", {
    id: "Wrong_ID",
    description: "test",
    flowSource: "",
    testSource: "",
    fixtureJson: "{}"
  })
  expect(result.message).toContain("Use lowercase letters, digits, and hyphens")
  expect(result.message).toContain("reissue flows/write-flow")
})

const refuse = () =>
  Effect.fail(
    new TevmError({
      message: "Call tevm/fork before reading chain state.",
      cause: { headers: { Authorization: "SYNTHETIC_HOST_SECRET" } }
    })
  )
const chain = tevmSource(Context.make(Tevm, {
  fork: refuse,
  getBalance: refuse,
  readContract: refuse,
  call: refuse,
  setAccount: refuse,
  mine: refuse,
  simulate: refuse,
  getBlock: refuse
}))

test.each(
  [
    ["tevm/fork", { rpcUrl: "https://example.invalid" }],
    ["tevm/getBalance", { address: "0x1" }],
    ["tevm/readContract", { address: "0x1", abi: [], functionName: "balanceOf" }],
    ["tevm/call", { to: "0x1", data: "0x" }],
    ["tevm/setAccount", { address: "0x1" }],
    ["tevm/mine", {}],
    ["tevm/simulate", { calls: [] }],
    ["tevm/getBlock", {}]
  ] as const
)("%s publishes corrective text without diagnostic causes", async (name, input) => {
  const result = await invoke(chain, name, input)
  expect(result.code).toBe("flow_failed")
  expect(result.message).toBe(`Flow ${name} failed: Call tevm/fork before reading chain state.`)
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_HOST_SECRET")
})

test("real TEVM handler withholds SDK diagnostics while retaining the host cause", async () => {
  const cause = new Error("https://example.invalid/?api_key=SYNTHETIC_HOST_SECRET")
  const transport = vi.spyOn(TevmSdk, "http").mockImplementation(() => {
    throw cause
  })
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const services = yield* Layer.build(layerTevm({ rpcUrl: "https://example.invalid" }))
      const service = Context.get(services, Tevm)
      const failure = yield* Effect.flip(service.getBlock({}))
      expect(failure.cause).toBe(cause)
      const result = yield* Effect.promise(() => invoke(tevmSource(services), "tevm/getBlock", {}))
      expect(result.message).toBe("Flow tevm/getBlock failed: getBlock failed.")
      expect(JSON.stringify(result)).not.toContain("SYNTHETIC_HOST_SECRET")
    })))
  } finally {
    transport.mockRestore()
  }
})

test("real TEVM handler preserves host-authored fork and block-tag corrections", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const services = yield* Layer.build(layerTevm({}))
    const source = tevmSource(services)
    const unopened = yield* Effect.promise(() => invoke(source, "tevm/getBalance", { address: "0x1" }))
    expect(unopened.message).toContain("call tevm/fork")
    const invalid = yield* Effect.promise(() =>
      invoke(source, "tevm/getBalance", {
        address: "0x1",
        blockTag: "yesterday"
      })
    )
    expect(invalid.message).toContain("yesterday")
    expect(invalid.message).toContain("finalized")
  })))
})
