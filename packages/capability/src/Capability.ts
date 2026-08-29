/**
 * Capability values, wildcard policy patterns, and effect-tier
 * classification.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Effect Taxonomy.md`.
 *
 * @since 0.1.0
 */
import { Option, Schema } from "effect"

/**
 * A host operation that can be authorized by the permission kernel.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Action =
  | "fs:read"
  | "fs:write"
  | "net:get"
  | "net:post"
  | "model:call"
  | "proc:spawn"
  | "jj:status"
  | "jj:diff"
  | "jj:snapshot"
  | "jj:restore"
  | "jj:workspace-add"
  | "jj:workspace-forget"
  | "jj:root"
  | "jj:revert"

const Action = Schema.Literals(
  [
    "fs:read",
    "fs:write",
    "net:get",
    "net:post",
    "model:call",
    "proc:spawn",
    "jj:status",
    "jj:diff",
    "jj:snapshot",
    "jj:restore",
    "jj:workspace-add",
    "jj:workspace-forget",
    "jj:root",
    "jj:revert"
  ] as const
)

const actions: ReadonlySet<string> = new Set([
  "fs:read",
  "fs:write",
  "net:get",
  "net:post",
  "model:call",
  "proc:spawn",
  "jj:status",
  "jj:diff",
  "jj:snapshot",
  "jj:restore",
  "jj:workspace-add",
  "jj:workspace-forget",
  "jj:root",
  "jj:revert"
])

/**
 * An exact adapter request subject to authorization.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export class Capability extends Schema.Class<Capability>("@smthrs/capability/Capability")({
  action: Action,
  resource: Schema.String
}) {}

/**
 * Constructs an exact capability.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (action: Action, resource: string): Capability => new Capability({ action, resource })

/**
 * Formats a capability or a capability pattern for storage, display, and
 * durable key input.
 *
 * The one renderer for both. `Capability` and `CapabilityPattern` are
 * structurally identical `{action, resource}` records and rendered by
 * byte-identical bodies, so `format` and a separate `formatPattern` were two
 * names for one function — and a third, inline copy in
 * `@smthrs/kernel`'s `JournalGrantStore` was the one actually writing patterns
 * into durable journal payloads. Security-relevant strings get exactly one
 * renderer; folding them together is what keeps the bytes identical after the
 * next edit.
 *
 * @since 0.1.0
 * @category formatting
 * @slop
 */
export const format = (capability: {
  readonly action: string
  readonly resource: string
}): string => `${capability.action}:${capability.resource}`

/**
 * Parses an exact capability. The action is the first two colon-separated
 * components; all remaining text belongs to the resource.
 *
 * @since 0.1.0
 * @category parsing
 * @slop
 */
export const parse = (input: string): Option.Option<Capability> => {
  const components = input.split(":")
  const namespace = components[0]
  const operation = components[1]
  if (namespace === undefined || operation === undefined || components.length < 3) {
    return Option.none()
  }
  const action = `${namespace}:${operation}`
  return actions.has(action)
    ? Option.some(make(action as Action, components.slice(2).join(":")))
    : Option.none()
}

