/**
 * Workflow packs: a directory of flows with a manifest, a content address, and
 * a merge order.
 *
 * `Discovery` already answers "what flows are in this directory". A pack adds
 * the three things a shareable directory needs and a bare directory cannot
 * carry: a *name and version* so a descriptor can say where it came from, a
 * *content address* so a lock file can pin exactly the bytes that were
 * installed, and a *compatibility range* so a pack written against a newer
 * runtime is refused at load rather than halfway through a run.
 *
 * The old smithers verbs (`pack add | remove | list | update | eject`) are the
 * CLI half and are not here. This module is the runtime contract underneath
 * them, and it deliberately holds no filesystem policy of its own: it reads a
 * manifest from a directory a caller names, and the caller decides which
 * directories are local and which are installed.
 *
 * Precedence is `local` before `installed`, by name. That is the one rule the
 * old pack system had that a plain source list cannot express: two sources
 * merge first-found in scan order, so an installed pack listed first would win
 * a name a project pack defines. Here the origin decides, and the loser is
 * reported as a {@link module:Descriptor.DiscoveryWarning} naming both packs
 * rather than dropped silently.
 *
 * @since 0.1.0
 */
import * as Digest from "@smthrs/core/Digest"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { DiscoveryWarning, FlowDescriptor, Provenance, type Source } from "./Descriptor.ts"
import type { RegistryError } from "./RegistryError.ts"
import { registryError } from "./RegistryError.ts"

/**
 * Where a pack was installed from, and therefore which one wins a name.
 *
 * `local` is a pack the project owns — checked in, or linked into the working
 * tree. `installed` is one a package manager or `pack add` put there. A local
 * flow shadows an installed flow of the same name, never the other way round.
 *
 * @category models
 * @since 0.1.0
 */
export const Origin = Schema.Literals(["local", "installed"])

/**
 * Where a pack was installed from.
 *
 * @category models
 * @since 0.1.0
 */
export type Origin = typeof Origin.Type

/**
 * The runtime range a pack declares it needs.
 *
 * Only `smithers` is named. A pack is a set of flow declarations, and the one
 * thing that can make them unloadable is the runtime that reads them.
 *
 * @category models
 * @since 0.1.0
 */
export const Requires = Schema.Struct({ smithers: Schema.NonEmptyString })

/**
 * The runtime range a pack declares it needs.
 *
 * @category models
 * @since 0.1.0
 */
export type Requires = typeof Requires.Type

/**
 * A pack manifest, as it is written in `pack.json`.
 *
 * `flows` and `skills` are directory paths relative to the pack root, each
 * scanned exactly the way an ordinary registry source is. They are paths and
 * not flow names on purpose: a manifest that listed names would have to be
 * re-edited every time a flow was added, and the digest would then not change
 * when one was.
 *
 * @category models
 * @since 0.1.0
 */
export class Manifest extends Schema.Class<Manifest>("flows/registry/Pack/Manifest")({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  flows: Schema.Array(Schema.NonEmptyString),
  skills: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  requires: Schema.optional(Requires)
}) {}

/**
 * One pack the host has decided to load, and where it came from.
 *
 * @category models
 * @since 0.1.0
 */
export interface Installed {
  readonly manifest: Manifest
  /** The pack root. Every manifest path is resolved against it. */
  readonly dir: string
  readonly origin: Origin
}

/**
 * One file's contribution to a pack's content address.
 *
 * @category models
 * @since 0.1.0
 */
export interface File {
  /** The path relative to the pack root, in the manifest's own vocabulary. */
  readonly path: string
  readonly contents: string
}

/** The manifest file every pack root carries. */
const manifestFileName = "pack.json"

const decodeManifest = Schema.decodeUnknownEffect(Manifest)

