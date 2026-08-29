import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"

/*
 * The composer is an invocation surface, not a second contract.
 *
 * A flow the human TYPES refuses exactly the way a flow the human CLICKS
 * refuses. Dropping the outcome of `commands.run` on the composer path is what
 * made `/issues.view 999999 owner/repo` render nothing while the bare
 * `/issues.view` (which the slash menu routes through the pointer path) stated
 * its refusal — the same flow, the same seam, two behaviours.
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

const silentAgent = (): NativeAgent => ({
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** A signed-in, allowlisted session: the state every repository flow requires. */
const signedInStore = async (): Promise<AppStore> => {
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

const failedToasts = (store: AppStore) =>
  [...store.collections.toasts.values()].filter((toast) => toast.status === "failed")

describe("a flow typed into the composer states its refusal", () => {
  test("an upstream 404 on /issues.view <n> <repo> surfaces the seam's own message", async () => {
    const store = await signedInStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      fetchImpl: async (input) => {
        const path = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          "https://app.test"
        ).pathname
        if (path.includes("/issues/999999")) return json(404, { message: "issue not found" })
        return json(404, { message: `no stub for ${path}` })
      }
    })
    controller.send("/issues.view 999999 codeplanesmithers/canary-sandbox")
    await settled()
    await settled()
    const failed = failedToasts(store)
    expect(failed.length).toBe(1)
    expect(failed[0]?.title).toBe("/issues.view didn't run")
    expect(failed[0]?.detail).toContain("Issue #999999")
    expect(failed[0]?.detail).toContain("codeplanesmithers/canary-sandbox")
  })

  test("a malformed argument is refused before the flow runs", async () => {
    const store = await signedInStore()
    let calls = 0
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      fetchImpl: async () => {
        calls += 1
        return json(200, {})
      }
    })
    controller.send("/env.set NOT_AN_ASSIGNMENT codeplanesmithers/canary-sandbox")
    await settled()
    await settled()
    const failed = failedToasts(store)
    expect(failed.length).toBe(1)
    expect(failed[0]?.title).toBe("/env.set didn't run")
    expect(failed[0]?.detail).toContain("NAME=value")
    expect(calls).toBe(0)
  })

  test("a flow that succeeds raises no refusal", async () => {
    const store = await signedInStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), {
      fetchImpl: async () => json(200, [])
    })
    controller.send("/issues.list open codeplanesmithers/canary-sandbox")
    await settled()
    await settled()
    expect(failedToasts(store).length).toBe(0)
  })
})