/**
 * An action selector accepted in a capability pattern.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type PatternAction = Action | "fs:*" | "net:*" | "model:*" | "proc:*" | "jj:*" | "*"

const PatternAction = Schema.Literals(
  [
    "fs:read",
    "fs:write",
    "net:get",
    "net:post",
    "model:call",
    "proc:spawn",
    "jj:status",
    "jj:diff",
    "jj:snapshot",
    "jj:restore",
    "jj:workspace-add",
    "jj:workspace-forget",
    "jj:root",
    "jj:revert",
    "fs:*",
    "net:*",
    "model:*",
    "proc:*",
    "jj:*",
    "*"
  ] as const
)

/**
 * An action and resource glob used to grant or deny a family of capabilities.
 * Resource globs are slash-normalized and matched against the whole resource.
 *
 * `*` compiles to `.*` and therefore crosses path separators, so
 * `fs:read src/*.ts` matches `src/nested/Capability.ts`. {@link subsumes}
 * recognises only `**` as recursive, so a grant written with `*` can never be
 * *proven* to cover anything and an envelope built from `*` patterns re-prompts
 * forever. Write `**` for a grant that has to be provable.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export class CapabilityPattern extends Schema.Class<CapabilityPattern>("@smthrs/capability/CapabilityPattern")({
  action: PatternAction,
  resource: Schema.String
}) {}

const normalizeSlashes = (value: string): string => value.replaceAll("\\", "/")

const matchesAction = (pattern: PatternAction, action: Action): boolean =>
  pattern === "*" || pattern === action || (pattern.endsWith(":*") && action.startsWith(pattern.slice(0, -1)))

/**
 * ECMA-262 non-Unicode `i`-flag canonicalization, applied per UTF-16 code
 * unit: uppercase the unit, but keep the original when uppercasing changes
 * its length or maps a non-ASCII unit onto ASCII. Matching the earlier
 * RegExp-based matcher's `i` flag exactly keeps Windows-path matching
 * byte-for-byte compatible with every stored grant.
 */
const canonicalUnit = (unit: string): string => {
  const upper = unit.toUpperCase()
  if (upper.length !== 1) {
    return unit
  }
  return unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128 ? unit : upper
}

const unitsEqual = (left: string, right: string, foldCase: boolean): boolean =>
  left === right || (foldCase && canonicalUnit(left) === canonicalUnit(right))

/**
 * Iterative glob matcher over UTF-16 code units: `*` matches any run of
 * units (path separators and newlines included), `?` matches exactly one
 * unit, and everything else is literal.
 *
 * Grant patterns are attacker-influenced input on the authorization path, so
 * the matcher must not be built on RegExp backtracking: a pattern such as
 * `a*a*a*a*b` against a long non-matching resource made the old
 * `.*`-compiled RegExp exponential. This two-pointer form remembers only the
 * most recent `*` and re-anchors it one unit at a time, which bounds the
 * whole match at O(pattern × resource) with constant memory — the standard
 * linear-scan wildcard algorithm.
 */
const matchGlob = (pattern: string, resource: string, foldCase: boolean): boolean => {
  let patternIndex = 0
  let resourceIndex = 0
  let starIndex = -1
  let starResourceIndex = 0
  while (resourceIndex < resource.length) {
    const unit = pattern[patternIndex]
    if (unit === "*") {
      starIndex = patternIndex
      starResourceIndex = resourceIndex
      patternIndex += 1
    } else if (unit !== undefined && (unit === "?" || unitsEqual(unit, resource[resourceIndex]!, foldCase))) {
      patternIndex += 1
      resourceIndex += 1
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      starResourceIndex += 1
      resourceIndex = starResourceIndex
    } else {
      return false
    }
  }
  while (pattern[patternIndex] === "*") {
    patternIndex += 1
  }
  return patternIndex === pattern.length
}

const matchesResource = (pattern: string, resource: string): boolean => {
  const normalizedPattern = normalizeSlashes(pattern)
  const normalizedResource = normalizeSlashes(resource)
  const foldCase = /^[A-Za-z]:\//.test(normalizedPattern) || /^[A-Za-z]:\//.test(normalizedResource)
  // A pattern ending in ` *` (`proc:spawn` command grants such as `npm *`)
  // additionally matches the bare resource without its trailing argument
  // text, exactly as the old `( .*)?` compilation did.
  if (normalizedPattern.endsWith(" *") && matchGlob(normalizedPattern.slice(0, -2), normalizedResource, foldCase)) {
    return true
  }
  return matchGlob(normalizedPattern, normalizedResource, foldCase)
}

