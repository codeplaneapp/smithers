/**
 * The executor's half of the flow catalog: registry discovery over the flows
 * directory, joined with the `Smithers.Flow` declarations and written or
 * checked as `flows/catalog.json`.
 *
 * The rendering rules live in `@smthrs/targets/FlowCatalog`, which owns the
 * row shape and the ordering. This module only supplies what a pure module
 * cannot: the discovery walk, which is the same code path `smthrs ls` runs,
 * so the catalog can never list a flow the CLI would not.
 *
 * @since 1.0.0
 */
import type { Action, FlowRuntime } from "@smthrs/flow"
import * as Discovery from "@smthrs/registry/Discovery"
import * as FlowCatalog from "@smthrs/targets/FlowCatalog"
import * as GeneratedFile from "@smthrs/targets/GeneratedFile"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as NodePath from "node:path"
import { posix } from "./internal/Text.ts"

const kindOf = (entryPath: string): FlowCatalog.Kind | undefined => {
  switch (NodePath.basename(entryPath)) {
    case "flow.ts":
      return "ts"
    case "flow.mdx":
      return "mdx"
    case "SKILL.md":
      return "skill"
    default:
      return undefined
  }
}

/**
 * Discovers every flow under one workspace-relative directory, reduced to the
 * fields the catalog carries. Paths are workspace-relative and POSIX.
 *
 * @category effects
 * @since 1.0.0
 */
export const discoverFlows = (
  workspaceRoot: string,
  root: string
): Effect.Effect<
  ReadonlyArray<FlowCatalog.DiscoveredFlow>,
  FlowCatalog.FlowCatalogError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const absoluteRoot = NodePath.join(workspaceRoot, ...root.split("/"))
    const scan = yield* Discovery.make(fs, path).scan({ source: "project", root: absoluteRoot, naming: "path" }).pipe(
      Effect.mapError((cause) =>
        new FlowCatalog.FlowCatalogError({
          message: `could not discover the flows under ${root}: ${cause.message}`
        })
      )
    )
    const flows: Array<FlowCatalog.DiscoveredFlow> = []
    for (const descriptor of scan.entries) {
      const kind = kindOf(descriptor.body.path)
      if (kind === undefined) {
        return yield* new FlowCatalog.FlowCatalogError({
          message: `discovery reported ${JSON.stringify(descriptor.name)} from an entry the catalog does not know: ${
            NodePath.basename(descriptor.body.path)
          }`
        })
      }
      flows.push({
        id: descriptor.name,
        description: descriptor.description,
        kind,
        path: posix(NodePath.relative(workspaceRoot, descriptor.body.path)),
        capabilities: descriptor.capabilities,
        model: Option.getOrNull(descriptor.model),
        modelInvocable: descriptor.modelInvocable
      })
    }
    return flows
  })

/**
 * Discovers, joins, and writes or checks one catalog.
 *
 * @category effects
 * @since 1.0.0
 */
export const renderCatalog = (
  workspaceRoot: string,
  payload: FlowCatalog.Payload
): Effect.Effect<
  void,
  FlowCatalog.FlowCatalogError | GeneratedFile.WriteFileError | GeneratedFile.DriftError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const discovered = yield* discoverFlows(workspaceRoot, payload.root)
    const contents = yield* Effect.try({
      try: () => FlowCatalog.render(FlowCatalog.rows(discovered, payload.flows)),
      catch: (cause) =>
        cause instanceof FlowCatalog.FlowCatalogError
          ? cause
          : new FlowCatalog.FlowCatalogError({ message: GeneratedFile.failureMessage(cause) })
    })
    const file = { path: payload.output, contents }
    return yield* payload.mode === "write"
      ? GeneratedFile.writeGeneratedFile(workspaceRoot, file)
      : GeneratedFile.checkGeneratedFile(workspaceRoot, file)
  })

/**
 * Implements the catalog action over the registry's discovery and the shared
 * generated-file publication.
 *
 * @category layers
 * @since 1.0.0
 */
export const FlowCatalogLive = (options: {
  readonly workspaceRoot: string
}): Layer.Layer<
  Action.Requirement<"smithers-build/flow-catalog">,
  never,
  FlowRuntime.FlowRuntime | FileSystem.FileSystem | Path.Path
> => FlowCatalog.FlowCatalogAction.toLayer((payload) => renderCatalog(options.workspaceRoot, payload))
