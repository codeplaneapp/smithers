import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AgentTurnFrame, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"

/*
 * /retry re-RUNS the last turn. Re-SENDING the prompt appended a second user
 * bubble per attempt, so the transcript grew a duplicate pair every time and
 * each retry shipped a longer history than the one before it.
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

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/** An agent that records every leg it is asked to run and ends turns on demand. */
const recordingAgent = () => {
  const launches: StartAgentTurnRequest[] = []
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const agent: NativeAgent = {
    available: true,
    startTurn: async (request) => {
      launches.push(request)
      return { status: "started" }
    },
    cancelTurn: async () => {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const emit = (frame: AgentTurnFrame) => {
    for (const listener of listeners) listener(frame)
  }
  return {
    agent,
    launches,
    fail: (runId: string, error: string) => emit({ runId, type: "done", error }),
    answer: (runId: string, text: string) => {
      emit({ runId, type: "delta", kind: "text", text })
      emit({ runId, type: "done", reason: "stop" })
    }
  }
}

const signedInStore = async (): Promise<AppStore> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  return store
}

const userBubbles = (store: AppStore, text: string) =>
  [...store.collections.messages.values()].filter(
    (message) => message.role === "user" && message.text === text
  )

describe("/retry re-runs the last turn", () => {
  test("the user message is never duplicated, however many times retry runs", async () => {
    const store = await signedInStore()
    const { agent, launches, fail } = recordingAgent()
    const controller = createAppController(store, unavailableRepositories, agent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    controller.send("Reply with one random uncommon English noun, nothing else.")
    await settled()
    const turnId = launches[0]?.runId
    expect(turnId).toBeDefined()
    fail(turnId as string, "the upstream fell over")
    await settled()

    await controller.commands.run("retry")
    await settled()
    expect(userBubbles(store, "Reply with one random uncommon English noun, nothing else.").length).toBe(1)

    fail(turnId as string, "again")
    await settled()
    await controller.commands.run("retry")
    await settled()
    expect(userBubbles(store, "Reply with one random uncommon English noun, nothing else.").length).toBe(1)
    // Three legs: the original send plus two re-runs, all on the same turn.
    expect(launches.length).toBe(3)
    expect(launches.every((launch) => launch.runId === turnId)).toBe(true)
  })

  test("the failed answer makes way for the re-run instead of being sent back to the model", async () => {
    const store = await signedInStore()
    const { agent, launches, fail } = recordingAgent()
    const controller = createAppController(store, unavailableRepositories, agent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    controller.send("what is my balance?")
    await settled()
    const turnId = launches[0]?.runId as string
    fail(turnId, "the upstream fell over")
    await settled()
    expect(store.collections.messages.get(`message-${turnId}-smithers`)).toBeDefined()

    await controller.commands.run("retry")
    await settled()
    expect(store.collections.messages.get(`message-${turnId}-smithers`)).toBeUndefined()
    const retried = launches[1]
    expect(
      retried?.messages.map((message) => ("content" in message ? message.content : message.type))
    ).toEqual(["what is my balance?"])
  })

  test("retry mid-turn does nothing — there is nothing settled to re-run", async () => {
    const store = await signedInStore()
    const { agent, launches } = recordingAgent()
    const controller = createAppController(store, unavailableRepositories, agent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    controller.send("still running")
    await settled()
    expect(store.session().phase).toBe("responding")
    await controller.commands.run("retry")
    await settled()
    expect(launches.length).toBe(1)
  })
})
