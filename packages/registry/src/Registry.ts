/**
 * Refreshable, progressively-disclosed flow registry.
 *
 * Implements lookup, first-found collision handling, on-demand bodies, and
 * same-session rediscovery from
 * [Flow Registry](../../../docs/specs/Concepts/Flow%20Registry.md).
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Option, Path, Ref } from "effect"
import * as FileSystem from "effect/FileSystem"
import { DiscoveryWarning, type FlowBody, FlowBodyModule, type FlowDescriptor, type Source } from "./Descriptor.ts"
import { Discovery } from "./Discovery.ts"
import * as MarkdownFlow from "./MarkdownFlow.ts"
import type { DiscoveryError, RegistryError } from "./RegistryError.ts"
import { registryError } from "./RegistryError.ts"

/**
 * Configuration for constructing a registry from ordered discovery sources.
 *
 * Sources are scanned in caller order. The canonical order is system, project,
 * plugin, then foreign sources.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config {
  readonly sources: ReadonlyArray<Source>
}

/**
 * A refreshable snapshot of discovered flow descriptors.
 *
 * Reads observe one complete snapshot. `refresh` rescans all configured
 * sources and atomically replaces it only after every source succeeds.
 *
 * @category services
 * @since 0.1.0
 */
export interface Registry {
  /** Returns descriptors in deterministic first-found order. */
  readonly list: () => Effect.Effect<ReadonlyArray<FlowDescriptor>>
  /** Returns the descriptors visible to model invocation. */
  readonly visible: () => Effect.Effect<ReadonlyArray<FlowDescriptor>>
  /** Looks up a descriptor by name. */
  readonly get: (name: string) => Effect.Effect<FlowDescriptor, RegistryError>
  /** Looks up a descriptor by name without failing when it is absent. */
  readonly getOption: (name: string) => Effect.Effect<Option.Option<FlowDescriptor>>
  /** Loads a flow body on demand. */
  readonly loadBody: (name: string) => Effect.Effect<FlowBody, RegistryError | DiscoveryError>
  /** Runs a markdown flow with its fixed decoded `{ args: string }` input. */
  readonly runPrompt: (
    name: string,
    input: MarkdownFlow.Input
  ) => Effect.Effect<MarkdownFlow.Output, RegistryError | DiscoveryError>
  /** Atomically replaces the snapshot after rescanning every configured source. */
  readonly refresh: () => Effect.Effect<void, RegistryError | DiscoveryError>
  /** Returns all discovery and collision warnings. */
  readonly warnings: () => Effect.Effect<ReadonlyArray<DiscoveryWarning>>
}

/**
 * Service tag for the refreshable flow registry.
 *
 * @category services
 * @since 0.1.0
 */
export const Registry: Context.Service<Registry, Registry> = Context.Service("flows/registry/Registry")

interface RetainedDescriptor {
  readonly descriptor: FlowDescriptor
  readonly system: boolean
}

interface Snapshot {
  readonly entries: ReadonlyArray<FlowDescriptor>
  readonly visible: ReadonlyArray<FlowDescriptor>
  readonly byName: ReadonlyMap<string, FlowDescriptor>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
}

const notFound = (name: string): RegistryError =>
  registryError({
    code: "not_found",
    method: "get",
    description: `flow "${name}" was not found`
  })

const snapshotFrom = (
  entries: ReadonlyArray<FlowDescriptor>,
  registryWarnings: ReadonlyArray<DiscoveryWarning>
): Snapshot => {
  const byName = new Map<string, FlowDescriptor>()
  const snapshotEntries: Array<FlowDescriptor> = []
  const snapshotWarnings = Array.from(registryWarnings)
  for (const entry of entries) {
    const existing = byName.get(entry.name)
    if (existing !== undefined) {
      snapshotWarnings.push(
        new DiscoveryWarning({
          code: "duplicate_name",
          path: entry.path,
          name: entry.name,
          message: `Duplicate flow name "${entry.name}"; keeping first entry from "${existing.path}"`
        })
      )
      continue
    }
    byName.set(entry.name, entry)
    snapshotEntries.push(entry)
  }
  const frozenEntries = Object.freeze(snapshotEntries)
  return {
    entries: frozenEntries,
    visible: Object.freeze(frozenEntries.filter((entry) => entry.modelInvocable)),
    byName,
    warnings: Object.freeze(snapshotWarnings)
  }
}

const scanSources = (
  config: Config,
  discovery: Discovery
): Effect.Effect<Snapshot, RegistryError | DiscoveryError> =>
  Effect.gen(function*() {
    const retained = new Map<string, RetainedDescriptor>()
    const entries: Array<FlowDescriptor> = []
    const registryWarnings: Array<DiscoveryWarning> = []

    for (const source of config.sources) {
      const scan = yield* discovery.scan(source)
      registryWarnings.push(...scan.warnings)

      for (const entry of scan.entries) {
        const existing = retained.get(entry.name)
        if (existing === undefined) {
          retained.set(entry.name, {
            descriptor: entry,
            system: source.system === true
          })
          entries.push(entry)
          continue
        }

        if (existing.system || source.system === true) {
          return yield* Effect.fail(
            registryError({
              code: "system_collision",
              method: "make",
              description: `flow "${entry.name}" collides with the system namespace`
            })
          )
        }

        registryWarnings.push(
          new DiscoveryWarning({
            code: "duplicate_name",
            path: entry.path,
            name: entry.name,
            message: `Duplicate flow name "${entry.name}"; keeping first entry from "${existing.descriptor.path}"`
          })
        )
      }
    }

    return snapshotFrom(entries, registryWarnings)
  })

