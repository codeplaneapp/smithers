/**
 * In-memory capability grants with an attended Deferred request lifecycle.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 1.0.0-rc.0
 */
import {
  type Capability,
  Capability as CapabilityValue,
  CapabilityPattern,
  type EffectTier,
  format,
  matches,
  maxResourceLength,
  patternFromCapability,
  subsumes,
  tierOf
} from "@smthrs/capability/Capability"
import {
  evaluate,
  GrantStoreError,
  type PermissionDenied,
  permissionDenied,
  type PermissionRequired,
  permissionRequired,
  Rule
} from "@smthrs/capability/Permission"
import { Context, Deferred, Effect, Layer, Option, type Scope, Semaphore } from "effect"
import { allows, type CapabilitySet, current } from "./CapabilitySet.ts"
import { DeniedGrant, EnvelopeGrant, type GrantEvent, OnceGrant, RememberedGrant, RunGrant } from "./GrantEvent.ts"
import { Workspace } from "./Workspace.ts"

/**
 * A capability request waiting for an attended reply.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface PendingRequest {
  readonly requestId: string
  readonly capability: Capability
  readonly tier: EffectTier
  readonly meta: Record<string, unknown>
}

/**
 * A resolution supplied by an attended permission surface.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type Resolution = "once" | "run" | "remembered" | "deny"

/**
 * Scope and plan identity for a bulk envelope approval.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface EnvelopeGrantOptions {
  readonly planDigest: string
  readonly patterns: ReadonlyArray<CapabilityPattern>
  readonly scope?: "run" | "remembered" | undefined
}

/**
 * Operations exposed by the grant store.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface Service {
  readonly check: (
    capability: Capability,
    meta?: Record<string, unknown>
  ) => Effect.Effect<void, PermissionRequired | PermissionDenied | GrantStoreError>
  readonly reply: (
    requestId: string,
    resolution: Resolution,
    pattern?: CapabilityPattern
  ) => Effect.Effect<void, GrantStoreError>
  readonly list: Effect.Effect<ReadonlyArray<PendingRequest>>
  readonly grantEnvelope: (options: EnvelopeGrantOptions) => Effect.Effect<void, GrantStoreError>
}

/**
 * Service key for permission decisions and attended grant requests.
 *
 * @category services
 * @since 1.0.0-rc.0
 * @slop
 */
export class GrantStore extends Context.Service<GrantStore, Service>()("@smthrs/kernel/GrantStore") {}

/**
 * A hook that durably records a grant decision before it becomes active.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export type Persist = (event: GrantEvent) => Effect.Effect<void, GrantStoreError>

/**
 * Configuration for an in-memory grant store.
 *
 * A nested `rules` value is also accepted by the journal adapter: its first
 * ruleset is configured policy and subsequent rulesets are replayed remembered
 * grants.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface MakeOptions {
  readonly attended?: boolean | undefined
  readonly rules?: ReadonlyArray<Rule> | ReadonlyArray<ReadonlyArray<Rule>> | undefined
  readonly runRules?: ReadonlyArray<Rule> | undefined
  readonly envelope?: EnvelopeGrantOptions | undefined
  /**
   * {@link envelopeSignature} values of envelopes that are already durable —
   * typically replayed from a journal. A construction or runtime envelope
   * matching a seeded signature still activates its rules but is not
   * persisted again.
   */
  readonly envelopeSignatures?: ReadonlyArray<string> | undefined
  readonly runId?: string | undefined
  readonly planDigest?: string | undefined
  readonly persist?: Persist | undefined
}

interface PendingEntry extends PendingRequest {
  readonly ceiling: CapabilitySet
  readonly deferred: Deferred.Deferred<void, PermissionDenied>
}

