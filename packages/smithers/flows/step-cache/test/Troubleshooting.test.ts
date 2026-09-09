import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const troubleshooting = readFileSync(new URL("../docs/troubleshooting.md", import.meta.url), "utf8")
const recovery = troubleshooting.split("## decode_failed: a stored row\n")[1]!
  .split("\n## ")[0]!
  .replace(/\s+/g, " ")

describe("stored-row corruption recovery documentation", () => {
  it("does not recommend deleting the database as a disposable cache", () => {
    expect(recovery).not.toMatch(/faster to delete than to repair/i)
    expect(recovery).not.toMatch(/losing it costs recomputation rather than correctness/i)
    expect(recovery).toMatch(/only reusable head rows are disposable/i)
  })

  it("requires backup and preserves durable state with a ledger retention link", () => {
    expect(recovery).toMatch(/back up the shared database/i)
    expect(recovery).toMatch(/evict or repair only the affected.*head rows/i)
    expect(recovery).toContain("flows_step_cache_recorded")
    expect(recovery).toMatch(/preserve or restore/i)
    expect(recovery).toMatch(/journal and run store/i)
    expect(recovery).toContain("(#flows_step_cache_recorded-grows-and-nothing-reclaims-it)")
    expect(troubleshooting).toContain("## flows_step_cache_recorded grows and nothing reclaims it")
  })
})
