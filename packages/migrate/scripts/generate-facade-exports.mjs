/**
 * Regenerates `src/internal/FacadeExports.ts` from a Smithers 0.x checkout.
 *
 * The catalog cannot be written by hand: the old facade re-exports 305 values
 * from `packages/smithers/src/index.js` alone, and eight more barrels carry the
 * subpath surfaces application code imports. This script reads that export
 * graph and writes the generated data module the catalog builds its rows from.
 *
 * It also reads every `<Component>Props.ts` beside the old components, because
 * a prop the catalog does not name is a prop no class escalation can see: that
 * is how a `skipIf` or a `maxConcurrency` slips through as automatic.
 *
 * Usage: node scripts/generate-facade-exports.mjs [old-checkout] [--check]
 *
 * The default checkout is `/Users/williamcory/smithers`. The generated file is
 * committed, so the old tree is needed only when the surface changes.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const ts = require("typescript")

const here = dirname(fileURLToPath(import.meta.url))
const check = process.argv.includes("--check")
const args = process.argv.slice(2).filter((value) => value !== "--check")
const oldRoot = resolve(args[0] ?? "/Users/williamcory/smithers")
const facadeDir = join(oldRoot, "packages/smithers")
const target = join(here, "../src/internal/FacadeExports.ts")

if (!existsSync(join(facadeDir, "package.json"))) {
  console.error(`no Smithers 0.x checkout at ${oldRoot}; nothing to regenerate`)
  process.exit(2)
}

const read = (file) => readFileSync(file, "utf8")

const parse = (file) =>
  ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS
  )

/**
 * The entry file one `@smthrs/<package>[/<subpath>]` specifier resolves to
 * inside the old checkout. Returns `undefined` for a package outside it.
 */
const resolveWorkspace = (specifier) => {
  const parts = specifier.split("/")
  if (parts[0] !== "@smthrs" || parts[1] === undefined) return undefined
  const packageDir = join(oldRoot, "packages", parts[1])
  const manifestPath = join(packageDir, "package.json")
  if (!existsSync(manifestPath)) return undefined
  const packageManifest = JSON.parse(read(manifestPath))
  const key = parts.length === 2 ? "." : `./${parts.slice(2).join("/")}`
  const condition = packageManifest.exports?.[key]
  const entry = typeof condition === "string" ? condition : condition?.import ?? condition?.default
  if (typeof entry === "string") return join(packageDir, entry)
  if (parts.length > 2) {
    for (const extension of [".js", ".ts", "/index.js", "/index.ts"]) {
      const guess = join(packageDir, "src", `${parts.slice(2).join("/")}${extension}`)
      if (existsSync(guess)) return guess
    }
    return undefined
  }
  const main = typeof packageManifest.main === "string" ? packageManifest.main : "src/index.js"
  return join(packageDir, main)
}

/**
 * The named value exports of one barrel, with the module each came from.
 *
 * `export * from` is followed through relative paths and through `@smthrs/*`
 * workspace packages, because that is how the facade's subpath barrels are
 * written: `src/gateway-react.js` is one `export * from "@smthrs/gateway-react"`.
 */
const exportsOf = (file, origin, seen = new Set()) => {
  if (file === undefined || seen.has(file)) return []
  if (!existsSync(file) || !statSync(file).isFile()) return []
  seen.add(file)
  const source = parse(file)
  const found = []
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue
    const from = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : ""
    if (statement.exportClause === undefined) {
      const next = from.startsWith(".") ? join(dirname(file), from) : resolveWorkspace(from)
      found.push(...exportsOf(next, from.startsWith(".") ? origin : from, seen))
      continue
    }
    if (!ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue
      found.push({ name: element.name.text, module: from === "" ? origin : from })
    }
  }
  for (const statement of source.statements) {
    // A barrel written as `export const x = ...` or `export function x() {}`.
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : []
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) found.push({ name: declaration.name.text, module: origin })
      }
      continue
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined) {
      found.push({ name: statement.name.text, module: origin })
    }
  }
  return found
}

