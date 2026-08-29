import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"

/*
 * The §26 debug reads answer the human who typed them.
 *
 * `{ value }` is the agent boundary's channel and never renders on its own, so
 * a read whose only answer is a value was a silent no-op in the transcript —
 * the flow ran, the payload was correct, and the admin saw nothing.
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

const agentWithGrants = (revoked: { count: number }): NativeAgent => ({
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {},
  revokeGrants: async () => {
    revoked.count += 1
  }
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The only session the debug plugin registers for. */
const adminStore = async (): Promise<AppStore> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: true,
    scopesPlain: null
  })
  return store
}

const bodies = (store: AppStore): string[] => [...store.collections.messages.values()].map((message) => message.text)

describe("the debug reads render for the human", () => {
  test("/debug.backend answers the human", async () => {
    const store = await adminStore()
    const controller = createAppController(store, unavailableRepositories, agentWithGrants({ count: 0 }), {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.messages.size
    controller.send("/debug.backend")
    await settled()
    await settled()
    expect(store.collections.messages.size).toBe(before + 1)
    expect(bodies(store).at(-1)).toContain("agent backend: chain")
  })

  test.each([
    ["debug.snapshot", "App state snapshot"],
    ["debug.events", "Transition journal tail"],
    ["debug.chain", "Chain journal x-ray"],
    ["debug.net", "Network tap"]
  ])("/%s appends its payload to the transcript", async (flow, title) => {
    const store = await adminStore()
    const controller = createAppController(store, unavailableRepositories, agentWithGrants({ count: 0 }), {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.messages.size
    controller.send(`/${flow}`)
    await settled()
    await settled()
    expect(store.collections.messages.size).toBe(before + 1)
    const rendered = bodies(store).at(-1) ?? ""
    expect(rendered).toContain(title)
    expect(rendered).toContain("```json")
  })

  test("/debug.grants.reset states that the grants are gone", async () => {
    const revoked = { count: 0 }
    const store = await adminStore()
    const controller = createAppController(store, unavailableRepositories, agentWithGrants(revoked), {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    controller.send("/debug.grants.reset")
    await settled()
    await settled()
    expect(revoked.count).toBe(1)
    expect(bodies(store).at(-1)).toContain("session grants are revoked")
  })

  test("the agent's own invocation renders nothing and still reads the value", async () => {
    const store = await adminStore()
    const controller = createAppController(store, unavailableRepositories, agentWithGrants({ count: 0 }), {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.messages.size
    const outcome = await controller.commands.runForAgent("debug.snapshot")
    expect(outcome.status).toBe("executed")
    expect(outcome.status === "executed" ? outcome.value : undefined).toContain("surface")
    expect(store.collections.messages.size).toBe(before)
  })

  test("the dev-tools panel's read never dispatches", async () => {
    const store = await adminStore()
    const controller = createAppController(store, unavailableRepositories, agentWithGrants({ count: 0 }), {
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const before = store.collections.messages.size
    JSON.parse(controller.netTap())
    JSON.parse(controller.netTap())
    expect(store.collections.messages.size).toBe(before)
  })
})
