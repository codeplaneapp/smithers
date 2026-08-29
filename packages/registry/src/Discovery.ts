/**
 * Portable discovery of markdown and module-backed flows.
 *
 * Implements the file layout and progressive-disclosure lifecycle in
 * [Flow Registry](../../../docs/specs/Concepts/Flow%20Registry.md),
 * [File Conventions](../../../docs/specs/Specs/File%20Conventions.md), and
 * [Flow Directory](../../../docs/specs/Specs/Flow%20Directory.md).
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import {
  BodyRefModule,
  DiscoveryWarning,
  FlowDescriptor,
  Provenance,
  SchemaRefModule,
  SchemaRefNone,
  type Source,
  SourceScan
} from "./Descriptor.ts"
import * as Frontmatter from "./internal/Frontmatter.ts"
import * as ModuleMetadata from "./internal/ModuleMetadata.ts"
import * as Names from "./internal/Names.ts"
import * as MarkdownFlow from "./MarkdownFlow.ts"
import type { DiscoveryError } from "./RegistryError.ts"
import { discoveryError } from "./RegistryError.ts"

/**
 * Discovers flow descriptors from a configured source without loading their
 * bodies into the returned scan.
 *
 * @category services
 * @since 0.1.0
 */
export interface Discovery {
  readonly scan: (source: Source) => Effect.Effect<SourceScan, DiscoveryError>
}

/**
 * Service tag for portable flow discovery.
 *
 * @category services
 * @since 0.1.0
 */
export const Discovery: Context.Service<Discovery, Discovery> = Context.Service("flows/registry/Discovery")

const entryPrecedence = ["flow.ts", "flow.mdx", "SKILL.md"] as const

const warning = (
  code: DiscoveryWarning["code"],
  path: string,
  message: string,
  name?: string,
  cause?: unknown
): DiscoveryWarning =>
  new DiscoveryWarning({
    code,
    path,
    message,
    ...(name === undefined ? {} : { name }),
    ...(cause === undefined ? {} : { cause })
  })

const metadataReadLimit = 64 * 1024
const metadataChunkSize = 512

/**
 * Reads just enough of an entry file to decide its metadata.
 *
 * This reads the whole file and then truncates, rather than streaming until
 * the metadata block closes. `FileSystem.stream` is only available from a host
 * that attests whole-filesystem isolation; the Node host provides
 * descriptor-relative access one operation at a time, so a streaming read is
 * refused there and every entry would be reported `unreadable`. `readFile` is
 * one of the operations the atomic host does serve, and the host applies its
 * own read ceiling, so the bound below is a second, explicit one rather than
 * the only one.
 */
const readMetadata = (
  fs: FileSystem.FileSystem,
  location: string,
  kind: "markdown" | "module"
) =>
  fs.readFile(location).pipe(
    Effect.map((bytes) => {
      const decoder = new TextDecoder()
      let text = ""
      for (let offset = 0; offset < bytes.length; offset += metadataChunkSize) {
        text += decoder.decode(bytes.subarray(offset, offset + metadataChunkSize), { stream: true })
        const complete = kind === "markdown"
          ? Frontmatter.isMetadataComplete(text)
          : ModuleMetadata.isComplete(text)
        if (complete || text.length >= metadataReadLimit) break
      }
      return text + decoder.decode()
    })
  )

const compareWarnings = (left: DiscoveryWarning, right: DiscoveryWarning): number => {
  if (left.path !== right.path) {
    return left.path < right.path ? -1 : 1
  }
  if (left.code !== right.code) {
    return left.code < right.code ? -1 : 1
  }
  return left.message < right.message ? -1 : left.message > right.message ? 1 : 0
}

