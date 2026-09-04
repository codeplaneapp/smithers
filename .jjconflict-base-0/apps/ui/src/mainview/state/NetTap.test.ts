import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
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

const idleAgent: NativeAgent = {
  available: true,
  startTurn: async () => ({ status: "started" }),
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

describe("the wire tap", () => {
  test("records method, path, status, and duration for every controller fetch", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, idleAgent, {
      fetchImpl: async () => new Response("{}", { status: 500 })
    })
    await controller.refreshBalance()
    const entries = JSON.parse(controller.debugNet().value) as ReadonlyArray<{
      readonly method: string
      readonly url: string
      readonly status: number | "error"
      readonly ms: number
    }>
    expect(entries.length).toBeGreaterThan(0)
    const balance = entries.find((entry) => entry.url.includes("/api/billing/balance"))
    expect(balance?.method).toBe("GET")
    expect(balance?.status).toBe(500)
    expect(typeof balance?.ms).toBe("number")
  })

  test("records a thrown fetch as an error entry and rethrows to the caller's handling", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, idleAgent, {
      fetchImpl: async () => {
        throw new Error("network down")
      }
    })
    await controller.refreshBalance()
    const entries = JSON.parse(controller.debugNet().value) as ReadonlyArray<{
      readonly status: number | "error"
    }>
    expect(entries.some((entry) => entry.status === "error")).toBe(true)
  })
})
