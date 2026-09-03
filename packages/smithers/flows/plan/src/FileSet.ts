/**
 * Static filesystem declaration vocabulary shared by planning and execution.
 *
 * Declared paths use `/` as their canonical separator and normalize Unicode
 * to NFC. Workspace-relative paths reject C0 controls (U+0000 through U+001F)
 * and DEL (U+007F), which name nothing a supported filesystem can open. C1
 * controls (U+0080 through U+009F) remain accepted because those bytes are
 * legal in a POSIX file name.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * The canonical spelling of a declared path or pattern: every separator is
 * `/`, and Unicode is normalized to NFC.
 *
 * {@link workspaceRelative} accepts a backslash as a separator, so
 * `dist\same.js` and `dist/same.js` are two spellings of ONE workspace path.
 * Every exact-path comparison in this module goes through this form, because
 * comparing the raw spellings would let the separator alias defeat overlap
 * detection exactly as `.` segments and empty segments would.
 *
 * @category accessors
 * @since 0.1.0
 * @slop
 */
export const canonical = (path: string): string => path.replaceAll("\\", "/").normalize("NFC")

/** Workspace-relative glob pattern.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Pattern = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (pattern) => workspaceRelative(pattern) || "file patterns must be workspace-relative and cannot traverse upward",
    { title: "workspaceRelativePattern" }
  )
)

/**
 * Whether a declared path or pattern stays inside the workspace and names it
 * one way only. Refuses absolute paths (POSIX and drive-letter), upward
 * traversal, and the aliasing forms — `.` segments, empty segments — that
 * would let two spellings of one file defeat exact-string overlap detection.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const workspaceRelative = (pattern: string): boolean => {
  for (let index = 0; index < pattern.length; index++) {
    const code = pattern.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return false
  }
  if (pattern.startsWith("/")) return false
  const segments = canonical(pattern).split("/")
  if (segments[0]!.endsWith(":")) return false
  return segments.every((segment) => segment !== ".." && segment !== "." && segment !== "")
}

/** Bazel-style file glob.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Glob = Schema.TaggedStruct("Glob", {
  include: Schema.NonEmptyArray(Pattern),
  exclude: Schema.optional(Schema.Array(Pattern))
})

/** Bazel-style file glob.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Glob = typeof Glob.Type

/** A directory output captured and replayed as one tree artifact.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const TreeArtifact = Schema.TaggedStruct("TreeArtifact", {
  path: Pattern
})

/** A directory output captured and replayed as one tree artifact.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TreeArtifact = typeof TreeArtifact.Type

/** One leaf of a named filegroup.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Entry = Schema.Union([Pattern, Glob, TreeArtifact])

/** One leaf of a named filegroup.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Entry = typeof Entry.Type

/** A declaration valid in a read set.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const ReadEntry = Schema.Union([Pattern, Glob])

/** A declaration valid in a read set.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ReadEntry = typeof ReadEntry.Type

/** A named reusable collection expanded before measurement.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Filegroup = Schema.TaggedStruct("Filegroup", {
  name: Schema.NonEmptyString,
  entries: Schema.Array(Entry)
})

/** A named reusable collection expanded before measurement.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Filegroup = typeof Filegroup.Type

/** A named read-only collection.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const ReadFilegroup = Schema.TaggedStruct("Filegroup", {
  name: Schema.NonEmptyString,
  entries: Schema.Array(ReadEntry)
})

/** A named read-only collection.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ReadFilegroup = typeof ReadFilegroup.Type

/** Any declaration accepted by a plan effect set.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Declaration = Schema.Union([Entry, Filegroup])

/** Any declaration accepted by a plan effect set.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Declaration = typeof Declaration.Type

/** Any declaration accepted by a plan read set.
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const ReadDeclaration = Schema.Union([ReadEntry, ReadFilegroup])

/** Any declaration accepted by a plan read set.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ReadDeclaration = typeof ReadDeclaration.Type

/** Creates a named filegroup.
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeFilegroup = (name: string, entries: ReadonlyArray<Entry>): Filegroup => ({
  _tag: "Filegroup",
  name,
  entries
})

/** Expands filegroups deterministically, preserving declaration order.
 * @category accessors
 * @since 0.1.0
 * @slop
 */
