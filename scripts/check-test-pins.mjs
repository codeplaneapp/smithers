/**
 * Fails when a test pin in the engine or tooling package groups is not written
 * down in docs/alpha-notes.md.
 *
 * A pin is a test the default gate never runs to a pass. Three forms count:
 * `it.fails`/`test.fails` (an assertion that current behavior is wrong),
 * `.skip`/`.todo` (disabled outright), and a `.skipIf`/`.runIf` gated on an
 * environment variable nothing in the repo sets. All three are legitimate
 * occasionally and all three rot silently, so the rule is not "no pins" — it is
 * "no pin the docs do not explain". The 2026-08-16 readiness audit's F4 line
 * item existed because nothing enforced that.
 *
 * A `.skipIf`/`.runIf` on `process.platform`, on an installed binary, or on a
 * built artifact is a capability gate, not a pin: it runs on the supported
 * configuration.
 *
 * Group membership comes from `smthrs.group`, the same authority the release
 * train uses, so a new package is covered without being listed here. Agent-group
 * packages are out of scope.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** The package groups whose pins this register covers. */
export const guardedGroups = new Set(["engine", "tooling"])

export const notesPath = join(repoRoot, "docs", "alpha-notes.md")

/**
 * Matches an outright pin and captures its title.
 *
 * The prefix is deliberately loose — `it`, `test`, `describe`, `it.effect`,
 * `it.live`, `it.scoped` all appear in this repo — but the modifier is anchored
 * to the exact pin forms.
 */
