/** Pure helpers behind `scripts/docs.mjs`, split out so they can be tested without touching docs/pages. */

/** Removes the leading JSDoc gutter from a comment body. */
export const ungutter = (block: string): string =>
  block.split("\n").map((line) => line.replace(/^\s*\* ?/, "")).join("\n")

/** Returns the prose before the first JSDoc tag. */
export const description = (body: string): string => {
  const lines: string[] = []
  for (const line of body.split("\n")) {
    if (/^@\w+/.test(line)) break
    lines.push(line)
  }
  return lines.join("\n").trim()
}

/** Replaces JSDoc links with inline code. */
export const delink = (value: string): string => value.replace(/\{@link\s+([^}]+)\}/g, "`$1`")

/** Joins wrapped lines while preserving paragraph breaks. */
export const paragraphs = (value: string): string => {
  const blocks: string[] = []
  let current: string[] = []
  for (const line of value.split("\n")) {
    if (line.trim() === "") {
      if (current.length > 0) blocks.push(current.join(" "))
      current = []
    } else current.push(line.trim())
  }
  if (current.length > 0) blocks.push(current.join(" "))
  return blocks.join("\n\n")
}

/** Returns the first sentence from the first paragraph. */
export const firstSentence = (value: string): string => {
  const paragraph = delink(value).split("\n\n")[0] ?? ""
  const flat = paragraph.split("\n").join(" ")
  return (/^[\s\S]*?\.(?=\s|$)/.exec(flat)?.[0] ?? flat).trim()
}

/** Extracts the prose from a module's leading JSDoc block. */
export const moduleDoc = (source: string): string => {
  const match = /\/\*\*([\s\S]*?)\*\//.exec(source)
  if (match === null) throw new Error("errors docs: no module JSDoc block")
  return delink(description(ungutter(match[1]!)))
}

/** Extracts categorized JSDoc metadata for exported declarations. */
export const exportedDocs = (source: string): ReadonlyArray<{
  readonly name: string
  readonly declaration: string
  readonly category: string
  readonly summary: string
}> => {
  const entries: Array<{
    readonly name: string
    readonly declaration: string
    readonly category: string
    readonly summary: string
  }> = []
  const pattern =
    /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*\nexport (?:abstract |async )?(type|const|let|class|interface|function|enum) (\w+)/g
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const body = ungutter(match[1]!)
    const category = /@category (\S+)/.exec(body)?.[1]
    if (category === undefined) continue
    entries.push({
      name: match[3]!,
      declaration: match[2]!,
      category,
      summary: firstSentence(description(body))
    })
  }
  return entries
}

/** Lists every supported top-level exported declaration name. */
export const exportNames = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/^export (?:abstract |async )?(?:type|const|let|class|interface|function|enum) (\w+)/gm)]
    .map((match) => match[1]!)

/** Lists each local name, public name, and source module exported by a barrel. */
export const barrelExports = (source: string): ReadonlyArray<{
  readonly name: string
  readonly exported: string
  readonly module: string
}> => {
  const entries: Array<{ readonly name: string; readonly exported: string; readonly module: string }> = []
  const pattern = /^export \{([^}]*)\} from "\.\/([^"/]+)\.ts"/gm
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const module = match[2]!
    for (const specifier of match[1]!.split(",")) {
      const [name, alias] = specifier.trim().replace(/^type\s+/, "").split(/\s+as\s+/)
      if (name !== undefined && name !== "") {
        entries.push({ name, exported: alias?.trim() ?? name, module })
      }
    }
  }
  return entries
}

/** Lists every top-level export statement the generator cannot represent. */
export const unsupportedExports = (source: string): ReadonlyArray<string> => {
  const unsupported: string[] = []
  for (const match of source.matchAll(/^export\b[^\n]*/gm)) {
    const statement = match[0]!
    const declaration = /^export (?:abstract |async )?(?:type|const|let|class|interface|function|enum) \w+/
    // [^}] keeps the block from leaking past its own closing brace into a
    // later statement's `} from "./..."`, so a local export list stays flagged.
    const barrel = /^export \{[^}]*\} from "\.\/[^"/]+\.ts"/
    if (!declaration.test(statement) && !barrel.test(source.slice(match.index))) {
      unsupported.push(statement.trim())
    }
  }
  return unsupported
}

/** Escapes a Markdown table cell and flattens its line breaks. */
export const escapeCell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ")

/** Measures a Markdown table cell after removing pipe escapes. */
export const displayWidth = (value: string): number => [...value.replaceAll("\\|", "|")].length

/** Pads a Markdown table cell to a display width. */
export const padCell = (value: string, width: number): string => `${value}${" ".repeat(width - displayWidth(value))}`

/** Renders a padded Markdown table with a minimum column width of three. */
export const markdownTable = (
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): string => {
  const escapedHeader = header.map(escapeCell)
  const escapedRows = rows.map((row) => row.map(escapeCell))
  const widths = escapedHeader.map((cell, index) =>
    Math.max(3, displayWidth(cell), ...escapedRows.map((row) => displayWidth(row[index] ?? "")))
  )
  const render = (row: ReadonlyArray<string>): string =>
    `| ${row.map((cell, index) => padCell(cell, widths[index] ?? 3)).join(" | ")} |`
  return [
    render(escapedHeader),
    render(widths.map((width) => "-".repeat(width))),
    ...escapedRows.map(render)
  ].join("\n")
}

const usesMdxMarkers = (path: string): boolean => path.startsWith("docs/pages/")

/** Returns the generated-region start marker for a path. */
export const regionStart = (path: string, name: string): string =>
  usesMdxMarkers(path)
    ? `{/* generated:${name} start */}`
    : `<!-- generated:${name} start -->`

/** Returns the generated-region end marker for a path. */
export const regionEnd = (path: string, name: string): string =>
  usesMdxMarkers(path)
    ? `{/* generated:${name} end */}`
    : `<!-- generated:${name} end -->`

/** Replaces a named generated region or reports a missing marker. */
export const replaceRegion = (source: string, name: string, body: string, path: string): string => {
  const startMarker = regionStart(path, name)
  const endMarker = regionEnd(path, name)
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`errors docs: region ${name} is missing from ${path}`)
  }
  return `${source.slice(0, start)}${startMarker}\n\n${body.trim()}\n\n${source.slice(end)}`
}
