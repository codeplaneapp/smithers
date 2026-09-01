/** Pure helpers behind `scripts/docs.mjs`, split out so they can be tested without touching docs/pages. */

import * as ts from "typescript"

const sourceFile = (source: string): ts.SourceFile => {
  const parsed = ts.createSourceFile("errors-docs.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostic = (parsed as ts.SourceFile & {
    readonly parseDiagnostics: ReadonlyArray<ts.Diagnostic>
  }).parseDiagnostics[0]
  if (diagnostic !== undefined) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
    throw new Error(`errors docs: source has a syntax error: ${message}`)
  }
  return parsed
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true

const declaration = (
  statement: ts.Statement
): { readonly names: ReadonlyArray<string>; readonly kind: string } | undefined => {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return undefined
  if (
    hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ||
    hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
  ) return undefined
  if (ts.isTypeAliasDeclaration(statement) && statement.name !== undefined) {
    return { names: [statement.name.text], kind: "type" }
  }
  if (ts.isVariableStatement(statement)) {
    if ((statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0) return undefined
    const names: Array<string> = []
    for (const entry of statement.declarationList.declarations) {
      if (!ts.isIdentifier(entry.name)) return undefined
      names.push(entry.name.text)
    }
    return {
      names,
      kind: (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 ? "const" : "let"
    }
  }
  if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
    return { names: [statement.name.text], kind: "class" }
  }
  if (ts.isInterfaceDeclaration(statement)) return { names: [statement.name.text], kind: "interface" }
  if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
    return { names: [statement.name.text], kind: "function" }
  }
  if (ts.isEnumDeclaration(statement)) return { names: [statement.name.text], kind: "enum" }
  return undefined
}

const jsdocBody = (statement: ts.Statement, parsed: ts.SourceFile): string | undefined => {
  const trivia = parsed.text.slice(statement.getFullStart(), statement.getStart(parsed))
  const comments = [...trivia.matchAll(/\/\*\*((?:[^*]|\*(?!\/))*)\*\//g)]
  const last = comments.at(-1)
  if (last === undefined || last.index === undefined) return undefined
  if (trivia.slice(last.index + last[0].length).trim() !== "") return undefined
  return ungutter(last[1]!)
}

const supportedBarrel = (statement: ts.Statement): statement is ts.ExportDeclaration =>
  ts.isExportDeclaration(statement) &&
  !statement.isTypeOnly &&
  statement.moduleSpecifier !== undefined &&
  ts.isStringLiteral(statement.moduleSpecifier) &&
  /^\.\/[^/\"]+\.ts$/.test(statement.moduleSpecifier.text) &&
  statement.exportClause !== undefined &&
  ts.isNamedExports(statement.exportClause)

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
  const parsed = sourceFile(source)
  for (const statement of parsed.statements) {
    const exported = declaration(statement)
    if (exported === undefined) continue
    const body = jsdocBody(statement, parsed)
    if (body === undefined) continue
    const category = /@category (\S+)/.exec(body)?.[1]
    if (category === undefined) continue
    for (const name of exported.names) {
      entries.push({
        name,
        declaration: exported.kind,
        category,
        summary: firstSentence(description(body))
      })
    }
  }
  return entries
}

/** Lists every supported top-level exported declaration name. */
export const exportNames = (source: string): ReadonlyArray<string> =>
  sourceFile(source).statements.flatMap((statement) => declaration(statement)?.names ?? [])

/** Lists each local name, public name, and source module exported by a barrel. */
export const barrelExports = (source: string): ReadonlyArray<{
  readonly name: string
  readonly exported: string
  readonly module: string
}> => {
  const entries: Array<{ readonly name: string; readonly exported: string; readonly module: string }> = []
  for (const statement of sourceFile(source).statements) {
    if (!supportedBarrel(statement)) continue
    const clause = statement.exportClause
    if (clause === undefined || !ts.isNamedExports(clause)) continue
    const module = (statement.moduleSpecifier as ts.StringLiteral).text.slice(2, -3)
    for (const specifier of clause.elements) {
      entries.push({
        name: specifier.propertyName?.text ?? specifier.name.text,
        exported: specifier.name.text,
        module
      })
    }
  }
  return entries
}

/** Lists every top-level export statement the generator cannot represent. */
export const unsupportedExports = (source: string): ReadonlyArray<string> => {
  const unsupported: string[] = []
  const parsed = sourceFile(source)
  for (const statement of parsed.statements) {
    const isExport = ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    if (!isExport || declaration(statement) !== undefined || supportedBarrel(statement)) continue
    unsupported.push(statement.getText(parsed).trim())
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
