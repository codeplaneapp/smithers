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
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

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

describe("planning documentation", () => {
  it.each(["quickstart.md", "cli.md"])("%s makes no promise of zero subprocesses or host writes", (page) => {
    const text = Fs.readFileSync(NodePath.join(import.meta.dirname, "../docs", page), "utf8")
    expect(text).not.toMatch(/nothing spawns|spawns nothing|executes? nothing|nothing is\s+written outside the cache/i)
  })

  it("quickstart states the plan-time trust, tool and write requirements", () => {
    const text = Fs.readFileSync(NodePath.join(import.meta.dirname, "../docs/quickstart.md"), "utf8")
    expect(text).toMatch(/skips target bodies/i)
    expect(text).toMatch(/evaluates trusted declarations/i)
    expect(text).toMatch(/reads the workspace/i)
    expect(text).toMatch(/bounded tool probes/i)
    expect(text).toMatch(/version and identity lookups/i)
    expect(text).toMatch(/resolve or build\s+declared environments/i)
    expect(text).toContain("Nix store")
    expect(text).toMatch(/tools.*PATH/)
  })
})

/**
 * The doc comments on `PackageLoader`'s two workspace entry points, checked
 * against what each one does. The forgiving probe and the strict loader sat
 * under one comment, so the exported loader advertised an undefined fallback
 * and a memo that only the probe below it has.
 */
describe("workspace loader documentation", () => {
  const loader = Fs.readFileSync(NodePath.join(import.meta.dirname, "../src/PackageLoader.ts"), "utf8")

  /** The doc comment immediately above an exported binding, markers stripped. */
  const docFor = (name: string): string => {
    const declaration = loader.indexOf(`export const ${name} =`)
    expect(declaration, `PackageLoader no longer exports ${name}`).toBeGreaterThan(0)
    const open = loader.lastIndexOf("/**", declaration)
    const close = loader.indexOf("*/", open)
    expect(close, `${name} carries no doc comment`).toBeLessThan(declaration)
    return loader.slice(open + 3, close).replace(/^\s*\*\s?/gm, "").replace(/\s+/g, " ")
  }

  it("documents loadWorkspaceDeclaration as the rejecting, unmemoized loader", () => {
    const text = docFor("loadWorkspaceDeclaration")
    expect(text).toContain("returns the validated declaration")
    expect(text).toContain("module_import_failed")
    expect(text).toMatch(/keeps no memo of its own/)
    expect(text).not.toMatch(/any failure returns undefined/)
    expect(text).not.toMatch(/memo below/)
  })

  it("documents probeCacheDirectory as the forgiving, memoized probe", () => {
    const text = docFor("probeCacheDirectory")
    expect(text).toMatch(/any failure returns undefined/)
    expect(text).toMatch(/memo below/)
  })

  it("pins the behaviour each comment now claims", async () => {
    const directory = Fs.mkdtempSync(NodePath.join(Os.tmpdir(), "build-cli-loader-docs-"))
    Fs.writeFileSync(NodePath.join(directory, "WORKSPACE.ts"), "throw new Error(\"workspace refuses\")\n")
    await expect(PackageLoader.loadWorkspaceDeclaration(directory, "WORKSPACE.ts")).rejects.toMatchObject({
      code: "module_import_failed",
      path: "WORKSPACE.ts"
    })
    await expect(PackageLoader.probeCacheDirectory(directory, "WORKSPACE.ts")).resolves.toBeUndefined()
  })
})

/**
 * The discovery guide's loading model. It promised that a label loaded only
 * the modules it named, but every declaration is evaluated and validated
 * before the pattern selects anything out of the finished index.
 */
describe("discovery guide loading model", () => {
  const page = Fs.readFileSync(NodePath.join(import.meta.dirname, "../docs/concepts/discovery.md"), "utf8")
    .replace(/\s+/g, " ")

  it("does not promise selective declaration loading", () => {
    expect(page).not.toMatch(/exact label loads the one declaration module/i)
    expect(page).not.toMatch(/pattern loads the modules of the selected subtree/i)
  })

  it("describes whole-workspace evaluation followed by label selection", () => {
    expect(page).toMatch(/pattern never narrows what is loaded/i)
    expect(page).toMatch(/Every admitted `PACKAGE\.ts` is evaluated and validated first/)
    expect(page).toMatch(/index is built from the whole graph/)
    expect(page).toMatch(/refuses the command even when the pattern names one target in an unrelated package/)
  })
})
