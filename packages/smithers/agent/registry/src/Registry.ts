/**
 * Refreshable, progressively-disclosed flow registry.
 *
 * Lookup, first-found collision handling, on-demand bodies, and same-session
 * rediscovery. Governing contract: `packages/smithers/agent/registry/docs/api.md`, published
 * as https://smithers.sh/api/registry.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import { Context, Effect, Layer, Option, Path, Ref } from "effect"
import * as FileSystem from "effect/FileSystem"
import { DiscoveryWarning, type FlowBody, FlowBodyModule, FlowDescriptor, type Source } from "./Descriptor.ts"
import { Discovery } from "./Discovery.ts"
import * as MarkdownFlow from "./MarkdownFlow.ts"
import * as Pack from "./Pack.ts"
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
  /**
   * Installed packs, scanned after `sources` and folded in under the same
   * first-found rule, so a source entry shadows a pack entry of the same name.
   * Omit it for a registry with no packs.
   */
  readonly packs?: PackConfig | undefined
}

/**
 * The pack half of a {@link Config}.
 *
 * `runtimeVersion` is required rather than optional because it is the only
 * thing `requires.smithers` can be checked against: an optional field would
 * silently skip the check for every caller that forgot it, which is the one
 * failure mode a compatibility range exists to prevent.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackConfig {
  /** The packs to scan. Precedence is `origin`, not caller order. */
  readonly installed: ReadonlyArray<Pack.Installed>
  /** The runtime version every pack's `requires.smithers` is checked against. */
  readonly runtimeVersion: string
}

/**
 * A refreshable snapshot of discovered flow descriptors.
 *
 * Reads observe one complete snapshot. `refresh` rescans all configured
 * sources and atomically replaces it only after every source succeeds.
 * Descriptors and warnings returned by the service are frozen copies owned by
 * the registry. Mutating a descriptor or configuration value supplied by a
 * caller cannot change later registry answers.
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

const ownedValue = <A>(value: A, seen: WeakMap<object, object> = new WeakMap()): A => {
  if (value === null || typeof value !== "object") return value
  const input = value as object
  const previous = seen.get(input)
  if (previous !== undefined) return previous as A

  const copy: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))
  seen.set(input, copy)
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key)!
    Object.defineProperty(copy, key, {
      configurable: Boolean(property.configurable),
      enumerable: Boolean(property.enumerable),
      writable: true,
      value: ownedValue(Reflect.get(input, key), seen)
    })
  }
  return Object.freeze(copy) as A
}

/**
 * One deep, frozen copy of a descriptor the registry owns outright.
 *
 * Re-constructing through the class is what drops any own property a caller
 * hung on the value it passed; the single `ownedValue` pass over the result is
 * what makes the copy deep and frozen. Doing both in one pass matters: a copy
 * per field followed by a copy of the assembled descriptor cloned every
 * descriptor twice per `refresh`, and gave each field its own `seen` map, so a
 * value two fields shared came back as two objects. One pass and one map keeps
 * the cost at one traversal per descriptor and preserves that sharing.
 */
const ownedDescriptor = (entry: FlowDescriptor): FlowDescriptor => ownedValue(new FlowDescriptor({ ...entry }))

const ownedConfig = (config: Config): Config =>
  ownedValue({
    sources: [...config.sources],
    ...(config.packs === undefined
      ? {}
      : {
        packs: {
          installed: [...config.packs.installed],
          runtimeVersion: config.packs.runtimeVersion
        }
      })
  })

const snapshotFrom = (
  entries: ReadonlyArray<FlowDescriptor>,
  registryWarnings: ReadonlyArray<DiscoveryWarning>
): Snapshot => {
  const byName = new Map<string, FlowDescriptor>()
  const snapshotEntries: Array<FlowDescriptor> = []
  const snapshotWarnings = registryWarnings.map((warning) => ownedValue(warning))
  for (const supplied of entries) {
    const entry = ownedDescriptor(supplied)
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

/**
 * Scans every pack in a {@link PackConfig} and merges the results.
 *
 * Compatibility is checked for every pack before anything is scanned, and a
 * pack source that cannot be scanned fails as an `invalid_pack` naming the
 * pack rather than as a bare discovery error naming only a directory: a
 * missing `flows/` under a pack is the pack's defect, and an operator has to
 * be told which pack to reinstall.
 */
const scanPacks = (
  config: PackConfig,
  discovery: Discovery
): Effect.Effect<
  { readonly entries: ReadonlyArray<FlowDescriptor>; readonly warnings: ReadonlyArray<DiscoveryWarning> },
  RegistryError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const installed = [...config.installed]
    const scans: Array<Pack.Scan> = []
    for (const pack of installed) {
      yield* Pack.checkCompatible(pack, config.runtimeVersion)
    }
    for (const pack of installed) {
      const entries: Array<FlowDescriptor> = []
      const warnings: Array<DiscoveryWarning> = []
      for (const source of yield* Pack.sources(pack, path)) {
        const scan = yield* discovery.scan(source).pipe(
          Effect.mapError((cause) =>
            registryError({
              code: "invalid_pack",
              method: "make",
              path: source.root,
              description:
                `pack "${pack.manifest.name}@${pack.manifest.version}" declares a source at "${source.root}" that could not be scanned`,
              cause
            })
          )
        )
        entries.push(...scan.entries)
        warnings.push(...scan.warnings)
      }
      scans.push({ pack, entries, warnings })
    }
    return Pack.merge(scans)
  })

