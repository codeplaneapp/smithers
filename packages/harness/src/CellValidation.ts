/**
 * Cell validation at the boundary.
 *
 * A cell used to be parsed for the first time inside the realm that runs it, so
 * "this does not compile" arrived as a settled frame: one whole model turn
 * bought, spent, and answered with a syntax error. The r90 wave paid for nine
 * of them — `sympy__sympy-20154` emitted a 53 KB program that never ran and
 * then had it replayed back to it verbatim as input, `django__django-15987`
 * spent 59 % of the instance's whole bill on one dead cell, and
 * `sympy__sympy-18763` emitted the *same* syntax error twice in a row because
 * the first failure was invisible to it.
 *
 * Parsing is cheap and the controller can do it before it commits anything, so
 * it does: this module is the parse, and `CellTurn` answers what it finds
 * inside the same frame, at cached-prefix price, instead of ending the frame on
 * it.
 *
 * The same parse does one more thing: it normalizes the top-level statement
 * list so the persistent realm behaves like a notebook rather than like a script
 * that may only be run once. See {@link normalize}.
 *
 * Nothing here executes anything, and nothing here is a gate. The only outcome
 * it can produce is a rejection the model is asked to fix in this frame.
 *
 * @since 0.1.0
 */
import ts from "typescript"
import * as Cell from "./Cell.ts"

/**
 * What the boundary learned by parsing one cell.
 *
 * Exactly one of `rejected` and `compiled` is present: a cell either has a
 * program to run or a reason it does not.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Validation {
  /** Why the cell cannot run, when it cannot. */
  readonly rejected: Cell.Rejected | undefined
  /** The JavaScript to evaluate, when there is any. */
  readonly compiled: string | undefined
}

/**
 * The module syntax a cell used, named as the model would say it.
 *
 * @private
 */
type ModuleSyntax = "import" | "export" | "require"

/**
 * Finds module syntax a cell wrote, by parsing rather than by matching text.
 *
 * A cell has no module loader to reach, so this is a real violation. Its
 * strings are another matter: cells routinely pass a `bash` command whose
 * Python heredoc reads `from pathlib import Path`, or a `grep` pattern naming
 * `from _pytest import`. That text is data. A regexp over the source cannot
 * tell the two apart, and reading the source as text rejected five otherwise
 * correct SWE-bench frames in one wave, one of them an instance's opening
 * frame, each costing a whole turn to a rule the cell had not broken.
 *
 * A namespace body is not descended into. `export` inside one is not ESM, and
 * the namespace itself is refused by {@link nonErasableSyntax}.
 *
 * @private
 */
const moduleSyntax = (source: ts.SourceFile): ModuleSyntax | undefined => {
  let found: ModuleSyntax | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) found = "import"
    else if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) found = "export"
    else if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    ) found = "export"
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found = "import"
    else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) found = "import"
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      found = "require"
    } else if (!ts.isModuleDeclaration(node)) ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const nonErasableSyntax = (source: ts.SourceFile): string | undefined => {
  let found: string | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isEnumDeclaration(node)) found = "enum declarations"
    else if (ts.isModuleDeclaration(node)) found = "namespace/module declarations"
    else if (
      ts.isParameter(node) &&
      node.modifiers?.some((modifier) =>
          modifier.kind === ts.SyntaxKind.PublicKeyword ||
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword ||
          modifier.kind === ts.SyntaxKind.ReadonlyKeyword ||
          modifier.kind === ts.SyntaxKind.OverrideKeyword
        ) === true
    ) found = "parameter properties"
    else ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * The first thing a compiler refused, as a sentence naming where it is.
 *
 * The line and the offending text are the whole point. A model handed
 * "'}' expected." can only guess; handed "line 34: `if (a) {`" it edits the
 * line it wrote.
 *
 * @private
 */
const located = (text: string, diagnostic: ts.Diagnostic): string => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")
  /* v8 ignore next -- `transpileModule` attaches its synthetic source file and a position to every syntactic diagnostic it reports, and syntactic diagnostics are the only kind it reports; the guard discharges the optional types on `ts.Diagnostic`, which also covers program-wide diagnostics that have neither */
  if (diagnostic.file === undefined || diagnostic.start === undefined) return message
  const at = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  // A compiler points past the last token when the thing that is missing is a
  // closing one, so the named line is regularly blank. Quoting a blank line
  // says nothing and reads like a truncation, so it is left out.
  /* v8 ignore next -- the position came from the same text, so the line it names is a line this split produced; the coalesce discharges the optional type an index read carries */
  const line = (text.split("\n")[at.line] ?? "").trim()
  return `line ${at.line + 1}, column ${at.character + 1}: ${message}${line === "" ? "" : `\n  ${line}`}`
}

