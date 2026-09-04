/**
 * A pane crosses two boundaries: the author declares typed props, and the
 * agent sends whatever it likes over the wire. `renderUnknown` is where those
 * meet, so it is what these tests exercise. The card schemas are the
 * transcript's wire format, so a widened or narrowed field is a protocol
 * change and is asserted here rather than discovered in a browser.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { AppCard, definePane, type PaneContext, TurnFrame } from "../src/ui.ts"

const Props = Schema.Struct({ address: Schema.String, wei: Schema.String })

const context: PaneContext = { fullscreen: false, maximize: () => {}, restore: () => {} }

describe("definePane", () => {
  it("defaults to no title and no fullscreen presentation", () => {
    const pane = definePane({ props: Props, render: () => "body" })
    expect(pane._tag).toBe("PaneDefinition")
    expect(pane.fullscreen).toBe(false)
    expect("title" in pane).toBe(false)
  })

  it("keeps a declared title and fullscreen", () => {
    const pane = definePane({ props: Props, title: "Balance", fullscreen: true, render: () => "body" })
    expect(pane.title).toBe("Balance")
    expect(pane.fullscreen).toBe(true)
  })

  it("renders decoded props and hands the pane its presentation context", () => {
    const seen: Array<{ readonly address: string; readonly fullscreen: boolean }> = []
    const pane = definePane({
      props: Props,
      render: (props, paneContext) => {
        seen.push({ address: props.address, fullscreen: paneContext.fullscreen })
        return `${props.address}: ${props.wei}`
      }
    })
    expect(pane.render({ address: "0xabc", wei: "1" }, context)).toBe("0xabc: 1")
    expect(pane.renderUnknown({ address: "0xdef", wei: "2" }, { ...context, fullscreen: true })).toBe("0xdef: 2")
    expect(seen).toEqual([
      { address: "0xabc", fullscreen: false },
      { address: "0xdef", fullscreen: true }
    ])
  })

  it("throws on props the schema rejects instead of rendering them", () => {
    const pane = definePane({ props: Props, render: ({ address }) => address })
    expect(() => pane.renderUnknown({ address: 1 }, context)).toThrow()
  })
})

describe("cards", () => {
  it("decodes a pane card", () => {
    const card = Schema.decodeUnknownSync(AppCard)({
      kind: "pane",
      id: "c1",
      name: "chain-balance",
      props: { address: "0xabc" },
      fullscreen: true
    })
    expect(card.kind).toBe("pane")
  })

  it("decodes an html card, a flow-run card, and a flow-saved card", () => {
    const kinds = [
      { kind: "html", id: "c2", html: "<p>hi</p>" },
      {
        kind: "flow-run",
        id: "c3",
        flowId: "build",
        executionId: "e1",
        phase: "running",
        steps: [{ name: "plan", status: "done" }]
      },
      { kind: "flow-saved", id: "c4", flowId: "build", description: "d", files: ["flows/build/flow.ts"] }
    ]
    expect(kinds.map((card) => Schema.decodeUnknownSync(AppCard)(card).kind)).toEqual([
      "html",
      "flow-run",
      "flow-saved"
    ])
  })

  it("refuses an unknown card kind", () => {
    expect(() => Schema.decodeUnknownSync(AppCard)({ kind: "iframe", id: "c5" })).toThrow()
  })

  it("refuses a flow-run phase that is not one of the five", () => {
    expect(() =>
      Schema.decodeUnknownSync(AppCard)({
        kind: "flow-run",
        id: "c6",
        flowId: "build",
        executionId: "e1",
        phase: "paused",
        steps: []
      })
    ).toThrow()
  })
})

describe("TurnFrame", () => {
  it("decodes every frame the turn stream emits", () => {
    const frames = [
      { type: "delta", text: "hi" },
      { type: "cell", source: "return 1", ordinal: 0 },
      { type: "call", flow: "tevm/balance", input: {}, outcome: "success" },
      { type: "card", card: { kind: "html", id: "c1", html: "<p>hi</p>" } },
      { type: "card.update", card: { kind: "html", id: "c1", html: "<p>ho</p>" } },
      { type: "park", reason: "approval", message: "approve the deploy" },
      { type: "done", output: { answer: "42" } },
      { type: "error", message: "rate limited" }
    ]
    expect(frames.map((frame) => Schema.decodeUnknownSync(TurnFrame)(frame).type)).toEqual([
      "delta",
      "cell",
      "call",
      "card",
      "card.update",
      "park",
      "done",
      "error"
    ])
  })

  it("refuses a call outcome that is neither success nor failure", () => {
    expect(() => Schema.decodeUnknownSync(TurnFrame)({ type: "call", flow: "f", input: {}, outcome: "partial" }))
      .toThrow()
  })
})
