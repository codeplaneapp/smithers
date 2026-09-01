import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as TriggerStore from "../src/TriggerStore.ts"

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
) as {
  readonly private: boolean
  readonly exports: Record<string, unknown>
  readonly publishConfig: { readonly exports: Record<string, unknown> }
}

const declaration = {
  id: "daily",
  flowId: "flow",
  input: {},
  cron: "0 0 * * *",
  overlap: "skip" as const,
  catchUp: "none" as const,
  maxCatchUp: 0,
  enabled: true
}

const call = (store: TriggerStore.Service, method: keyof TriggerStore.Service) => {
  switch (method) {
    case "register":
      return store.register(declaration)
    case "get":
      return store.get("daily")
    case "list":
      return store.list()
    case "listEnabled":
      return store.listEnabled()
    case "claimFire":
      return store.claimFire({ triggerId: "daily", occurrence: 1, expectedRevision: 1 })
    case "recordResult":
      return store.recordResult({ triggerId: "daily", occurrence: 1, outcome: "completed" })
    case "setPending":
      return store.setPending({ triggerId: "daily", occurrence: 1 })
    case "takePending":
      return store.takePending("daily")
    case "activeRun":
      return store.activeRun("daily")
    case "clearActive":
      return store.clearActive("daily", "run-1")
  }
}

const methods: ReadonlyArray<keyof TriggerStore.Service> = [
  "register",
  "get",
  "list",
  "listEnabled",
  "claimFire",
  "recordResult",
  "setPending",
  "takePending",
  "activeRun",
  "clearActive"
]

describe("TriggerStore.makeNoop", () => {
  it("fails every method as an unavailable store", async () => {
    const store = TriggerStore.makeNoop()
    for (const method of methods) {
      const error = await Effect.runPromise(Effect.flip(call(store, method)))
      expect(error.code).toBe("store")
      expect(error.message).toBe(`${method} is unavailable`)
    }
  })

  it("replaces exactly the overridden method", async () => {
    const store = TriggerStore.makeNoop({ get: () => Effect.succeed(Option.none()) })
    expect(await Effect.runPromise(store.get("daily"))).toMatchObject({ _tag: "None" })
    for (const method of methods.filter((name) => name !== "get")) {
      const error = await Effect.runPromise(Effect.flip(call(store, method)))
      expect(error.message).toBe(`${method} is unavailable`)
    }
  })

  it("provides the unavailable store as a layer", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        return yield* Effect.flip(store.list())
      }).pipe(Effect.provide(TriggerStore.layerNoop()))
    )
    expect(error.message).toBe("list is unavailable")

    const overridden = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        return yield* store.list()
      }).pipe(Effect.provide(TriggerStore.layerNoop({ list: () => Effect.succeed([]) })))
    )
    expect(overridden).toEqual([])
  })
})

describe("TriggerStore reservation ids", () => {
  // The reservation id is a cross-process wire contract: the SQL store writes
  // it and both stores and the scheduler read it back with `isReservation`.
  // Freezing the exact string is what keeps one incarnation from failing to
  // recognize the reservation another one wrote.
  it("freezes the reservation id shape", () => {
    expect(TriggerStore.reservationPrefix).toBe("trigger-reservation:")
    expect(TriggerStore.reservationId("hourly", 3_600_000)).toBe(
      "trigger-reservation:hourly:3600000"
    )
    expect(TriggerStore.isReservation(TriggerStore.reservationId("hourly", 0))).toBe(true)
    expect(TriggerStore.isReservation("run-1")).toBe(false)
    expect(TriggerStore.isReservation(undefined)).toBe(false)
  })
})

describe("package boundaries", () => {
  // A database built from 0001 alone has no `active_claimed_at_ms`, which every
  // claim and active-run query reads, so the individual migration files are not
  // a supported entry point. `SqlTriggerStore.layer` applies both in order.
  it("keeps every migration subpath out of the export map", () => {
    const exports = manifest.exports as Record<string, unknown>
    const published = manifest.publishConfig.exports as Record<string, unknown>
    for (const map of [exports, published]) {
      expect(map["./migrations/*"]).toBeNull()
      expect(map["./*/index"]).toBeNull()
      expect(map["./internal/*"]).toBeNull()
      expect(map["./package.json"]).toBe("./package.json")
    }
    expect(exports["./*"]).toBe("./src/*.ts")
  })

  it("stays private at 1.0.0-rc.0", () => {
    expect(manifest.private).toBe(true)
  })
})
