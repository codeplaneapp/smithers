/**
 * The migration modules export named bindings and no default export.
 *
 * The CommonJS build converts each source file with esbuild in Node interop
 * mode. There a default import of a sibling module resolves to that module's
 * whole exports object (`{ __esModule, default }`) instead of the Effect, so
 * `set.migrations["0001_initial"].pipe` was undefined under `require` while
 * the ESM build kept working. A named export has one shape in both formats,
 * and the second case here fails as soon as a default export comes back.
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import * as Initial from "../src/migrations/0001_initial.ts"
import * as SelectionStore from "../src/migrations/0002_selection_store.ts"

describe("migration modules", () => {
  it("registers an Effect for every migration in the set", () => {
    const entries = Object.entries(Migrations.set.migrations)
    expect(entries.map(([id]) => id)).toEqual(["0001_initial", "0002_selection_store"])
    for (const [id, migration] of entries) {
      expect(Effect.isEffect(migration), id).toBe(true)
      expect(typeof migration.pipe, id).toBe("function")
    }
    expect(Migrations.set.migrations["0001_initial"]).toBe(Initial.initial)
    expect(Migrations.set.migrations["0002_selection_store"]).toBe(SelectionStore.selectionStore)
  })

  it("exports each migration as a named binding and no default", () => {
    expect("default" in Initial).toBe(false)
    expect("default" in SelectionStore).toBe(false)
    expect(Object.keys(Initial)).toEqual(["initial"])
    expect(Object.keys(SelectionStore)).toEqual(["selectionStore"])
    expect(typeof Initial.initial.pipe).toBe("function")
    expect(typeof SelectionStore.selectionStore.pipe).toBe("function")
  })
})
