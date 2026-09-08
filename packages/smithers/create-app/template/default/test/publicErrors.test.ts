import * as Cell from "@smthrs/harness/Cell"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Context, Effect, Option, Schema } from "effect"
import { describe, expect, test } from "vitest"
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
