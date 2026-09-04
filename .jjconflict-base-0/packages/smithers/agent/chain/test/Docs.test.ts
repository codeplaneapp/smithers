import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"
import * as Authorize from "../src/Authorize.ts"
import * as Chain from "../src/Chain.ts"
import * as chain from "../src/index.ts"
import * as Journal from "../src/Journal.ts"
import * as Prompt from "../src/Prompt.ts"
import * as QuickJsRunner from "../src/QuickJsRunner.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import * as Steering from "../src/Steering.ts"
import * as SubChains from "../src/SubChains.ts"

// The package owns its own prose (see docs/README.md). Nothing generates
// these files, so this is the gate that keeps them honest: a namespace added
// to the barrel, a default changed in the source, or a new dangling citation
// has to be answered in the same commit.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (...parts: ReadonlyArray<string>): string => readFileSync(join(packageRoot, ...parts), "utf8")

const api = read("docs", "api.md")
const contract = read("docs", "contract.md")
const readme = read("README.md")

describe("package documentation", () => {
  // dprint pads markdown table cells, so rows are read cell by cell rather
  // than matched as raw text.
  const cells = (document: string): ReadonlyArray<ReadonlyArray<string>> =>
    document.split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))

  const defaultOf = (label: string): string => {
    const found = cells(contract).find((row) => row[0] === label)
    if (found?.[1] === undefined) throw new Error(`docs/contract.md has no limits row for ${label}`)
    return found[1]
  }

  it("describes every namespace the barrel exports", () => {
    const described = new Set(cells(api).map((row) => row[0]))
    const missing = Object.keys(chain).filter((name) => !described.has(`\`${name}\``))
    expect(missing).toEqual([])
  })

  it("states the resource limits the source actually carries", () => {
    const memoryBytes = QuickJsRunner.defaultLimits.memoryBytes ?? 0
    expect(defaultOf("QuickJS realm memory")).toBe(
      `${memoryBytes / 1024 / 1024} MiB, floored at ${QuickJsRunner.memoryFloor / 1024} KiB`
    )
    const stackBytes = QuickJsRunner.defaultLimits.stackBytes ?? 0
    expect(defaultOf("QuickJS in-realm stack")).toBe(
      `${stackBytes / 1024} KiB, capped at ${QuickJsRunner.stackCeiling / 1024} KiB`
    )
    expect(defaultOf("QuickJS interrupt polls")).toBe(String(QuickJsRunner.defaultLimits.steps))
    expect(defaultOf("JSON boundary depth")).toBe(String(ScriptRunner.maxJsonDepth))
    expect(defaultOf("JSON boundary size budget")).toBe(
      `${ScriptRunner.maxJsonSize / 1024 / 1024} MiB in nodes plus string code units`
    )
    expect(defaultOf("Catalog entry name in the prompt")).toBe(`${Prompt.maxEntryName} characters`)
    expect(defaultOf("Catalog entry description in the prompt")).toBe(
      `${Prompt.maxEntryDescription} characters`
    )
    expect(defaultOf("Links per chain")).toBe(String(Chain.defaultMaxLinks))
    expect(defaultOf("Calls per link")).toBe(String(Chain.defaultMaxCallsPerLink))
    expect(defaultOf("Sub-chain nesting depth")).toBe(String(SubChains.defaultMaxDepth))
    // The README repeats the headline numbers; keep it from drifting too.
    expect(readme).toContain(
      `${Chain.defaultMaxLinks} links per chain, ${Chain.defaultMaxCallsPerLink} calls per link`
    )
    expect(readme).toContain(`${stackBytes / 1024} KiB stack`)
  })

  // Read out of the schemas, not transcribed: a code added to or removed
  // from any of these unions changes what the contract has to name.
  // `Schema.Literals` carries `literals`, `Schema.Literal` carries `literal`,
  // and either wrapped in `withConstructorDefault` carries the wrapped schema
  // under `schema`. An unreadable field throws rather than silently
  // contributing nothing, which would turn this gate into a no-op.
  const codesOf = (name: string, error: unknown): ReadonlyArray<string> => {
    type Union = {
      readonly literal?: string
      readonly literals?: ReadonlyArray<string>
      readonly schema?: Union
    }
    const code = (error as { readonly fields: { readonly code: Union } }).fields.code
    const read = (union: Union | undefined): ReadonlyArray<string> | undefined =>
      union === undefined
        ? undefined
        : union.literals ?? (union.literal === undefined ? read(union.schema) : [union.literal])
    const literals = read(code)
    if (literals === undefined || literals.length === 0) {
      throw new Error(`${name} no longer exposes its code literals; the docs gate cannot read them`)
    }
    return literals
  }

  it("names every stable error code the contract promises", () => {
    const codes = [
      ...codesOf("ChainError", Chain.ChainError),
      ...codesOf("JournalError", Journal.JournalError),
      ...codesOf("AuthorError", Author.AuthorError),
      ...codesOf("AuthorizeError", Authorize.AuthorizeError),
      ...codesOf("SteeringError", Steering.SteeringError),
      ...codesOf("ScriptFailure", ScriptRunner.ScriptFailure)
    ]
    const unnamed = codes.filter((code) => !contract.includes(`\`${code}\``))
    expect(unnamed).toEqual([])
  })

  it("keeps the README pointing at the package-owned prose", () => {
    expect(readme).toContain("./docs/api.md")
    expect(readme).toContain("./docs/contract.md")
    expect(readme).toContain("./docs/exports.md")
    expect(readme).toContain("./docs/README.md")
  })

  it("leaves no source file citing a document this repository does not carry", () => {
    // Every module used to name a `docs/specs/Concepts/*.md` file as its
    // governing contract. That directory never came across with the package,
    // so the package's stated authority resolved to nothing for any reader.
    const sources = readdirSync(join(packageRoot, "src")).filter((name) => name.endsWith(".ts"))
    const dangling = sources.filter((name) => read("src", name).includes("docs/specs/"))
    expect(dangling).toEqual([])
  })
})
