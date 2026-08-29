import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const productionComponents = async (): Promise<ReadonlyArray<{ readonly path: string; readonly source: string }>> => {
  const files: Array<{ readonly path: string; readonly source: string }> = []
  const glob = new Bun.Glob("**/*.tsx")
  for await (const path of glob.scan({ cwd: import.meta.dir, absolute: true })) {
    if (path.endsWith(".test.tsx")) continue
    files.push({ path, source: await readFile(path, "utf8") })
  }
  return files
}

describe("React architecture boundaries", () => {
  test("components do not acquire domain effects", async () => {
    const offenders = (await productionComponents())
      .filter(({ source }) =>
        /React\.useEffect\s*\(/.test(source) ||
        /import\s*\{[^}]*\buseEffect\b[^}]*\}\s*from\s*["']react["']/.test(source)
      )
      .map(({ path }) => path.slice(import.meta.dir.length + 1))
    expect(offenders).toEqual([])
  })

  test("components mutate through controllers, never the store dispatcher", async () => {
    const offenders = (await productionComponents())
      .filter(({ source }) => /\b(?:controller\.)?store\.dispatch\s*\(/.test(source))
      .map(({ path }) => path.slice(import.meta.dir.length + 1))
    expect(offenders).toEqual([])
  })

  test("components do not depend on the concrete AppStore module", async () => {
    const offenders = (await productionComponents())
      .filter(({ source }) => /from\s+["'][^"']*state\/AppStore["']/.test(source))
      .map(({ path }) => path.slice(import.meta.dir.length + 1))
    expect(offenders).toEqual([])
  })
})