const fromRef = (
  state: Ref.Ref<Snapshot>,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  refresh: Effect.Effect<void, RegistryError | DiscoveryError>
): Registry => {
  const getOption = Effect.fn("Registry.getOption")(
    function*(name: string): Effect.fn.Return<Option.Option<FlowDescriptor>> {
      return yield* Effect.map(Ref.get(state), (snapshot) => Option.fromUndefinedOr(snapshot.byName.get(name)))
    }
  )

  const get = Effect.fn("Registry.get")(function*(name: string): Effect.fn.Return<FlowDescriptor, RegistryError> {
    return yield* Effect.flatMap(Ref.get(state), (snapshot) => {
      const entry = snapshot.byName.get(name)
      return entry === undefined ? Effect.fail(notFound(name)) : Effect.succeed(entry)
    })
  })

  const loadBody = Effect.fn("Registry.loadBody")(
    function*(name: string): Effect.fn.Return<FlowBody, RegistryError | DiscoveryError> {
      const descriptor = yield* get(name)
      if (descriptor.body._tag === "Module") {
        return new FlowBodyModule({ path: descriptor.body.path })
      }

      const bodyPath = path.normalize(descriptor.body.path)
      const text = yield* fs.readFileString(bodyPath).pipe(
        Effect.mapError((cause) =>
          registryError({
            code: "body_unavailable",
            method: "loadBody",
            description: `body for flow "${name}" is unavailable at "${bodyPath}"`,
            cause
          })
        )
      )
      return MarkdownFlow.loadBody(text, descriptor.body.baseDirectory)
    }
  )

  const runPrompt = Effect.fn("Registry.runPrompt")(function*(
    name: string,
    input: MarkdownFlow.Input
  ): Effect.fn.Return<MarkdownFlow.Output, RegistryError | DiscoveryError> {
    return yield* Effect.flatMap(loadBody(name), (body) =>
      body._tag === "Prompt"
        ? Effect.succeed(MarkdownFlow.renderPrompt(body, input))
        : Effect.fail(
          registryError({
            code: "not_prompt_flow",
            method: "runPrompt",
            description: `flow "${name}" is module-backed and cannot be rendered as a markdown prompt`
          })
        ))
  })

  return Registry.of({
    list: Effect.fn("Registry.list")(() => Effect.map(Ref.get(state), (snapshot) => snapshot.entries)),
    visible: Effect.fn("Registry.visible")(() => Effect.map(Ref.get(state), (snapshot) => snapshot.visible)),
    get,
    getOption,
    loadBody,
    runPrompt,
    refresh: Effect.fn("Registry.refresh")(() => refresh),
    warnings: Effect.fn("Registry.warnings")(() => Effect.map(Ref.get(state), (snapshot) => snapshot.warnings))
  })
}

/**
 * Scans ordered sources and constructs a refreshable first-found-wins
 * registry. Failed refreshes leave the previous complete snapshot in place.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  config: Config
): Effect.Effect<
  Registry,
  RegistryError | DiscoveryError,
  Discovery | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const discovery = yield* Discovery
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const initial = yield* scanSources(config, discovery)
    const state = yield* Ref.make(initial)
    const refresh = Effect.flatMap(scanSources(config, discovery), (snapshot) => Ref.set(state, snapshot))
    return fromRef(state, fs, path, refresh)
  })

/**
 * Provides a registry constructed from ordered discovery sources.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  config: Config
): Layer.Layer<
  Registry,
  RegistryError | DiscoveryError,
  Discovery | FileSystem.FileSystem | Path.Path
> => Layer.effect(Registry)(make(config))

/**
 * Provides an in-memory descriptor snapshot while retaining lazy body loading.
 * Its refresh operation is a no-op because it has no discovery sources.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFromDescriptors = (
  entries: ReadonlyArray<FlowDescriptor>
): Layer.Layer<Registry, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Registry,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const state = yield* Ref.make(snapshotFrom(entries, []))
      return fromRef(state, fs, path, Effect.void)
    })
  )

/**
 * Creates an empty registry stub with optional method overrides.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Registry> = {}): Registry => {
  const get = (name: string): Effect.Effect<FlowDescriptor, RegistryError> => Effect.fail(notFound(name))
  return Registry.of({
    list: Effect.fn("Registry.list")(() => Effect.succeed([])),
    visible: Effect.fn("Registry.visible")(() => Effect.succeed([])),
    get,
    getOption: Effect.fn("Registry.getOption")(() => Effect.succeed(Option.none())),
    loadBody: Effect.fn("Registry.loadBody")((name) => Effect.fail(notFound(name))),
    runPrompt: Effect.fn("Registry.runPrompt")((name) => Effect.fail(notFound(name))),
    refresh: Effect.fn("Registry.refresh")(() => Effect.void),
    warnings: Effect.fn("Registry.warnings")(() => Effect.succeed([])),
    ...overrides
  })
}

/**
 * Provides an empty registry stub with optional method overrides.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Registry> = {}): Layer.Layer<Registry> =>
  Layer.succeed(Registry)(makeNoop(overrides))
