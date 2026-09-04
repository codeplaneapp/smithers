import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Initial from "../src/migrations/0001_triggers.ts"
import * as ReservationLease from "../src/migrations/0002_reservation_lease.ts"
import * as Migrations from "../src/migrations/index.ts"

// The CommonJS build reads a default import of a sibling module as the whole
// exports object (`{ default }`), not the Effect, so the migrator received a
// record whose values had no `pipe`. The migration modules therefore export a
// named binding, and the record is imported the way `SqlTriggerStore` does.
describe("migrations", () => {
  it("exposes every migration as an Effect", () => {
    const entries = Object.entries(Migrations.migrations)
    expect(entries.map(([name]) => name)).toEqual(["0001_triggers", "0002_reservation_lease"])
    for (const [, migration] of entries) {
      expect(typeof migration.pipe).toBe("function")
      expect(Effect.isEffect(migration)).toBe(true)
    }
  })

  it("migration modules carry no default export", () => {
    expect("default" in Initial).toBe(false)
    expect("default" in ReservationLease).toBe(false)
    expect(Object.keys(Initial)).toEqual(["triggers"])
    expect(Object.keys(ReservationLease)).toEqual(["reservationLease"])
  })
})
