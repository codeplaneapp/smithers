/** Shared readers for the documentation toolchain. */
import { readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** The repository root, resolved from this file rather than the caller's cwd. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

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
  if (start < 0) throw new Error(`docs: heading not found: ${heading}`)
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
    if (seenHeader) rows.push(tableCells(line))
  }
  if (rows.length === 0) throw new Error(`docs: no table under ${heading}`)
  return rows
}

/** Smithers 0.x package names that current pages must not advertise. */
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

/** JSX-era surfaces that belong only in historical or upgrade documentation. */
export const removedJsxSurfaces = [
  "jsxImportSource",
  "smthrs/jsx-runtime",
  "smthrs/jsx-dev-runtime",
  "createSmithers",
  "SmithersCtx",
  "renderFrame",
  "<Workflow>",
  "<Task>",
  "<Sequence>",
  "<Parallel>",
  "<Loop>",
  "<Ralph>",
  "<Branch>",
  "<Approval>",
  "<Signal>",
  "<Timer>",
  "<Subflow>",
  "<Worktree>",
  "<Saga>",
  "<Kanban>"
]

/** Removed surfaces one page body names. */
export const namedRemovedSurfaces = (body, surfaces = {}) => {
  const jsx = surfaces.jsx ?? removedJsxSurfaces
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

/** Documents whose current release counts are checked against live sources. */
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

/** Explicit package counts in maintained release prose. */
export const citedPackageCounts = (body) =>
  [
    ...body.matchAll(/the (\d+) packages `node scripts\/pack-release\.mjs --names` prints/g),
    ...body.matchAll(/^\| Published packages \| (\d+) \|/gm)
  ].map((match) => Number(match[1]))
