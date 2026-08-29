import { type Dirent, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PACKAGES_DIR = fileURLToPath(new URL("../..", import.meta.url))
const CONSOLE_CALL = /console\.(?:log|info|warn|error|debug|trace)\s*\(/

/**
 * The one file whose `console.log` is data rather than a call.
 *
 * `cellPrompt.ts` is the contract a model is taught, and the contract's worked
 * example is JavaScript for a *different* realm: `console.log` is how a cell
 * talks to its next turn, so the example has to spell it. Models imitate the
 * example, so spelling it any other way to satisfy a text match would teach a
 * shape the realm does not have. Nothing in this file calls `console`; the
 * matches are inside a template literal that is shown, never run.
 *
 * The exemption is pinned to a count rather than left open, because a
 * whole-file pass would let a real debugging call into the one file the guard
 * no longer reads. Editing the worked example moves this number, which is the
 * same deliberateness the contract's own digest and token ceiling ask for.
 */
const TEACHING = "harness/src/internal/cellPrompt.ts"

/** How many `console.*` lines the teaching text is expected to spell. */
const TEACHING_LINES = 2

/**
 * Source files under every package's `src`. Walked in-process rather than
 * shelled out to ripgrep: a runner without `rg` makes `spawnSync` return
 * `status: null`, which fails this guard with "expected null to be 1" and
 * reads like a real console violation instead of a missing binary.
 */
function* sourceFiles(dir: string): Generator<string> {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
      yield* sourceFiles(path)
    } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      yield path
    }
  }
}

function packageSourceRoots(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name, "src"))
}

describe("console guard", () => {
  it("finds no direct console calls in package source", () => {
    const offenders: string[] = []
    for (const root of packageSourceRoots()) {
      for (const file of sourceFiles(root)) {
        const relative = file.slice(PACKAGES_DIR.length)
        if (relative === TEACHING) continue
        const source = readFileSync(file, "utf8")
        if (!CONSOLE_CALL.test(source)) continue
        for (const [index, line] of source.split("\n").entries()) {
          if (CONSOLE_CALL.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("holds the teaching file to the console lines its worked example spells", () => {
    const source = readFileSync(join(PACKAGES_DIR, TEACHING), "utf8")
    const matched = source.split("\n").filter((line) => CONSOLE_CALL.test(line))
    expect(matched).toHaveLength(TEACHING_LINES)
  })

  it("scans a non-empty set of package sources", () => {
    const scanned = packageSourceRoots().flatMap((root) => Array.from(sourceFiles(root)))
    expect(scanned.length).toBeGreaterThan(0)
  })
})
