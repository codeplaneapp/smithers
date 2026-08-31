/**
 * The frozen release contract, parsed.
 *
 * `docs/migration/rc-contract.md` sections 4.1 and 4.2 are the authority for
 * which commands ship in 1.0.0-rc.0, which were removed, and what a removed
 * command must say when someone runs it. Both the page generator and the docs
 * gate read the tables from here so neither carries a second copy of the list.
 */
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The repository root, resolved from this file rather than the caller's cwd. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** The frozen contract document. */
export const contractPath = join(repoRoot, "docs", "migration", "rc-contract.md")

/** Splits one Markdown table row into cells, honouring `\|` inside a cell. */
export const tableCells = (row) =>
  row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())

/** Every backtick-delimited span in a cell, in order. */
export const codeSpans = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1])

/** Reads the rows of the Markdown table that follows a heading. */
export const tableUnder = (source, heading) => {
  const start = source.indexOf(`\n${heading}\n`)
  if (start < 0) throw new Error(`docs-contract: heading not found: ${heading}`)
  const body = source.slice(start + heading.length + 2)
  const rows = []
  let seenHeader = false
  for (const line of body.split("\n")) {
    if (!line.startsWith("|")) {
      if (rows.length > 0 && seenHeader) break
      continue
    }
    if (/^\|[\s:|-]+\|$/.test(line)) {
      seenHeader = true
      continue
    }
    if (!seenHeader) continue
    rows.push(tableCells(line))
  }
  if (rows.length === 0) throw new Error(`docs-contract: no table under ${heading}`)
  return rows
}

/** The command name a section 4 code span names, or undefined for a bare flag. */
export const commandName = (span) => {
  const words = span.replace(/^smithers\s+/, "").trim().split(/\s+/)
  const head = words[0]
  if (head === undefined || head.startsWith("-") || head.startsWith("<") || head.startsWith("[")) return undefined
  return head
}

/**
 * Section 4.1: the commands that ship.
 *
 * One entry per command name. `forms` keeps every spelling the row shows, so
 * `run` records both `run <approval-payload>` and `run --resume <run-id>`.
 */
export const shippedCommands = (source = readFileSync(contractPath, "utf8")) => {
  const commands = new Map()
  for (const [command, origin, behavior] of tableUnder(source, "### 4.1 Commands that ship")) {
    for (const span of codeSpans(command)) {
      const name = commandName(span)
      if (name === undefined) continue
      const entry = commands.get(name) ?? { name, forms: [], origin, behavior }
      entry.forms.push(span.replace(/^smithers\s+/, ""))
      commands.set(name, entry)
    }
  }
  return commands
}

/**
 * Section 4.2: the verbs that were removed, with the reason each error prints.
 *
 * Aliases that section 4.1 keeps (`inspect`, `why`, `events`, `resume`,
 * `gateway`, `workflow list`) are not removed and never appear here.
 */
/**
 * The aliases section 4.2 keeps, read from its closing sentence.
 *
 * An alias is not a removed verb: `smithers why` runs, and documenting it as
 * removed would contradict the command it aliases.
 */
