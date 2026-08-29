/**
 * File-system routing over metadata-only registry discovery.
 *
 * @since 0.1.0
 */
import type * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { FsError } from "./FsError.ts"
import type { Route } from "./Route.ts"

/**
 * Configuration for a file-router scan.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ScanConfig {
  readonly root: string
}

/**
 * A non-fatal diagnostic emitted while routing a flows tree.
 *
 * Registry diagnostics are retained unchanged; router diagnostics use the
 * same structural shape so callers can render one ordered list.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Warning {
  readonly code: string
  readonly path: string
  readonly message: string
  readonly name?: string | undefined
  readonly cause?: unknown
}

/**
 * The metadata-only result of scanning a flows tree.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ScanResult {
  readonly routes: ReadonlyArray<Route>
  readonly warnings: ReadonlyArray<Warning>
}

const compareStrings = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

const toSegments = (path: Path.Path, root: string, sourcePath: string): ReadonlyArray<string> => {
  const relative = path.relative(root, path.dirname(sourcePath))
  if (relative === "" || relative === ".") {
    return []
  }
  return relative.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".")
}

const kindOf = (descriptor: Descriptor.FlowDescriptor): Route["kind"] => {
  if (descriptor.body._tag === "Module") {
    return "module"
  }
  return descriptor.path.split(/[\\/]/).at(-1) === "SKILL.md" ? "skill" : "markdown"
}

const discoveryFailure = (cause: unknown): FsError =>
  new FsError({
    code: "discovery_failed",
    method: "scan",
    description: "Could not discover flow routes",
    cause
  })

/**
 * Scans a flows root without importing or evaluating any flow module.
 *
 * The registry owns entry precedence, metadata parsing, directive detection,
 * and bounded reads. This adapter only projects descriptors into path-derived
 * command routes and records colocated UI modules.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const scan = (config: ScanConfig): Effect.Effect<ScanResult, FsError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // TODO port: Registry discovery is parameterized over the kernel's
    // permission-aware filesystem tag. Its read-only method surface is the
    // Effect FileSystem surface used here, so this adapter remains portable.
    const discovery = Discovery.make(fileSystem, path)
    const result = yield* discovery.scan({
      source: "flows",
      root: config.root,
      naming: "path"
    }).pipe(Effect.mapError(discoveryFailure))

    const routes: Array<Route> = []
    for (const descriptor of result.entries) {
      const segments = toSegments(path, config.root, descriptor.path)
      // Discovery excludes this already. Keep the guard at this projection
      // boundary so a future descriptor source cannot give the root a route.
      if (segments.length === 0) {
        continue
      }
      const directory = path.dirname(descriptor.path)
      const uiPath = path.join(directory, "ui.tsx")
      const hasUi = yield* fileSystem.exists(uiPath).pipe(Effect.mapError(discoveryFailure))
      routes.push({
        name: segments.join("/"),
        segments,
        kind: kindOf(descriptor),
        sourcePath: descriptor.path,
        description: Option.some(descriptor.description),
        input: descriptor.input,
        output: descriptor.output,
        capabilities: descriptor.capabilities,
        effects: descriptor.effects,
        modelInvocable: descriptor.modelInvocable,
        placement: descriptor.placement,
        ui: hasUi ? Option.some(uiPath) : Option.none()
      })
    }

    routes.sort((left, right) => compareStrings(left.name, right.name))
    return {
      routes,
      warnings: result.warnings
    }
  })