const firstError = (diagnostics: ReadonlyArray<ts.Diagnostic> | undefined): ts.Diagnostic | undefined =>
  diagnostics?.find((item) => item.category === ts.DiagnosticCategory.Error)

/**
 * One replacement of a byte range of a cell's compiled text.
 *
 * @private
 */
interface Splice {
  readonly start: number
  readonly end: number
  readonly text: string
}

/**
 * Finds a `return` the realm would refuse, wherever the cell put it.
 *
 * A REPL cell is a global async script, and `return` is a syntax error at the
 * top level of one — measured on the shipped QuickJS variant, which answers
 * `SyntaxError: return not in a function` and runs nothing at all. Function
 * bodies are skipped, because a `return` inside one is ordinary JavaScript.
 *
 * @private
 */
const topLevelReturn = (source: ts.SourceFile): ts.ReturnStatement | undefined => {
  let found: ts.ReturnStatement | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isReturnStatement(node)) found = node
    else if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

/**
 * The two names a REPL cell may not declare at its top level.
 *
 * They are the realm's own host bindings, and in a persistent realm a top-level
 * declaration of one is not a shadow — {@link normalize} makes it a `var`, and a
 * `var` over an existing global assigns. Under the per-cell realm that
 * assignment died with the cell; here it would take `ctx.call` or `console.log`
 * away from every later cell of the run.
 *
 * @private
 */
const reserved = ["ctx", "console"]

/**
 * Names every identifier one top-level declaration binds, patterns included.
 *
 * @private
 */
const declaredNames = (source: ts.SourceFile): ReadonlyArray<string> => {
  const found: Array<string> = []
  const fromName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      found.push(name.text)
      return
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) fromName(element.name)
    }
  }
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) fromName(declaration.name)
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined
    ) {
      found.push(statement.name.text)
    }
  }
  return found
}

/**
 * Rewrites a cell's top-level declarations so a persistent realm can re-run it.
 *
 * Raw persistence is not enough. Consecutive global evals in one QuickJS context
 * do share top-level `const`/`let` — they live in the realm's global lexical
 * scope, exactly like consecutive `<script>` tags — but that leaves a REPL three
 * measured edges: a later cell that reuses a name dies on
 * `SyntaxError: redeclaration of 'x'` with nothing run at all, a cell that
 * throws leaves every name below the throw permanently in TDZ — unreadable and
 * un-redeclarable for the rest of the run — and lexical names are invisible to
 * reflection, so no panel can enumerate them.
 *
 * All three are closed by one mechanical rewrite of the top-level statement list
 * only:
 *
 * - a top-level `const`/`let` variable statement becomes the same statement
 *   with the keyword `var`; destructuring patterns, initializers and multiple
 *   declarators are untouched, because only the keyword token moves;
 * - `let x;` with no initializer becomes `var x = undefined;`, so re-declaring
 *   a name really does clear it;
 * - a top-level `class K { … }` becomes `var K = class K { … };`;
 * - a top-level `function f() {}` is untouched, being already a redeclarable
 *   global;
 * - everything nested — function bodies, blocks, loop heads, class bodies — is
 *   untouched, so an inner `const` is still an inner `const` and a
 *   `for (const x of …)` head still scopes to its loop.
 *
 * The price is stated plainly: a top-level `const` is no longer read-only. That
 * is the same price every notebook pays. What it buys is that rebinding a name
 * is ordinary, a throw leaves no poison, and every live name is an own property
 * of `globalThis` — which is what makes the variables panel reflective instead
 * of parsed.
 *
 * @category conversions
 * @since 0.1.0
 */
