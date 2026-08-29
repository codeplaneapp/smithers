import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import { createControllerContext } from "./controller/context"

/*
 * §22.6 / A.18: `POST /api/workflow/provision` never answered, so "Preparing
 * your … workspace…" stood past 120s with no run card, no timeout and no
 * error. A request that never answers has to become an answer.
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

describe("a seam that never answers becomes an honest answer", () => {
  test("provisioning refuses on its own deadline instead of standing forever", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, unavailableAgent, {
      seamTimeoutMs: 40,
      toastDebounceMs: 10_000,
      fetchImpl: (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.includes("/api/workflow/provision")) {
          // The measured shape: the request is accepted and never answered.
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          })
        }
        if (url.includes("/api/identity/watched")) {
          return Promise.resolve(json(200, { selected: ["will/flows"] }))
        }
        return Promise.resolve(json(404, { message: "no stub" }))
      }
    })
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    store.dispatch({
      type: "watched.replaced",
      actor: "system",
      selected: ["will/flows"],
      selectedAt: "2026-08-19T00:00:00.000Z",
      via: "command"
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const started = Date.now()
    const outcome = await controller.commands.run("flow.create", "nightly digest will/flows")
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("didn't answer in time")
  })

  test("the deadline rejects with a named seam timeout, not a message-less TimeoutError", async () => {
    /*
     * boundedFetch's deadline is the seam's own failure and has to say so:
     * `Effect.timeout` alone rejects with a TimeoutError whose `message` is
     * undefined, which reaches any caller that reports `error.message` as
     * the literal string "undefined".
     */
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const ctx = createControllerContext(store, unavailableRepositories, unavailableAgent, {
      seamTimeoutMs: 20,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })
    })
    const failure = await ctx.boundedFetch("https://app.test/api/anything", { method: "GET" }).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("seam timeout")
  })
})
