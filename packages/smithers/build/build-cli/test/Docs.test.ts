/**
 * The colocated command reference's drift gate.
 *
 * `docs/cli.md` is the authoritative inventory of the CLI's commands and
 * flags, but the package's `docs` target checks only that a README exists, so
 * nothing failed when `--sweep` shipped without a sentence. Every assertion
 * here reads the claim out of the CLI incur actually serves — the registered
 * command map and each command's option schema — so adding a command or a
 * flag moves this gate instead of a reviewer's memory of it.
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
