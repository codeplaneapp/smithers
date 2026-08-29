/**
 * In-memory capability grants with an attended Deferred request lifecycle.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import {
  type Capability,
  CapabilityPattern,
  type EffectTier,
  format,
  matches,
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
import { Context, Deferred, Effect, Layer, type Scope, Semaphore } from "effect"
import { allows, type CapabilitySet, current } from "./CapabilitySet.ts"
import { DeniedGrant, EnvelopeGrant, type GrantEvent, OnceGrant, RememberedGrant, RunGrant } from "./GrantEvent.ts"
import { Workspace } from "./Workspace.ts"

/**
 * A capability request waiting for an attended reply.
 *
 * @category models
 * @since 0.1.0
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
 * @since 0.1.0
 * @slop
 */
export type Resolution = "once" | "run" | "remembered" | "deny"

/**
 * Scope and plan identity for a bulk envelope approval.
 *
 * @category models
 * @since 0.1.0
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
 * @since 0.1.0
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
 * @since 0.1.0
 * @slop
 */
export class GrantStore extends Context.Service<GrantStore, Service>()("@smthrs/kernel/GrantStore") {}

/**
 * A hook that durably records a grant decision before it becomes active.
 *
 * @category models
 * @since 0.1.0
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
 * @since 0.1.0
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
 * @since 0.1.0
 * @slop
 */
