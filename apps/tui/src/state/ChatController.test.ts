import { describe, expect, test } from "bun:test"
import type { StartAgentTurnRequest, StartAgentTurnResult } from "smithers-shared/NativeAgent"
import { ChatController } from "./ChatController"
import type { TuiTransport } from "./ChatController"
import { TranscriptStore } from "./Transcript"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("ChatController turn lifecycle", () => {
  test("submit owns composer state and starts the exact built request", async () => {
    const requests: Array<StartAgentTurnRequest> = []
    const transport: TuiTransport = {
      start: (request) => {
        requests.push(request)
        return { status: "started" }
      },
      cancel: () => undefined
    }
    const store = new TranscriptStore()
    const controller = new ChatController(store, transport)
    store.setDraft(" hello ")

    await controller.submit(store.draft())

    expect(store.draft()).toBe("")
    expect(store.draftRevision()).toBe(1)
    expect(store.phase()).toBe("responding")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages).toEqual([{ role: "user", content: "hello" }])
  })

  test("an oversized submit leaves the draft available for editing", async () => {
    const store = new TranscriptStore()
    const controller = new ChatController(store, {
      start: () => ({ status: "started" }),
      cancel: () => undefined
    })
    const draft = "x".repeat(64 * 1024)
    store.setDraft(draft)

    await controller.submit(store.draft())

    expect(store.draft()).toBe(draft)
    expect(store.draftRevision()).toBe(0)
    expect(store.phase()).toBe("idle")
    expect(store.entries().at(-1)).toMatchObject({ kind: "event", text: expect.stringContaining("too large") })
  })

  test("a late start error cannot overwrite a turn cancelled while connecting", async () => {
    const started = deferred<StartAgentTurnResult>()
    const cancelled: Array<string> = []
    const transport: TuiTransport = {
      start: () => started.promise,
      cancel: (runId) => cancelled.push(runId)
    }
    const store = new TranscriptStore()
    const controller = new ChatController(store, transport)

    const submitting = controller.submit("wait for it")
    controller.cancelActive()
    started.resolve({ status: "error", message: "late network error" })
    await submitting

    expect(cancelled).toHaveLength(1)
    expect(store.phase()).toBe("idle")
    expect(store.entries().at(-1)).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "",
      status: "interrupted",
      detail: "Stopped the current response."
    })
  })

  test("buffered frames from a cancelled or foreign run are ignored", () => {
    const store = new TranscriptStore()
    const controller = new ChatController(store, {
      start: () => ({ status: "started" }),
      cancel: () => undefined
    })

    controller.publish({ runId: "foreign", type: "delta", kind: "text", text: "stale" })
    expect(store.entries()).toHaveLength(0)
  })
})
