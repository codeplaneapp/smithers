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
 * ## Hook order
 *
 * Two resolve hooks are registered, because the two jobs want opposite
 * positions in the chain. Node runs resolve hooks newest first, and tsx
 * registers a fresh namespace loader for every declaration module this CLI
 * evaluates.
 *
 * {@link parentHooks} pins a CLI-owned specifier, and has to run BEFORE tsx's
 * loader: tsx reads the namespace to apply from the `parentURL` it was handed
 * and stamps it onto whatever the rest of the chain returns, so a rewrite
 * performed underneath tsx changes the package the module is read from but not
 * the namespace it lands in. It is therefore re-registered after every tsx
 * registration; {@link importDeclarationModule} is what keeps that true.
 *
 * {@link formatHooks} pins a declaration module's format and identity, and has
 * to run AFTER tsx's loader, because both rules read what tsx resolved. It
 * stays where it was first registered and is never moved.
 *
 * ## BUILD.ts module format
 *
 * The format hook below reports `format: "module"` for every BUILD.ts, so a
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
import { randomUUID } from "node:crypto"
import { createRequire, default as Module, registerHooks } from "node:module"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { register as registerCommonJs } from "tsx/cjs/api"
import { register as registerModule } from "tsx/esm/api"

const installation = Symbol.for("smthrs/effect-resolution-installed")
const registration = Symbol.for("smthrs/effect-resolution-registration")
const buildModuleParameter = "smithers-build-module"

/**
 * This file's own URL with every query stripped.
 *
 * `import.meta.url` is not it. A declaration module imports the CLI's modules,
 * so tsx evaluates a second copy of this file inside that module's namespace
 * and the copy's `import.meta.url` carries `?tsx-namespace=`. Resolving from
 * that URL asks tsx for `effect` in the very namespace this resolver exists to
 * escape. The bare path names one installation from every copy.
 *
 * This is the request-side half of the single-instance guard;
 * {@link withoutNamespace} is the result-side half. Either one alone holds the
 * bare specifiers, which is why removing just this one changes nothing
 * measurable. It is kept because the other half depends on resolving
 * {@link effectRoot}, and a host layout where that resolution fails would
 * otherwise leave the bare specifiers unguarded.
 */
const cliParentUrl = (() => {
  const url = new URL(import.meta.url)
  url.search = ""
  url.hash = ""
  return url.href
})()

/**
 * The bare specifiers the CLI owns, resolved from this file, not the importer.
 *
 * A package belongs here when two physical copies of it would disagree, not
 * merely when it is shared. `effect` holds schema sentinels compared by
 * identity. `@smthrs/plan` keeps each node's continuation and mapper in a
 * module-level `WeakMap` keyed by the AST object, so a second copy has a second
 * table: the node is registered in one and read from the other, and the graph
 * walk reports the continuation as missing with a message that blames
 * serialization. `@smthrs/core` and `@smthrs/flow` build and read those same
 * nodes, so they resolve from here for the same reason.
 */
const isCliOwned = (specifier) =>
  specifier === "effect" ||
  specifier.startsWith("effect/") ||
  cliOwnedPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))

/** Workspace packages whose module-level state is compared by identity. */
const cliOwnedPackages = ["@smthrs/targets", "@smthrs/plan", "@smthrs/core", "@smthrs/flow"]

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

/** tsx's marker for the module registry one `tsImport` call evaluates into. */
const namespaceParameter = "tsx-namespace"

/**
 * The directory holding the Effect installation this CLI runs on.
 *
 * A bare `effect` import is pinned by rewriting `parentURL`, but a declaration
 * module may also import one of these files by absolute URL — a BUILD.ts that
 * writes `import.meta.resolve("effect/Schema")` into a generated file does.
 * That specifier names the right file already; what it lacks is protection
 * from tsx stamping a namespace onto the result and producing a second
 * instance of it. This root is what lets {@link withoutNamespace} recognize
 * the resolutions that must stay on one instance.
 *
 * This is the only rule covering that absolute-URL import, which the CLI's own
 * BUILD.ts fixtures write with `import.meta.resolve("effect/Schema")`: the
 * specifier is not bare, so re-parenting never sees it. Removing this rule puts
 * a second Effect instance back into such a workspace.
 *
 * Only Effect is pinned this way. Effect ships built JavaScript, so a
 * namespace-free URL still loads; `@smthrs/targets` ships TypeScript sources
 * whose namespaced form only tsx's loader compiles, and stripping a namespace
 * it already carries hands Node a file it cannot parse. Two copies of the
 * target definitions interoperate as long as both build their schemas out of
 * one Effect.
 */
