import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

interface Declaration {
  readonly kind: "file" | "glob"
  readonly pattern: string
}

const infraRoot = fileURLToPath(new URL("../../", import.meta.url).href)
const packagePrefix = "//packages/build/infra/"

const filesUnder = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await Fs.readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = NodePath.join(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : Promise.resolve([path])
    })
  )
  return paths.flat()
}

const arrayBody = (source: string, pattern: RegExp, name: string): string => {
  const match = pattern.exec(source)
  if (match?.[1] === undefined) throw new Error(`PACKAGE.ts does not expose a readable ${name} array`)
  return match[1]
}

const declarationsIn = (source: string): ReadonlyArray<Declaration> =>
  Array.from(source.matchAll(/Smithers\.(glob|file)\("([^"]+)"\)/g), (match) => ({
    kind: match[1] as Declaration["kind"],
    pattern: match[2] ?? ""
  }))

const relativePattern = (pattern: string): string | null => {
  if (pattern.startsWith(packagePrefix)) return pattern.slice(packagePrefix.length)
  if (pattern.startsWith("//")) return null
  return pattern
}

const globExpression = (glob: string): RegExp => {
  let expression = "^"
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]
    if (character === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        expression += "(?:.*/)?"
        index += 2
      } else {
        expression += ".*"
        index += 1
      }
    } else if (character === "*") {
      expression += "[^/]*"
    } else {
      expression += character !== undefined && "\\^$+?.()|{}[]".includes(character)
        ? `\\${character}`
        : character
    }
  }
  return new RegExp(`${expression}$`)
}

const covers = (declaration: Declaration, path: string): boolean => {
  const pattern = relativePattern(declaration.pattern)
  if (pattern === null) return false
  return declaration.kind === "file" ? pattern === path : globExpression(pattern).test(path)
}

const relative = (path: string): string => NodePath.relative(infraRoot, path).split(NodePath.sep).join("/")

describe("build target inputs", () => {
  it("covers every migration, suite test, and gate configuration", async () => {
    // Importing PACKAGE.ts executes the repository target graph. This text-level
    // check stands in for unavailable target-key inspection by matching every
    // concrete input against the declarations that contribute to the key.
    const build = await Fs.readFile(fileURLToPath(new URL("../../PACKAGE.ts", import.meta.url).href), "utf8")
    const sourceDeclarations = declarationsIn(
      arrayBody(build, /const sources = \[([\s\S]*?)\n\]/, "sources")
    )
    const testDeclarations = declarationsIn(
      arrayBody(build, /tests:\s*\[([\s\S]*?)\n\s*\]/, "tests")
    )
    const migrations = (await filesUnder(NodePath.join(infraRoot, "worker", "migrations")))
      .filter((path) => path.endsWith(".sql"))
      .map(relative)
    const tests = (
      await Promise.all([
        filesUnder(NodePath.join(infraRoot, "worker", "test")),
        filesUnder(NodePath.join(infraRoot, "scripts"))
      ])
    ).flat().filter((path) => path.endsWith(".test.ts")).map(relative)

    for (const path of migrations) {
      expect(sourceDeclarations.some((declaration) => covers(declaration, path)), `${path} is not a source input`)
        .toBe(true)
    }
    for (const path of tests) {
      expect(testDeclarations.some((declaration) => covers(declaration, path)), `${path} is not a test input`)
        .toBe(true)
    }
    for (const path of ["PACKAGE.ts", "vitest.config.ts"]) {
      expect(sourceDeclarations.some((declaration) => covers(declaration, path)), `${path} is not a source input`)
        .toBe(true)
    }
  })
})
