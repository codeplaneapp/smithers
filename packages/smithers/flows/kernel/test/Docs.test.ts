import { globSync, mkdtempSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { defaultInclude } from "vitest/config"

const readDoc = (path: string): Promise<string> => readFile(new URL(`../docs/${path}`, import.meta.url), "utf8")

/**
 * Whether the runner this package installs would discover a file with this
 * name. The package declares no `test.include`, so Vitest's default governs,
 * and a filename passed on the command line only narrows what the default
 * already found.
 */
const discovers = (name: string): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "kernel-docs-"))
  writeFileSync(join(dir, name), "")
  return globSync([...defaultInclude], { cwd: dir }).includes(name)
}

describe("documentation contracts", () => {
  it("runs the same quickstart file it tells the reader to create", async () => {
    const quickstart = await readDoc("quickstart.md")
    const created = /Create `([^`]+)`/.exec(quickstart)?.[1]
    const executed = /pnpm vitest run (\S+)/.exec(quickstart)?.[1]
    expect(created).toBeDefined()
    expect(executed).toBe(created)
  })

  it("names a quickstart file the installed runner discovers", async () => {
    const created = /Create `([^`]+)`/.exec(await readDoc("quickstart.md"))?.[1]
    expect(created).toBeDefined()
    expect(discovers(created!)).toBe(true)
    expect(discovers("quickstart.ts")).toBe(false)
  })
})
