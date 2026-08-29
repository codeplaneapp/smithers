/**
 * Typed permission failures and capability policy rules.
 *
 * The schema ids below round-trip through the grant journal and are digested
 * into step keys, so renaming one invalidates recorded runs.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import { Option, Schema } from "effect"
import { type PlatformError, systemError } from "effect/PlatformError"
import { Capability, CapabilityPattern, type EffectTier, format, matches } from "./Capability.ts"

/**
 * A permission request that must be resolved by an attended surface.
 *
 * The capability is always the exact adapter request, never a wildcard.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class PermissionRequired extends Schema.TaggedError<PermissionRequired>()(
  "@smthrs/capability/PermissionRequired",
  {
    code: Schema.Literal("permission_required"),
    requestId: Schema.String,
    runId: Schema.optional(Schema.String),
    capability: Capability,
    tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
    meta: Schema.Record(Schema.String, Schema.Unknown)
  }
) {
  constructor(props: {
    readonly code?: "permission_required"
    readonly requestId: string
    readonly runId?: string | undefined
    readonly capability: Capability
    readonly tier: EffectTier
    readonly meta: Record<string, unknown>
  }) {
    super({ ...props, code: "permission_required" })
  }
}

/**
 * A capability rejected by policy or by the current capability ceiling.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()(
  "@smthrs/capability/PermissionDenied",
  {
    code: Schema.Literal("permission_denied"),
    capability: Capability,
    reason: Schema.String
  }
) {
  constructor(props: {
    readonly code?: "permission_denied"
    readonly capability: Capability
    readonly reason: string
  }) {
    super({ ...props, code: "permission_denied" })
  }
}

/**
 * Stable grant-store failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const GrantStoreErrorCode = Schema.Literals([
  "duplicate_request",
  "request_not_found",
  "journal_failed",
  "store_closed",
  "invalid_resolution"
])

/**
 * Stable grant-store failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type GrantStoreErrorCode = typeof GrantStoreErrorCode.Type

/**
 * A failure to register, persist, or resolve a grant request.
 *
 * `message` and `cause` are optional operation context for persistence
 * adapters; callers branch on the stable `code`.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class GrantStoreError extends Schema.TaggedError<GrantStoreError>()(
  "@smthrs/capability/GrantStoreError",
  {
    code: GrantStoreErrorCode,
    message: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * The decision made by a matching permission rule.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type RuleEffect = "allow" | "deny" | "ask"

const RuleEffect = Schema.Literals(["allow", "deny", "ask"])

/**
 * A capability pattern and the decision it applies.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export class Rule extends Schema.Class<Rule>("@smthrs/capability/Permission/Rule")({
  effect: RuleEffect,
  pattern: CapabilityPattern
}) {}

/**
 * Evaluates ordered permission rules.
 *
 * Matching rules are last-match-wins across all rulesets and the default is
 * `ask`. The configured ruleset is first reduced with that same rule before
 * an effective configured denial is treated as a hard veto. A configured deny
 * superseded by a later configured allow or ask is therefore not a veto.
 *
 * @category policy
 * @since 0.1.0
 * @slop
 */
export const evaluate = (
  rulesets: ReadonlyArray<ReadonlyArray<Rule>>,
  capability: Capability
): RuleEffect => {
  const configured = rulesets[0]
  let configuredEffect: RuleEffect = "ask"
  for (const rule of configured ?? []) {
    if (matches(rule.pattern, capability)) {
      configuredEffect = rule.effect
    }
  }
  if (configuredEffect === "deny") {
    return "deny"
  }

  let effect: RuleEffect = "ask"
  for (const ruleset of rulesets) {
    for (const rule of ruleset) {
      if (matches(rule.pattern, capability)) {
        effect = rule.effect
      }
    }
  }
  return effect
}

/**
 * Constructs a permission request for an exact capability.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const permissionRequired = (options: {
  readonly requestId: string
  readonly runId?: string | undefined
  readonly capability: Capability
  readonly tier: EffectTier
  readonly meta?: Readonly<Record<string, unknown>> | undefined
}): PermissionRequired =>
  new PermissionRequired({
    code: "permission_required",
    requestId: options.requestId,
    runId: options.runId,
    capability: options.capability,
    tier: options.tier,
    meta: { ...options.meta }
  })

/**
 * Constructs a denied permission failure.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const permissionDenied = (capability: Capability, reason: string): PermissionDenied =>
  new PermissionDenied({
    code: "permission_denied",
    capability,
    reason
  })

/**
 * Every failure the capability kernel can add to a guarded Host call.
 *
 * A protected service names this union in its own interface, so a caller that
 * holds the service cannot forget that an operation may be suspended, denied,
 * or left undecided by a broken grant store.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type PermissionError = PermissionRequired | PermissionDenied | GrantStoreError

/**
 * Refines an unknown value to a kernel permission failure.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const isPermissionError = (input: unknown): input is PermissionError =>
  typeof input === "object" && input !== null && "_tag" in input &&
  (input._tag === "@smthrs/capability/PermissionRequired" ||
    input._tag === "@smthrs/capability/PermissionDenied" ||
    input._tag === "@smthrs/capability/GrantStoreError")

/**
 * Renders a permission failure as the one-line `description` a `SystemError`
 * carries — the string a log line or an unattended report shows.
 *
 * @category formatting
 * @since 0.1.0
 * @slop
 */
export const formatError = (error: PermissionError): string => {
  switch (error._tag) {
    case "@smthrs/capability/PermissionRequired":
      return `${error.code}: ${format(error.capability)} (tier ${error.tier}, request ${error.requestId})`
    case "@smthrs/capability/PermissionDenied":
      return `${error.code}: ${format(error.capability)}: ${error.reason}`
    case "@smthrs/capability/GrantStoreError":
      // `message` is optional in the schema, but the `Error` base always
      // materializes it — an unset one is the empty string, not `undefined`.
      return `grant store ${error.code}${error.message ? `: ${error.message}` : ""}`
  }
}

/**
 * Projects a permission failure into Effect's `PlatformError` channel.
 *
 * Effect owns `FileSystem` and `ChildProcessSpawner`, and their tags fix the
 * error channel to `PlatformError`. Rather than mint a second tag whose only
 * difference is a wider error type, the kernel decorates those tags in place
 * and maps its own failures through here.
 *
 * Nothing is lost: the normalized reason is always `PermissionDenied` — the
 * operation did not happen because the capability kernel refused, suspended,
 * or could not decide it — `description` carries the human rendering from
 * {@link formatError}, and `cause` carries the structured failure itself, so
 * {@link fromPlatformError} hands the attended surface back the original
 * `capability`, `tier`, `requestId`, and `reason`.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const toPlatformError = (options: {
  readonly module: string
  readonly method: string
  readonly pathOrDescriptor?: string | number | undefined
  readonly error: PermissionError
}): PlatformError =>
  systemError({
    _tag: "PermissionDenied",
    module: options.module,
    method: options.method,
    description: formatError(options.error),
    ...(options.pathOrDescriptor === undefined ? {} : { pathOrDescriptor: options.pathOrDescriptor }),
    cause: options.error
  })

/**
 * Recovers the structured permission failure a {@link toPlatformError}
 * projection carries, so an attended surface can still reply to the request
 * and an unattended report can still name the capability.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const fromPlatformError = (error: PlatformError): Option.Option<PermissionError> =>
  isPermissionError(error.reason.cause) ? Option.some(error.reason.cause) : Option.none()