/**
 * Reads and decodes one pack's manifest.
 *
 * A pack whose manifest is missing, unparseable, or incomplete fails
 * `RegistryError { code: "invalid_pack" }` here rather than producing a
 * half-loaded registry: the manifest is what names the pack in every
 * descriptor's provenance, so there is nothing useful to do without it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const read = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string
): Effect.Effect<{ readonly manifest: Manifest; readonly dir: string }, RegistryError> =>
  Effect.gen(function*() {
    const location = path.join(dir, manifestFileName)
    const invalid = (description: string, cause?: unknown) =>
      registryError({
        code: "invalid_pack",
        module: "Pack",
        method: "read",
        description,
        cause
      })
    const text = yield* fs.readFileString(location).pipe(
      Effect.mapError((cause) => invalid(`the pack manifest at "${location}" could not be read`, cause))
    )
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => invalid(`the pack manifest at "${location}" is not valid JSON`, cause)
    })
    const manifest = yield* decodeManifest(parsed).pipe(
      Effect.mapError((cause) => invalid(`the pack manifest at "${location}" is not a valid manifest`, cause))
    )
    return { manifest, dir }
  })

/**
 * The content address of one pack, as a lock file records it.
 *
 * The digest covers the manifest and every file the caller measured, each by
 * its own content hash under its pack-relative path. Two installs of the same
 * bytes produce the same digest whatever order the files were read in, and
 * editing one flow body changes it.
 *
 * @category identity
 * @since 0.1.0
 */
export const digest = (manifest: Manifest, files: ReadonlyArray<File>): string =>
  Digest.digest(
    Digest.canonical({
      name: manifest.name,
      version: manifest.version,
      flows: [...manifest.flows],
      skills: manifest.skills === undefined ? [] : [...manifest.skills],
      requires: manifest.requires === undefined ? null : { smithers: manifest.requires.smithers },
      files: files
        .map((file) => ({ path: file.path, contents: Digest.digest(file.contents) }))
        .sort((left, right) => left.path < right.path ? -1 : 1)
    })
  )

interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/**
 * Reads `major.minor.patch`, ignoring any prerelease or build suffix.
 *
 * A pack's compatibility question is about the release line, and this runtime
 * ships as `1.0.0-rc.N`. Comparing the prerelease tag as well would refuse
 * every release candidate from a range written against its own release, which
 * is the opposite of what the range means.
 */
const parseVersion = (value: string): Version | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim())
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

const compare = (left: Version, right: Version): number =>
  left.major !== right.major
    ? left.major - right.major
    : left.minor !== right.minor
    ? left.minor - right.minor
    : left.patch - right.patch

/** The comparator prefixes the manifest grammar accepts, longest first. */
const operators = [">=", "<=", ">", "<", "=", "^", "~"] as const

const satisfiesComparator = (comparator: string, version: Version): boolean => {
  if (comparator === "*") return true
  const operator = operators.find((candidate) => comparator.startsWith(candidate))
  const bound = parseVersion(operator === undefined ? comparator : comparator.slice(operator.length))
  if (bound === undefined) return false
  const order = compare(version, bound)
  switch (operator) {
    case ">=":
      return order >= 0
    case "<=":
      return order <= 0
    case ">":
      return order > 0
    case "<":
      return order < 0
    case "^":
      // Caret allows anything up to the next bump of the LEFT-MOST NON-ZERO
      // field, which is the major only on a released line. On `0.x` the minor
      // is that field and on `0.0.x` the patch is, because a pre-1.0 line
      // makes no compatibility promise across them: `^0.2.3` is
      // `>=0.2.3 <0.3.0` and `^0.0.3` is `>=0.0.3 <0.0.4`. Pinning only the
      // major there would load a pack written for 0.2 against 0.9.
      return order >= 0 && version.major === bound.major &&
        (bound.major !== 0 ||
          (version.minor === bound.minor && (bound.minor !== 0 || version.patch === bound.patch)))
    case "~":
      return order >= 0 && version.major === bound.major && version.minor === bound.minor
    default:
      // A bare version and an explicit `=` mean the same thing.
      return order === 0
  }
}

/**
 * Whether a runtime version satisfies a pack's declared range.
 *
 * The supported grammar is the space-separated conjunction every pack manifest
 * in the old tree actually used: `*`, an exact version, and `>=`, `>`, `<=`,
 * `<`, `^`, `~` comparators. A range this cannot parse is refused rather than
 * assumed compatible, because the failure mode of guessing is a pack loading
 * against a runtime it was never written for.
 *
 * @category refinements
 * @since 0.1.0
 */
