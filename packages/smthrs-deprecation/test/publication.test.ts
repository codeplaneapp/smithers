import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"
import { beforeAll, describe, expect, it } from "vitest"
import { notice } from "./golden.ts"

const url = (path: string): URL => new URL(path, import.meta.url)
const manifest = JSON.parse(readFileSync(url("../package.json"), "utf8")) as {
  readonly bin?: unknown
  readonly dependencies?: unknown
  readonly engines?: { readonly node?: string }
  readonly exports?: unknown
  readonly sideEffects?: unknown
  readonly publishConfig?: { readonly access?: string; readonly tag?: string }
}

describe("the published manifest", () => {
  it("ships no bin, which is what makes the smithers-build rename collision-free", () => {
    // Contract section 3.4 renames the private build CLI's binary to
    // `smithers-build` and justifies it with "the deprecation package `smthrs`
    // ships no bin, so no `PATH` collision exists between the two names". A bin
    // added here would shadow @smthrs/cli's `smithers` on every machine that
    // installs both.
    expect(manifest.bin).toBeUndefined()
  })

  it("declares no dependencies, so installing the notice installs nothing else", () => {
    expect(manifest.dependencies).toBeUndefined()
  })

  it("keeps the side effect that is the whole package", () => {
    // A bundler told this module is side-effect free may drop the import, and
    // dropping the import drops the notice.
    expect(manifest.sideEffects).toBe(true)
  })

  it("exports the root and nothing else", () => {
    // Contract sections 3.3 and 3.5: `smthrs` exports `.` only.
    expect(manifest.exports).toEqual({ ".": "./src/index.ts" })
  })

  it("publishes publicly under the next dist-tag, so it never becomes an accidental install", () => {
    expect(manifest.publishConfig?.access).toBe("public")
    expect(manifest.publishConfig?.tag).toBe("next")
  })

  it("declares the repository Node floor the contract says every package declares", () => {
    // Contract section 1 states the supported Node minimum as `>=22.19.0` and
    // cites "every `packages/*/package.json` `engines.node`" as the evidence;
    // docs/pages/release/support-matrix.md republishes that sentence. A lower
    // floor here would make both statements false, so relaxing it to reach an
    // unmigrated 0.x project on older Node is a contract amendment, not a
    // manifest edit.
    expect(manifest.engines?.node).toBe(">=22.19.0")
  })
})

/**
 * Every file `publishConfig.exports` resolves to, plus the `type: commonjs`
 * marker that makes the CJS entry loadable, relative to the package root.
 */
const publishedEntries = [
  "dist/esm/index.js",
  "dist/esm/index.d.ts",
  "dist/cjs/index.js",
  "dist/cjs/package.json"
] as const

const missingEntries = (): ReadonlyArray<string> =>
  publishedEntries.filter((entry) => !existsSync(fileURLToPath(url(`../${entry}`))))

const builtCjs = fileURLToPath(url("../dist/cjs/index.js"))

// The published entries are built artifacts, not `src/index.ts`, so this suite
// needs a build to have happened. `//packages/smthrs-deprecation:test` declares
// `//packages/smthrs-deprecation:lib` as a dependency
// (`packages/repo-targets/src/BuildAndCheckTypeScriptPackage.ts`), so a build-graph run always
// arrives here with a complete `dist/` and nothing else writes to that
// directory while the suite runs. The two runners that reach vitest directly do
// not: a fresh checkout running `pnpm test` has no `dist/` at all, and
// `pnpm check` runs `tsc -b`, which emits `dist/esm` and never the CJS entry.
// Skipping on either would drop the only assertions about what npm actually
// publishes, and a partial build would report a module-resolution error rather
// than a missing notice, so build what is missing instead of deciding not to
// look.
beforeAll(() => {
  if (missingEntries().length === 0) return
  const build = spawnSync(process.execPath, [fileURLToPath(url("../scripts/build.mjs"))], {
    cwd: fileURLToPath(url("../")),
    encoding: "utf8"
  })
  if (build.status !== 0) {
    throw new Error(`building the published entries failed\n${build.stdout ?? ""}${build.stderr ?? ""}`)
  }
})

/** The names one exported statement introduces. */
const boundNames = (statement: ts.Statement): ReadonlyArray<string> => {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((declared) => declared.name.getText())
  }
  if (
    ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
    || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)
  ) {
    return [statement.name.getText()]
  }
  if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) {
    return [statement.name?.text ?? "default"]
  }
  return ["default"]
}

