/**
 * Installs the process-wide module resolvers required by BUILD.ts evaluation.
 *
 * Targets, the planner, and the flow engine exchange values branded by Effect's
 * runtime symbols. A linked workspace can otherwise load another physical
 * `effect` installation—even at the same version—and hand the engine schemas
 * it cannot interpret. BUILD.ts modules therefore resolve every `effect` bare
 * import from the CLI package that owns the runtime.
 *
 * The CLI also owns the BUILD.ts authoring surface. Resolving
 * `@smthrs/targets` from here lets a globally installed `smithers-build` bootstrap a
 * repository that has only a BUILD.ts; requiring the repository to install the
 * package would make generated package.json files circular to create.
 *
 * ## BUILD.ts module format
 *
 * The resolve hook below reports `format: "module"` for every BUILD.ts, so a
 * workspace whose nearest `package.json` declares no `type` still evaluates
 * its BUILD.ts as an ES module — but that override reaches tsx only when
 * these hooks were registered before tsx's loader was created. An evaluation
 * path that misses that window (a bootstrap that touches tsx first, or a
 * nested require from an already-CommonJS module) falls back to tsx's own
 * classification and evaluates BUILD.ts through the CommonJS bridge. There,
 * an `import` of a `file:` URL compiles to `require("file://...")` — valid
 * ESM, but accepted by the CommonJS resolver only on newer Node versions.
 * The `_resolveFilename` patch below converts a `file:` URL request to its
 * path first, so a URL import (for example one produced by
 * `import.meta.resolve`) behaves identically in both formats on every
 * supported Node version.
 *
 * @since 0.1.0
 */
import { default as Module, registerHooks } from "node:module"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"

const installation = Symbol.for("smthrs/effect-resolution-installed")
const buildModuleParameter = "smithers-build-module"

/** The bare specifiers the CLI owns, resolved from this file, not the importer. */
const isCliOwned = (specifier) =>
  specifier === "effect" ||
  specifier.startsWith("effect/") ||
  specifier === "@smthrs/targets" ||
  specifier.startsWith("@smthrs/targets/")

/**
 * TypeScript's `./foo.js` -> `foo.ts` mapping, in the compiler's probe order.
 *
 * tsx applies it on the ES-module path; the CommonJS bridge below applies the
 * same table so a declaration module's relative imports mean one thing.
 */
const jsExtensionSiblings = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"]
}

/** tsx's marker for the CommonJS virtual module it wraps a CJS `.ts` file in. */
const commonjsVirtualParameter = "tsx-commonjs-virtual-query"

/**
 * The declaration module a resolved URL names, as a `file:` URL with no query.
 *
 * tsx re-encodes a nested import's own query into the pathname
 * (`…/PACKAGE.ts%3Fnamespace=…`) and appends its search parameters, so neither
 * the href nor the raw pathname ends in the file's extension. Cutting at the
 * encoded query first makes the match hold for a nested declaration module,
 * not only for the one an import started at.
 *
 * Returns `undefined` for everything that is not a declaration module.
 */
const buildModuleBase = (url) => {
  if (!url.startsWith("file:")) return undefined
  const parsed = new URL(url)
  const encoded = parsed.pathname.search(/%3F/i)
  const filePart = encoded === -1 ? parsed.pathname : parsed.pathname.slice(0, encoded)
  const base = `file://${parsed.host}${filePart}`
  if (parsed.searchParams.get(buildModuleParameter) === "1") return base
  const pathname = decodeURIComponent(filePart)
  // BUILD.ts is the legacy authoring surface; PACKAGE.ts, WORKSPACE.ts, and
  // the .smithers/*.ts siblings WORKSPACE.ts imports are the routed one.
  // All are authored as ES modules regardless of the host repository's
  // package.json `type`, so their format is pinned here.
  const declaration = pathname.endsWith("/BUILD.ts") ||
    pathname.endsWith("/PACKAGE.ts") ||
    pathname.endsWith("/WORKSPACE.ts") ||
    (pathname.includes("/.smithers/") && pathname.endsWith(".ts"))
  return declaration ? base : undefined
}

