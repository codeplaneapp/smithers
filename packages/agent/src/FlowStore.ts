/**
 * Where a saved flow's files land.
 *
 * A model that promotes the script it just ran produces three ordinary files —
 * the flow, its end-to-end test, and the fixture that test replays — and they
 * have to be written somewhere the next run can discover them. That "somewhere"
 * is not one thing: a checkout writes into the working tree, a browser host
 * writes into session storage it owns, and a test writes into a map it can
 * inspect. This module is the one contract all three satisfy, so
 * `PromoteFlows` never learns which one it is talking to.
 *
 * The store is also the last place an id is still just text. Every path a write
 * builds comes from it, so {@link validateId} runs before any of them are built
 * rather than after: `../escape` is refused as a bad id, not caught as a
 * surprising write outside the root.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Path, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"

/**
 * Stable error codes returned by saved-flow storage.
 *
 * @category models
 * @since 0.1.0
 */
export const FlowStoreErrorCode = Schema.Literals([
  "invalid_id",
  "invalid_path",
  "write_failed",
  "unsupported"
])

/**
 * Stable error codes returned by saved-flow storage.
 *
 * @category models
 * @since 0.1.0
 */
export type FlowStoreErrorCode = typeof FlowStoreErrorCode.Type

/**
 * Error raised by saved-flow storage.
 *
 * Every message is written for the model that will read it back as a call
 * failure, because the cell that asked to save a flow is the only thing that
 * can correct the id or reissue the write.
 *
 * @category errors
 * @since 0.1.0
 */
