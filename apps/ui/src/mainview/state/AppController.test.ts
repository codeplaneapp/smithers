import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame } from "smithers-shared/NativeAgent"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

/** Mirrors a web-mode agent whose server boundary is unreachable: every turn errors. */
const webAgent = (message = "Could not reach the Smithers web agent."): NativeAgent => ({
  available: false,
  startTurn: async () => ({ status: "error", message }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createAppController in pure web mode", () => {
  test("reports the native agent as unavailable without blocking the composer path", async () => {
    const controller = createAppController(await webStore(), unavailableRepositories, webAgent())
    expect(controller.nativeAgentAvailable).toBe(false)
    expect(controller.nativeRepositoriesAvailable).toBe(false)
  })

  test("records the user message and a visible failure when no native agent can run the turn", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, webAgent())

    controller.send("hello from the web build")
    await settled()

    const messages = [...store.collections.messages.values()]
    const submitted = messages.find((message) => message.text === "hello from the web build")
    expect(submitted?.role).toBe("user")

    const failure = messages.find((message) => message.status === "failed")
    expect(failure?.role).toBe("smithers")
    expect(failure?.text).toContain("Could not reach the Smithers web agent.")
  })

  test("returns the session to idle so the composer stays usable after a failed turn", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, webAgent())

    controller.send("first attempt")
    await settled()
    expect(store.session().phase).toBe("idle")

    controller.send("second attempt")
    await settled()
    const texts = [...store.collections.messages.values()].map((message) => message.text)
    expect(texts).toContain("second attempt")
  })

  test("renders a streamed web turn to completion through the shared frame contract", async () => {
    const store = await webStore()
    const listeners = new Set<(frame: AgentTurnFrame) => void>()
    const streamingAgent: NativeAgent = {
      available: true,
      startTurn: async (request) => {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({ runId: request.runId, type: "delta", kind: "text", text: "Hello from " })
            listener({ runId: request.runId, type: "delta", kind: "text", text: "Smithers Cloud." })
            listener({ runId: request.runId, type: "done" })
          }
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    const controller = createAppController(store, unavailableRepositories, streamingAgent)
    expect(controller.nativeAgentAvailable).toBe(true)

    controller.send("Hello who are you")
    await settled()

    const response = [...store.collections.messages.values()]
      .filter((message) => message.role === "smithers")
      .sort((left, right) => right.ordinal - left.ordinal)[0]
    expect(response?.text).toBe("Hello from Smithers Cloud.")
    expect(response?.status).toBe("complete")
    expect(store.session().phase).toBe("idle")
  })

  test("journals composer and theme transitions with their actor in web mode", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, webAgent())

    controller.changeDraft("draft in the browser")
    expect(store.session().draft).toBe("draft in the browser")

    const before = store.session().theme
    controller.toggleTheme()
    expect(store.session().theme).not.toBe(before)

    const journal = [...store.collections.transitions.values()]
    expect(journal.some((record) => record.type === "theme.changed" && record.actor === "user")).toBe(true)
  })
})
