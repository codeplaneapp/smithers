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
 * `@smthrs/targets` from here lets a globally installed `smthrs` bootstrap a
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
import { fileURLToPath } from "node:url"

const installation = Symbol.for("smthrs/effect-resolution-installed")
const buildModuleParameter = "smithers-build-module"

const isBuildModule = (url) => {
  if (!url.startsWith("file:")) return false
  const parsed = new URL(url)
  if (parsed.searchParams.get(buildModuleParameter) === "1") return true
  const pathname = parsed.pathname
  // BUILD.ts is the legacy authoring surface; PACKAGE.ts, WORKSPACE.ts, and
  // the .smithers/*.ts siblings WORKSPACE.ts imports are the routed one.
  // All are authored as ES modules regardless of the host repository's
  // package.json `type`, so their format is pinned here.
  return pathname.endsWith("/BUILD.ts") ||
    pathname.endsWith("/PACKAGE.ts") ||
    pathname.endsWith("/WORKSPACE.ts") ||
    (pathname.includes("/.smithers/") && pathname.endsWith(".ts"))
}

/**
 * Installs the resolvers once per process.
 * @slop
 */
export const installEffectResolution = () => {
  if (globalThis[installation] === true) return
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const cliOwned = specifier === "effect" ||
        specifier.startsWith("effect/") ||
        specifier === "@smthrs/targets" ||
        specifier.startsWith("@smthrs/targets/")
      const resolved = cliOwned
        ? nextResolve(specifier, { ...context, parentURL: import.meta.url })
        : nextResolve(specifier, context)
      return isBuildModule(resolved.url) ? { ...resolved, format: "module" } : resolved
    }
  })
  // The CommonJS resolver on Node 22 rejects a `file:` URL request outright,
  // while newer versions convert it. Converting here makes the accepted
  // specifier set version-independent for the CommonJS-bridged BUILD.ts
  // evaluation path documented above. Only `file:` is converted; every other
  // request passes through untouched.
  const resolveFilename = Module._resolveFilename
  Module._resolveFilename = function(request, ...rest) {
    return resolveFilename.call(
      this,
      typeof request === "string" && request.startsWith("file:") ? fileURLToPath(request) : request,
      ...rest
    )
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
