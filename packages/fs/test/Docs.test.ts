import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Manifest } from "../docs/Manifest.ts"
import * as fs from "../src/index.ts"

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (...parts: ReadonlyArray<string>): string => readFileSync(join(packageRoot, ...parts), "utf8")

describe("package documentation", () => {
  it("describes every root namespace from the package manifest", () => {
    expect(Object.keys(fs)).toEqual(Manifest.modules.map((module) => module.namespace))
    const api = read("docs", "api.md")
    for (const module of Manifest.modules) expect(api).toContain(`\`${module.namespace}\``)
  })

  it("keeps generated documentation current", () => {
    const checked = spawnSync(process.execPath, [join(packageRoot, "scripts", "docs.mjs"), "--check"], {
      encoding: "utf8"
    })
    expect(`${checked.stdout}${checked.stderr}`.trim()).toContain("current")
    expect(checked.status).toBe(0)
  })

  it("keeps the README linked to every package-owned contract", () => {
    const readme = read("README.md")
    expect(readme).toContain("private at 1.0.0-rc.0")
    for (const fragment of Manifest.fragments) {
      const relative = fragment.replace("packages/fs/", "./")
      expect(readme).toContain(relative)
      expect(readFileSync(join(packageRoot, relative), "utf8").length).toBeGreaterThan(0)
    }
  })
})