export const compatible = (range: string, runtimeVersion: string): boolean => {
  const version = parseVersion(runtimeVersion)
  if (version === undefined) return false
  const comparators = range.trim().split(/\s+/).filter((part) => part.length > 0)
  if (comparators.length === 0) return false
  return comparators.every((comparator) => satisfiesComparator(comparator, version))
}

/**
 * The registry sources one pack contributes, in manifest order.
 *
 * Every path in `flows` and `skills` becomes an ordinary source rooted inside
 * the pack, so a pack is discovered by exactly the pipeline a project
 * directory is. `source` carries the pack name, which is what a
 * `DiscoveryWarning` about a pack file reads back.
 *
 * @category conversions
 * @since 0.1.0
 */
export const sources = (pack: Installed, path: Path.Path): ReadonlyArray<Source> =>
  [...pack.manifest.flows, ...(pack.manifest.skills ?? [])].map((relative) => ({
    source: `pack:${pack.manifest.name}`,
    root: path.join(pack.dir, relative),
    naming: "path" as const
  }))

/**
 * Stamps a descriptor with the pack it was discovered in.
 *
 * @category conversions
 * @since 0.1.0
 */
export const attribute = (descriptor: FlowDescriptor, pack: Installed): FlowDescriptor =>
  new FlowDescriptor({
    ...descriptor,
    provenance: new Provenance({
      source: descriptor.provenance.source,
      root: descriptor.provenance.root,
      pack: { name: pack.manifest.name, version: pack.manifest.version, origin: pack.origin }
    })
  })

/** How a pack is named in a shadowing warning. */
const label = (pack: Installed): string => `${pack.manifest.name}@${pack.manifest.version} (${pack.origin})`

/** Local packs first, each group keeping the caller's own order. */
const ordered = <A extends { readonly pack: Installed }>(scans: ReadonlyArray<A>): ReadonlyArray<A> => [
  ...scans.filter((scan) => scan.pack.origin === "local"),
  ...scans.filter((scan) => scan.pack.origin === "installed")
]

/**
 * One pack's scan, ready to merge.
 *
 * @category models
 * @since 0.1.0
 */
export interface Scan {
  readonly pack: Installed
  readonly entries: ReadonlyArray<FlowDescriptor>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
}

/**
 * Merges scanned packs into one descriptor set, local packs first.
 *
 * A name defined by more than one pack keeps the highest-precedence
 * definition and reports a `shadowed` warning naming both packs, so an
 * operator can see which pack lost and why rather than discovering it from a
 * flow that behaves unexpectedly.
 *
 * @category combinators
 * @since 0.1.0
 */
export const merge = (
  scans: ReadonlyArray<Scan>
): {
  readonly entries: ReadonlyArray<FlowDescriptor>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
} => {
  const kept = new Map<string, { readonly descriptor: FlowDescriptor; readonly pack: Installed }>()
  const entries: Array<FlowDescriptor> = []
  const warnings: Array<DiscoveryWarning> = []
  for (const scan of ordered(scans)) {
    warnings.push(...scan.warnings)
    for (const entry of scan.entries) {
      const attributed = attribute(entry, scan.pack)
      const existing = kept.get(entry.name)
      if (existing !== undefined) {
        warnings.push(
          new DiscoveryWarning({
            code: "shadowed",
            path: entry.path,
            name: entry.name,
            message: `Flow "${entry.name}" from ${label(existing.pack)} shadows the one from ${
              label(scan.pack)
            }; the shadowed definition is not loaded`
          })
        )
        continue
      }
      kept.set(entry.name, { descriptor: attributed, pack: scan.pack })
      entries.push(attributed)
    }
  }
  return { entries, warnings }
}

/**
 * Refuses a pack whose declared runtime range this runtime does not satisfy.
 *
 * @category refinements
 * @since 0.1.0
 */
export const checkCompatible = (
  pack: Installed,
  runtimeVersion: string
): Effect.Effect<void, RegistryError> =>
  pack.manifest.requires === undefined || compatible(pack.manifest.requires.smithers, runtimeVersion)
    ? Effect.void
    : Effect.fail(
      registryError({
        code: "incompatible_pack",
        module: "Pack",
        method: "checkCompatible",
        description:
          `pack "${pack.manifest.name}@${pack.manifest.version}" requires smithers ${pack.manifest.requires.smithers}, and this runtime is ${runtimeVersion}`
      })
    )