/**
 * Maximum policy rules retained by one store.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumRules = 1_024
/**
 * Maximum predicates in one approval envelope.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumEnvelopePatterns = 256
/**
 * Maximum permission requests parked at once.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumPendingRequests = 1_024
/**
 * Maximum nesting depth of permission metadata.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumMetadataDepth = 16
/**
 * Maximum members across one permission metadata graph.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumMetadataMembers = 1_024
/**
 * Maximum encoded bytes retained for one metadata value.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumMetadataBytes = 64 * 1024
/**
 * Maximum encoded bytes persisted for one grant event.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumEventBytes = 256 * 1024
/**
 * Maximum length of a run, plan, request, or signature identity.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumIdentityLength = 4_096
/**
 * Maximum capability resource length enforced by the capability vocabulary.
 * @category limits
 * @since 1.0.0-rc.0
 */
export const maximumCapabilityResourceLength = maxResourceLength

const encoder = new TextEncoder()

const isWellFormed = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

const invalid = (message: string): GrantStoreError => new GrantStoreError({ code: "invalid_resolution", message })

const immutableFields = <A extends object, K extends keyof A>(
  value: A,
  fields: ReadonlyArray<K>
): A => {
  for (const field of fields) {
    Object.defineProperty(value, field, {
      value: value[field],
      enumerable: true,
      writable: false,
      configurable: false
    })
  }
  return value
}

const snapshotCapability = (capability: Capability): Capability =>
  immutableFields(
    new CapabilityValue({ action: capability.action, resource: capability.resource }),
    ["action", "resource"]
  )

const snapshotPattern = (pattern: CapabilityPattern): CapabilityPattern =>
  immutableFields(
    new CapabilityPattern({ action: pattern.action, resource: pattern.resource }),
    ["action", "resource"]
  )

const snapshotRule = (rule: Rule): Rule =>
  immutableFields(
    new Rule({ effect: rule.effect, pattern: snapshotPattern(rule.pattern) }),
    ["effect", "pattern"]
  )

const snapshotFailure = (what: string, cause: unknown): GrantStoreError =>
  cause instanceof GrantStoreError ? cause : invalid(`${what} is invalid`)

const attemptSnapshot = <A>(what: string, evaluate: () => A): Effect.Effect<A, GrantStoreError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) => snapshotFailure(what, cause)
  })

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

const metadataSnapshot = (input: Readonly<Record<string, unknown>>): Readonly<Record<string, Json>> => {
  let members = 0
  const active = new WeakSet<object>()

  const visit = (value: unknown, depth: number): Json => {
    if (depth > maximumMetadataDepth) throw invalid(`metadata exceeds depth ${maximumMetadataDepth}`)
    if (value === null || typeof value === "boolean") return value
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw invalid("metadata contains a non-finite number")
      return value
    }
    if (typeof value === "string") {
      if (!isWellFormed(value)) throw invalid("metadata contains ill-formed text")
      if (value.length > maximumMetadataBytes) throw invalid(`metadata exceeds ${maximumMetadataBytes} bytes`)
      return value
    }
    if (typeof value !== "object" || value === null) throw invalid("metadata must be JSON data")
    if (active.has(value)) throw invalid("metadata must not contain cycles")
    active.add(value)
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const snapshot: Array<Json> = []
        for (let index = 0; index < value.length; index += 1) {
          members += 1
          if (members > maximumMetadataMembers) {
            throw invalid(`metadata exceeds ${maximumMetadataMembers} members`)
          }
          const descriptor = descriptors[String(index)]
          if (descriptor === undefined || !("value" in descriptor)) {
            throw invalid("metadata arrays must be dense data")
          }
          snapshot.push(visit(descriptor.value, depth + 1))
        }
        return Object.freeze(snapshot)
      }

      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalid("metadata objects must be plain records")
      }
      const snapshot: Record<string, Json> = {}
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable) continue
        members += 1
        if (members > maximumMetadataMembers) {
          throw invalid(`metadata exceeds ${maximumMetadataMembers} members`)
        }
        if (!isWellFormed(key) || !("value" in descriptor)) {
          throw invalid("metadata members must be well-formed data properties")
        }
        if (descriptor.value !== undefined) snapshot[key] = visit(descriptor.value, depth + 1)
      }
      return Object.freeze(snapshot)
    } finally {
      active.delete(value)
    }
  }

  const snapshot = visit(input, 0)
  if (Array.isArray(snapshot) || snapshot === null || typeof snapshot !== "object") {
    throw invalid("metadata must be a record")
  }
  const encoded = JSON.stringify(snapshot)
  if (encoder.encode(encoded).byteLength > maximumMetadataBytes) {
    throw invalid(`metadata exceeds ${maximumMetadataBytes} bytes`)
  }
  return snapshot as Readonly<Record<string, Json>>
}