/**
 * The resolution a declaration module gets: the ES-module format, always.
 *
 * On the Node version this repository pins (22.19.0) tsx answers a declaration
 * module whose nearest package.json declares no `type` with a CommonJS virtual
 * module. That module is a second instance of a file the ES-module graph may
 * already hold, so a workspace mixing `type` declarations across its packages
 * loaded one PACKAGE.ts twice and reported the shared targets it exports as
 * unowned. Rewriting the URL back to the plain file drops tsx's virtual wrapper
 * and leaves one instance per file, which is what a newer Node already does.
 */
const asBuildModule = (resolved, base) => {
  const parsed = new URL(resolved.url)
  if (!parsed.searchParams.has(commonjsVirtualParameter)) return { ...resolved, format: "module" }
  const rewritten = new URL(base)
  for (const [name, value] of parsed.searchParams) {
    if (name !== commonjsVirtualParameter) rewritten.searchParams.set(name, value)
  }
  return { ...resolved, url: rewritten.href, format: "module" }
}

/**
 * Installs the resolvers once per process.
 * @slop
 */
export const installEffectResolution = () => {
  if (globalThis[installation] === true) return
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = isCliOwned(specifier)
        ? nextResolve(specifier, { ...context, parentURL: import.meta.url })
        : nextResolve(specifier, context)
      const base = buildModuleBase(resolved.url)
      return base === undefined ? resolved : asBuildModule(resolved, base)
    }
  })
  // Everything above reaches the ES-module resolver only. On Node 22.19.0 --
  // the version this repository pins and CI runs -- tsx routes a declaration
  // module whose nearest package.json declares no `type` through a CommonJS
  // virtual module, and every specifier that module names is then resolved by
  // `Module._resolveFilename`, where none of the hooks apply. A newer Node
  // keeps the same file on the ES-module path, so the two versions disagreed
  // about what a workspace declares. The patch below gives the CommonJS
  // resolver the same three rules:
  //
  //   1. A `file:` URL request becomes its path. Node 22's CommonJS resolver
  //      rejects the URL form outright while newer versions convert it.
  //   2. A CLI-owned bare specifier resolves from this file, so a workspace
  //      that installs nothing still finds `@smthrs/targets` and the one
  //      `effect` the engine's branded values came from.
  //   3. A NodeNext `./x.js` specifier falls back to the TypeScript file next
  //      to it. The fallback runs only after real resolution failed, so an
  //      existing `.js` still wins and a specifier that resolves to nothing
  //      still reports itself.
  const resolveFilename = Module._resolveFilename
  const self = fileURLToPath(import.meta.url)
  const cliParent = { id: self, filename: self, paths: Module._nodeModulePaths(NodePath.dirname(self)) }
  Module._resolveFilename = function(request, parent, ...rest) {
    const specifier = typeof request === "string" && request.startsWith("file:")
      ? fileURLToPath(request)
      : request
    if (typeof specifier !== "string") return resolveFilename.call(this, specifier, parent, ...rest)
    if (isCliOwned(specifier)) return resolveFilename.call(this, specifier, cliParent, ...rest)
    try {
      return resolveFilename.call(this, specifier, parent, ...rest)
    } catch (unresolved) {
      const suffix = Object.keys(jsExtensionSiblings).find((extension) => specifier.endsWith(extension))
      if (suffix === undefined) throw unresolved
      for (const sibling of jsExtensionSiblings[suffix]) {
        try {
          return resolveFilename.call(this, `${specifier.slice(0, -suffix.length)}${sibling}`, parent, ...rest)
        } catch {
          // The next sibling, then the original failure.
        }
      }
      throw unresolved
    }
  }
  Object.defineProperty(globalThis, installation, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  })
}

/**
 * Marks one admitted BUILD.ts URL for ES-module evaluation.
 * @slop
 */
export const buildModuleUrl = (url) => {
  const marked = new URL(url)
  marked.searchParams.set(buildModuleParameter, "1")
  return marked.href
}
