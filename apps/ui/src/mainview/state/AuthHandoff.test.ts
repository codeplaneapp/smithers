import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"

/*
 * The native sign-in handoff: with the system-browser door (openExternal),
 * auth.sign-in mints a handoff, opens the OAuth start OUTSIDE the webview,
 * polls the claim until the session cookie lands, and re-probes the session.
 * Passkeys cannot run inside an embedded webview — this flow exists so they
 * never have to.
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
const until = async (predicate: () => boolean): Promise<void> => {
  for (let tick = 0; tick < 200 && !predicate(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const signedOut = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-out",
    login: null,
    allowlisted: false,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

interface Harness {
  readonly store: AppStore
  readonly opened: string[]
  readonly requests: string[]
  readonly signIn: () => Promise<unknown>
}

const harness = async (options: {
  readonly claims: ReadonlyArray<{ readonly status: number; readonly body: unknown }>
  readonly openResult?: boolean
  readonly startAnswer?: { readonly status: number; readonly body: unknown }
}): Promise<Harness> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const opened: string[] = []
  const requests: string[] = []
  const claims = [...options.claims]
  const services: AppServices = {
    baseUrl: "https://app.test",
    handoffPollMs: 1,
    openExternal: async (url) => {
      opened.push(url)
      return options.openResult ?? true
    },
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const path = new URL(url).pathname
      requests.push(`${init?.method ?? "GET"} ${path}`)
      if (path === "/api/auth/native/start") {
        const answer = options.startAnswer ?? {
          status: 200,
          body: { handoffId: "handoff-1", pollSecret: "secret-1", expiresAt: Date.now() + 600_000 }
        }
        return json(answer.status, answer.body)
      }
      if (path === "/api/auth/native/claim") {
        const next = claims.length > 1 ? claims.shift() : claims[0]
        return json(next?.status ?? 404, next?.body ?? { status: "error", message: "expired" })
      }
      if (path === "/api/auth/session") {
        // After a ready claim the cookie is in the jar: the probe answers signed-in.
        return json(200, { login: "will", allowlisted: true, admin: false })
      }
      return json(404, { status: "error", message: `no stub for ${path}` })
    }
  }
  const controller = createAppController(store, unavailableRepositories, unavailableAgent, services)
  await signedOut(store)
  return { store, opened, requests, signIn: () => controller.commands.run("auth.sign-in") }
}

describe("the native sign-in handoff", () => {
  test("mints the handoff, opens the system browser at the bound OAuth start, claims, and lands signed in", async () => {
    const h = await harness({
      claims: [
        { status: 200, body: { status: "pending" } },
        { status: 200, body: { status: "ready" } }
      ]
    })
    await h.signIn()
    await until(() => h.store.collections.identitySessions.get("identity")?.state === "signed-in")
    expect(h.opened).toEqual(["https://app.test/api/auth/github/start?handoff=handoff-1"])
    expect(h.requests).toContain("POST /api/auth/native/start")
    expect(h.requests.filter((line) => line === "POST /api/auth/native/claim").length).toBeGreaterThanOrEqual(2)
    const identity = h.store.collections.identitySessions.get("identity")
    expect(identity?.state).toBe("signed-in")
    expect(identity?.login).toBe("will")
    const toasts = [...h.store.collections.toasts.values()]
    expect(toasts.some((toast) => toast.title === "Signed in")).toBe(true)
  })

  test("a failed OAuth propagates the recorded reason and never fabricates a session", async () => {
    const h = await harness({
      claims: [{ status: 200, body: { status: "failed", message: "GitHub said no." } }]
    })
    await h.signIn()
    await until(() => [...h.store.collections.toasts.values()].some((toast) => toast.detail === "GitHub said no."))
    expect(h.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  })

  test("an expired handoff states itself honestly", async () => {
    const h = await harness({ claims: [{ status: 404, body: { status: "error", message: "expired" } }] })
    await h.signIn()
    await until(() =>
      [...h.store.collections.toasts.values()].some((toast) => (toast.detail ?? "").includes("expired"))
    )
    expect(h.store.collections.identitySessions.get("identity")?.state).toBe("signed-out")
  })

  test("a browser that will not open fails the arc without polling", async () => {
    const h = await harness({ claims: [], openResult: false })
    await h.signIn()
    await until(() =>
      [...h.store.collections.toasts.values()].some((toast) =>
        (toast.detail ?? "").includes("browser couldn't be opened")
      )
    )
    expect(h.requests.filter((line) => line.includes("claim"))).toHaveLength(0)
  })
})