/**
 * Tests whether an exact capability is selected by a pattern.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const matches = (pattern: CapabilityPattern, capability: Capability): boolean =>
  matchesAction(pattern.action, capability.action) && matchesResource(pattern.resource, capability.resource)

const actionSubsumes = (left: PatternAction, right: PatternAction): boolean => {
  if (left === "*" || left === right) {
    return true
  }
  return left.endsWith(":*") && right !== "*" && right.startsWith(left.slice(0, -1))
}

const resourceSubsumes = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeSlashes(left)
  const normalizedRight = normalizeSlashes(right)
  if (normalizedLeft === normalizedRight || normalizedLeft === "**") {
    return true
  }
  if (!normalizedLeft.endsWith("/**")) {
    return false
  }
  const prefix = normalizedLeft.slice(0, -3)
  return normalizedRight.startsWith(`${prefix}/`)
}

/**
 * Conservatively determines whether every capability selected by `right` is
 * also selected by `left`. It returns `false` for glob relationships that
 * cannot be proven by its syntactic checks.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const subsumes = (left: CapabilityPattern, right: CapabilityPattern): boolean =>
  actionSubsumes(left.action, right.action) && resourceSubsumes(left.resource, right.resource)

/**
 * The durability and retry semantics of an effect.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type EffectTier = "sealed" | "compensable" | "irreversible"

const lexicalPath = (path: string): string => {
  const normalized = normalizeSlashes(path)
  const drive = /^[A-Za-z]:\//.exec(normalized)?.[0]
  const absolute = drive !== undefined || normalized.startsWith("/")
  const prefix = drive ?? (absolute ? "/" : "")
  const segments: Array<string> = []
  for (const segment of normalized.slice(prefix.length).split("/")) {
    if (segment === "" || segment === ".") {
      continue
    }
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop()
      } else if (!absolute) {
        segments.push(segment)
      }
    } else {
      segments.push(segment)
    }
  }
  return `${prefix}${segments.join("/")}` || "."
}

const isAbsolutePath = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:\//.test(path)

const isInsideWorkspace = (resource: string, workspaceRoot: string): boolean => {
  const root = lexicalPath(workspaceRoot)
  const normalizedResource = normalizeSlashes(resource)
  const resolved = lexicalPath(
    isAbsolutePath(normalizedResource) ? normalizedResource : `${root}/${normalizedResource}`
  )
  const windowsRoot = /^[A-Za-z]:\//.test(root)
  const comparableRoot = windowsRoot ? root.toLowerCase() : root
  const comparableResolved = windowsRoot ? resolved.toLowerCase() : resolved
  const prefix = comparableRoot.endsWith("/") ? comparableRoot : `${comparableRoot}/`
  if (comparableResolved === comparableRoot) {
    return true
  }
  if (!comparableResolved.startsWith(prefix)) {
    return false
  }
  // A relative root keeps its leading `..` segments, so a textual prefix match
  // is not containment: `../../x` starts with `../` yet escapes the root `..`.
  const remainder = comparableResolved.slice(prefix.length)
  return remainder !== ".." && !remainder.startsWith("../")
}

/**
 * Options used to classify workspace-relative file writes.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface TierOptions {
  readonly workspaceRoot: string
}

/**
 * Determines the effect tier for an exact capability.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const tierOf = (capability: Capability, options: TierOptions): EffectTier => {
  switch (capability.action) {
    case "fs:read":
    case "net:get":
    case "model:call":
    case "jj:status":
    case "jj:diff":
    case "jj:root":
      return "sealed"
    case "fs:write":
      return isInsideWorkspace(capability.resource, options.workspaceRoot) ? "compensable" : "irreversible"
    case "jj:snapshot":
    case "jj:restore":
    case "jj:workspace-add":
    case "jj:workspace-forget":
    case "jj:revert":
      return "compensable"
    case "net:post":
    case "proc:spawn":
      return "irreversible"
  }
}

/**
 * Determines whether retrying an effect requires an idempotency key.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const requiresIdempotencyKey = (tier: EffectTier): boolean => tier === "irreversible"