export const canonicalEnvelopePatterns = (
  patterns: ReadonlyArray<CapabilityPattern>
): Array<CapabilityPattern> => {
  const byIdentity = new Map<string, CapabilityPattern>()
  for (const pattern of patterns) {
    const identity = format(pattern)
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, pattern)
    }
  }
  return [...byIdentity.keys()].sort().map((identity) => byIdentity.get(identity)!)
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
 * @since 0.1.0
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
 * more dangerous effect tier than the request displayed to the user.
 *
 * @category validation
 * @since 0.1.0
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
 * @since 0.1.0
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
  readonly configured: Array<Rule>
  readonly remembered: Array<Rule>
} => {
  if (rules === undefined || rules.length === 0 || rules[0] === undefined) {
    return { configured: [], remembered: [] }
  }
  if (Array.isArray(rules[0])) {
    const rulesets = rules as ReadonlyArray<ReadonlyArray<Rule>>
    return {
      configured: [...rulesets[0]!],
      remembered: rulesets.slice(1).flatMap((ruleset) => [...ruleset])
    }
  }
  return {
    configured: [...(rules as ReadonlyArray<Rule>)],
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
 * @since 0.1.0
 * @slop
 */
export const make = (
  options: MakeOptions = {}
): Effect.Effect<Service, GrantStoreError, Scope.Scope | Workspace> =>
  Effect.gen(function*() {
    const attended = options.attended ?? true
    const workspace = yield* Workspace
    const initialCeiling = yield* current
    const workspaceRoot = workspace.root
    const initial = normalizeRules(options.rules)
    const configuredRules = initial.configured
    const envelopeRules: Array<Rule> = []
    const runRules: Array<{ readonly rule: Rule; readonly ceiling: CapabilitySet }> = (options.runRules ?? []).map(
      (rule) => ({ rule, ceiling: initialCeiling })
    )
    const rememberedRules = initial.remembered
    const pending = new Map<string, PendingEntry>()
    const persist = options.persist ?? (() => Effect.void)
    const grantedEnvelopes = new Set<string>(options.envelopeSignatures ?? [])
    let nextRequestId = 1
    let closed = false
    const mutation = yield* Semaphore.make(1)

    if (
      rememberedRules.some((rule) => rule.effect === "allow" && !isValidEnvelopePattern(rule.pattern, workspaceRoot))
      || runRules.some(({ rule }) => rule.effect === "allow" && !isValidEnvelopePattern(rule.pattern, workspaceRoot))
    ) {
      return yield* Effect.fail(new GrantStoreError({ code: "invalid_resolution" }))
    }

    if (options.envelope !== undefined && options.envelope.patterns.length > 0) {
      const scope = options.envelope.scope ?? "run"
      if (
        !isEnvelopeScope(scope)
        || options.planDigest === undefined
        || options.envelope.planDigest !== options.planDigest
        || options.envelope.planDigest.length === 0
        || options.envelope.patterns.some((pattern) => !isValidEnvelopePattern(pattern, workspaceRoot))
      ) {
        return yield* Effect.fail(new GrantStoreError({ code: "invalid_resolution" }))
      }
      const patterns = canonicalEnvelopePatterns(options.envelope.patterns)
      const signature = envelopeSignature(options.envelope.planDigest, scope, patterns)
      if (!grantedEnvelopes.has(signature)) {
        yield* persist(
          new EnvelopeGrant({
            eventType: "flows.kernel.grant.envelope.v1",
            runId: options.runId ?? "",
            planDigest: options.envelope.planDigest,
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
          const entry = yield* mutation.withPermit(
            Effect.gen(function*() {
              if (closed) {
                return yield* Effect.fail(new GrantStoreError({ code: "store_closed" }))
              }
              const ceiling = yield* current
              if (!allows(ceiling, capability)) {
                return yield* Effect.fail(permissionDenied(capability, "outside capability ceiling"))
              }

              const decision = evaluate(rulesets(capability), capability)
              if (decision === "allow") {
                return undefined
              }
              if (decision === "deny") {
                return yield* Effect.fail(permissionDenied(capability, "denied by permission policy"))
              }

              const tier = tierOf(capability, { workspaceRoot })
              if (!attended) {
                const requestId = yield* nextUnattendedRequestId
                return yield* Effect.fail(
                  permissionRequired({
                    requestId,
                    runId: options.runId,
                    capability,
                    tier,
                    meta
                  })
                )
              }

              return yield* allocateRequest(capability, tier, { ...meta }, ceiling)
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
            const pattern = resolution === "run" || resolution === "remembered"
              ? suppliedPattern ?? exactPattern(entry.capability)
              : exactPattern(entry.capability)

            switch (resolution) {
              case "once": {
                yield* persist(
                  new OnceGrant({
                    eventType: "flows.kernel.grant.once.v1",
                    requestId,
                    runId: options.runId ?? "",
                    ...(options.planDigest === undefined ? {} : { planDigest: options.planDigest }),
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
                if (options.planDigest === undefined || options.planDigest.length === 0) {
                  return yield* Effect.fail(
                    new GrantStoreError({
                      code: "invalid_resolution",
                      message: "run grants require a plan digest"
                    })
                  )
                }
                if (!isValidGrantPattern(pattern, entry.capability, entry.tier, workspaceRoot)) {
                  return yield* Effect.fail(new GrantStoreError({ code: "invalid_resolution" }))
                }
                const rule = new Rule({ effect: "allow", pattern })
                yield* persist(
                  new RunGrant({
                    eventType: "flows.kernel.grant.run.v1",
                    requestId,
                    runId: options.runId ?? "",
                    planDigest: options.planDigest,
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
                  return yield* Effect.fail(new GrantStoreError({ code: "invalid_resolution" }))
                }
                const rule = new Rule({ effect: "allow", pattern })
                yield* persist(
                  new RememberedGrant({
                    eventType: "flows.kernel.grant.remembered.v1",
                    requestId,
                    runId: options.runId ?? "",
                    ...(options.planDigest === undefined ? {} : { planDigest: options.planDigest }),
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
                yield* persist(
                  new DeniedGrant({
                    eventType: "flows.kernel.grant.denied.v1",
                    requestId,
                    runId: options.runId ?? "",
                    ...(options.planDigest === undefined ? {} : { planDigest: options.planDigest }),
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
          Array.from(
            pending.values(),
            ({ requestId, capability, tier, meta }): PendingRequest => ({
              requestId,
              capability,
              tier,
              meta
            })
          )
        )
      )
    )()

    const grantEnvelope: Service["grantEnvelope"] = Effect.fn("GrantStore.grantEnvelope")((
      { patterns, planDigest, scope = "run" }
    ) =>
      Effect.uninterruptible(
        mutation.withPermit(
          Effect.gen(function*() {
            if (closed) {
              return yield* Effect.fail(new GrantStoreError({ code: "store_closed" }))
            }
            if (
              !isEnvelopeScope(scope)
              || options.planDigest === undefined
              || planDigest !== options.planDigest
              || planDigest.length === 0
              || patterns.some((pattern) => !isValidEnvelopePattern(pattern, workspaceRoot))
            ) {
              // A runtime-invalid scope is caller input, not a defect: it must
              // surface as a typed store error before it can reach the event
              // schema constructor.
              return yield* Effect.fail(new GrantStoreError({ code: "invalid_resolution" }))
            }
            if (patterns.length === 0) {
              return
            }
            const canonical = canonicalEnvelopePatterns(patterns)
            const signature = envelopeSignature(planDigest, scope, canonical)
            if (grantedEnvelopes.has(signature)) {
              // The same approval was already activated and persisted —
              // repeating or reordering its predicates is a no-op, not new
              // durable evidence.
              return
            }
            yield* persist(
              new EnvelopeGrant({
                eventType: "flows.kernel.grant.envelope.v1",
                runId: options.runId ?? "",
                planDigest,
                patterns: canonical,
                scope
              })
            )
            grantedEnvelopes.add(signature)
            const destination = scope === "remembered" ? rememberedRules : envelopeRules
            for (const pattern of canonical) {
              destination.push(new Rule({ effect: "allow", pattern }))
            }
            yield* resolveCovered
          })
        )
      )
    )

    return GrantStore.of({ check, reply, list, grantEnvelope })
  })

/**
 * Provides a scoped in-memory grant store.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (
  options: MakeOptions = {}
): Layer.Layer<GrantStore, GrantStoreError, Workspace> => Layer.effect(GrantStore, make(options))

/**
 * An allow-all grant store.
 *
 * @category constructors
 * @since 0.1.0
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
 * @since 0.1.0
 * @slop
 */
export const layerNoop: Layer.Layer<GrantStore> = Layer.succeed(GrantStore)(makeNoop)