const scanSources = (
  config: Config,
  discovery: Discovery
): Effect.Effect<Snapshot, RegistryError | DiscoveryError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const retained = new Map<string, RetainedDescriptor>()
    const entries: Array<FlowDescriptor> = []
    const registryWarnings: Array<DiscoveryWarning> = []

    /** Folds one scanned batch into the first-found snapshot under construction. */
    const fold = (
      batch: ReadonlyArray<FlowDescriptor>,
      system: boolean
    ): Effect.Effect<void, RegistryError> =>
      Effect.gen(function*() {
        for (const entry of batch) {
          const existing = retained.get(entry.name)
          if (existing === undefined) {
            retained.set(entry.name, { descriptor: entry, system })
            entries.push(entry)
            continue
          }

          if (existing.system || system) {
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
      })

    for (const source of config.sources) {
      const scan = yield* discovery.scan(source)
      registryWarnings.push(...scan.warnings)
      yield* fold(scan.entries, source.system === true)
    }

    // A pack's flows are scanned AFTER the caller's own sources and folded in
    // through the same first-found rule, so a project flow shadows a pack flow
    // of the same name and reports it as a duplicate. Precedence AMONG packs is
    // the pack's origin, which is `Pack.merge`'s rule and reports `shadowed`
    // naming both packs; a pack is never a system source.
    if (config.packs !== undefined) {
      const packed = yield* scanPacks(config.packs, discovery)
      registryWarnings.push(...packed.warnings)
      yield* fold(packed.entries, false)
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
      const bytes = yield* fs.readFile(bodyPath).pipe(
        Effect.mapError((cause) =>
          registryError({
            code: "body_unavailable",
            method: "loadBody",
            path: bodyPath,
            description: `body for flow "${name}" is unavailable at "${bodyPath}"`,
            cause
          })
        )
      )
      if (
        descriptor.body.contentDigest !== undefined &&
        Digest.digest(bytes) !== descriptor.body.contentDigest
      ) {
        return yield* Effect.fail(
          registryError({
            code: "body_unavailable",
            method: "loadBody",
            path: bodyPath,
            description:
              `body for flow "${name}" changed at "${bodyPath}" after discovery; refresh the registry before loading it`
          })
        )
      }
      const text = new TextDecoder().decode(bytes)
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
> => {
  const configSnapshot = ownedConfig(config)
  return Effect.gen(function*() {
    const discovery = yield* Discovery
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const scan = scanSources(configSnapshot, discovery).pipe(
      Effect.provideService(Path.Path, path),
      Effect.provideService(FileSystem.FileSystem, fs)
    )
    const initial = yield* scan
    const state = yield* Ref.make(initial)
    const refresh = Effect.flatMap(scan, (snapshot) => Ref.set(state, snapshot))
    return fromRef(state, fs, path, refresh)
  })
}

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
  entries: ReadonlyArray<FlowDescriptor>,
  warnings: ReadonlyArray<DiscoveryWarning> = []
): Layer.Layer<Registry, never, FileSystem.FileSystem | Path.Path> => {
  const snapshot = snapshotFrom(entries, warnings)
  return Layer.effect(
    Registry,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const state = yield* Ref.make(snapshot)
      return fromRef(state, fs, path, Effect.void)
    })
  )
}

/**
 * Scans a set of installed packs and constructs a registry over their merged
 * descriptors.
 *
 * This is the multi-source half of the registry. `layer` merges ordered
 * sources first-found, which is the right rule when the caller controls the
 * order; a pack set does not work that way. Precedence here is the pack's
 * `origin` — every `local` pack outranks every `installed` one — so a project
 * pack shadows a vendored flow of the same name whatever order the host
 * happened to list them in, and the shadowed definition is reported as a
 * `shadowed` warning naming both packs.
 *
 * Every pack's `requires.smithers` is checked before anything is scanned, so a
 * pack written against a newer runtime fails `incompatible_pack` at load
 * rather than at the first call into one of its flows.
 *
 * This is {@link layer} with no sources of its own, so `refresh` rescans every
 * pack the same way it rescans a source.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFromPacks = (
  packs: ReadonlyArray<Pack.Installed>,
  options: { readonly runtimeVersion: string }
): Layer.Layer<
  Registry,
  RegistryError | DiscoveryError,
  Discovery | FileSystem.FileSystem | Path.Path
> => {
  // The host that calls Pack.read must surface its manifest warnings before
  // projecting that result to Installed, whose public shape retains none.
  return layer({ sources: [], packs: { installed: packs, runtimeVersion: options.runtimeVersion } })
}

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