/**
 * Every name a declaration file offers an importer, in source order.
 *
 * The contract is that `smthrs` declares nothing, and matching text cannot
 * state that contract. `export interface Workflow {}` and
 * `export type Workflow = string` are exported names that carry neither an
 * `export declare` prefix nor an `export {` clause, so a pattern written
 * against those two spellings accepts both. Parsing states the contract
 * directly: a module exports a name three ways, through an `export` modifier,
 * an export clause, or an export assignment, and this reads all three off the
 * syntax tree. It also reads only the syntax tree, so an export spelled inside
 * a comment stays what it is, prose.
 */
const declaredExports = (declaration: string): ReadonlyArray<string> => {
  const parsed = ts.createSourceFile("index.d.ts", declaration, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  return parsed.statements.flatMap((statement) => {
    if (ts.isExportAssignment(statement)) return [statement.isExportEquals === true ? "export =" : "default"]
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause === undefined) return ["*"]
      return ts.isNamespaceExport(clause) ? [clause.name.text] : clause.elements.map((element) => element.name.text)
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    return exported ? boundNames(statement) : []
  })
}

describe("the built entries a consumer actually loads", () => {
  it("ships every file publishConfig.exports resolves to", () => {
    expect(missingEntries()).toEqual([])
  })

  it("throws the notice through the ESM entry", async () => {
    const failure = await import(url("../dist/esm/index.js").href).then(
      () => undefined,
      (error: unknown) => error as Error
    )

    expect(failure?.message).toBe(notice)
  })

  it("throws the notice through the CJS entry", () => {
    const require_ = createRequire(import.meta.url)

    expect(() => require_(builtCjs)).toThrow(notice)
  })

  it("marks the CJS directory commonjs, which is what lets require resolve the entry", () => {
    // The package is `type: module`, so without this file Node reads
    // `dist/cjs/index.js` as ESM: the `require` condition would stop resolving
    // to CommonJS, which is a broken publication even on the Node versions
    // whose `require(esm)` support hides it by still throwing the notice.
    // `scripts/build.mjs` writes the marker, and `files` publishes it.
    const marker = readFileSync(url("../dist/cjs/package.json"), "utf8")

    expect(JSON.parse(marker)).toEqual({ type: "commonjs" })
  })

  it("declares no importable type surface, because no import can ever resolve one", () => {
    // A declared export type-checks and then throws at run time, which is the
    // type-versus-runtime drift the umbrella used to be guarded against.
    const types = readFileSync(url("../dist/esm/index.d.ts"), "utf8")

    expect(declaredExports(types)).toEqual([])
  })
})

/**
 * A declaration this package must never emit, and the names it would hand an
 * importer. Every case is a one line edit to `src/index.ts` away, and the
 * empty-surface assertion is worth only what it rejects, so the reader runs
 * against each of them here.
 */
const mutations = [
  {
    case: "an exported interface",
    declaration: "export interface LegacyWorkflow { readonly id: string }",
    exports: ["LegacyWorkflow"]
  },
  {
    case: "an exported type alias",
    declaration: "export type LegacyWorkflow = { readonly id: string }",
    exports: ["LegacyWorkflow"]
  },
  {
    case: "a named re-export written without spaces inside the braces",
    declaration: "export {LegacyWorkflow} from \"./legacy.js\"",
    exports: ["LegacyWorkflow"]
  },
  {
    case: "a type-only re-export",
    declaration: "export type { LegacyWorkflow } from \"./legacy.js\"",
    exports: ["LegacyWorkflow"]
  },
  {
    case: "a star re-export",
    declaration: "export * from \"./legacy.js\"",
    exports: ["*"]
  },
  {
    case: "a namespace re-export",
    declaration: "export * as legacy from \"./legacy.js\"",
    exports: ["legacy"]
  },
  {
    case: "an exported declare const, which is what the old pattern did catch",
    declaration: "export declare const notice: string",
    exports: ["notice"]
  },
  {
    case: "an exported declare function",
    declaration: "export declare function run(): void",
    exports: ["run"]
  },
  {
    case: "a default export",
    declaration: "declare const notice: string\nexport default notice",
    exports: ["default"]
  },
  {
    case: "an export assignment, the CJS spelling",
    declaration: "declare const notice: string\nexport = notice",
    exports: ["export ="]
  },
  {
    case: "the empty-module marker tsc emits for a module with no exports",
    declaration: "export {}",
    exports: []
  },
  {
    case: "an unexported declaration, which no import can name",
    declaration: "declare const notice: string",
    exports: []
  },
  {
    case: "a comment that spells an export, which is prose and not a declaration",
    declaration: "/** Removed in 1.0: `export interface LegacyWorkflow {}`. */\nexport {}",
    exports: []
  }
] as const

describe("the reader the empty type surface assertion is made of", () => {
  for (const mutation of mutations) {
    it(`reports ${mutation.case}`, () => {
      expect(declaredExports(mutation.declaration)).toEqual(mutation.exports)
    })
  }
})
