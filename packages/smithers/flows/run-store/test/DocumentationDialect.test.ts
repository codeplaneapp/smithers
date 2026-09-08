import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it.each(["guides/compose-the-stores.md", "installation.md"])(
  "%s states the SQLite and serialized-writer requirements",
  (page) => {
    const text = readFileSync(new URL(`../docs/${page}`, import.meta.url), "utf8").replace(/\s+/g, " ")

    expect(text).not.toContain("anything that provides `SqlClient` works")
    expect(text).toMatch(/`SqlClient` must execute this package's SQLite migration and statement dialect/)
    expect(text).toContain("triggers, `randomblob`, `typeof`, and `json_valid`")
    expect(text).toContain("`DurableWriter` serialization contract")
    expect(text).toContain("@effect/sql-sqlite-node")
    expect(text).toMatch(
      /Other databases require a dialect-specific migration and statement implementation, which does not exist yet/
    )
  }
)
