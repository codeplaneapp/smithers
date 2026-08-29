import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import type { StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import { ChatController } from "../state/ChatController"
import type { TuiTransport } from "../state/ChatController"
import { AgentTurnFrameDecoder, applyFrame, TranscriptStore } from "../state/Transcript"
import { App } from "./App"

/*
 * E15.1 / E15.3 — the TUI driven headlessly through its real render tree.
 *
 * `scripts/smoke.ts` folds the same fixture stream but asserts nothing and is
 * bound to `bun run smoke`, not to `test`, so nothing here was ever checked by
 * a run. These tests render the real App through OpenTUI's test renderer, drive
 * it with real terminal key bytes, and assert on the characters the terminal
 * would actually show — so a regression in the store fold, the projection, the
 * composer, or the Escape handler turns them red.
 *
 * Two OpenTUI gotchas the tests depend on:
 *   - `mockInput.pressEscape()` leaves a lone 0x1B pending in the terminal
 *     parser, where it merges with the next byte. Escape must be delivered as
 *     `pressKeys(["ESCAPE"], delay)` so the parser times the sequence out.
 *   - Every input dispatch and `renderer.destroy()` runs inside React's `act`.
 */

/** The fixture NDJSON stream from scripts/smoke.ts, split mid-line to exercise the fold. */
const FIXTURE_CHUNKS: ReadonlyArray<string> = [
  "{\"runId\":\"smoke-1\",\"type\":\"delta\",\"kind\":\"reasoning\",\"text\":\"The user wants a launch ",
  "plan.\"}\n{\"runId\":\"smoke-1\",\"type\":\"delta\",\"kind\":\"text\",\"text\":\"Here is the pla",
  "n.\"}\n{\"runId\":\"smoke-1\",\"type\":\"tool_call\",\"call_id\":\"call-1\",\"name\":\"commands\",\"arguments\":\"{\\\"action\\\":\\\"list\\\"}\"}\n",
  "{\"runId\":\"smoke-1\",\"type\":\"card\",\"card\":{\"id\":\"plan-1\",\"kind\":\"plan\",\"title\":\"TUI launch\",\"status\":\"active\",\"createdAt\":1755000000000,\"ordinal\":1,\"payload\":{\"items\":[{\"id\":\"1\",\"title\":\"scaffold\",\"status\":\"done\"},{\"id\":\"2\",\"title\":\"smoke\",\"status\":\"pending\"}]}}}\n",
  "{\"runId\":\"smoke-1\",\"type\":\"card.update\",\"id\":\"plan-1\",\"patch\":{\"status\":\"acted\"}}\n",
  "{\"runId\":\"smoke-1\",\"type\":\"done\",\"reason\":\"stop\"}\n"
]

/** A transport that records what the controller sent and never answers on its own. */
interface RecordingTransport extends TuiTransport {
  readonly requests: ReadonlyArray<StartAgentTurnRequest>
  readonly cancels: ReadonlyArray<string>
}

const recordingTransport = (): RecordingTransport => {
  const requests: Array<StartAgentTurnRequest> = []
  const cancels: Array<string> = []
  return {
    requests,
    cancels,
    start: (request) => {
      requests.push(request)
      return { status: "started" }
    },
    cancel: (runId) => {
      cancels.push(runId)
    }
  }
}

/** The rendered terminal with runs of spaces collapsed, so column padding never decides a test. */
const frameText = (setup: TestRendererSetup): string =>
  setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .join("\n")

let open: TestRendererSetup | undefined

const render = async (controller: ChatController): Promise<TestRendererSetup> => {
  const setup = await testRender(<App controller={controller} describe="test transport" />, {
    width: 100,
    height: 24
  })
  open = setup
  await setup.flush()
  return setup
}

afterEach(() => {
  const setup = open
  open = undefined
  if (setup !== undefined) act(() => setup.renderer.destroy())
})

describe("TUI headless render", () => {
  test("E15.1 the fixture NDJSON stream folds into the rendered transcript", async () => {
    const store = new TranscriptStore()
    const controller = new ChatController(store, recordingTransport())
    store.appendUserMessage("smoke-1", "plan the tui launch")
    store.setPhase("responding")
    const setup = await render(controller)

    // The fold runs against the live store, so every frame below is proved
    // by what the terminal ends up showing — not by the store's own return.
    const decoder = new AgentTurnFrameDecoder((frame) => applyFrame(store, frame))
    let applied = 0
    await act(async () => {
      for (const chunk of FIXTURE_CHUNKS) applied += decoder.push(chunk)
      applied += decoder.finish()
      store.setPhase("idle")
    })
    await setup.flush()

    expect(applied).toBe(6)
    const frame = frameText(setup)
    expect(frame).toContain("> plan the tui launch")
    expect(frame).toContain("The user wants a launch plan.")
    expect(frame).toContain("Here is the plan.")
    expect(frame).toContain("[tool] commands {\"action\":\"list\"}")
    // The card.update patch must have landed: "active" here means card.update
    // stopped folding, which is exactly the drift that hid in the old suite.
    expect(frame).toContain("[card] plan: TUI launch (acted)")
    expect(frame).not.toContain("[card] plan: TUI launch (active)")
    // The turn settled, so the streaming ellipsis is gone and the composer is ready.
    expect(frame).toContain("message")
    expect(frame).not.toContain("responding… (Esc to cancel)")
    expect(store.phase()).toBe("idle")
  })

  test("E15.1 a composer submit sends the built turn request over the real key path", async () => {
    const store = new TranscriptStore()
    const transport = recordingTransport()
    const controller = new ChatController(store, transport)
    // A settled prior exchange, so the request must carry the visible history.
    store.appendUserMessage("turn-0", "plan the tui launch")
    store.appendDelta("turn-0", "text", "Here is the plan.")
    store.settleAssistant("turn-0", "complete")
    const setup = await render(controller)

    await act(async () => {
      await setup.mockInput.typeText("looks good, ship step 2")
    })
    await setup.flush()
    await act(async () => {
      setup.mockInput.pressEnter()
    })
    await setup.flush()

    expect(transport.requests).toHaveLength(1)
    const request = transport.requests[0]!
    expect(request.runId).toStartWith("tui-")
    expect(request.messages).toEqual([
      { role: "user", content: "plan the tui launch" },
      { role: "assistant", content: "Here is the plan." },
      { role: "user", content: "looks good, ship step 2" }
    ])
    expect(request.instructions.length).toBeGreaterThan(0)
    expect(store.phase()).toBe("responding")

    const frame = frameText(setup)
    expect(frame).toContain("> looks good, ship step 2")
    // The composer cleared and switched to the responding placeholder.
    expect(frame).toContain("responding… (Esc to cancel)")
  })

  test("E15.3 Escape interrupts the live turn through the transport's cancel contract", async () => {
    const store = new TranscriptStore()
    const transport = recordingTransport()
    const controller = new ChatController(store, transport)
    const setup = await render(controller)

    await act(async () => {
      await setup.mockInput.typeText("start something long")
    })
    await setup.flush()
    await act(async () => {
      setup.mockInput.pressEnter()
    })
    await setup.flush()
    const runId = transport.requests[0]?.runId
    expect(runId).toBeString()
    // A delta lands before the interrupt, so the assertion covers a turn that
    // was genuinely mid-stream rather than one that never started.
    await act(async () => {
      controller.publish({ runId: runId!, type: "delta", kind: "text", text: "Working on it" })
    })
    await setup.flush()
    expect(frameText(setup)).toContain("Working on it")

    // A lone 0x1B would merge with the next byte; pressKeys times it out.
    await act(async () => {
      await setup.mockInput.pressKeys(["ESCAPE"], 60)
    })
    await setup.flush()

    expect(transport.cancels).toEqual([runId!])
    expect(store.phase()).toBe("idle")
    const frame = frameText(setup)
    expect(frame).toContain("Stopped the current response.")
    expect(frame).not.toContain("responding… (Esc to cancel)")
    // The partial answer stays on screen: an interrupt is not an erasure.
    expect(frame).toContain("Working on it")
  })

  test("E15.3 a retry after the interrupt starts a fresh turn and keeps the interrupt visible", async () => {
    const store = new TranscriptStore()
    const transport = recordingTransport()
    const controller = new ChatController(store, transport)
    const setup = await render(controller)

    await act(async () => {
      await setup.mockInput.typeText("start something long")
    })
    await setup.flush()
    await act(async () => {
      setup.mockInput.pressEnter()
    })
    await setup.flush()
    await act(async () => {
      await setup.mockInput.pressKeys(["ESCAPE"], 60)
    })
    await setup.flush()

    await act(async () => {
      await setup.mockInput.typeText("try again")
    })
    await setup.flush()
    await act(async () => {
      setup.mockInput.pressEnter()
    })
    await setup.flush()

    expect(transport.requests).toHaveLength(2)
    const [first, second] = transport.requests
    expect(second!.runId).not.toBe(first!.runId)
    expect(store.phase()).toBe("responding")
    // The interrupted turn contributed no assistant speech to the retry's
    // context: a local transport note must never enter the model's prompt.
    expect(second!.messages).toEqual([
      { role: "user", content: "start something long" },
      { role: "user", content: "try again" }
    ])

    const frame = frameText(setup)
    expect(frame).toContain("Stopped the current response.")
    expect(frame).toContain("> try again")
    expect(frame).toContain("responding… (Esc to cancel)")
  })
})
