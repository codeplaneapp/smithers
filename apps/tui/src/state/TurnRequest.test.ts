import { describe, expect, test } from "bun:test"
import { SMITHERS_TUI_INSTRUCTIONS } from "./Instructions"
import { TranscriptStore } from "./Transcript"
import { applyFrame } from "./Transcript"
import { buildTurnRequest, MAX_TURN_REQUEST_BYTES, turnRequestBytes } from "./TurnRequest"

describe("buildTurnRequest — composer submit produces a correct StartAgentTurnRequest", () => {
  test("a draft over history becomes runId + role/content messages + instructions", () => {
    const store = new TranscriptStore()
    store.appendUserMessage("t1", "first question")
    applyFrame(store, { runId: "t1", type: "delta", kind: "text", text: "first answer" })
    applyFrame(store, { runId: "t1", type: "done", reason: "stop" })

    const built = buildTurnRequest("t2", store.entries(), "  second question  ")
    expect(built.status).toBe("ok")
    if (built.status !== "ok") return
    expect(built.request.runId).toBe("t2")
    expect(built.request.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" }
    ])
    expect(built.request.instructions).toBe(SMITHERS_TUI_INSTRUCTIONS)
    expect(turnRequestBytes(built.request)).toBeLessThanOrEqual(MAX_TURN_REQUEST_BYTES)
  })

  test("an empty draft submits nothing", () => {
    const store = new TranscriptStore()
    expect(buildTurnRequest("t2", store.entries(), "   ").status).toBe("empty")
  })

  test("a draft that would exceed the boundary limit is refused before send", () => {
    const store = new TranscriptStore()
    const built = buildTurnRequest("t2", store.entries(), "x".repeat(MAX_TURN_REQUEST_BYTES))
    expect(built.status).toBe("oversized")
  })

  test("an in-flight assistant message is excluded from the request", () => {
    const store = new TranscriptStore()
    store.appendUserMessage("t1", "question")
    store.appendDelta("t1", "text", "still streaming")
    const built = buildTurnRequest("t2", store.entries(), "next")
    expect(built.status).toBe("ok")
    if (built.status !== "ok") return
    expect(built.request.messages).toEqual([
      { role: "user", content: "question" },
      { role: "user", content: "next" }
    ])
  })
})