export const expand = (declarations: ReadonlyArray<Declaration>): ReadonlyArray<Entry> =>
  declarations.flatMap((declaration) =>
    typeof declaration !== "string" && declaration._tag === "Filegroup" ? declaration.entries : [declaration]
  )

/** Expands read filegroups deterministically, preserving declaration order.
 * @category accessors
 * @since 0.1.0
 * @slop
 */
export const expandReads = (declarations: ReadonlyArray<ReadDeclaration>): ReadonlyArray<ReadEntry> =>
  declarations.flatMap((declaration) =>
    typeof declaration !== "string" && declaration._tag === "Filegroup" ? declaration.entries : [declaration]
  )

/** Whether a value is a glob declaration.
 * @category guards
 * @since 0.1.0
 * @slop
 */
export const isGlob = (value: unknown): value is Glob =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "Glob"

/** Whether a value is a tree artifact declaration.
 * @category guards
 * @since 0.1.0
 * @slop
 */
export const isTreeArtifact = (value: unknown): value is TreeArtifact =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "TreeArtifact"

const escape = (value: string): string => value.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")

/** Compiles Bazel's `*`/`**` path semantics without permitting traversal. */
const patternExpression = (pattern: string): RegExp => {
  const segments = canonical(pattern).split("/")
  let source = "^"
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    if (segment === "**") {
      source += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*"
      continue
    }
    source += escape(segment).replaceAll("*", "[^/]*")
    if (index < segments.length - 1) source += "/"
  }
  return new RegExp(`${source}$`)
}

/** Tests one workspace-relative path against one Bazel-style pattern.
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const matchesPattern = (pattern: string, path: string): boolean => patternExpression(pattern).test(path)

/** Tests one file path against a glob, including exclusions.
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const matchesGlob = (glob: Glob, path: string): boolean =>
  glob.include.some((pattern) => matchesPattern(pattern, path)) &&
  !(glob.exclude ?? []).some((pattern) => matchesPattern(pattern, path))

const beneath = (tree: string, path: string): boolean => {
  const root = canonical(tree)
  const inside = canonical(path)
  return inside === root || inside.startsWith(`${root}/`)
}

/**
 * Conservative static overlap. `true` may over-serialize; `false` proves that
 * no path can belong to both declarations.
 *
 * Exact paths compare in their {@link canonical} separator and NFC form, so
 * separator aliases and canonically equivalent Unicode spellings overlap. A
 * glob tests the path bytes it is handed; its property suite pins a backslash
 * inside a path segment as literal text, so canonicalizing a measured path
 * before matching is its caller's decision, not this module's.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const overlaps = (left: Entry, right: Entry): boolean => {
  if (typeof left === "string" && typeof right === "string") return canonical(left) === canonical(right)
  if (typeof left === "string" && isGlob(right)) return matchesGlob(right, canonical(left))
  if (isGlob(left) && typeof right === "string") return matchesGlob(left, canonical(right))
  if (isGlob(left) && isGlob(right)) return true
  if (isTreeArtifact(left) && typeof right === "string") return beneath(left.path, right)
  if (typeof left === "string" && isTreeArtifact(right)) return beneath(right.path, left)
  if (isTreeArtifact(left) && isTreeArtifact(right)) {
    return beneath(left.path, right.path) || beneath(right.path, left.path)
  }
  if (isTreeArtifact(left) && isGlob(right)) return true
  /* v8 ignore else -- the closed Entry union leaves only Glob/TreeArtifact here */
  if (isGlob(left) && isTreeArtifact(right)) return overlaps(right, left)
  /* v8 ignore next -- Entry's closed union makes every pair return above */
  return true
}
