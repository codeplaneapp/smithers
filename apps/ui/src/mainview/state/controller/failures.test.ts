import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import type { ControllerContext } from "./context"
import { createFailureController } from "./failures"

/*
 * The toast run counter used to be write-only: every withToast set an entry
 * and nothing ever removed one, so the map grew for the session's lifetime.
 * Terminal paths now delete their entry equality-guarded — a newer run of
 * the same key keeps its own slot untouched.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const fakeContext = async (options?: {
  readonly toastDebounceMs?: number
  readonly toastAutoDismissMs?: number
}): Promise<{ ctx: ControllerContext; store: Awaited<ReturnType<typeof createAppStore>> }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const ctx = {
    store,
    toastRuns: new Map<string, number>(),
    toastDebounceMs: options?.toastDebounceMs ?? 0,
    toastAutoDismissMs: options?.toastAutoDismissMs ?? 0,
    unref: () => {}
  } as unknown as ControllerContext
  return { ctx, store }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the toast run counter's terminal cleanup", () => {
  test("an ok run's entry leaves when its auto-dismiss fires", async () => {
    const { ctx } = await fakeContext()
    const failures = createFailureController(ctx)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = failures.withToast("flow.ok", "Working…", "Done", () => gate.then(() => true))
    await settled()
    release()
    await pending
    // The toast showed and resolved; the entry stays until the auto-dismiss
    // — the slot's terminal act — fires.
    expect(ctx.toastRuns.has("flow.ok")).toBe(true)
    await settled()
    expect(ctx.toastRuns.has("flow.ok")).toBe(false)
  })

  test("a failed run's entry leaves at settle even though its toast stays", async () => {
    const { ctx, store } = await fakeContext()
    const failures = createFailureController(ctx)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = failures.withToast("flow.bad", "Working…", "Done", () => gate.then(() => "it broke"))
    await settled()
    release()
    const outcome = await pending
    expect(outcome).toBe("it broke")
    expect(ctx.toastRuns.has("flow.bad")).toBe(false)
    // The failure toast itself still waits for the user.
    expect(store.collections.toasts.get("toast-flow.bad")?.status).toBe("failed")
  })

  test("work settled before the debounce leaves no entry behind", async () => {
    const { ctx, store } = await fakeContext({ toastDebounceMs: 10_000 })
    const failures = createFailureController(ctx)
    await failures.withToast("flow.quick", "Working…", "Done", async () => true)
    expect(store.collections.toasts.size).toBe(0)
    expect(ctx.toastRuns.has("flow.quick")).toBe(false)
  })

  test("a superseding run keeps its own slot when the stale run settles", async () => {
    const { ctx } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    let releaseStale!: () => void
    let releaseCurrent!: () => void
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const stale = failures.withToast("flow.race", "Working…", "Done", () => staleGate.then(() => "stale line"))
    const current = failures.withToast("flow.race", "Working…", "Done", () => currentGate.then(() => true))
    await settled()
    releaseStale()
    releaseCurrent()
    await stale
    await current
    // The current run owns the slot; the stale run settled without touching it.
    expect(ctx.toastRuns.get("flow.race")).toBe(2)
  })
})
