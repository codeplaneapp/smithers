import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it.each([
  "README.md",
  "concepts/key-derivation.md",
  "guides/derive-a-key-inside-a-schema.md"
])("docs/%s states the execution identity default and restart options", (path) => {
  const document = readFileSync(new URL(`../docs/${path}`, import.meta.url), "utf8").replace(/\s+/g, " ")

  expect(document).toMatch(/default[^.]*fresh UUID/)
  expect(document).toMatch(/retain and reuse[^.]*execution [Ii][Dd]/)
  expect(document).toContain("declare an idempotency key")
  expect(document).toContain("Flow.layerExecutionIds(Flow.derived)")
  expect(document).not.toMatch(/mints the default execution id[^.]*canonical/)
})