/**
 * The old component props, read from `packages/components/src/components`.
 *
 * Every `<Name>Props.ts` there declares one component's props. The declarations
 * are plain type aliases and interfaces over type literals, intersections,
 * `Omit`, and references to a sibling file, so the shapes below cover the whole
 * directory without a type checker.
 */
const componentsDir = join(oldRoot, "packages/components/src/components")

const propsFiles = () => {
  const found = []
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (item.isDirectory()) walk(join(dir, item.name))
      else if (item.name.endsWith("Props.ts")) found.push(join(dir, item.name))
    }
  }
  if (existsSync(componentsDir)) walk(componentsDir)
  return found
}

/** The file one relative specifier resolves to. */
const sibling = (from, specifier) => {
  const base = join(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return base
}

const declarationCache = new Map()

/** The type declarations one file makes, plus the file each imported name comes from. */
const declarationsOf = (file) => {
  const cached = declarationCache.get(file)
  if (cached !== undefined) return cached
  const found = new Map()
  const imports = new Map()
  if (existsSync(file) && statSync(file).isFile()) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        found.set(statement.name.text, statement)
        continue
      }
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const specifier = statement.moduleSpecifier.text
      if (!specifier.startsWith(".")) continue
      const bindings = statement.importClause?.namedBindings
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements) imports.set(element.name.text, sibling(file, specifier))
    }
  }
  const record = { found, imports }
  declarationCache.set(file, record)
  return record
}

const memberNames = (members) =>
  members.flatMap((member) =>
    (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
      member.name !== undefined &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
      ? [member.name.text]
      : []
  )

const literalNames = (type) => {
  if (type === undefined) return []
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return [type.literal.text]
  if (ts.isUnionTypeNode(type)) return type.types.flatMap(literalNames)
  return []
}

const namesOfType = (file, type, seen) => {
  if (type === undefined) return []
  if (ts.isTypeLiteralNode(type)) return memberNames(type.members)
  if (ts.isIntersectionTypeNode(type)) return type.types.flatMap((part) => namesOfType(file, part, seen))
  if (ts.isParenthesizedTypeNode(type)) return namesOfType(file, type.type, seen)
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return []
  const reference = type.typeName.text
  const args = type.typeArguments ?? []
  if (reference === "Omit" && args[0] !== undefined) {
    const removed = new Set(literalNames(args[1]))
    return namesOfType(file, args[0], seen).filter((name) => !removed.has(name))
  }
  if (reference === "Pick" && args[0] !== undefined) {
    const kept = new Set(literalNames(args[1]))
    return namesOfType(file, args[0], seen).filter((name) => kept.has(name))
  }
  if (["Partial", "Readonly", "Required"].includes(reference) && args[0] !== undefined) {
    return namesOfType(file, args[0], seen)
  }
  return namesOfDeclaration(file, reference, seen)
}

const namesOfDeclaration = (file, name, seen) => {
  const key = `${file}#${name}`
  if (seen.has(key)) return []
  seen.add(key)
  const { found, imports } = declarationsOf(file)
  const declaration = found.get(name)
  if (declaration === undefined) {
    const next = imports.get(name)
    return next === undefined ? [] : namesOfDeclaration(next, name, seen)
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    const inherited = (declaration.heritageClauses ?? []).flatMap((clause) =>
      clause.types.flatMap((type) =>
        ts.isIdentifier(type.expression) ? namesOfDeclaration(file, type.expression.text, seen) : []
      )
    )
    return [...inherited, ...memberNames(declaration.members)]
  }
  return namesOfType(file, declaration.type, seen)
}

const props = new Map()
for (const file of propsFiles()) {
  for (const [name] of declarationsOf(file).found) {
    if (!name.endsWith("Props") || name === "Props") continue
    const component = name.slice(0, -"Props".length)
    const names = [...new Set(namesOfDeclaration(file, name, new Set()))].sort()
    if (names.length === 0) continue
    if ((props.get(component)?.length ?? 0) >= names.length) continue
    props.set(component, names)
  }
}

const manifest = JSON.parse(read(join(facadeDir, "package.json")))
const skip = new Set(["./package.json", "./*", "./jsx-runtime", "./jsx-dev-runtime"])
const rows = new Map()

for (const [subpath, condition] of Object.entries(manifest.exports)) {
  if (skip.has(subpath)) continue
  const entry = typeof condition === "string" ? condition : condition?.import
  if (typeof entry !== "string") continue
  for (const { module, name } of exportsOf(join(facadeDir, entry), `smthrs${subpath.slice(1)}`)) {
    const key = `${subpath} ${name}`
    if (rows.has(key)) continue
    rows.set(key, { module, name, subpath: subpath === "." ? "" : subpath.slice(2) })
  }
}

const compare = (left, right) =>
  left.subpath < right.subpath
    ? -1
    : left.subpath > right.subpath
    ? 1
    : left.name < right.name
    ? -1
    : left.name > right.name
    ? 1
    : 0

const sorted = [...rows.values()].sort(compare)

const lines = sorted.map((row) =>
  `  { name: ${JSON.stringify(row.name)}, subpath: ${JSON.stringify(row.subpath)}, module: ${
    JSON.stringify(row.module)
  } }`
)

const propLines = [...props.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1)).map(([name, names]) =>
  `  ${JSON.stringify(name)}: [${names.map((value) => JSON.stringify(value)).join(", ")}]`
)