const validIdentity = (value: unknown): value is string | undefined =>
  value === undefined ||
  (typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumIdentityLength &&
    isWellFormed(value) &&
    !value.includes("\0"))

const prepareEnvelope = (
  input: EnvelopeGrantOptions,
  expectedPlanDigest: string | undefined,
  workspaceRoot: string
): Effect.Effect<{
  readonly planDigest: string
  readonly scope: "run" | "remembered"
  readonly patterns: ReadonlyArray<CapabilityPattern>
}, GrantStoreError> =>
  attemptSnapshot("grant envelope", () => {
    if (!Array.isArray(input.patterns)) throw invalid("patterns must be an array")
    if (input.patterns.length > maximumEnvelopePatterns) {
      throw invalid(`patterns exceed ${maximumEnvelopePatterns} entries`)
    }
    const patterns = canonicalEnvelopePatterns(input.patterns)
    // An empty envelope carries no authority. It is deliberately a no-op even
    // when replayed without the plan identity that authorized a non-empty one.
    if (patterns.length === 0) {
      return { planDigest: expectedPlanDigest ?? "", scope: "run" as const, patterns }
    }
    const scope = input.scope ?? "run"
    if (!isEnvelopeScope(scope)) throw invalid("scope must be run or remembered")
    if (expectedPlanDigest === undefined) throw invalid("grant envelope requires a configured planDigest")
    if (!validIdentity(input.planDigest)) throw invalid("planDigest is empty, malformed, or too long")
    if (input.planDigest !== expectedPlanDigest) throw invalid("planDigest mismatch")
    for (let index = 0; index < patterns.length; index += 1) {
      if (!isValidEnvelopePattern(patterns[index]!, workspaceRoot)) {
        throw invalid(`patterns[${index}] is outside the workspace envelope`)
      }
    }
    return { planDigest: input.planDigest, scope, patterns }
  })

/**
 * Records the displayed capability for once/deny audit events, which are never
 * installed or replayed as authority.
 */
const exactPattern = (capability: Capability): CapabilityPattern =>
  new CapabilityPattern({
    action: capability.action,
    resource: capability.resource
  })

const hasResourceWildcard = (resource: string): boolean => resource.includes("*") || resource.includes("?")

const isResolution = (value: string): value is Resolution =>
  value === "once" || value === "run" || value === "remembered" || value === "deny"

const isEnvelopeScope = (value: string): value is "run" | "remembered" => value === "run" || value === "remembered"

/**
 * Canonicalizes an envelope pattern list: duplicate predicates collapse to
 * their first occurrence and the survivors sort by their formatted identity.
 *
 * An envelope is a *set* of predicates, so two envelopes listing the same
 * predicates in a different order or multiplicity are the same approval. Every
 * envelope is canonicalized before it is persisted or compared, which makes
 * envelope idempotency structural rather than dependent on caller discipline.
 *
 * The ordering is the code-unit sort of `format(pattern)` — the one renderer
 * for capability identity. RFC 8785 canonical JSON (`@smthrs/canonical`)
 * was considered and does not fit: it canonicalizes object keys but preserves
 * array order as semantic, and the ordering that matters here is exactly the
 * pattern-array order.
 *
 * @category validation
 * @since 1.0.0-rc.0
 * @slop
 */
export const canonicalEnvelopePatterns = (
  patterns: ReadonlyArray<CapabilityPattern>
): ReadonlyArray<CapabilityPattern> => {
  const byIdentity = new Map<string, CapabilityPattern>()
  for (const input of patterns) {
    const pattern = snapshotPattern(input)
    const identity = format(pattern)
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, pattern)
    }
  }
  return Object.freeze([...byIdentity.keys()].sort().map((identity) => byIdentity.get(identity)!))
}

