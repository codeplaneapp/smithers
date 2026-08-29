import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../../native/NativeBridge"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * The BYOK keys seam through the real command path: keys.list surfaces the
 * one "keys" card (masked previews only — the secret law), keys.remove
 * deletes upstream and re-lists so the transcript states the new truth, and
 * every failure answers an honest string outcome, never a throw.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: NativeAgent = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

/** A raw secret planted in backend rows; it must never surface in the client. */
const RAW_SECRET = "sk-ant-api03-THE-WHOLE-UNMASKED-SECRET-VALUE"

interface RecordedRequest {
  readonly method: string
  readonly url: string
}

/**
 * A stateful BYOK backend double: GET answers the current rows (hostile — each
 * row also carries the raw secret under upstream field names, exactly what the
 * seam must never forward), DELETE removes by provider, everything else 404s.
 */
const keysBackend = (initialRows: Array<Record<string, unknown>>) => {
  let rows = [...initialRows]
  const requests: RecordedRequest[] = []
  const services: AppServices = {
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"
      requests.push({ method, url })
      if (method === "GET" && url.endsWith("/api/user/byok-keys")) {
        return json(200, { keys: rows })
      }
      const removal = /\/api\/user\/byok-keys\/([^/?]+)$/.exec(url)
      if (method === "DELETE" && removal !== null) {
        const provider = decodeURIComponent(removal[1] ?? "")
        if (!rows.some((row) => row.provider === provider)) {
          return json(404, { message: `no ${provider} key` })
        }
        rows = rows.filter((row) => row.provider !== provider)
        return json(200, {})
      }
      return json(404, { status: "error", message: `no stub for ${method} ${url}` })
    }
  }
  return { services, requests }
}

const hostileRows: Array<Record<string, unknown>> = [
  {
    id: "1",
    provider: "anthropic",
    last4: "abcd",
    status: "active",
    created_at: "2026-08-01T00:00:00.000Z",
    api_key: RAW_SECRET,
    key: RAW_SECRET,
    encrypted_key: RAW_SECRET
  },
  { id: "2", provider: "openai", masked: "sk-…wxyz", status: "active", api_key: RAW_SECRET },
  { id: "3", provider: "groq", status: "active" }
]

const freshController = async (services: AppServices) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, services)
  await signedIn(store)
  return { store, controller }
}

const keysCard = (store: AppStore) => {
  const card = store.collections.cards.get("byok-keys")
  if (card === undefined || card.kind !== "keys") return undefined
  return card
}

describe("keys.list — the masked card", () => {
  test("surfaces one 'keys' card with masked previews mapped from the platform rows", async () => {
    const backend = keysBackend(hostileRows)
    const { store, controller } = await freshController(backend.services)
    const outcome = await controller.commands.run("keys.list")
    expect(outcome.status).toBe("executed")
    await settled()
    const card = keysCard(store)
    expect(card).toBeDefined()
    expect(card?.title).toBe("Provider keys")
    expect(card?.status).toBe("active")
    expect(card?.payload.keys).toEqual([
      // last4 answered → a synthesized preview.
      { provider: "anthropic", masked: "sk-…abcd" },
      // The API's own masked field wins when present.
      { provider: "openai", masked: "sk-…wxyz" },
      // Nothing maskable → the plain fact.
      { provider: "groq", masked: "configured" }
    ])
  })

  test("the secret law: no unmasked key material anywhere in the card", async () => {
    const backend = keysBackend(hostileRows)
    const { store, controller } = await freshController(backend.services)
    await controller.commands.run("keys.list")
    await settled()
    const card = keysCard(store)
    expect(card).toBeDefined()
    expect(JSON.stringify(card)).not.toContain(RAW_SECRET)
    // Nor in any other card, message, or toast the run produced.
    for (const other of store.collections.cards.values()) {
      expect(JSON.stringify(other)).not.toContain(RAW_SECRET)
    }
    for (const message of store.collections.messages.values()) {
      expect(JSON.stringify(message)).not.toContain(RAW_SECRET)
    }
    for (const toast of store.collections.toasts.values()) {
      expect(JSON.stringify(toast)).not.toContain(RAW_SECRET)
    }
  })

  test("re-listing re-surfaces the same card at the end of the transcript", async () => {
    const backend = keysBackend(hostileRows)
    const { store, controller } = await freshController(backend.services)
    await controller.commands.run("keys.list")
    await settled()
    const first = keysCard(store)
    await controller.commands.run("keys.list")
    await settled()
    const second = keysCard(store)
    expect(second?.id).toBe("byok-keys")
    expect(second?.ordinal).toBeGreaterThan(first?.ordinal ?? Number.NaN)
    expect([...store.collections.cards.values()].filter((card) => card.kind === "keys")).toHaveLength(1)
  })

  test("a 500 answers the server's honest message as a failed outcome, no card", async () => {
    const services: AppServices = {
      fetchImpl: async () => json(500, { message: "the byok store is unavailable" })
    }
    const { store, controller } = await freshController(services)
    const outcome = await controller.commands.run("keys.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the byok store is unavailable")
    expect(keysCard(store)).toBeUndefined()
  })

  test("a network throw answers an honest string, never a throw", async () => {
    const services: AppServices = {
      fetchImpl: async () => {
        throw new Error("connection refused")
      }
    }
    const { store, controller } = await freshController(services)
    const outcome = await controller.commands.run("keys.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Your provider keys couldn't be listed — the platform didn't answer.")
    }
    expect(keysCard(store)).toBeUndefined()
  })

  test("a malformed 200 body fails honestly instead of surfacing a wrong card", async () => {
    const services: AppServices = { fetchImpl: async () => json(200, { unexpected: true }) }
    const { store, controller } = await freshController(services)
    const outcome = await controller.commands.run("keys.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("The provider keys answer was malformed.")
    expect(keysCard(store)).toBeUndefined()
  })
})

