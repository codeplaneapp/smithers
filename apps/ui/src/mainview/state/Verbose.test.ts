/*
 * /verbose — the maintainer's view of everything Smithers does.
 *
 * On, every flow invocation (listed or hidden, user or agent, deferred or
 * settled) and every non-user transition renders as a trace line in the
 * transcript, and the transition logger writes to the console. Off, the
 * transcript reads exactly as it would have without the switch.
 */
import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, test } from "bun:test"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "./AppController"
import { createAppStore, TRACE_MESSAGE_PREFIX, VERBOSE_OFF_TEXT, VERBOSE_ON_TEXT, verboseTrace } from "./AppStore"

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

const fresh = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return { store, controller: createAppController(store, unavailableRepositories, unavailableAgent) }
}

const traces = (store: Awaited<ReturnType<typeof fresh>>["store"]): Array<string> =>
  [...store.collections.messages.values()]
    .filter((message) => message.id.startsWith(TRACE_MESSAGE_PREFIX))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((message) => message.act ?? "")

const originalDebug = console.debug
afterEach(() => {
  console.debug = originalDebug
})

describe("/verbose", () => {
  test("registers for every session as a listed, user-only flow", async () => {
    const { controller } = await fresh()
    const entry = controller.commands.find("debug.verbose")
    expect(entry).toBeDefined()
    expect(entry?.metadata.hidden).not.toBe(true)
    expect(entry?.binding.descriptor.modelInvocable).toBe(false)
    expect(controller.slashItems("verb").map((item) => item.flow.name)).toContain("debug.verbose")
  })

  test("toggles the session flag and states it in the transcript", async () => {
    const { store, controller } = await fresh()
    expect(store.session().verbose).toBe(false)
    expect((await controller.commands.run("debug.verbose")).status).toBe("executed")
    expect(store.session().verbose).toBe(true)
    const texts = [...store.collections.messages.values()].map((message) => message.text)
    expect(texts).toContain(VERBOSE_ON_TEXT)
    expect((await controller.commands.run("debug.verbose")).status).toBe("executed")
    expect(store.session().verbose).toBe(false)
    expect([...store.collections.messages.values()].map((message) => message.text)).toContain(VERBOSE_OFF_TEXT)
  })

  test("a hidden flow leaves a trace line only while verbose is on", async () => {
    const { store, controller } = await fresh()
    // `stop` is a hidden alias of chat.stop: off, it leaves no line at all.
    await controller.commands.run("stop")
    expect(traces(store)).toEqual([])
    const before = [...store.collections.messages.values()].length

    await controller.commands.run("debug.verbose")
    await controller.commands.run("stop")
    const lines = traces(store)
    expect(lines.some((line) => line.startsWith("You ran /stop [hidden] → executed"))).toBe(true)
    // Every act is recorded as a transition whether or not it is rendered.
    const invoked = [...store.collections.transitions.values()].filter((record) => record.type === "flow.invoked")
    expect(invoked.length).toBeGreaterThanOrEqual(2)

    await controller.commands.run("debug.verbose")
    // Off removes every trace line; the on/off statements are the only additions.
    expect(traces(store)).toEqual([])
    expect([...store.collections.messages.values()].length).toBe(before + 2)
  })

  test("an unknown name and a failed flow trace their outcome", async () => {
    const { store, controller } = await fresh()
    await controller.commands.run("debug.verbose")
    await controller.commands.run("no.such.flow")
    await controller.commands.run("appearance.theme", "not-a-palette")
    const lines = traces(store)
    expect(lines.some((line) => line.startsWith("You ran /no.such.flow → unknown-command"))).toBe(true)
    expect(lines.some((line) => line.startsWith("You ran /appearance.theme not-a-palette → failed ("))).toBe(true)
  })

  test("agent invocations trace as Smithers", async () => {
    const { store, controller } = await fresh()
    await controller.commands.run("debug.verbose")
    await controller.commands.runForAgent("world")
    expect(traces(store).some((line) => line.startsWith("Smithers ran /world → executed"))).toBe(true)
  })

  test("background and system transitions trace; keystrokes and deltas never do", async () => {
    const { store, controller } = await fresh()
    await controller.commands.run("debug.verbose")
    store.dispatch({ type: "toast.shown", actor: "system", key: "toast-1", title: "Working…" })
    controller.changeDraft("hello")
    const lines = traces(store)
    expect(lines.some((line) => line.startsWith("system: toast.shown"))).toBe(true)
    expect(lines.some((line) => line.includes("composer.changed"))).toBe(false)
    expect(verboseTrace({ type: "composer.changed", actor: "user", draft: "x" })).toBeUndefined()
    expect(verboseTrace({ type: "message.response.delta", actor: "smithers", turnId: "t", channel: "text", delta: "x" })).toBeUndefined()
  })

  test("the logger writes every trace to the console only while on", async () => {
    const { controller } = await fresh()
    const logged: Array<string> = []
    console.debug = (...args: Array<unknown>) => {
      logged.push(String(args[0]))
    }
    await controller.commands.run("appearance.dark-mode")
    expect(logged).toEqual([])
    await controller.commands.run("debug.verbose")
    await controller.commands.run("appearance.dark-mode")
    expect(logged.some((line) => line.includes("ran /appearance.dark-mode"))).toBe(true)
    const count = logged.length
    await controller.commands.run("debug.verbose")
    await controller.commands.run("appearance.dark-mode")
    expect(logged.length).toBe(count)
  })
})
