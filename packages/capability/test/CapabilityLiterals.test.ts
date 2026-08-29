import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as Capability from "../src/Capability.ts"

/**
 * HARDEN-2: every capability literal the repository stages is validated by the
 * real parser and matcher.
 *
 * A capability literal is a security-relevant string that nothing type-checks.
 * It is written into a prompt, a skill, a plugin manifest, an example, a
 * documentation snippet, or a host's own grant rules, and it is read back by
 * `parse` and `matches` at run time. A literal that is misspelled, renamed on
 * one side only, or padded with a stray space neither fails to compile nor
 * fails to load. It simply grants nothing, and the first sign of it is a
 * permission refusal in a run that should have been allowed.
 *
 * That has happened three times here: a `jj:snapshot` grant whose resource
 * still named the pre-rename message, an MCP authority vocabulary the
 * permission boundary rejected, and a `proc:spawn` grant written `" *"`, whose
 * leading space put every real command outside it.
 *
 * This suite reads the staged literals out of the tree and asserts the one
 * thing every grant must do: permit at least one concrete request. It cannot
 * know which request a given grant is meant to allow, so it does not guess. It
 * fails a literal the parser rejects, and a literal that parses but permits
 * nothing.
 *
 * What it therefore does not catch, stated so nobody reads more into a green
 * run: a rename whose new resource still grants something, just not the thing
 * the caller asks for. `jj:snapshot:flows action *` grants `flows action x` and
 * passes here; only a test that knows the message the engine writes can catch
 * that one, and `packages/engine-store` owns that message.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

/**
 * Where a capability literal is staged rather than constructed by a test.
 *
 * Test sources are out of scope on purpose: a test that pins a refusal has to
 * be free to write a literal that grants nothing, which is exactly what this
 * suite fails everywhere else.
 */
const roots = [
  "skills",
  "claude-plugin",
  "codex-plugin",
  "examples/src",
  "docs",
  ".smithers",
  "prompts",
  "packages/flows/src",
  "packages/std/src",
  "packages/kernel/src",
  "packages/agent/src",
  "packages/migrate/src"
]

const readable = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".js",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".toml",
  ".yaml",
  ".yml"
])

const filesUnder = (directory: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".git")) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (readable.has(path.slice(path.lastIndexOf(".")))) found.push(path)
    }
  }
  walk(directory)
  return found
}

const stagedFiles = roots
  .map((entry) => join(root, entry))
  .filter((path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  })
  .flatMap(filesUnder)

/** A literal written whole, inside quotes or a code span: `fs:read:/tmp/x`. */
const whole = /["'`]((?:fs|net|model|proc|jj|\*):(?:[a-z-]+|\*):[^"'`\n]*)["'`]/g

/** A literal split across an `action`/`resource` pair, as a pattern is built. */
const split = /action:\s*["']([^"']+)["']\s*,\s*resource:\s*["']([^"']*)["']/g

interface Literal {
  readonly file: string
  readonly line: number
  readonly text: string
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length

const literals: ReadonlyArray<Literal> = stagedFiles.flatMap((path) => {
  const source = readFileSync(path, "utf8")
  const file = relative(root, path)
  const found: Array<Literal> = []
  for (const match of source.matchAll(whole)) {
    found.push({ file, line: lineOf(source, match.index), text: match[1]! })
  }
  for (const match of source.matchAll(split)) {
    found.push({ file, line: lineOf(source, match.index), text: `${match[1]!}:${match[2]!}` })
  }
  return found
})

/**
 * The narrowest request a grant is written to permit, with every wildcard
 * standing for one segment.
 *
 * Trimmed, because every resource a host asks about is trimmed: a path, a
 * command line, a URL, a change id. A grant that permits only a resource with
 * leading or trailing whitespace permits nothing that will ever be requested,
 * which is how `"proc:spawn: *"` passed review.
 */
const witnessOf = (resource: string): string =>
  resource
    .replaceAll("**", "x")
    .replaceAll("*", "x")
    .replaceAll("?", "x")
    .trim()

/** One concrete action each wildcard action selector stands for. */
const witnessActions: Readonly<Record<string, Capability.Action>> = {
  "*": "fs:read",
  "fs:*": "fs:read",
  "net:*": "net:get",
  "model:*": "model:call",
  "proc:*": "proc:spawn",
  "jj:*": "jj:status"
}

/** Splits a literal the way both readers do: `*` alone is the whole action. */
const halves = (text: string): { readonly action: string; readonly resource: string } => {
  const parts = text.split(":")
  return parts[0] === "*"
    ? { action: "*", resource: parts.slice(1).join(":") }
    : { action: `${parts[0]}:${parts[1]}`, resource: parts.slice(2).join(":") }
}

const decodePattern = Schema.decodeUnknownOption(Capability.CapabilityPattern)

/**
 * Reads a literal with the reader that owns its shape: `parse` for an exact
 * capability, the `CapabilityPattern` schema for one whose action selector is
 * a wildcard, which `parse` rejects by design.
 */
const read = (text: string): Option.Option<Capability.CapabilityPattern> => {
  const { action } = halves(text)
  if (!action.includes("*")) {
    return Option.map(
      Capability.parse(text),
      (capability) => new Capability.CapabilityPattern({ action: capability.action, resource: capability.resource })
    )
  }
  const { resource } = halves(text)
  return decodePattern({ action, resource })
}

describe("HARDEN-2: every staged capability literal grants something", () => {
  it("finds staged literals at all, so a silently empty sweep fails", () => {
    expect(literals.length).toBeGreaterThan(0)
  })

  it.each(literals.map((literal) => [`${literal.file}:${literal.line} ${literal.text}`, literal] as const))(
    "%s",
    (_label, literal) => {
      const read_ = read(literal.text)

      expect(
        Option.isSome(read_),
        `${literal.file}:${literal.line}: "${literal.text}" is not a capability or pattern the readers accept`
      ).toBe(true)
      if (Option.isNone(read_)) return

      const pattern = read_.value
      const witness = witnessOf(pattern.resource)
      expect(
        witness.length > 0,
        `${literal.file}:${literal.line}: "${literal.text}" permits no non-empty resource`
      ).toBe(true)

      const action = witnessActions[pattern.action] ?? (pattern.action as Capability.Action)
      expect(
        Capability.matches(pattern, Capability.make(action, witness)),
        `${literal.file}:${literal.line}: "${literal.text}" permits nothing; it does not permit "${action}:${witness}"`
      ).toBe(true)
    }
  )
})