const pinPattern = /\b(?:it|test|describe)(?:\.[a-zA-Z]+)*\.(fails|skip|todo)\s*\(\s*(["'`])((?:[^\\]|\\.)*?)\2/g

/** Matches the beginning of a conditional suite's condition. */
const conditionalStartPattern =
  /\b(?:it|test|describe)(?:\.[a-zA-Z]+)*\.(skipIf|runIf)\s*\(/g

/** Reads the closing parenthesis paired with the one at `openIndex`. */
const readParenthesized = (source, openIndex) => {
  let depth = 0
  let quote
  for (let index = openIndex; index < source.length; index++) {
    const character = source[index]
    if (quote !== undefined) {
      if (character === "\\") index++
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === "(") depth++
    else if (character === ")" && --depth === 0) {
      return { text: source.slice(openIndex + 1, index), closeIndex: index }
    }
  }
  return undefined
}

/** Reads the title at the start of a conditional suite's invocation. */
const conditionalTitlePattern = /\s*\(\s*(["'`])((?:[^\\]|\\.)*?)\1/y

/**
 * Whether a `skipIf`/`runIf` condition leaves the suite off in a default run.
 *
 * A condition that reads an environment variable is opt-in: nothing sets it, so
 * the suite does not execute unless someone remembers it exists. A condition on
 * `process.platform`, on an installed binary, or on a built artifact is a
 * capability gate — it runs on the supported configuration. `CI` is excluded
 * because CI is a configuration the repo actually runs.
 *
 * The check is textual, so a condition that reaches an environment variable
 * through a helper defined elsewhere reads as a capability gate. That is a
 * deliberate floor, not a claim of completeness.
 */
const readsOptInEnv = (text) => /process\.env\.(?!CI\b)[A-Za-z_]/.test(text)

/**
 * Resolves a bare-identifier condition against a `const` in the same file, so
 * the readable idiom — naming the flag once, using it on several suites —
 * is not a way around the guard.
 */
const isOptIn = (condition, source) => {
  if (readsOptInEnv(condition)) return true
  const identifier = condition.trim().match(/^!?([A-Za-z_$][\w$]*)$/)
  if (identifier === null) return false
  const binding = source.match(new RegExp(`\\bconst\\s+${identifier[1]}\\s*=([^\\n]*)`))
  return binding !== null && readsOptInEnv(binding[1])
}

/** Directory names never worth walking for tests. */
const ignoredDirectories = new Set(["node_modules", "dist", "build", "coverage", ".git", "target"])

const isTestFile = (name) => /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)

/** Every package directory whose manifest declares one of the guarded groups. */
export const guardedPackages = (packagesRoot = join(repoRoot, "packages")) => {
  const found = []
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(packagesRoot, entry.name, "package.json")
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (guardedGroups.has(manifest.smthrs?.group)) found.push(join(packagesRoot, entry.name))
  }
  return found
}

const testFilesUnder = (directory, collected = []) => {
  if (!existsSync(directory)) return collected
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) testFilesUnder(path, collected)
    else if (entry.isFile() && isTestFile(entry.name)) collected.push(path)
  }
  return collected
}

/**
 * Every pin in `source`, as `{ form, title, line }`.
 *
 * Exported so the unit test can drive it against fixtures rather than against
 * whatever the tree happens to contain.
 */
export const findPins = (source) => {
  const lineOf = (index) => source.slice(0, index).split("\n").length
  const pins = []
  for (const match of source.matchAll(pinPattern)) {
    pins.push({ form: match[1], title: match[3], line: lineOf(match.index) })
  }
  for (const match of source.matchAll(conditionalStartPattern)) {
    const openIndex = match.index + match[0].length - 1
    const condition = readParenthesized(source, openIndex)
    if (condition === undefined || !isOptIn(condition.text, source)) continue
    conditionalTitlePattern.lastIndex = condition.closeIndex + 1
    const title = conditionalTitlePattern.exec(source)
    if (title === null) continue
    pins.push({
      form: `${match[1]}(${condition.text.trim()})`,
      title: title[2],
      line: lineOf(match.index)
    })
  }
  return pins.sort((a, b) => a.line - b.line)
}

/** The documented `{ package, title }` pairs in the Surviving pins table. */
const survivingPins = (notes) => {
  // `(?![\s\S])` is a real end-of-input assertion in ECMAScript. Unlike
  // `\z` (which JavaScript treats as a literal `z`), it cannot stop a table
  // at ordinary prose before its documented rows.
  const section = notes.match(/^### Surviving pins\s*$([\s\S]*?)(?=^### |(?![\s\S]))/m)
  if (section === null) return new Set()
  const documented = new Set()
  const rowPattern = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm
  for (const row of section[1].matchAll(rowPattern)) documented.add(`${row[1]}\u0000${row[2]}`)
  return documented
}

/**
 * Pins across the guarded packages that the Surviving pins table does not list.
 *
 * A pin counts as documented only when that table pairs its package and exact
 * title. Resolved-pin history can quote the same title, but must not authorize
 * re-pinning the test.
 */
export const undocumentedPins = (notes = readFileSync(notesPath, "utf8"), packages = guardedPackages()) => {
  const unexplained = []
  const documented = survivingPins(notes)
  for (const packageDirectory of packages) {
    const packageName = relative(join(repoRoot, "packages"), packageDirectory)
    for (const file of testFilesUnder(packageDirectory)) {
      for (const pin of findPins(readFileSync(file, "utf8"))) {
        if (documented.has(`${packageName}\u0000${pin.title}`)) continue
        unexplained.push({ ...pin, file: relative(repoRoot, file) })
      }
    }
  }
  return unexplained
}

const main = () => {
  if (!existsSync(notesPath) || !statSync(notesPath).isFile()) {
    console.error(`${relative(repoRoot, notesPath)} is missing: it is the register every pin must appear in.`)
    process.exit(1)
  }
  const unexplained = undocumentedPins()
  if (unexplained.length === 0) {
    console.log("No undocumented test pins in the engine or tooling package groups.")
    return
  }
  console.error(`${unexplained.length} test pin(s) are not documented in docs/alpha-notes.md:`)
  for (const pin of unexplained) {
    console.error(`  ${pin.file}:${pin.line}  .${pin.form}  ${JSON.stringify(pin.title)}`)
  }
  console.error("")
  console.error("Fix the defect and unpin it, or add the pin to the \"Known test pins\" section")
  console.error("of docs/alpha-notes.md with a rationale. See that file's \"Adding a pin\".")
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