describe("keys.remove — delete upstream, then state the new truth", () => {
  test("removes the provider and re-lists the card without it", async () => {
    const backend = keysBackend(hostileRows)
    const { store, controller } = await freshController(backend.services)
    await controller.commands.run("keys.list")
    await settled()
    const before = keysCard(store)
    expect(before?.payload.keys.map((key) => key.provider)).toContain("anthropic")

    const outcome = await controller.commands.run("keys.remove", "anthropic")
    expect(outcome.status).toBe("executed")
    await settled()

    const deletes = backend.requests.filter((request) => request.method === "DELETE")
    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.url.endsWith("/api/user/byok-keys/anthropic")).toBe(true)

    const after = keysCard(store)
    expect(after?.payload.keys).toEqual([
      { provider: "openai", masked: "sk-…wxyz" },
      { provider: "groq", masked: "configured" }
    ])
    // The re-listed card sits at the end of the transcript, not mid-history.
    expect(after?.ordinal).toBeGreaterThan(before?.ordinal ?? Number.NaN)
    expect(JSON.stringify(after)).not.toContain(RAW_SECRET)
  })

  test("a failed delete answers the server's message and leaves the card's truth alone", async () => {
    const backend = keysBackend(hostileRows)
    let failDeletes = false
    const services: AppServices = {
      fetchImpl: async (input, init) => {
        if (failDeletes && init?.method === "DELETE") {
          return json(500, { message: "the key store refused" })
        }
        if (backend.services.fetchImpl === undefined) throw new Error("no backend stub")
        return backend.services.fetchImpl(input, init)
      }
    }
    const { store, controller } = await freshController(services)
    await controller.commands.run("keys.list")
    await settled()
    failDeletes = true
    const outcome = await controller.commands.run("keys.remove", "anthropic")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the key store refused")
    // Nothing was removed upstream, so the card still states all three keys.
    expect(keysCard(store)?.payload.keys).toHaveLength(3)
  })

  test("a network throw during delete answers an honest string naming the provider", async () => {
    const backend = keysBackend(hostileRows)
    let killNetwork = false
    const services: AppServices = {
      fetchImpl: async (input, init) => {
        if (killNetwork) throw new Error("connection reset")
        if (backend.services.fetchImpl === undefined) throw new Error("no backend stub")
        return backend.services.fetchImpl(input, init)
      }
    }
    const { controller } = await freshController(services)
    await controller.commands.run("keys.list")
    await settled()
    killNetwork = true
    const outcome = await controller.commands.run("keys.remove", "anthropic")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("The anthropic key couldn't be removed — the platform didn't answer.")
    }
  })

  test("keys.remove is the human's act alone: the agent path refuses and deletes nothing", async () => {
    const backend = keysBackend(hostileRows)
    const { controller } = await freshController(backend.services)
    const outcome = await controller.commands.runForAgent("keys.remove", "anthropic")
    expect(outcome.status).toBe("failed")
    expect(backend.requests.filter((request) => request.method === "DELETE")).toHaveLength(0)
  })
})