const effectRoot = (() => {
  try {
    return NodePath.dirname(createRequire(cliParentUrl).resolve("effect/package.json")) + NodePath.sep
  } catch {
    // A host without the package resolves nothing through it either.
    return undefined
  }
})()

/** Strips tsx's namespace from a resolution that must stay on one instance. */
const withoutNamespace = (url) => {
  if (effectRoot === undefined || !url.startsWith("file:") || !url.includes(namespaceParameter)) return url
  const parsed = new URL(url)
  if (!parsed.searchParams.has(namespaceParameter)) return url
  if (!fileURLToPath(`${parsed.protocol}//${parsed.host}${parsed.pathname}`).startsWith(effectRoot)) return url
  parsed.searchParams.delete(namespaceParameter)
  return parsed.href
}

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
 * Pins every CLI-owned specifier to this installation. Runs before tsx's
 * loader; see the hook-order note above.
 */
const parentHooks = {
  resolve(specifier, context, nextResolve) {
    const resolved = isCliOwned(specifier)
      ? nextResolve(specifier, { ...context, parentURL: cliParentUrl })
      : nextResolve(specifier, context)
    const url = withoutNamespace(resolved.url)
    return url === resolved.url ? resolved : { ...resolved, url }
  }
}

/**
 * Pins a declaration module's format and identity. Runs after tsx's loader;
 * see the hook-order note above.
 */
const formatHooks = {
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    const base = buildModuleBase(resolved.url)
    return base === undefined ? resolved : asBuildModule(resolved, base)
  }
}

/**
 * Re-registers {@link parentHooks} so it runs before every hook registered so
 * far.
 *
 * Each tsx namespace loader wraps this resolver and derives its namespace from
 * the importer it was handed, so `effect` imported from a BUILD.ts lands in
 * that BUILD.ts's namespace and `effect` imported from the CLI lands in the
 * CLI's — two physical module instances whose schema internals do not
 * interoperate. Moving this resolver back to the front after each tsx
 * registration restores the single instance: tsx then reads the rewritten
 * `parentURL`, which names one installation and carries no namespace, and
 * leaves the resolution alone.
 * @slop
 */
const reassert = () => {
  const previous = globalThis[registration]
  if (previous === undefined) return
  previous.deregister()
  globalThis[registration] = registerHooks(parentHooks)
}

/**
 * Evaluates one declaration module through tsx with the parent resolver in
 * front of tsx's namespace loader.
 *
 * `tsImport` registers that loader and imports in one call, which leaves no
 * point at which the resolver can be moved back to the front. The two steps
 * are taken separately here for that reason. The loader stays registered
 * afterwards, as `tsImport` leaves it, so a module the declaration imports
 * lazily still resolves.
 * @slop
 */
export const importDeclarationModule = async (url, parentURL) => {
  installEffectResolution()
  const namespace = randomUUID()
  // Both halves, as `tsImport` registers them. The CommonJS half is what
  // answers a `require` that a declaration module reaches through the
  // CommonJS bridge, and it must know this namespace or the request arrives
  // carrying a namespace nothing resolves.
  registerCommonJs({ namespace })
  const loader = registerModule({ namespace, parentURL, tsconfig: false })
  reassert()
  return await loader.import(url, parentURL)
}

/**
 * Installs the resolvers once per process.
 * @slop
 */
export const installEffectResolution = () => {
  if (globalThis[installation] === true) return
  // Oldest first, so the format hook ends up behind tsx and the parent hook in
  // front of it. See the hook-order note above.
  registerHooks(formatHooks)
  globalThis[registration] = registerHooks(parentHooks)
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
  //
  // Rule 2 resolves from `cliParentUrl` for the reason that constant exists: a
  // copy of this file evaluated inside a tsx namespace must still name the one
  // installation.
  const resolveFilename = Module._resolveFilename
  const self = fileURLToPath(cliParentUrl)
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
