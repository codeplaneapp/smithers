import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ")

it.each(["../README.md", "../docs/api.md", "../CHANGELOG.md"])(
  "%s documents the shipped CLI and unified MCP access",
  (path) => {
    const text = read(path)
    expect(text).toContain("`smthrs runs inspect|replay|fork|rewind`")
    expect(text).toContain("https://smithers.sh/docs/reference/cli/")
    expect(text).toMatch(/MCP[^.]*only through the unified command tools/)
    expect(text).not.toMatch(/no (?:time-travel|CLI) verb|only a library API|`smithers` command-line/)
  }
)

it("documents the current documentation sync pipeline", () => {
  const text = read("../CHANGELOG.md")
  expect(text).not.toMatch(/docs\/Manifest\.ts|scripts\/docs\.mjs|docs\/pages\//)
  expect(text).toContain("contentSync")
  expect(text).toContain("apps/site/scripts/sync-api-docs.mjs")
})