const body = `/**
 * Every value the Smithers 0.x facade exports, and every prop its components
 * declare.
 *
 * Generated by \`scripts/generate-facade-exports.mjs\` from the old checkout's
 * \`packages/smithers\` export graph and \`packages/components\` prop
 * declarations (version ${manifest.version}). Do not edit by hand: \`Constructs\`
 * turns each row into a catalog entry, and a name that is missing here is a
 * name the scanner drops on the floor.
 *
 * @since 0.1.0
 */

/**
 * One value export of the old facade.
 *
 * @category models
 * @since 0.1.0
 */
export interface FacadeExport {
  /** The identifier application code imports. */
  readonly name: string
  /** The subpath it is imported from, \`""\` for the root entry point. */
  readonly subpath: string
  /** The old package the facade re-exports it from. */
  readonly module: string
}

/**
 * The generated export list, sorted by subpath then name.
 *
 * @category models
 * @since 0.1.0
 */
export const facadeExports: ReadonlyArray<FacadeExport> = [
${lines.join(",\n")}
]

/**
 * The props each old component declares, by component name, sorted.
 *
 * Read from the \`<Name>Props.ts\` files beside the old components. \`Constructs\`
 * merges these into every component row, so a class escalation can see any prop
 * the old component accepted.
 *
 * @category models
 * @since 0.1.0
 */
export const componentProps: Readonly<Record<string, ReadonlyArray<string>>> = {
${propLines.join(",\n")}
}
`

// dprint owns the layout of every file in this package, the generated one
// included, so the script hands its output to dprint before comparing or
// writing. Otherwise `run lint` and `--check` disagree forever.
const formatted = execFileSync(join(here, "../node_modules/.bin/dprint"), ["fmt", "--stdin", "FacadeExports.ts"], {
  cwd: join(here, ".."),
  input: body,
  encoding: "utf8"
})

if (check) {
  if (!existsSync(target) || read(target) !== formatted) {
    console.error("src/internal/FacadeExports.ts is stale; run node scripts/generate-facade-exports.mjs")
    process.exit(1)
  }
  process.exit(0)
}

writeFileSync(target, formatted)
console.log(`wrote ${sorted.length} export rows and ${propLines.length} prop rows to src/internal/FacadeExports.ts`)
