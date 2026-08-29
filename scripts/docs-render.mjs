/**
 * The rendering helpers the page generator uses.
 *
 * They are pure: Markdown escaping, contract prose, frontmatter, the generated
 * region markers, and the Effect Schema AST reader that turns a request
 * definition into a table. Keeping them here is what lets a test exercise them
 * without spawning the CLI the generator reads.
 */
import { readFileSync } from "node:fs"
import { contractPath } from "./docs-contract.mjs"

/** Markers around the block this generator owns inside a hand-written page. */
export const regionStart = (name) => `{/* generated:${name} start */}`

/** The closing marker of a generated region. */
export const regionEnd = (name) => `{/* generated:${name} end */}`

/** Replaces the body of a generated region, keeping the prose around it. */
export const replaceRegion = (source, name, body) => {
  const start = source.indexOf(regionStart(name))
  const end = source.indexOf(regionEnd(name))
  if (start < 0 || end < 0) throw new Error(`generate-docs-pages: region ${name} is missing`)
  return `${source.slice(0, start)}${regionStart(name)}\n\n${body.trim()}\n\n${source.slice(end)}`
}

/**
 * Escapes the angle brackets a Markdown page renders as MDX would parse as JSX.
 *
 * `--help` text is data from the binary, and `smithers init` describes itself as
 * "Scaffold flows/<name>/flow.mdx". Interpolated into a page, `<name>` is an
 * unclosed JSX element and the site build dies on it. A code span is left alone,
 * because inside one the brackets are already literal and are the conventional
 * way to write a placeholder; a lone `<` between spaces is left alone too,
 * because it is arithmetic rather than a tag.
 *
 * This escapes `>` as well, so apply it to interpolated data and never to
 * authored Markdown: a blockquote passed through it would come out as text.
 */
export const mdxText = (text) =>
  text
    .split(/(`[^`]*`)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/<(?=[A-Za-z/])/g, "&lt;").replace(/>/g, "&gt;")))
    .join("")

/** Escapes a cell so a pipe inside it cannot end the Markdown column. */
export const cell = (text) => mdxText(text).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim()

/** Clauses that address the migration's own record rather than a reader. */
const internalReference = /import reference|ledger |Phase [1-9]|triage|flows-cli|`Command\.ts|at HEAD/

/**
 * Turns contract prose into page prose.
 *
 * A behavior cell explains itself to the migration as well as to a reader, so
 * it can end with the file and line a Phase 4 lane must change. Those
 * sentences are dropped here: a command page says what the command does, and
 * the contract stays the place that records why.
 */
export const contractProse = (text) =>
  text
    .replace(/\\\|/g, "|")
    .replace(/§\s*/g, "section ")
    .split(/(?<=\.)\s+(?=[A-Z`(])/)
    .filter((sentence) => !internalReference.test(sentence))
    .join(" ")
    .trim()

/** A page's YAML frontmatter. One key, always quoted, never multi-line. */
export const frontmatter = (description) => `---\ndescription: ${JSON.stringify(description)}\n---\n`

/** The `_tag` literal of a tagged object member, when it has one. */
export const variantTag = (ast) => {
  const property = (ast.propertySignatures ?? []).find((entry) => String(entry.name) === "_tag")
  const literal = property?.type?.literal ?? property?.type?.literals?.[0]
  return literal === undefined ? undefined : String(literal)
}

/** The tagged members of a union schema, with the fields each one carries. */
export const variantRows = (ast) => {
  if (ast?._tag !== "Union") return undefined
  const rows = (ast.types ?? [])
    .filter((type) => type._tag === "Objects")
    .map((type) => ({
      tag: variantTag(type),
      fields: (type.propertySignatures ?? []).map((entry) => String(entry.name)).filter((name) => name !== "_tag")
    }))
    .filter((row) => row.tag !== undefined)
  return rows.length === 0 ? undefined : rows
}

/** Renders one Effect Schema AST as a short type expression. */
export const renderAst = (ast, depth = 0) => {
  if (ast === undefined || ast === null) return "unknown"
  const identifier = ast.annotations?.identifier
  if (typeof identifier === "string" && depth > 0) return identifier.replace(/^\/control\//, "")
  switch (ast._tag) {
    case "String":
    case "Number":
    case "Boolean":
    case "Null":
    case "Undefined":
    case "Never":
    case "Any":
    case "Unknown":
      return ast._tag.toLowerCase()
    case "Literal":
      return JSON.stringify(ast.literal)
    case "Literals":
      return (ast.literals ?? []).map((literal) => JSON.stringify(literal)).join(" | ")
    case "Union": {
      const members = (ast.types ?? []).filter((type) => type._tag !== "Undefined")
      const rendered = members.map((type) => renderAst(type, depth + 1))
      return [...new Set(rendered)].join(" | ") || "unknown"
    }
    case "Objects": {
      const tag = variantTag(ast)
      if (tag !== undefined) return tag
      if (depth > 1) return "object"
      const properties = ast.propertySignatures ?? []
      return `{ ${properties.map((property) => String(property.name)).join(", ")} }`
    }
    case "Arrays":
      return "array"
    case "Suspend":
      return "recursive"
    case "Declaration":
      return typeof identifier === "string" ? identifier : (ast.annotations?.expected ?? "declaration")
    default:
      return typeof identifier === "string" ? identifier : String(ast._tag).toLowerCase()
  }
}

/** True when a schema field accepts `undefined`, which makes it optional. */
export const isOptional = (ast) => ast?._tag === "Union" && (ast.types ?? []).some((type) => type._tag === "Undefined")

/** The `{ tag, code }` pairs a schema's error union carries. */
export const errorTags = (ast) => {
  const types = ast?._tag === "Union" ? (ast.types ?? []) : ast === undefined ? [] : [ast]
  return types
    .map((type) => {
      const sentinels = type.annotations?.["~sentinels"] ?? []
      const tag = sentinels.find((sentinel) => sentinel.key === "_tag")?.literal
      const code = sentinels.find((sentinel) => sentinel.key === "code")?.literal
      const identifier = type.annotations?.identifier
      if (tag === undefined && identifier === undefined) return undefined
      return { tag: String(tag ?? identifier).replace(/^\/control\//, ""), code: code === undefined ? "" : String(code) }
    })
    .filter((entry) => entry !== undefined)
}

/** The exit-code sentence in contract section 4, parsed into rows. */
export const exitCodes = (source = readFileSync(contractPath, "utf8")) => {
  const sentence = /^Exit codes \([^)]*\): (.+)$/m.exec(source)
  if (sentence === null) throw new Error("generate-docs-pages: the exit-code sentence is missing")
  const rows = []
  for (const part of sentence[1].split("; ")) {
    const match = /^(\d+) ([^.]+)/.exec(part.trim())
    // The sentence ends with prose about the 0.x codes; stop at the first
    // fragment that does not open with a code.
    if (match === null) break
    rows.push({ code: match[1], meaning: match[2].trim() })
  }
  if (rows.length === 0) throw new Error("generate-docs-pages: the exit-code sentence has no codes")
  return rows
}

