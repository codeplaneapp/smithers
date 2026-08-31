import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"

/*
 * `/world.new-note` typed from the chat used to create a note in a pane
 * that stayed closed: the act "executed" and nothing on screen changed. The
 * user's act opens the World pane on the new note; the agent's act embeds
 * (THE EMBED LAW) and leaves the surface alone.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const silentAgent: NativeAgent = {
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const noRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "cancelled" })
}

describe("world.new-note from the chat", () => {
  test("the user's act opens the World pane on the new note", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, noRepositories, silentAgent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.worldDocuments.size
    expect(store.session().surface).toBe("chat")
    expect((await controller.commands.run("world.new-note")).status).toBe("executed")
    expect(store.collections.worldDocuments.size).toBe(before + 1)
    expect(store.session().surface).toBe("world")
    const selected = store.session().selectedWorldDocumentId
    const created = [...store.collections.worldDocuments.values()].find((document) => document.id === selected)
    expect(created?.title).toMatch(/^Untitled/)
  })

  test("the agent's act creates the note and leaves the surface where it was", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, noRepositories, silentAgent, {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.worldDocuments.size
    expect((await controller.commands.runForAgent("world.new-note")).status).toBe("executed")
    expect(store.collections.worldDocuments.size).toBe(before + 1)
    expect(store.session().surface).toBe("chat")
  })
})