/**
 * Creates a discovery service from portable file-system and path services.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (fs: FileSystem.FileSystem, path: Path.Path): Discovery =>
  Discovery.of({
    scan: Effect.fn("Discovery.scan")((source) =>
      Effect.gen(function*() {
        const provenance = new Provenance({ source: source.source, root: source.root })
        const entries: Array<FlowDescriptor> = []
        const warnings: Array<DiscoveryWarning> = []

        const exists = yield* fs.exists(source.root).pipe(
          Effect.mapError((cause) =>
            discoveryError({
              code: "read_failed",
              method: "scan",
              description: `could not access source root "${source.root}"`,
              cause
            })
          )
        )
        if (!exists) {
          return yield* Effect.fail(
            discoveryError({
              code: "root_missing",
              method: "scan",
              description: `source root "${source.root}" does not exist`
            })
          )
        }

        const rootInfo = yield* fs.stat(source.root).pipe(
          Effect.mapError((cause) =>
            discoveryError({
              code: "read_failed",
              method: "scan",
              description: `could not inspect source root "${source.root}"`,
              cause
            })
          )
        )
        if (rootInfo.type !== "Directory") {
          return yield* Effect.fail(
            discoveryError({
              code: "invalid_root",
              method: "scan",
              description: `source root "${source.root}" is not a directory`
            })
          )
        }

        const rootEntries = yield* fs.readDirectory(source.root).pipe(
          Effect.mapError((cause) =>
            discoveryError({
              code: "read_failed",
              method: "scan",
              description: `could not read source root "${source.root}"`,
              cause
            })
          )
        )

        const visit: (
          directory: string,
          segments: ReadonlyArray<string>,
          initialEntries?: ReadonlyArray<string>
        ) => Effect.Effect<void> =
          // Untraced because recursive directory traversal is a scan hot path.
          Effect.fnUntraced(function*(
            directory,
            segments,
            initialEntries
          ) {
            const directoryEntries = initialEntries === undefined
              ? yield* Effect.result(fs.readDirectory(directory))
              : Result.succeed(initialEntries)

            if (Result.isFailure(directoryEntries)) {
              warnings.push(
                warning(
                  "unreadable",
                  directory,
                  `Could not read directory "${directory}"`,
                  undefined,
                  directoryEntries.failure
                )
              )
              return
            }

            const files = new Set<string>()
            const directories: Array<{ readonly name: string; readonly location: string }> = []
            for (const entry of [...directoryEntries.success].sort()) {
              const location = path.join(directory, entry)
              const info = yield* Effect.result(fs.stat(location))
              if (Result.isFailure(info)) {
                warnings.push(
                  warning("unreadable", location, `Could not inspect "${location}"`, undefined, info.failure)
                )
                continue
              }
              if (info.success.type === "File") {
                files.add(entry)
                continue
              }
              if (info.success.type !== "Directory") {
                continue
              }
              if (
                entry === ".git" ||
                entry === "node_modules" ||
                entry.startsWith(".") ||
                (segments.length === 0 &&
                  source.naming === "path" &&
                  (entry === "channels" || entry === "connections"))
              ) {
                continue
              }
              directories.push({ name: entry, location })
            }

            const candidates = entryPrecedence.filter((entry) => files.has(entry))
            const selected = candidates[0]
            if (selected !== undefined) {
              const location = path.join(directory, selected)
              if (candidates.length > 1) {
                warnings.push(
                  warning(
                    "multiple_entry_files",
                    directory,
                    `Multiple entry files found (${candidates.join(", ")}); using ${selected}`
                  )
                )
              }

              if (segments.length === 0 && source.naming === "path") {
                warnings.push(
                  warning(
                    "root_level_entry",
                    location,
                    "Path-named sources cannot contain a root-level entry"
                  )
                )
              } else {
                const contents = yield* Effect.result(
                  readMetadata(fs, location, selected === "flow.ts" ? "module" : "markdown")
                )
                if (Result.isFailure(contents)) {
                  warnings.push(
                    warning(
                      "unreadable",
                      location,
                      `Could not read entry metadata from "${location}"`,
                      undefined,
                      contents.failure
                    )
                  )
                } else if (selected === "flow.ts") {
                  const metadata = ModuleMetadata.parse(contents.success)
                  const pathName = Names.deriveFromPath(segments)
                  const name = source.naming === "path"
                    ? Option.getOrElse(pathName, () => path.basename(directory))
                    : path.basename(directory)
                  for (const item of metadata.warnings) {
                    warnings.push(
                      warning("unsupported_module_metadata", location, item.message, name)
                    )
                  }
                  if (metadata.declaresName && source.naming === "path") {
                    warnings.push(
                      warning(
                        "name_field_ignored",
                        location,
                        "Ignoring Flow.make name because this source uses path-derived names",
                        name
                      )
                    )
                  }
                  if (metadata.description === undefined) {
                    warnings.push(
                      warning(
                        "missing_description",
                        location,
                        "Module flows require a literal description in the default Flow.make or Flow.agent value",
                        name
                      )
                    )
                  } else {
                    entries.push(
                      new FlowDescriptor({
                        name,
                        description: metadata.description,
                        body: new BodyRefModule({ path: location }),
                        input: metadata.hasInput
                          ? new SchemaRefModule({ path: location, field: "input" })
                          : new SchemaRefNone({}),
                        output: metadata.hasOutput
                          ? new SchemaRefModule({ path: location, field: "output" })
                          : new SchemaRefNone({}),
                        model: metadata.model,
                        flows: metadata.flows,
                        capabilities: metadata.capabilities,
                        effects: metadata.effects,
                        placement: metadata.placement,
                        modelInvocable: metadata.modelInvocable,
                        path: location,
                        frontmatter: {},
                        provenance
                      })
                    )
                  }
                } else {
                  const result = MarkdownFlow.fromMarkdown({
                    text: contents.success,
                    path: location,
                    baseDirectory: directory,
                    naming: source.naming,
                    name: Names.deriveFromPath(segments),
                    dirBasename: path.basename(directory),
                    provenance
                  })
                  warnings.push(...result.warnings)
                  Option.match(result.descriptor, {
                    onNone: () => undefined,
                    onSome: (descriptor) => entries.push(descriptor)
                  })
                }
              }
            }

            for (const child of directories) {
              yield* visit(child.location, [...segments, child.name])
            }
          })

        yield* visit(source.root, [], rootEntries)
        entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
        warnings.sort(compareWarnings)
        return new SourceScan({ entries, warnings })
      })
    )
  })

/**
 * Provides portable flow discovery from the current file-system and path
 * services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Discovery, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  Discovery,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return make(fs, path)
  })
)

/**
 * Creates an empty discovery stub with optional method overrides.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Discovery> = {}): Discovery =>
  Discovery.of({
    scan: Effect.fn("Discovery.scan")(() => Effect.succeed(new SourceScan({ entries: [], warnings: [] }))),
    ...overrides
  })

/**
 * Provides an empty discovery stub with optional method overrides.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Discovery> = {}): Layer.Layer<Discovery> =>
  Layer.succeed(Discovery)(makeNoop(overrides))