export class FlowStoreError extends Schema.TaggedError<FlowStoreError>()(
  "@smthrs/agent/FlowStore/FlowStoreError",
  {
    code: FlowStoreErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

const error = (code: FlowStoreErrorCode, message: string, cause?: unknown): FlowStoreError =>
  new FlowStoreError({ code, message, ...(cause === undefined ? {} : { cause }) })

/**
 * The flow ids a router can route.
 *
 * One directory name, lowercase, and no separators: a saved flow is discovered
 * as `flows/<id>/flow.ts`, so an id is exactly what may stand between those two
 * slashes.
 *
 * @category models
 * @since 0.1.0
 */
export const idPattern = /^[a-z][a-z0-9-]*$/

/**
 * Refuses an id no flow directory could be named.
 *
 * @category constructors
 * @since 0.1.0
 */
export const validateId = (id: string): Effect.Effect<void, FlowStoreError> =>
  idPattern.test(id) ? Effect.void : Effect.fail(
    error(
      "invalid_id",
      `"${id}" is not a saveable flow id. Use lowercase letters, digits, and hyphens, starting with a letter, then save it again.`
    )
  )

/**
 * One flow the store already holds.
 *
 * @category models
 * @since 0.1.0
 */
export interface SavedFlow {
  /** The flow's id, which is also its directory name. */
  readonly id: string
  /** Every file the store holds for it, root-relative and sorted. */
  readonly files: ReadonlyArray<string>
}

/**
 * What one write recorded.
 *
 * @category models
 * @since 0.1.0
 */
export interface WriteResult {
  /** The paths that were written, in the order they were given. */
  readonly files: ReadonlyArray<string>
}

/**
 * Saved-flow storage operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * Writes one flow's files, keyed by their root-relative paths.
   *
   * The keys are the caller's own paths and are reported back unchanged, so a
   * host that mounts its flows somewhere else still tells the model where the
   * files went in terms the model gave it.
   */
  readonly write: (
    id: string,
    files: Record<string, string>
  ) => Effect.Effect<WriteResult, FlowStoreError>
  /** Every flow the store holds, by id. */
  readonly list: () => Effect.Effect<ReadonlyArray<SavedFlow>, FlowStoreError>
}

/**
 * Service tag for saved-flow storage.
 *
 * @category services
 * @since 0.1.0
 */
export class FlowStore extends Context.Service<FlowStore, Service>()("@smthrs/agent/FlowStore") {}

/** Groups written paths into one entry per `flows/<id>/` prefix. */
const listPaths = (paths: Iterable<string>): ReadonlyArray<SavedFlow> => {
  const byId = new Map<string, Array<string>>()
  for (const path of paths) {
    const parts = path.split("/")
    if (parts.length < 3 || parts[0] !== "flows" || !idPattern.test(parts[1]!)) continue
    const id = parts[1]!
    const held = byId.get(id)
    if (held === undefined) byId.set(id, [path])
    else held.push(path)
  }
  return [...byId.keys()].sort().map((id) => ({ id, files: byId.get(id)!.sort() }))
}

/**
 * Constructs a store over an in-memory map, keyed by path.
 *
 * The map is the caller's, so a test writes through the store and reads the
 * bytes back without a filesystem. The listing is derived from the keys rather
 * than tracked separately, which is what lets a host hand in a map it populated
 * itself and still have the flows in it be listable.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeMemory = (written: Map<string, string> = new Map()): Service =>
  FlowStore.of({
    write: (id, files) =>
      Effect.gen(function*() {
        yield* validateId(id)
        for (const [path, source] of Object.entries(files)) written.set(path, source)
        return { files: Object.keys(files) }
      }),
    list: () => Effect.sync(() => listPaths(written.keys()))
  })

/** Refuses a file path that would land outside the root it is joined to. */
const validatePath = (path: Path.Path, relative: string): Effect.Effect<void, FlowStoreError> =>
  path.isAbsolute(relative) || relative.split("/").includes("..")
    ? Effect.fail(error("invalid_path", `"${relative}" is not a path inside the flows root.`))
    : Effect.void

/**
 * Constructs a store over a directory on the host filesystem.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeFileSystem = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string
): Service =>
  FlowStore.of({
    write: (id, files) =>
      Effect.gen(function*() {
        yield* validateId(id)
        for (const relative of Object.keys(files)) yield* validatePath(path, relative)
        // Every path is checked before the first byte is written, so a
        // rejected file cannot leave a half-saved flow on disk.
        for (const [relative, source] of Object.entries(files)) {
          const target = path.join(root, relative)
          yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
            Effect.mapError((cause) => error("write_failed", `could not create the directory for ${relative}`, cause))
          )
          yield* fs.writeFileString(target, source).pipe(
            Effect.mapError((cause) => error("write_failed", `could not write ${relative}`, cause))
          )
        }
        return { files: Object.keys(files) }
      }),
    list: () =>
      Effect.gen(function*() {
        const directory = path.join(root, "flows")
        // A directory that cannot be listed contributes nothing, which is the
        // same reading `WorkspaceObservation` takes of the same question. A
        // root that has never saved a flow has no `flows` directory at all, and
        // that is the state every host starts in rather than a failure.
        const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))
        const paths: Array<string> = []
        for (const id of entries) {
          if (!idPattern.test(id)) continue
          const held = yield* fs.readDirectory(path.join(directory, id), { recursive: true }).pipe(
            Effect.orElseSucceed(() => [])
          )
          for (const relative of held) {
            const info = yield* fs.stat(path.join(directory, id, relative)).pipe(
              Effect.map((stat) => stat.type),
              // An entry that cannot be stated is not a file the store can
              // claim to hold: a dangling link is the ordinary way to produce
              // one, and reporting it would name a path nothing can read.
              Effect.orElseSucceed(() => "Unknown" as const)
            )
            if (info === "File") paths.push(`flows/${id}/${relative}`)
          }
        }
        return listPaths(paths)
      })
  })

/**
 * Constructs a store that saves nothing, optionally overriding operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) =>
    Effect.fail(
      error("unsupported", `This host has nowhere to save a flow, so ${method} is unavailable and no flow was saved.`)
    )
  return FlowStore.of({
    write: () => unavailable("FlowStore.write"),
    list: () => unavailable("FlowStore.list"),
    ...overrides
  })
}

/**
 * Provides a store over an in-memory map.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerMemory = (written: Map<string, string> = new Map()): Layer.Layer<FlowStore> =>
  Layer.succeed(FlowStore)(makeMemory(written))

/**
 * Provides a store over a directory on the host filesystem.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFileSystem = (
  root: string
): Layer.Layer<FlowStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(FlowStore)(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      return makeFileSystem(fs, path, root)
    })
  )

/**
 * Provides a store that saves nothing.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<FlowStore> =>
  Layer.succeed(FlowStore)(makeNoop(overrides))