export const normalize = (compiled: string): string => {
  const source = ts.createSourceFile("cell.js", compiled, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const splices: Array<Splice> = []
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const flags = ts.getCombinedNodeFlags(statement.declarationList)
      const isConst = (flags & ts.NodeFlags.Const) !== 0
      if (!isConst && (flags & ts.NodeFlags.Let) === 0) continue
      const keyword = statement.declarationList.getStart(source)
      splices.push({ start: keyword, end: keyword + (isConst ? "const".length : "let".length), text: "var" })
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer === undefined) {
          splices.push({ start: declaration.end, end: declaration.end, text: " = undefined" })
        }
      }
      continue
    }
    /* v8 ignore next -- a nameless top-level class is only spellable as `export default class {}`, and module syntax is refused before this runs; the guard discharges the optional type on `ClassDeclaration.name` */
    if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue
    const start = statement.getStart(source)
    splices.push({ start, end: start, text: `var ${statement.name.text} = ` })
    splices.push({ start: statement.end, end: statement.end, text: ";" })
  }
  if (splices.length === 0) return compiled
  let text = compiled
  for (const splice of [...splices].sort((left, right) => right.start - left.start)) {
    text = text.slice(0, splice.start) + splice.text + text.slice(splice.end)
  }
  return text
}

/**
 * Parses one cell and reports everything the parse can decide.
 *
 * It refuses a `return` the realm cannot compile, refuses a top-level
 * declaration of a name the realm owns, and normalizes the top-level
 * declarations the realm has to be able to re-run.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const validate = (cell: Cell.Source): Validation => {
  const isTypeScript = cell.language === "typescript"
  const parsed = ts.createSourceFile(
    isTypeScript ? "cell.ts" : "cell.js",
    cell.text,
    ts.ScriptTarget.ES2022,
    true,
    isTypeScript ? ts.ScriptKind.TS : ts.ScriptKind.JS
  )
  const refuse = (rejected: Cell.Rejected): Validation => ({ rejected, compiled: undefined })
  const moduleUse = moduleSyntax(parsed)
  if (moduleUse !== undefined) {
    return refuse(
      new Cell.Rejected({
        code: "imports_forbidden",
        message: `A cell may not ${moduleUse} anything: it runs in a realm with no module loader. ` +
          "Use ctx.call for every effect and ctx.flows for the catalog it may call; they are the only bindings a cell has."
      })
    )
  }
  if (isTypeScript) {
    const forbidden = nonErasableSyntax(parsed)
    if (forbidden !== undefined) {
      return refuse(
        new Cell.Rejected({
          code: "compile_failed",
          message: `The TypeScript cell uses ${forbidden}, which are not erasable syntax.`
        })
      )
    }
  }
  // Both languages are compiled, and only the TypeScript output is kept. The
  // JavaScript pass exists for its diagnostics: a cell that does not parse is
  // the single most expensive thing a frame can contain, and until this ran at
  // the boundary the only party that ever noticed was the realm — after the
  // model turn had been bought.
  const transpiled = ts.transpileModule(cell.text, {
    compilerOptions: isTypeScript
      ? {
        erasableSyntaxOnly: true,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      }
      : { allowJs: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: isTypeScript ? "cell.ts" : "cell.js",
    reportDiagnostics: true
  })
  const diagnostic = firstError(transpiled.diagnostics)
  if (diagnostic !== undefined) {
    return refuse(
      new Cell.Rejected({
        code: "compile_failed",
        message: `The cell did not compile — ${located(cell.text, diagnostic)}`
      })
    )
  }
  // The JavaScript a cell wrote is run as written. Only TypeScript is handed
  // to the emitter, and only to have its type-only syntax erased.
  const compiled = isTypeScript ? transpiled.outputText : cell.text
  const returned = topLevelReturn(parsed)
  if (returned !== undefined) {
    const at = parsed.getLineAndCharacterOfPosition(returned.getStart(parsed))
    return refuse(
      new Cell.Rejected({
        code: "compile_failed",
        message:
          `A cell is a script, not a function body, so the \`return\` on line ${
            at.line + 1
          } would not compile and nothing would run. ` +
          "Finish by calling instead: ctx.done(output) ends the run, ctx.park(reason, message) waits durably, and a cell that calls neither simply ends its turn."
      })
    )
  }
  const claimed = declaredNames(parsed).find((name) => reserved.includes(name))
  if (claimed !== undefined) {
    return refuse(
      new Cell.Rejected({
        code: "compile_failed",
        message:
          `A cell may not declare \`${claimed}\` at its top level: the realm outlives the cell, so that name is ` +
          "the run's own binding and declaring it would take it away from every later cell. Rename the variable."
      })
    )
  }
  return { rejected: undefined, compiled: normalize(compiled) }
}
