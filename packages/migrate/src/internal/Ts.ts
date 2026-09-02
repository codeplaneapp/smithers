/**
 * TypeScript compiler helpers shared by the scanners.
 *
 * Every scanner parses one file at a time with `ts.createSourceFile` rather
 * than building a `ts.Program`. A 0.x project does not typecheck against the
 * new packages, its `tsconfig.json` points at a JSX runtime that is being
 * removed, and its `node_modules` may be absent. The syntax tree is all the
 * scanners need, and it is available whatever state the project is in.
 *
 * @since 1.0.0-rc.0
 * @private
 */
import ts from "typescript"

/**
 * One import in a file, with the local name each binding is written as.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface ImportRecord {
  readonly specifier: string
  /** Local name to exported name. A default import maps to `"default"`. */
  readonly names: ReadonlyMap<string, string>
  /** Local name of `import * as x`, when there is one. */
  readonly namespace: string | undefined
  readonly line: number
  readonly column: number
  /** True for `import type` and for every `type`-only named binding. */
  readonly typeOnly: boolean
}

/**
 * Chooses the script kind from the file extension so JSX parses as JSX and a
 * `.ts` file's angle brackets stay type assertions.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const scriptKind = (file: string): ts.ScriptKind => {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (file.endsWith(".mts") || file.endsWith(".cts")) return ts.ScriptKind.TS
  if (file.endsWith(".mjs") || file.endsWith(".cjs") || file.endsWith(".js")) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * Parses one file. `.js` parses as JS with JSX enabled, because a 0.x example
 * such as `examples/simple-workflow.jsx` is JavaScript carrying JSX.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const parse = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    text,
    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    true,
    scriptKind(file)
  )

/**
 * The 1-based line and column of a node.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const positionOf = (
  source: ts.SourceFile,
  node: ts.Node
): { readonly line: number; readonly column: number } => {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source))
  return { line: position.line + 1, column: position.character + 1 }
}

/**
 * Visits every node depth first.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const forEachNode = (node: ts.Node, visit: (node: ts.Node) => void): void => {
  visit(node)
  node.forEachChild((child) => forEachNode(child, visit))
}

/**
 * Reads every import in a file, including `export ... from` re-exports, which
 * bind an old specifier just as an import does.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const imports = (source: ts.SourceFile): ReadonlyArray<ImportRecord> => {
  const records: Array<ImportRecord> = []
  for (const statement of source.statements) {
    const clauseOf = (): { specifier: string; node: ts.Node } | undefined => {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        return { specifier: statement.moduleSpecifier.text, node: statement }
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        return { specifier: statement.moduleSpecifier.text, node: statement }
      }
      return undefined
    }
    const found = clauseOf()
    if (found === undefined) continue

    const names = new Map<string, string>()
    let namespace: string | undefined
    let typeOnly = false

    if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
      const clause = statement.importClause
      typeOnly = clause.isTypeOnly
      if (clause.name !== undefined) names.set(clause.name.text, "default")
      const bindings = clause.namedBindings
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespace = bindings.name.text
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue
          names.set(element.name.text, element.propertyName?.text ?? element.name.text)
        }
      }
    }
    if (ts.isExportDeclaration(statement)) {
      typeOnly = statement.isTypeOnly
      const clause = statement.exportClause
      if (clause !== undefined && ts.isNamespaceExport(clause)) namespace = clause.name.text
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue
          names.set(element.name.text, element.propertyName?.text ?? element.name.text)
        }
      }
    }

    const position = positionOf(source, found.node)
    records.push({ specifier: found.specifier, names, namespace, typeOnly, ...position })
  }
  return records
}

/**
 * The text of a JSX element's tag, `Foo` or `Foo.Bar`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const tagName = (node: ts.JsxOpeningLikeElement): string => node.tagName.getText()

/**
 * The names of the attributes on a JSX element, in source order. A spread
 * attribute is recorded as `...`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const attributeNames = (node: ts.JsxOpeningLikeElement): ReadonlyArray<string> =>
  node.attributes.properties.map((property) => ts.isJsxAttribute(property) ? property.name.getText() : "...")

/**
 * The source text of one JSX attribute's value, with the braces removed.
 * Returns `undefined` for a bare attribute (`<Task async>`).
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const attributeText = (node: ts.JsxOpeningLikeElement, name: string): string | undefined => {
  for (const property of node.attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue
    const initializer = property.initializer
    if (initializer === undefined) return undefined
    if (ts.isStringLiteral(initializer)) return initializer.text
    if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) {
      return initializer.expression.getText()
    }
    return undefined
  }
  return undefined
}

/**
 * The names bound by an object destructuring pattern, by their local name.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const destructuredNames = (pattern: ts.ObjectBindingPattern): ReadonlyMap<string, string> => {
  const names = new Map<string, string>()
  for (const element of pattern.elements) {
    if (element.dotDotDotToken !== undefined) continue
    if (!ts.isIdentifier(element.name)) continue
    const source = element.propertyName === undefined ? element.name.text : element.propertyName.getText()
    names.set(element.name.text, source)
  }
  return names
}

/**
 * The callee text of a call expression, `f` or `a.b`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const calleeName = (node: ts.CallExpression): string => node.expression.getText()

/**
 * One module specifier a file names, whatever form it names it in.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface SpecifierRecord {
  readonly specifier: string
  readonly form: "import" | "export" | "require" | "dynamic"
  readonly line: number
  readonly column: number
}

/**
 * Every module specifier a file names: static `import` and `export ... from`
 * declarations, `import "..."` side-effect imports, `require("...")` calls, and
 * dynamic `import("...")` calls.
 *
 * A check that asks whether a file still reaches an old package has to see all
 * four forms. A regular expression over `from "..."` sees only two of them.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const moduleSpecifiers = (source: ts.SourceFile): ReadonlyArray<SpecifierRecord> => {
  const records: Array<SpecifierRecord> = []
  const push = (specifier: string, form: SpecifierRecord["form"], node: ts.Node): void => {
    records.push({ specifier, form, ...positionOf(source, node) })
  }
  forEachNode(source, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      push(node.moduleSpecifier.text, "import", node)
      return
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      push(node.moduleSpecifier.text, "export", node)
      return
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const argument = node.moduleReference.expression
      if (ts.isStringLiteralLike(argument)) push(argument.text, "require", node)
      return
    }
    if (!ts.isCallExpression(node)) return
    const argument = node.arguments[0]
    if (argument === undefined || !ts.isStringLiteralLike(argument)) return
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) push(argument.text, "dynamic", node)
    else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
      push(argument.text, "require", node)
    }
  })
  return records
}

/**
 * The text of one JSX attribute when, and only when, the source wrote it as a
 * string literal: `id="review"` yields `review`, and `id={`${x}:review`}`
 * yields `undefined`.
 *
 * A rewrite names each step after the id the source gave it. An id the source
 * computes at run time is not a name this tool may print.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const attributeLiteral = (node: ts.JsxOpeningLikeElement, name: string): string | undefined => {
  for (const property of node.attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue
    const initializer = property.initializer
    if (initializer === undefined) return undefined
    if (ts.isStringLiteral(initializer)) return initializer.text
    if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) {
      const value = initializer.expression
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
    }
    return undefined
  }
  return undefined
}
