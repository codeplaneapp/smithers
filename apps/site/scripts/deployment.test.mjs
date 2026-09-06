/** Validate real Alchemy entry points offline; never evaluate or deploy a stack. */
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { join, resolve } from "node:path"
import test from "node:test"
import * as Effect from "effect/Effect"
import ts from "typescript"
import { sites } from "../../docs/shared/manifest.mjs"

const root = resolve(import.meta.dirname, "../../..")

test("all deployment entry points import as Alchemy 2 stack effects", async (t) => {
  const overrides = new Map()
  const set = (name, value) => {
    overrides.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  t.after(() => {
    for (const [name, value] of overrides) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  set("SMITHERS_SITE_DOMAIN", undefined)
  set("SMITHERS_SITE_WORKER_NAME", undefined)
  const entryPoints = [join(root, "apps/site/alchemy.run.ts")]
  for (const site of sites) {
    set(`${site.slug.toUpperCase().replaceAll("-", "_")}_WORKER_NAME`, `docs-test-${site.slug}`)
    entryPoints.push(join(site.siteDir, "alchemy.run.ts"))
  }
  for (const path of entryPoints) {
    const module = await import(pathToFileURL(path).href)
    assert.ok(Effect.isEffect(module.default), `${path}: the CLI needs a default-exported stack effect`)
  }
})

test("stack properties and shared implementation typecheck against the declared Alchemy API", () => {
  const program = ts.createProgram({
    rootNames: [
      join(root, "apps/site/alchemy.run.ts"),
      join(root, "apps/docs/shared/alchemy-site.mjs"),
      ...sites.map((site) => join(site.siteDir, "alchemy.run.ts"))
    ],
    options: {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      allowJs: true,
      checkJs: true,
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext
    }
  })
  const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n"
  }))
})

test("package stacks require an explicit physical Worker identity", async () => {
  const { makeDocsSiteStack } = await import("../../docs/shared/alchemy-site.mjs")
  const key = "UNCONFIGURED_DOCS_TEST_WORKER_NAME"
  const previous = process.env[key]
  delete process.env[key]
  try {
    assert.throws(() => makeDocsSiteStack({ slug: "unconfigured-docs-test" }), /Set UNCONFIGURED_DOCS_TEST_WORKER_NAME/)
  } finally {
    if (previous !== undefined) process.env[key] = previous
  }
})
