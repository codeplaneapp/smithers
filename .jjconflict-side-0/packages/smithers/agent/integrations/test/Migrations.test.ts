import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Core from "../src/core.ts"
import * as IntegrationCursors from "../src/core/migrations/0001_integration_cursors.ts"
import * as Migrations from "../src/core/migrations/index.ts"

// `scripts/build.mjs` converts every module to CommonJS with esbuild under
// `"type": "module"`, and esbuild reads a default import of a sibling as the
// whole interop wrapper `{ __esModule, default }` rather than the value.
// `core/migrations/index.ts` used to build its record from a default import,
// so `Migrations.set` in `dist/cjs` held a wrapper with no `pipe` and the
// migrator failed for every `require` consumer. Consumers reach the migration
// through the named binding, and the second test pins that the module offers
// no default export to regress onto.
describe("migration module exports", () => {
  it("exposes every migration in the set as an Effect", () => {
    const entries = Object.entries(Migrations.set.migrations)
    expect(entries.length).toBeGreaterThan(0)
    for (const [key, migration] of entries) {
      expect(Effect.isEffect(migration), key).toBe(true)
      expect(typeof migration.pipe, key).toBe("function")
    }
    expect(Core.Migrations.set).toBe(Migrations.set)
  })

  it("publishes the cursor table migration as a named binding with no default export", () => {
    expect("default" in IntegrationCursors).toBe(false)
    expect(Object.keys(IntegrationCursors)).toEqual(["integrationCursors"])
    expect(typeof IntegrationCursors.integrationCursors.pipe).toBe("function")
    expect(Migrations.set.migrations["0001_integration_cursors"]).toBe(IntegrationCursors.integrationCursors)
  })
})
