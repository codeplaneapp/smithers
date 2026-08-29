import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"

/*
 * §2.4: the transcript, its cards and the balance are persisted, so signing
 * out and reloading still rendered the previous account's repository names,
 * balance and open cards — on a shared machine, to whoever sits down next.
 * Signing out empties them.
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

const backend = (routes: Record<string, () => Response | Promise<Response>>): AppServices => ({
  fetchImpl: async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const path = new URL(url, "https://app.test").pathname
    const answer = routes[path]
    return answer === undefined ? json(404, { message: `no stub for ${path}` }) : answer()
  }
})

const signedIn = (store: AppStore, login = "codeplanesmithers"): void => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login,
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
}

/** The previous account's data, as the persisted store holds it. */
const seedAccountState = (store: AppStore): void => {
  store.dispatch({
    type: "message.appended",
    actor: "system",
    text: "You have 6 open issues across codeplanesmithers/canary-sandbox."
  })
  store.dispatch({
    type: "billing.refreshed",
    actor: "system",
    state: "ok",
    totalUsd: "505",
    allowedToStartWork: true,
    lifetimeChargedUsd: "0",
    chargeCount: 0
  })
  store.dispatch({
    type: "card.upsert",
    actor: "user",
    card: {
      id: "balance",
      kind: "balance",
      title: "Balance",
      status: "active",
      createdAt: Date.now(),
      ordinal: 1,
      payload: {
        state: "ok",
        totalUsd: "505",
        allowedToStartWork: true,
        lifetimeChargedUsd: "0",
        chargeCount: 0,
        introUsd: null
      }
    }
  })
  store.dispatch({
    type: "toolcall.recorded",
    actor: "smithers",
    turnId: "alice-turn",
    name: "issues.list",
    arguments: JSON.stringify({ repo: "alice/private" }),
    result: JSON.stringify({ title: "private issue" })
  })
  store.dispatch({
    type: "chain.event.appended",
    actor: "smithers",
    lineageId: "alice-chain",
    seq: 0,
    event: { _tag: "ChainStarted", goal: "read alice/private", envelope: null }
  })
}

const leftovers = (store: AppStore) => ({
  messages: store.collections.messages.size,
  cards: store.collections.cards.size,
  billing: store.collections.billingAccounts.get("billing")?.totalUsd ?? null,
  billingState: store.collections.billingAccounts.get("billing")?.state ?? null,
  toolCalls: store.collections.toolCalls.size,
  chainEvents: store.collections.chainEvents.size
})

describe("signing out leaves nothing of the account behind", () => {
  test("an explicit sign-out empties the transcript, the cards and the balance", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableRepositories,
      unavailableAgent,
      backend({ "/api/auth/logout": () => json(200, { ok: true }) })
    )
    signedIn(store)
    seedAccountState(store)
    expect(leftovers(store).messages).toBeGreaterThan(0)

    await controller.commands.run("auth.sign-out")
    await settled()
    expect(leftovers(store)).toEqual({
      messages: 0,
      cards: 0,
      billing: null,
      billingState: "unknown",
      toolCalls: 0,
      chainEvents: 0
    })
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  })

  test("a session that expires between loads is scrubbed the same way", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableRepositories,
      unavailableAgent,
      backend({ "/api/auth/session": () => json(200, { status: "signed-out" }) })
    )
    signedIn(store)
    seedAccountState(store)

    await controller.loadSession()
    await settled()
    expect(leftovers(store)).toEqual({
      messages: 0,
      cards: 0,
      billing: null,
      billingState: "unknown",
      toolCalls: 0,
      chainEvents: 0
    })
  })

  test("a direct Alice-to-Bob session replacement scrubs Alice before publishing Bob", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    signedIn(store, "alice")
    seedAccountState(store)

    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "bob",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    await settled()

    expect(store.collections.identitySessions.get("identity")?.login).toBe("bob")
    expect(leftovers(store)).toEqual({
      messages: 0,
      cards: 0,
      billing: null,
      billingState: "unknown",
      toolCalls: 0,
      chainEvents: 0
    })
    expect([...store.collections.transitions.values()].every((row) => !row.payload.includes("alice"))).toBe(true)
  })

  test("an Alice watched-selection response cannot repopulate state after sign-out", async () => {
    let answer!: (response: Response) => void
    const delayed = new Promise<Response>((resolve) => {
      answer = resolve
    })
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableRepositories,
      unavailableAgent,
      backend({
        "/api/identity/watched": () => delayed,
        "/api/auth/logout": () => json(200, { ok: true })
      })
    )
    signedIn(store, "alice")
    const pending = controller.openFirstRunRepos()
    await settled()
    await controller.commands.run("auth.sign-out")
    answer(json(200, { selected: ["alice/private"], selectedAt: "2026-08-09T09:00:00.000Z", via: "onboarding" }))
    await pending
    await settled()

    expect(store.collections.watchedRepos.get("watched")?.selected ?? null).toBeNull()
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  })

  test("an unavailable identity seam scrubs nothing — silence is not a sign-out", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableRepositories,
      unavailableAgent,
      backend({ "/api/auth/session": () => json(500, { message: "down" }) })
    )
    signedIn(store)
    seedAccountState(store)

    await controller.loadSession()
    await settled()
    expect(leftovers(store).messages).toBeGreaterThan(0)
    expect(store.collections.identitySessions.get("identity")?.state).toBe("unavailable")
  })

  test("a sign-out the identity service refuses says so, and signs nothing out", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(
      store,
      unavailableRepositories,
      unavailableAgent,
      backend({ "/api/auth/logout": () => json(403, { message: "forbidden" }) })
    )
    signedIn(store)
    seedAccountState(store)

    const outcome = await controller.commands.run("auth.sign-out")
    expect(outcome.status).toBe("failed")
    expect(store.collections.identitySessions.get("identity")?.state).toBe("signed-in")
    expect(leftovers(store).messages).toBeGreaterThan(0)
  })
})