export const survivingAliases = (source = readFileSync(contractPath, "utf8")) => {
  const sentence = /Only ((?:`[^`]+`(?:, | and )?)+) survive as aliases/.exec(source)
  if (sentence === null) throw new Error("docs-contract: the surviving-alias sentence is missing")
  return new Set(codeSpans(sentence[1]))
}

/** Command names a caller can type: section 4.1 commands plus their aliases. */
export const availableCommands = (source = readFileSync(contractPath, "utf8")) => {
  const names = new Set(shippedCommands(source).keys())
  for (const alias of survivingAliases(source)) names.add(alias.split(/\s+/)[0])
  return names
}

/**
 * Verbs section 4.2 removes, each with the reason the binary prints.
 *
 * A name the same contract still ships is not removed: the table lists a few
 * verbs that survived as a subcommand of something else, and those are dropped
 * here so a page may go on naming them.
 */
export const removedCommands = (source = readFileSync(contractPath, "utf8")) => {
  const removed = new Map()
  const available = availableCommands(source)
  for (const [group, verbs, reason] of tableUnder(source, "Verbs:")) {
    for (const span of codeSpans(verbs)) {
      const name = commandName(span)
      if (name === undefined) continue
      const spelling = span.replace(/\\\|/g, "|")
      // `gateway` is a section 4.1 alias of `serve`, and the row names it only
      // to say the bare verb survives. A name section 4.1 ships is never
      // removed; a sub-spelling of one is recorded by `removedForms`.
      if (available.has(name)) continue
      const entry = removed.get(name) ?? { name, group, spellings: [], reason }
      entry.spellings.push(spelling)
      removed.set(name, entry)
    }
  }
  return removed
}

/**
 * Section 4.2 rows that remove a subcommand of a command section 4.1 keeps,
 * such as `gateway status|stop` under the surviving `gateway` alias.
 */
export const removedForms = (source = readFileSync(contractPath, "utf8")) => {
  const available = availableCommands(source)
  const forms = []
  for (const [, verbs, reason] of tableUnder(source, "Verbs:")) {
    for (const span of codeSpans(verbs)) {
      const name = commandName(span)
      if (name === undefined || !available.has(name)) continue
      const spelling = span.replace(/\\\|/g, "|")
      if (!spelling.includes(" ")) continue
      forms.push({ parent: name, form: spelling, reason })
    }
  }
  return forms
}

/**
 * Sorts the binary's removal table into the three shapes the guide documents.
 *
 * `Unsupported.removedVerbs` keys every row by a command name, including the
 * rows that remove subcommands of a command section 4.1 keeps: the tip's
 * `gateway status|stop` row is named `gateway`, and `smithers gateway` is the
 * surviving `serve` alias. Reading that row as a removed verb is what makes a
 * proof spawn `smithers gateway`, wait for a server that never exits, and
 * report a fifteen-second kill instead of the shape it actually is.
 *
 * - `bare`: the name itself is gone. The guide gives it a `### <name>` block
 *   and the binary refuses the bare verb.
 * - `parentSurvives`: the parent runs and only the listed subcommands are
 *   gone. The provable unit is `<name> <subcommand>`, never the bare name.
 * - `contradictions`: a name section 4.1 ships that the removal table removes
 *   outright, with no subcommands to qualify it. The command tree binds one of
 *   the two meanings and the other is unreachable, so no spawn can prove
 *   either. It is a defect in whichever source is wrong, and the caller
 *   reports it by name.
 *
 * @param {ReadonlyArray<{ name: string, reason: string, subcommands?: ReadonlyArray<string> }>} removedVerbs the binary's table
 * @param {string} [source] the contract text
 * @returns {{ bare: Array<object>, parentSurvives: Array<object>, contradictions: Array<object> }}
 */
export const partitionRemovals = (removedVerbs, source = readFileSync(contractPath, "utf8")) => {
  const available = availableCommands(source)
  const bare = []
  const parentSurvives = []
  const contradictions = []
  for (const verb of removedVerbs) {
    if (!available.has(verb.name)) bare.push(verb)
    else if (verb.subcommands !== undefined && verb.subcommands.length > 0) parentSurvives.push(verb)
    else contradictions.push(verb)
  }
  return { bare, parentSurvives, contradictions }
}

/**
 * The control RPCs section 5.2 removes, read from its enforcement column.
 *
 * A CLI verb and an RPC can share a name: section 4.2 removes the 0.x
 * did-you-mean verb `list` while `List` is a live request, so the RPC set is
 * read from its own section.
 */
export const removedRpcs = (source = readFileSync(contractPath, "utf8")) => {
  const start = source.indexOf("### 5.2 Unsupported, with enforcement")
  const end = source.indexOf("## 6. Existing 0.x run databases")
  if (start < 0 || end < 0) throw new Error("docs-contract: section 5.2 not found")
  const section = source.slice(start, end)
  return new Set([...section.matchAll(/Remove the `(\w+)` RPC/g)].map((match) => match[1]))
}

/** Section 4.2: the flags that were removed, keyed by the command they sit on. */
export const removedFlags = (source = readFileSync(contractPath, "utf8")) => {
  const rows = []
  for (const [parent, flags, reason] of tableUnder(source, "Flags (hidden on the parent command; presence exits 1 with the message above):")) {
    for (const span of codeSpans(flags)) {
      rows.push({ parent: parent.replace(/`/g, ""), flag: span.replace(/\\\|/g, "|"), reason })
    }
  }
  return rows
}

/** The exact sentence a removed command prints, from the section 4.2 rule. */
export const removalMessage = (name, reason) =>
  `smithers ${name} was removed in 1.0.0-rc.0: ${reason}. See https://smithers.sh/migration/1.0#${name}`

/** Section 11, the compatibility promise, quoted verbatim. */
export const compatibilityPromise = (source = readFileSync(contractPath, "utf8")) => {
  const start = source.indexOf("## 11. Compatibility promise")
  if (start < 0) throw new Error("docs-contract: section 11 not found")
  const quoted = source.slice(start).split("\n").filter((line) => line.startsWith("> "))
  if (quoted.length === 0) throw new Error("docs-contract: section 11 has no quoted paragraph")
  return quoted.map((line) => line.slice(2)).join("\n")
}

/**
 * Every JSX surface check 7 of `check-docs.mjs` refuses outside the migration
 * guide.
 *
 * The component half is read out of the section 11 promise rather than typed
 * again, because the promise is the list: a component it retires and a
 * hand-kept array forgets is a component any page may keep advertising.
 * `extraComponents` carries the 0.x components the promise does not enumerate
 * one by one, and `identifiers` carries the JSX entry points, which are import
 * specifiers and functions rather than elements.
 *
 * @param {string} [promise] the promise text, for tests
 * @returns {ReadonlyArray<string>} every surface, elements written `<Name>`
 */
export const removedJsxSurfaces = (promise = compatibilityPromise()) => {
  const components = [...promise.matchAll(/<([A-Z][A-Za-z]*)>/g)].map((match) => match[0])
  if (components.length === 0) throw new Error("docs-contract: the promise names no JSX component")
  const identifiers = [
    "jsxImportSource",
    "smthrs/jsx-runtime",
    "smthrs/jsx-dev-runtime",
    "createSmithers",
    "SmithersCtx",
    "renderFrame"
  ]
  // `<Kanban>` shipped as a component of the 0.x board pack, which the promise
  // covers by retiring the JSX API rather than by naming every element in it.
  const extraComponents = ["<Kanban>"]
  return [...identifiers, ...new Set([...components, ...extraComponents])]
}

/**
 * The 0.x package names no page outside the migration guide may print.
 *
 * @category constants
 */
export const removedZeroXPackages = [
  "smithers-orchestrator",
  "@smthrs/graph",
  "@smthrs/scheduler",
  "@smthrs/driver",
  "@smthrs/components",
  "@smthrs/react-reconciler",
  "@smthrs/gateway-react",
  "@smthrs/gateway-ui",
  "@smthrs/gateway-client",
  "@smthrs/ui-core",
  "@smthrs/tui",
  "@smthrs/protocol",
  "@smthrs/control-plane",
  "@smthrs/db",
  "@smthrs/server",
  "@smthrs/devtools",
  "@smthrs/xstate"
]

/**
 * The removed surfaces one page's body names.
 *
 * Check 7 of `check-docs.mjs` is the only caller, and it is here rather than
 * there so the surfaces and the promise that retires them stay one list. A
 * command is matched only in its `\`smithers <verb>\`` form, because the bare
 * word is ordinary English on a page about approvals or a graph.
 *
 * @param {string} body the page body
 * @param {{ jsx?: ReadonlyArray<string>, packages?: ReadonlyArray<string>, commands?: ReadonlyArray<string> }} [surfaces]
 * @returns {ReadonlyArray<string>} every surface the body names, in the order it was asked about
 */
export const namedRemovedSurfaces = (body, surfaces = {}) => {
  const jsx = surfaces.jsx ?? removedJsxSurfaces()
  const packages = surfaces.packages ?? removedZeroXPackages
  const commands = surfaces.commands ?? []
  const named = []
  for (const api of jsx) if (body.includes(api)) named.push(api)
  for (const name of packages) {
    if (new RegExp(`${name.replace("/", "\\/")}(?![a-z-])`).test(body)) named.push(name)
  }
  for (const name of commands) {
    if (new RegExp(`\`smithers ${name}(?![a-z-])`).test(body)) named.push(`smithers ${name}`)
  }
  return named
}

/**
 * The files section 11 requires the promise in, word for word.
 *
 * The section names "the release notes, README, and migration guide". The
 * release notes are the compatibility-policy page, which is what a reader of
 * the changelog index lands on. Quoting rather than paraphrasing is the point:
 * an approximate promise is a different promise, and a reader deciding whether
 * to upgrade is entitled to the one the contract froze.
 */
export const promiseHolders = [
  "README.md",
  "docs/pages/migration/1.0.md",
  "docs/pages/changelogs/compatibility-policy.md"
]

/** Section 7, the deferred-feature release notes, as one paragraph per entry. */
export const releaseNoteParagraphs = (source = readFileSync(contractPath, "utf8")) => {
  const start = source.indexOf("## 7. Deferred features with release-note wording")
  const end = source.indexOf("## 8. Maintainer decisions")
  if (start < 0 || end < 0) throw new Error("docs-contract: section 7 not found")
  return source
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("> "))
    .map((line) => line.slice(2))
    .filter((line) => line.trim().length > 0)
}

/** The path of the Phase 5 gap triage, which keys the exclusions. */
export const triagePath = join(repoRoot, "docs", "migration", "phase5-gap-triage.md")

/**
 * Section 7 release notes, one entry per paragraph.
 *
 * `line` is the contract's own line, quote marker included, so a page that
 * copies it is verbatim by construction and a gate can prove it.
 */
export const releaseNotes = (source = readFileSync(contractPath, "utf8")) => {
  const start = source.indexOf("## 7. Deferred features with release-note wording")
  const end = source.indexOf("## 8. Maintainer decisions")
  if (start < 0 || end < 0) throw new Error("docs-contract: section 7 not found")
  return source
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("> "))
    .map((line) => {
      const title = /^> \*\*([^*]+)\.\*\*/.exec(line)
      return { title: title === null ? undefined : title[1], line }
    })
    .filter((note) => note.title !== undefined)
}

/** Table B of the Phase 5 triage: the RC exclusions, with the notes they cite. */
export const exclusions = (source = readFileSync(triagePath, "utf8")) => {
  const rows = tableUnder(source, "## Table B: RC exclusions")
  return rows.map(([id, feature, , noteSource, disposition]) => ({
    id,
    feature,
    disposition,
    titles: [...noteSource.matchAll(/§7 "([^"(]+?)(?:\s*\([^"]*\))?"/g)].map((match) => match[1].trim())
  }))
}

/** Section 5.2: the unsupported features and how each exclusion is enforced. */
export const unsupportedFeatures = (source = readFileSync(contractPath, "utf8")) =>
  tableUnder(source, "### 5.2 Unsupported, with enforcement").map(([feature, state]) => ({ feature, state }))

/** Section 5.1: the run-control features rc.0 supports. */
export const supportedRunControl = (source = readFileSync(contractPath, "utf8")) =>
  tableUnder(source, "### 5.1 Supported").map(([feature, contract]) => ({ feature, contract }))

/** Section 1: the supported runtimes. */
export const runtimes = (source = readFileSync(contractPath, "utf8")) =>
  tableUnder(source, "## 1. Supported runtimes").map(([runtime, status, minimum]) => ({ runtime, status, minimum }))

/**
 * Every place a document states the size of the published set.
 *
 * Four spellings appear in this tree: `N names frozen in` cites section 3.1
 * directly, "the N packages `node scripts/pack-release.mjs --names` prints"
 * cites the roster the contract freezes, the Phase 3 validation record states
 * it as a table cell, and the contract's own cross-references write the
 * shortest form, `N names in §3.1`. A number written by hand goes stale the
 * moment a package joins the release, and these are the documents a maintainer
 * reads before publishing.
 *
 * @example
 * ```ts
 * citedPackageCounts("against the 40 names frozen in section 3.1") // [40]
 * ```
 */
export const citedPackageCounts = (body) =>
  [
    ...body.matchAll(/(\d+) names frozen in/g),
    ...body.matchAll(/(\d+) names in (?:§|section )3\.1/g),
    ...body.matchAll(/the (\d+) packages `node scripts\/pack-release\.mjs --names` prints/g),
    ...body.matchAll(/^\| Published packages \| (\d+) \|/gm)
  ].map((match) => Number(match[1]))

/**
 * The documents the citation check reads: every source Markdown file under
 * `docs/` plus the README. `docs/dist` is the site vocs renders, so reading it
 * would report the same sentence twice and would report it from a directory
 * a fix cannot be applied to. Paths are repository-relative and sorted, so a
 * failure names the same file on every machine.
 */
export const countCitingDocuments = (root = repoRoot) => {
  const found = []
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (next !== "docs/dist") walk(next)
      } else if (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")) found.push(next)
    }
  }
  walk("docs")
  found.push("README.md")
  return found
}

/**
 * The section 3.1 heading, whose parenthesis carries the package count.
 *
 * The count moves whenever a package joins or leaves the release, so the
 * heading is matched by its stable prefix. Reading it back is what lets a page
 * cite the number without keeping a second copy of it.
 */
const publishedHeading = (source) => {
  const match = /^### 3\.1 Published at 1\.0\.0-rc\.0 \((\d+) names\)$/m.exec(source)
  if (match === null) throw new Error("docs-contract: the section 3.1 heading is missing or does not spell a count")
  return { heading: match[0], count: Number(match[1]) }
}

/**
 * Section 3.1: how many packages the contract says it publishes.
 *
 * @example
 * ```ts
 * publishedPackageCount() === publishedPackages().length
 * ```
 */
export const publishedPackageCount = (source = readFileSync(contractPath, "utf8")) => publishedHeading(source).count

/**
 * Section 3.1: the packages published at 1.0.0-rc.0.
 *
 * Throws when the heading's count and the table disagree. A contract that
 * contradicts itself is worse than a missing one: the pages generated from it
 * would state a number no reader could reproduce.
 */
export const publishedPackages = (source = readFileSync(contractPath, "utf8")) => {
  const { count, heading } = publishedHeading(source)
  const rows = tableUnder(source, heading).map(([name, purpose, browser]) => ({
    name: name.replace(/`/g, ""),
    purpose,
    browser
  }))
  if (rows.length !== count) {
    throw new Error(`docs-contract: section 3.1 heading says ${count} names and the table has ${rows.length} rows`)
  }
  return rows
}