/**
 * Computes the canonical identity of an envelope approval.
 *
 * Two envelopes with the same plan digest, scope, and predicate set produce
 * the same signature regardless of pattern order or repetition. The signature
 * is how the store, and journal replay above it, recognise an envelope that
 * is already durable.
 *
 * @category validation
 * @since 1.0.0-rc.0
 * @slop
 */
export const envelopeSignature = (
  planDigest: string,
  scope: "run" | "remembered",
  patterns: ReadonlyArray<CapabilityPattern>
): string =>
  JSON.stringify({
    planDigest,
    scope,
    patterns: canonicalEnvelopePatterns(patterns).map(format)
  })

/**
 * Checks that a request-scoped grant cannot authorize a different action or a
 * more dangerous effect tier than the request displayed to the user. A
 * wildcard-bearing pattern identical to the resource is ambiguous because the
 * grammar has no escape, so its wildcard reading would silently widen access.
 *
 * @category validation
 * @since 1.0.0-rc.0
 * @slop
 */
export const isValidGrantPattern = (
  pattern: CapabilityPattern,
  capability: Capability,
  tier: EffectTier,
  workspaceRoot: string
): boolean => {
  if (pattern.action !== capability.action || !matches(pattern, capability)) {
    return false
  }
  if (hasResourceWildcard(pattern.resource) && pattern.resource === capability.resource) {
    return false
  }
  if (tierOf(capability, { workspaceRoot }) !== tier) {
    return false
  }
  if (capability.action !== "fs:write") {
    return true
  }
  if (tier === "irreversible") {
    return !hasResourceWildcard(pattern.resource)
  }
  const workspacePattern = new CapabilityPattern({
    action: "fs:write",
    resource: `${workspaceRoot.replace(/[\\/]+$/, "")}/**`
  })
  return pattern.resource === workspaceRoot || subsumes(workspacePattern, pattern)
}

/**
 * Checks that a bulk envelope pattern preserves exact action and filesystem
 * effect-tier boundaries.
 *
 * @category validation
 * @since 1.0.0-rc.0
 * @slop
 */
export const isValidEnvelopePattern = (
  pattern: CapabilityPattern,
  workspaceRoot: string
): boolean => {
  if (pattern.action.includes("*")) {
    return false
  }
  if (pattern.action !== "fs:write" || !hasResourceWildcard(pattern.resource)) {
    return true
  }
  const workspacePattern = new CapabilityPattern({
    action: "fs:write",
    resource: `${workspaceRoot.replace(/[\\/]+$/, "")}/**`
  })
  return subsumes(workspacePattern, pattern)
}

const normalizeRules = (
  rules: MakeOptions["rules"]
): {
  readonly configured: ReadonlyArray<Rule>
  readonly remembered: ReadonlyArray<Rule>
} => {
  if (rules === undefined || rules.length === 0 || rules[0] === undefined) {
    return { configured: [], remembered: [] }
  }
  if (rules.length > maximumRules) throw invalid(`rules exceed ${maximumRules} entries`)
  if (Array.isArray(rules[0])) {
    const rulesets = rules as ReadonlyArray<ReadonlyArray<Rule>>
    let count = 0
    for (const ruleset of rulesets) {
      count += ruleset.length
      if (count > maximumRules) throw invalid(`rules exceed ${maximumRules} entries`)
    }
    return {
      configured: Object.freeze(rulesets[0]!.map(snapshotRule)),
      remembered: Object.freeze(rulesets.slice(1).flatMap((ruleset) => ruleset.map(snapshotRule)))
    }
  }
  return {
    configured: Object.freeze((rules as ReadonlyArray<Rule>).map(snapshotRule)),
    remembered: []
  }
}

