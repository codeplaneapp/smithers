/**
 * The colocated command reference's drift gate.
 *
 * `docs/cli.md` is the authoritative inventory of the CLI's commands and
 * flags, but the package's `docs` target checks only that a README exists, so
 * nothing failed when `--sweep` shipped without a sentence. Inventory assertions
 * read the CLI incur actually serves: its registered command map and option
 * schemas. The remaining contracts pin writer side effects, CI merge rules,
 * and links from the other pages to this single inventory.
 */
import { Cli as Incur } from "incur"
import * as Fs from "node:fs"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

const doc = Fs.readFileSync(NodePath.join(import.meta.dirname, "../docs/cli.md"), "utf8")

/** The two schema slots this contract reads off a registered command. */
type Registered = {
  readonly args?: { readonly shape?: Record<string, unknown> } | undefined
  readonly options?: { readonly shape?: Record<string, unknown> } | undefined
}

/** The live command registry, read from the CLI instance incur builds. */
const commandMap = (): ReadonlyMap<string, Registered> => {
  // `toCommands` is incur's internal instance-to-registry map; the structural
  // cast narrows its entry union to the schema slots the assertions read.
  const map = Incur.toCommands.get(makeCli({}) as never) as unknown as ReadonlyMap<string, Registered> | undefined
  expect(map, "incur no longer exposes the command registry").toBeDefined()
  return map as ReadonlyMap<string, Registered>
}

const numberWords = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty"
]

const kebab = (key: string): string => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

describe("docs/cli.md", () => {
  it("names every command the CLI registers, and counts them", () => {
    const commands = commandMap()
    expect(commands.size).toBeGreaterThanOrEqual(10)
    for (const name of commands.keys()) {
      expect(doc, `docs/cli.md never names the ${name} command`).toContain(name)
    }
    const written = doc.match(/registers (\w+) commands/)
    expect(written, "docs/cli.md no longer states how many commands makeCli registers").not.toBeNull()
    expect(
      /^\d+$/.test(written![1]!) ? Number(written![1]) : numberWords.indexOf(written![1]!),
      `docs/cli.md counts ${written![1]} commands, the CLI registers ${commands.size}`
    )
      .toBe(commands.size)
  })

  it("names every flag every command takes", () => {
    for (const [name, entry] of commandMap()) {
      for (const key of Object.keys(entry.options?.shape ?? {})) {
        expect(doc, `docs/cli.md never names ${name}'s --${kebab(key)} flag`).toContain(`--${kebab(key)}`)
      }
    }
  })
})

describe("command documentation contracts", () => {
  const read = (path: string): string => Fs.readFileSync(NodePath.join(import.meta.dirname, "..", path), "utf8")

  it.each([
    ["README.md", "./docs/cli.md"],
    ["docs/README.md", "./cli.md"],
    ["docs/api.md", "./cli.md"],
    ["docs/concepts/invocation.md", "../cli.md"]
  ])("%s delegates the command inventory to cli.md", (path, reference) => {
    const page = read(path)
    expect(page).toContain(`](${reference})`)
    expect(page).not.toMatch(/\| Verb\s*\|/)
  })

  const pages = [
    "README.md",
    ...Fs.readdirSync(NodePath.join(import.meta.dirname, "../docs"), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".md"))
      .map((path) => `docs/${path}`)
  ]

  it.each(pages)("%s has no stale command count or alternate command spelling", (path) => {
    const page = read(path)
    for (
      const match of page.matchAll(
        /(?:registers|with(?: all)?|CLI:|command line:|supports|has)\s+(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?)\s+(?:commands|verbs)\b/g
      )
    ) {
      const token = match[1]!
      const count = /^\d+$/.test(token) ? Number(token) : token.startsWith("twenty")
        ? 20 + (numberWords.indexOf(token.slice(7)) > 0 ? numberWords.indexOf(token.slice(7)) : 0)
        : numberWords.indexOf(token)
      expect(count, `${path} counts ${token} commands`).toBe(commandMap().size)
    }
    expect(page.match(/`gitHooks`/g) ?? []).toHaveLength(path === "docs/cli.md" ? 1 : 0)
    expect(page).not.toContain("smithers-build gitHooks")
  })

  it("documents the docs command's own stamp flag", () => {
    const row = doc.split("\n").find((line) => /^\| `docs`\s*\|/.test(line))
    expect(row).toContain("`--write`")
  })

  it.each(["docs/cli.md", "docs/guides/select-targets.md"])(
    "%s distinguishes page writers from freshness checks",
    (path) => {
      const page = read(path).replace(/\s+/g, " ")
      expect(page).toMatch(/Docs\.Page.*model CLI.*credentials/)
      expect(page).toMatch(/without `--write`/)
      expect(page).toMatch(/Docs\.Check.*freshness/)
      expect(page).toMatch(/`docs --write`.*stamp/)
      expect(page).toMatch(/`ci`.*excludes.*Docs\.Page/)
    }
  )

  it.each(["docs/cli.md", "src/Cli.ts"])("%s states the CI merge contract", (path) => {
    const page = read(path).replace(/\s*\*?\s+/g, " ")
    expect(page).not.toMatch(/first occurrence.*wins/)
    expect(page).toMatch(/same label and.*keyPreview.*deduplicat/)
    expect(page).toMatch(/lint.*regardless of.*order/)
    expect(page).toMatch(/conflicting non-lint.*reject/)
  })
})
