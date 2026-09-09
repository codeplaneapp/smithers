/**
 * The generated half of the catalog.
 *
 * `src/internal/FacadeExports.ts` is committed so the package builds without a 0.x
 * checkout beside it. That makes it a file that can rot. The first case pins the
 * surface the scanner reads out of the committed copy. The second drives
 * `scripts/generate-facade-exports.mjs` end to end over a fixture 0.x tree, so
 * the script stays runnable with the dependencies this package declares even
 * though the 0.x checkout it was originally generated from is gone.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { componentProps, facadeExports } from "../src/internal/FacadeExports.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const catalogFile = join(packageRoot, "src/internal/FacadeExports.ts")

/** Writes one fixture file, creating the directories above it. */
const write = (root: string, path: string, content: string) => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/**
 * A 0.x checkout in miniature.
 *
 * It carries every shape the generator has to walk: a facade manifest with a
 * root entry and a subpath, a barrel that re-exports a workspace package and
 * declares values of its own, and the `<Name>Props.ts` files the component rows
 * come from, one of them an alias into a sibling file.
 */
const fixtureCheckout = () => {
  const root = mkdtempSync(join(tmpdir(), "migrate-facade-"))
  write(
    root,
    "packages/smithers/package.json",
    JSON.stringify({
      name: "smthrs",
      version: "0.35.0",
      exports: { "./package.json": "./package.json", ".": "./src/index.js", "./testing": "./src/testing.js" }
    })
  )
  write(
    root,
    "packages/smithers/src/index.js",
    `export * from "@smthrs/widgets"
export { renderTask } from "./internal/task.js"
export const facadeConstant = 1
export function facadeFunction() {}
`
  )
  write(root, "packages/smithers/src/testing.js", `export * from "@smthrs/testing"\n`)
  write(
    root,
    "packages/widgets/package.json",
    JSON.stringify({ name: "@smthrs/widgets", exports: { ".": "./src/index.js" } })
  )
  write(root, "packages/widgets/src/index.js", `export const widgetHelper = () => {}\n`)
  write(
    root,
    "packages/testing/package.json",
    JSON.stringify({ name: "@smthrs/testing", exports: { ".": "./src/index.js" } })
  )
  write(root, "packages/testing/src/index.js", `export const virtualClock = () => {}\n`)
  write(
    root,
    "packages/components/src/components/Task/TaskProps.ts",
    `export interface TaskProps {
  readonly hijack?: boolean
  readonly prompt: string
}
`
  )
  write(
    root,
    "packages/components/src/components/Loop/LoopProps.ts",
    `export interface LoopProps {
  readonly maxIterations?: number
  readonly onMaxReached?: () => void
}
`
  )
  write(
    root,
    "packages/components/src/components/Ralph/RalphProps.ts",
    `import type { LoopProps } from "../Loop/LoopProps"

export type RalphProps = LoopProps
`
  )
  return root
}

describe("the generated catalog", () => {
  it("carries the whole old root entry point and the component props", () => {
    // These hold whether or not the old checkout is on this machine, because
    // the generated file is committed.
    expect(facadeExports.filter((row) => row.subpath === "").length).toBeGreaterThan(300)
    expect(facadeExports.some((row) => row.name === "approvalDecisionSchema" && row.subpath === "")).toBe(true)
    expect(facadeExports.some((row) => row.subpath === "gateway-react")).toBe(true)
    expect(componentProps["Task"]).toContain("hijack")
    expect(componentProps["Parallel"]).toContain("maxConcurrency")
    // `RalphProps` is `export type RalphProps = LoopProps`, so the generator
    // has to follow the alias into the sibling file to get these.
    expect(componentProps["Ralph"]).toContain("onMaxReached")
  })

  it("regenerates from a 0.x export graph with the dependencies this package declares", () => {
    const checkout = fixtureCheckout()
    const generated = join(checkout, "FacadeExports.ts")
    const committed = readFileSync(catalogFile, "utf8")
    try {
      execFileSync(
        process.execPath,
        [join(packageRoot, "scripts/generate-facade-exports.mjs"), checkout, "--out", generated],
        { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      )

      const catalog = readFileSync(generated, "utf8")
      // The root barrel's own declarations, the workspace package it re-exports
      // through, and the module a named re-export names.
      expect(catalog).toContain(`{ name: "facadeConstant", subpath: "", module: "smthrs" }`)
      expect(catalog).toContain(`{ name: "facadeFunction", subpath: "", module: "smthrs" }`)
      expect(catalog).toContain(`{ name: "widgetHelper", subpath: "", module: "@smthrs/widgets" }`)
      expect(catalog).toContain(`{ name: "renderTask", subpath: "", module: "./internal/task.js" }`)
      // A subpath barrel that is one `export * from` a workspace package.
      expect(catalog).toContain(`{ name: "virtualClock", subpath: "testing", module: "@smthrs/testing" }`)
      // Props, including the alias the generator has to follow into a sibling.
      expect(catalog).toContain(`"Task": ["hijack", "prompt"]`)
      expect(catalog).toContain(`"Ralph": ["maxIterations", "onMaxReached"]`)
      // The emitted `@since` is the one the committed catalog carries, so a
      // regeneration never rewrites the tag on every symbol in the file.
      expect(catalog).toContain(" * @since 1.0.0-rc.0")
      // `--out` wrote beside the fixture, not over the committed catalog.
      expect(readFileSync(catalogFile, "utf8")).toBe(committed)
    } finally {
      rmSync(checkout, { recursive: true, force: true })
    }
  })
})
