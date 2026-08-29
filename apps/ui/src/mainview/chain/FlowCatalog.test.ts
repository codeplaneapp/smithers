import { Author, Catalog, Chain, Journal, ScriptRunner } from "@smthrs/chain"
import type { Event, Outcome } from "@smthrs/chain"
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { NativeAgent, NativeRepositories } from "../native/NativeBridge"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import type { AppStore } from "../state/AppStore"
import { commandEntries, disclosedEntries } from "./FlowCatalog"

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

const harness = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, idleAgent)
  return { store, commands: controller.commands }
}

const flow = (...lines: ReadonlyArray<string>): string => ["```flow", ...lines, "```"].join("\n")

const runChain = (options: {
  readonly store: AppStore
  readonly entries: ReadonlyArray<Catalog.Entry>
  readonly scripts: ReadonlyArray<string>
}) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const outcome = yield* Chain.run({ goal: "test goal" })
      const journal = yield* Journal.Journal
      const events = yield* journal.read
      return { outcome, events }
    }).pipe(
      Effect.provide(
        (() => {
          const base = Layer.mergeAll(
            Journal.layerMemory([]),
            Author.layerMock(options.scripts),
            ScriptRunner.layerInProcess
          )
          return Layer.mergeAll(
            base,
            Catalog.layer(options.entries).pipe(Layer.provide(base))
          )
        })()
      )
    ) as Effect.Effect<
      { outcome: Outcome.Terminal; events: ReadonlyArray<Event.Event> },
      never,
      never
    >
  )

describe("commandEntries — the callable projection", () => {
  test("projects every non-user command, hidden id-scoped actions included", async () => {
    const { commands } = await harness()
    const names = commandEntries(commands).map((entry) => entry.name)
    expect(names).toContain("browser")
    expect(names).toContain("world.new-note")
    expect(names).toContain("approval.approve")
    // User-only chrome stays structurally unreachable.
    expect(names).not.toContain("theme")
    expect(names).not.toContain("send")
    expect(names).not.toContain("chat.stop")
    // Admin commands are absent for a non-admin session (non-enumerable).
    expect(names).not.toContain("reset")
    expect(names).not.toContain("debug.snapshot")
  })

  test("disclosedEntries is the unhidden subset the list action returns today", async () => {
    const { commands } = await harness()
    const disclosed = disclosedEntries(commands).map((entry) => entry.name)
    expect(disclosed).toContain("browser")
    expect(disclosed).not.toContain("world.new-note")
    const callable = new Set(commandEntries(commands).map((entry) => entry.name))
    for (const name of disclosed) expect(callable.has(name)).toBe(true)
  })
})

describe("commandEntries — execution through the one door", () => {
  test("a script's call runs the real command as actor smithers", async () => {
    const { store, commands } = await harness()
    const before = store.collections.worldDocuments.size
    const { outcome } = await runChain({
      store,
      entries: commandEntries(commands),
      scripts: [flow(`await ctx.call("world.new-note", {})`, `return done({ noted: true })`)]
    })
    expect(outcome._tag).toBe("Done")
    expect(store.collections.worldDocuments.size).toBe(before + 1)
    const created = [...store.collections.worldDocuments.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt
    )[0]
    expect(created?.updatedBy).toBe("smithers")
  })

  test("a command's honest failure string becomes a journaled observation, not a crash", async () => {
    const { store, commands } = await harness()
    const { outcome, events } = await runChain({
      store,
      entries: commandEntries(commands),
      scripts: [
        // world.select without args fails with the command's own message.
        flow(`await ctx.call("world.select", {})`, `return done({})`),
        flow(`return done({ recovered: true })`)
      ]
    })
    expect(outcome._tag).toBe("Done")
    const rejections = events.filter((event) => event._tag === "GateRejected")
    expect(rejections.length).toBeGreaterThan(0)
    expect(JSON.stringify(rejections)).toContain("world.select needs the document id")
  })

  test("a call to a name outside the catalog is gate 3's rejection", async () => {
    const { store, commands } = await harness()
    const { outcome, events } = await runChain({
      store,
      entries: commandEntries(commands),
      scripts: [
        flow(`await ctx.call("theme", {})`, `return done({})`),
        flow(`return done({ recovered: true })`)
      ]
    })
    expect(outcome._tag).toBe("Done")
    expect(events.some((event) => event._tag === "GateRejected")).toBe(true)
  })

  test("a malformed payload is a typed CallError before any execution", async () => {
    const { commands } = await harness()
    const entry = commandEntries(commands).find((candidate) => candidate.name === "world.new-note")
    expect(entry).toBeDefined()
    const error = await Effect.runPromise(
      Effect.flip(entry!.handler({ args: 42 })) as Effect.Effect<Catalog.CallError, never, never>
    )
    expect(error._tag).toBe("/chain/CallError")
    expect(error.message).toContain("args must be a string")
  })
})
