import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AgentChatMessage, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { MAX_TURN_REQUEST_BYTES, turnRequestBytes } from "./AgentTurnPolicy"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"

/** `AgentChatMessage` is a union: a chat turn, or a tool call/result item. */
const textOf = (message: AgentChatMessage | undefined): string =>
  message !== undefined && "content" in message ? message.content : ""

/*
 * §4.13 — the conversation the client sends is bounded, so a long one cannot
 * kill the seam for good.
 *
 * The size policy in AgentTurnPolicy.ts was written, unit-tested, and never
 * called: `contextMessages()` handed the WHOLE transcript to every turn. On
 * canary, seven long answers crossed the boundary's body limit and every turn
 * after that failed identically — `say ok` included, and `/clear` included,
 * because /clear runs a model turn of its own. This pins the wiring, not the
 * policy: the request that actually leaves the client is the thing under test.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

/** An agent double that records every turn request and ends the turn fast. */
const recordingAgent = (requests: StartAgentTurnRequest[]): NativeAgent => ({
  available: true,
  startTurn: async (request) => {
    requests.push(request)
    return { status: "error", message: "Recorded." }
  },
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("a long conversation still sends a turn the boundary accepts", () => {
  test("the turn is bounded, the newest prompt survives, and the drop is stated", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    // Six long turns is roughly where canary crossed the limit.
    for (let turn = 0; turn < 6; turn += 1) {
      controller.send(`turn ${turn} ${"w".repeat(15_000)}`)
      await settled()
    }
    controller.send("say ok")
    await settled()

    const last = requests.at(-1)
    expect(last).toBeDefined()
    expect(turnRequestBytes(last as StartAgentTurnRequest)).toBeLessThanOrEqual(
      MAX_TURN_REQUEST_BYTES
    )
    expect(textOf(last?.messages.at(-1))).toBe("say ok")
    expect(textOf(last?.messages[0])).toContain("dropped to fit this turn's size limit")
  })

  test("a short conversation is sent whole, with no notice invented", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const requests: StartAgentTurnRequest[] = []
    const controller = createAppController(store, unavailableRepositories, recordingAgent(requests))

    controller.send("hello")
    await settled()

    expect(requests[0]?.messages).toHaveLength(1)
    expect(textOf(requests[0]?.messages[0])).toBe("hello")
  })
})