/**
 * Builds an in-memory grant store.
 *
 * Attended stores suspend an asking fiber on a request-local `Deferred`.
 * Unattended stores fail immediately with `PermissionRequired`. The returned
 * service is scoped: closing its scope rejects every waiter and clears the
 * pending map.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const make = (
  options: MakeOptions = {}
): Effect.Effect<Service, GrantStoreError, Scope.Scope | Workspace> =>
  Effect.gen(function*() {
    const attended = options.attended ?? true
    const runId = options.runId
    const planDigest = options.planDigest
    if (!validIdentity(runId)) {
      return yield* Effect.fail(invalid("runId is empty, malformed, or too long"))
    }
    if (!validIdentity(planDigest)) {
      return yield* Effect.fail(invalid("planDigest is empty, malformed, or too long"))
    }
    const workspace = yield* Workspace
    const initialCeiling = yield* current
    const workspaceRoot = workspace.root
    const initial = yield* attemptSnapshot("rules", () => normalizeRules(options.rules))
    const initialRunRules = yield* attemptSnapshot("runRules", () => {
      const values = options.runRules ?? []
      if (values.length > maximumRules) throw invalid(`runRules exceed ${maximumRules} entries`)
      return values.map(snapshotRule)
    })
    if (initial.configured.length + initial.remembered.length + initialRunRules.length > maximumRules) {
      return yield* Effect.fail(invalid(`rules exceed ${maximumRules} entries`))
    }
    const configuredRules = initial.configured
    const envelopeRules: Array<Rule> = []
    const runRules: Array<{ readonly rule: Rule; readonly ceiling: CapabilitySet }> = initialRunRules.map(
      (rule) => ({ rule, ceiling: initialCeiling })
    )
    const rememberedRules = [...initial.remembered]
    const pending = new Map<string, PendingEntry>()
    const persist = options.persist ?? (() => Effect.void)
    const signatures = yield* attemptSnapshot("envelopeSignatures", () => {
      const values = options.envelopeSignatures ?? []
      if (!Array.isArray(values) || values.length > maximumRules) {
        throw invalid(`envelopeSignatures exceed ${maximumRules} entries`)
      }
      return values.map((value, index) => {
        if (typeof value !== "string" || !validIdentity(value)) {
          throw invalid(`envelopeSignatures[${index}] is malformed or too long`)
        }
        return value
      })
    })
    const grantedEnvelopes = new Set<string>(signatures)
    let nextRequestId = 1
    let closed = false
    const mutation = yield* Semaphore.make(1)

    const persistEvent = (event: GrantEvent): Effect.Effect<void, GrantStoreError> => {
      // Every event is constructed below exclusively from validated primitive
      // identities and immutable capability snapshots, so encoding cannot
      // observe caller objects or invoke a caller-defined `toJSON` hook.
      const bytes = encoder.encode(JSON.stringify(event)).byteLength
      return bytes <= maximumEventBytes
        ? persist(event)
        : Effect.fail(invalid(`grant event exceeds ${maximumEventBytes} bytes`))
    }

    const invalidRemembered = rememberedRules.findIndex((rule) =>
      rule.effect === "allow" && !isValidEnvelopePattern(rule.pattern, workspaceRoot)
    )
    if (invalidRemembered !== -1) {
      return yield* Effect.fail(invalid(`rememberedRules[${invalidRemembered}] is outside the workspace envelope`))
    }
    const invalidRun = runRules.findIndex(({ rule }) =>
      rule.effect === "allow" && !isValidEnvelopePattern(rule.pattern, workspaceRoot)
    )
    if (invalidRun !== -1) {
      return yield* Effect.fail(invalid(`runRules[${invalidRun}] is outside the workspace envelope`))
    }

    if (options.envelope !== undefined) {
      const envelope = yield* prepareEnvelope(options.envelope, planDigest, workspaceRoot)
      const { patterns, scope } = envelope
      if (patterns.length === 0) {
        // An empty envelope carries no authority and no durable event.
      } else {
        const signature = envelopeSignature(envelope.planDigest, scope, patterns)
        if (!grantedEnvelopes.has(signature)) {
          // The same ceiling `grantEnvelope` applies at reply time. Without it
          // the construction envelope is the one write path that can push the
          // durable signature history past what a later construction is
          // willing to replay, which would brick every process after this one.
          if (grantedEnvelopes.size >= maximumRules) {
            return yield* Effect.fail(invalid(`grant envelopes exceed ${maximumRules} entries`))
          }
          yield* persistEvent(
            new EnvelopeGrant({
              eventType: "flows.kernel.grant.envelope.v1",
              runId: runId ?? "",
              planDigest: envelope.planDigest,
              patterns,
              scope
            })
          )
          grantedEnvelopes.add(signature)
        }
        const destination = scope === "remembered" ? rememberedRules : envelopeRules
        for (const pattern of patterns) {
          destination.push(new Rule({ effect: "allow", pattern }))
        }
      }
    }

    const rulesets = (capability: Capability): ReadonlyArray<ReadonlyArray<Rule>> => [
      configuredRules,
      envelopeRules,
      runRules
        .filter(({ ceiling }) => allows(ceiling, capability))
        .map(({ rule }) => rule),
      rememberedRules
    ]

    yield* Effect.addFinalizer(() =>
      mutation.withPermit(
        Effect.gen(function*() {
          closed = true
          const entries = [...pending.values()]
          pending.clear()
          yield* Effect.forEach(
            entries,
            (entry) =>
              Deferred.fail(
                entry.deferred,
                permissionDenied(entry.capability, "grant store closed")
              ),
            { discard: true }
          )
        })
      )
    )

    const allocateRequest = (
      capability: Capability,
      tier: EffectTier,
      meta: Record<string, unknown>,
      ceiling: CapabilitySet
    ): Effect.Effect<PendingEntry, GrantStoreError> =>
      Effect.gen(function*() {
        if (pending.size >= maximumPendingRequests) {
          return yield* Effect.fail(invalid(`pending requests exceed ${maximumPendingRequests} entries`))
        }
        const requestId = `permission-${nextRequestId++}`
        const deferred = yield* Deferred.make<void, PermissionDenied>()
        const entry: PendingEntry = {
          requestId,
          capability,
          tier,
          meta,
          ceiling,
          deferred
        }
        pending.set(requestId, entry)
        return entry
      })

    const nextUnattendedRequestId = Effect.sync(() => `permission-${nextRequestId++}`)

    const check: Service["check"] = Effect.fn("GrantStore.check")((capability, meta = {}) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const request = yield* attemptSnapshot("permission request", () => ({
            capability: snapshotCapability(capability),
            meta: metadataSnapshot(meta)
          }))
          const entry = yield* mutation.withPermit(
            Effect.gen(function*() {
              if (closed) {
                return yield* Effect.fail(new GrantStoreError({ code: "store_closed" }))
              }
              const ceiling = yield* current
              if (!allows(ceiling, request.capability)) {
                return yield* Effect.fail(permissionDenied(request.capability, "outside capability ceiling"))
              }

              const decision = evaluate(rulesets(request.capability), request.capability)
              if (decision === "allow") {
                return undefined
              }
              if (decision === "deny") {
                return yield* Effect.fail(permissionDenied(request.capability, "denied by permission policy"))
              }

              const tier = tierOf(request.capability, { workspaceRoot })
              if (!attended) {
                const requestId = yield* nextUnattendedRequestId
                return yield* Effect.fail(
                  permissionRequired({
                    requestId,
                    runId,
                    capability: request.capability,
                    tier,
                    meta: request.meta
                  })
                )
              }

              return yield* allocateRequest(
                request.capability,
                tier,
                request.meta,
                ceiling
              )
            })
          )
          if (entry === undefined) {
            return
          }
          return yield* restore(Deferred.await(entry.deferred)).pipe(
            Effect.ensuring(
              mutation.withPermit(
                Effect.sync(() => {
                  pending.delete(entry.requestId)
                })
              )
            )
          )
        })
      )
    )

    const resolveCovered: Effect.Effect<void> = Effect.suspend(() =>
      Effect.forEach(
        [...pending.entries()],
        ([requestId, entry]) => {
          if (
            !allows(entry.ceiling, entry.capability) ||
            evaluate(rulesets(entry.capability), entry.capability) !== "allow"
          ) {
            return Effect.void
          }
          return Deferred.succeed(entry.deferred, undefined).pipe(
            Effect.andThen(
              Effect.sync(() => {
                pending.delete(requestId)
              })
            )
          )
        },
        { discard: true }
      ).pipe(Effect.asVoid)
    )

    const reply: Service["reply"] = Effect.fn("GrantStore.reply")((
      requestId,
      resolution,
      suppliedPattern
    ) =>
      Effect.uninterruptible(
        mutation.withPermit(
          Effect.gen(function*() {
            if (closed) {
              return yield* Effect.fail(new GrantStoreError({ code: "store_closed" }))
            }
            if (!isResolution(resolution)) {
              // A runtime-invalid resolution must fail the reply, not fall
              // through the switch below: silently succeeding would strand
              // the request's waiter on its Deferred forever. The request
              // stays pending so the caller can still answer it.
              return yield* Effect.fail(
                new GrantStoreError({
                  code: "invalid_resolution",
                  message: "unknown grant resolution"
                })
              )
            }
            const entry = pending.get(requestId)
            if (entry === undefined) {
              return yield* Effect.fail(new GrantStoreError({ code: "request_not_found" }))
            }
            const pattern = yield* attemptSnapshot("grant pattern", () => {
              if (resolution === "run" || resolution === "remembered") {
                if (suppliedPattern !== undefined) return snapshotPattern(suppliedPattern)
                const derived = patternFromCapability(entry.capability)
                if (Option.isNone(derived)) {
                  throw invalid(
                    "the requested resource contains glob metacharacters; supply an explicit grant pattern or resolve once"
                  )
                }
                return snapshotPattern(derived.value)
              }
              return snapshotPattern(exactPattern(entry.capability))
            })

            switch (resolution) {
              case "once": {
                yield* persistEvent(
                  new OnceGrant({
                    eventType: "flows.kernel.grant.once.v1",
                    requestId,
                    runId: runId ?? "",
                    ...(planDigest === undefined ? {} : { planDigest }),
                    capability: entry.capability,
                    pattern,
                    scope: "once",
                    tier: entry.tier
                  })
                )
                yield* Deferred.succeed(entry.deferred, undefined)
                pending.delete(requestId)
                return
              }
              case "run": {
                if (planDigest === undefined) {
                  return yield* Effect.fail(
                    new GrantStoreError({
                      code: "invalid_resolution",
                      message: "run grants require a plan digest"
                    })
                  )
                }
                if (!isValidGrantPattern(pattern, entry.capability, entry.tier, workspaceRoot)) {
                  return yield* Effect.fail(invalid("grant pattern exceeds the requested authority"))
                }
                if (
                  configuredRules.length + envelopeRules.length + runRules.length + rememberedRules.length >=
                    maximumRules
                ) {
                  return yield* Effect.fail(invalid(`rules exceed ${maximumRules} entries`))
                }
                const rule = snapshotRule(new Rule({ effect: "allow", pattern }))
                yield* persistEvent(
                  new RunGrant({
                    eventType: "flows.kernel.grant.run.v1",
                    requestId,
                    runId: runId ?? "",
                    planDigest,
                    capability: entry.capability,
                    pattern,
                    scope: "run",
                    tier: entry.tier
                  })
                )
                runRules.push({ rule, ceiling: entry.ceiling })
                yield* resolveCovered
                return
              }
              case "remembered": {
                if (!isValidGrantPattern(pattern, entry.capability, entry.tier, workspaceRoot)) {
                  return yield* Effect.fail(invalid("grant pattern exceeds the requested authority"))
                }
                if (
                  configuredRules.length + envelopeRules.length + runRules.length + rememberedRules.length >=
                    maximumRules
                ) {
                  return yield* Effect.fail(invalid(`rules exceed ${maximumRules} entries`))
                }
                const rule = snapshotRule(new Rule({ effect: "allow", pattern }))
                yield* persistEvent(
                  new RememberedGrant({
                    eventType: "flows.kernel.grant.remembered.v1",
                    requestId,
                    runId: runId ?? "",
                    ...(planDigest === undefined ? {} : { planDigest }),
                    capability: entry.capability,
                    pattern,
                    scope: "remembered",
                    tier: entry.tier
                  })
                )
                rememberedRules.push(rule)
                yield* resolveCovered
                return
              }
              case "deny": {
                yield* persistEvent(
                  new DeniedGrant({
                    eventType: "flows.kernel.grant.denied.v1",
                    requestId,
                    runId: runId ?? "",
                    ...(planDigest === undefined ? {} : { planDigest }),
                    capability: entry.capability,
                    pattern,
                    scope: "once",
                    tier: entry.tier
                  })
                )
                yield* Deferred.fail(
                  entry.deferred,
                  permissionDenied(entry.capability, "permission request denied")
                )
                pending.delete(requestId)
                return
              }
            }
          })
        )
      )
    )

    const list: Service["list"] = Effect.fn("GrantStore.list")(() =>
      mutation.withPermit(
        Effect.sync(() =>
          Object.freeze(Array.from(
            pending.values(),
            ({ requestId, capability, tier, meta }): PendingRequest =>
              Object.freeze({
                requestId,
                capability: snapshotCapability(capability),
                tier,
                meta: metadataSnapshot(meta)
              })
          ))
        )
      )
    )()

    const grantEnvelope: Service["grantEnvelope"] = Effect.fn("GrantStore.grantEnvelope")((input) =>
      Effect.uninterruptible(
        Effect.gen(function*() {
          const prepared = yield* prepareEnvelope(input, planDigest, workspaceRoot)
          if (prepared.patterns.length === 0) return
          yield* mutation.withPermit(
            Effect.gen(function*() {
              if (closed) {
                return yield* Effect.fail(new GrantStoreError({ code: "store_closed" }))
              }
              const signature = envelopeSignature(prepared.planDigest, prepared.scope, prepared.patterns)
              if (grantedEnvelopes.has(signature)) {
                // The same approval was already activated and persisted —
                // repeating or reordering its predicates is a no-op, not new
                // durable evidence.
                return
              }
              if (
                configuredRules.length + envelopeRules.length + runRules.length + rememberedRules.length +
                    prepared.patterns.length > maximumRules
              ) {
                return yield* Effect.fail(invalid(`rules exceed ${maximumRules} entries`))
              }
              if (grantedEnvelopes.size >= maximumRules) {
                return yield* Effect.fail(invalid(`grant envelopes exceed ${maximumRules} entries`))
              }
              yield* persistEvent(
                new EnvelopeGrant({
                  eventType: "flows.kernel.grant.envelope.v1",
                  runId: runId ?? "",
                  planDigest: prepared.planDigest,
                  patterns: prepared.patterns,
                  scope: prepared.scope
                })
              )
              grantedEnvelopes.add(signature)
              const destination = prepared.scope === "remembered" ? rememberedRules : envelopeRules
              for (const pattern of prepared.patterns) {
                destination.push(snapshotRule(new Rule({ effect: "allow", pattern })))
              }
              yield* resolveCovered
            })
          )
        })
      )
    )

    return GrantStore.of({ check, reply, list, grantEnvelope })
  })

/**
 * Provides a scoped in-memory grant store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layer = (
  options: MakeOptions = {}
): Layer.Layer<GrantStore, GrantStoreError, Workspace> => Layer.effect(GrantStore, make(options))

/**
 * An allow-all grant store.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const makeNoop: Service = GrantStore.of({
  check: Effect.fn("GrantStore.check")(() => Effect.void),
  reply: Effect.fn("GrantStore.reply")(() => Effect.void),
  list: Effect.fn("GrantStore.list")(() => Effect.succeed([]))(),
  grantEnvelope: Effect.fn("GrantStore.grantEnvelope")(() => Effect.void)
})

/**
 * Provides the allow-all grant store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 * @slop
 */
export const layerNoop: Layer.Layer<GrantStore> = Layer.succeed(GrantStore)(makeNoop)
