/**
 * Gate 4's seam: per-call authorization against declared capabilities.
 *
 * The check runs outside the journal on purpose — the cell harness
 * lesson: a permission requirement must be re-decidable against a later
 * grant, so a parked chain re-asks on resume instead of replaying a
 * refusal forever. A policy denial becomes a journaled observation the
 * model routes around; a required approval parks the run without ending
 * the link, so resuming re-executes the call under the new grant
 * (`packages/chain/docs/contract.md`).
 *
 * @since 0.1.0
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type * as Catalog from "./Catalog.ts"

/**
 * A refusal from the authorization seam: a policy denial, a required
 * approval, or an unreachable seam.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class AuthorizeError extends Schema.TaggedError<AuthorizeError>()("/chain/AuthorizeError", {
  code: Schema.Literals(["denied", "approval_required", "authorize_unavailable"]),
  message: Schema.String
}) {}

/**
 * What the chain hands the seam: the call's name, the capability claims
 * its entry declares (an undeclared entry claims everything), and the
 * call slot.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Request {
  readonly name: string
  readonly capabilities: ReadonlyArray<string>
  readonly slot: Catalog.CallSlot
}

/**
 * The seam's one operation: succeed when the call is allowed, fail with the
 * typed refusal otherwise.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly authorize: (request: Request) => Effect.Effect<void, AuthorizeError>
}

/**
 * The authorization seam service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Authorize extends Context.Service<Authorize, Service>()("/chain/Authorize") {}

/**
 * Builds a seam from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => Authorize.of(implementation)

/**
 * A seam whose every operation fails as unavailable, with per-operation
 * overrides — the default a test starts from.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    authorize: Effect.fn("Authorize.authorize")(() =>
      Effect.fail(new AuthorizeError({ code: "authorize_unavailable", message: "authorize is unavailable" }))
    ),
    ...overrides
  })

/**
 * The unavailable seam as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Authorize> =>
  Layer.succeed(Authorize)(makeNoop(overrides))

/**
 * Parses a declared claim into a capability pattern. Claims are patterns,
 * not exact capabilities: `*` claims everything, `ns:op` and `ns:*` claim
 * whole action families, `ns:op:resource` claims a resource glob. An
 * unparseable claim is `None` — the seam asks for it, never passes it.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const claimPattern = (declared: string): Option.Option<Capability.CapabilityPattern> => {
  if (declared === "*") {
    return Option.some(new Capability.CapabilityPattern({ action: "*", resource: "**" }))
  }
  const components = declared.split(":")
  const namespace = components[0]
  if (namespace === undefined || namespace === "") return Option.none()
  const operation = components[1]
  if (operation === undefined || operation === "") return Option.none()
  const action = `${namespace}:${operation}`
  const decoded = Schema.decodeUnknownOption(Capability.CapabilityPattern)({
    action,
    resource: components.length > 2 ? components.slice(2).join(":") : "**"
  })
  return decoded._tag === "Some" ? decoded : Option.none()
}

const decodeCapability = Schema.decodeUnknownOption(Capability.Capability)

/**
 * The claim as an exact capability, when it names one. A claim whose action
 * is a family selector (`*`, `ns:*`) or whose resource carries a glob
 * metacharacter selects a SET of capabilities, and `Permission.evaluate`
 * decides one capability at a time, so those stay on the pattern path.
 */
const exactCapability = (claim: Capability.CapabilityPattern): Option.Option<Capability.Capability> =>
  claim.resource.includes("*") || claim.resource.includes("?")
    ? Option.none()
    : decodeCapability({ action: claim.action, resource: claim.resource })

const anyResource = (action: Capability.CapabilityPattern["action"]): Capability.CapabilityPattern =>
  new Capability.CapabilityPattern({ action, resource: "**" })

/**
 * Whether two action selectors can name a common action. Selectors are `*`,
 * `ns:*`, or an exact action, and for those three shapes overlap is exactly
 * subsumption in one direction or the other, so this reuses the capability
 * package's predicate over a resource both sides cover rather than
 * re-deriving the action grammar.
 */
const actionsMayOverlap = (
  left: Capability.CapabilityPattern["action"],
  right: Capability.CapabilityPattern["action"]
): boolean =>
  Capability.subsumes(anyResource(left), anyResource(right)) ||
  Capability.subsumes(anyResource(right), anyResource(left))

/** The leading run of a resource glob that matches itself literally. */
const literalPrefix = (resource: string): string => {
  const star = resource.indexOf("*")
  const question = resource.indexOf("?")
  const end = Math.min(star < 0 ? resource.length : star, question < 0 ? resource.length : question)
  return resource.slice(0, end)
}

/**
 * Whether two resource globs can select a common resource. The answer is
 * `false` only when disjointness is PROVABLE — two literals that differ, or
 * literal prefixes that disagree on their shared span — and `true`
 * otherwise. That asymmetry is the point: this predicate only ever decides
 * whether a `deny` rule applies, so an unprovable relationship must keep
 * the deny alive rather than fall through to a later allow.
 */
const resourcesMayOverlap = (left: string, right: string): boolean => {
  const leftPrefix = literalPrefix(left)
  const rightPrefix = literalPrefix(right)
  if (leftPrefix === left && rightPrefix === right) return left === right
  const shared = Math.min(leftPrefix.length, rightPrefix.length)
  return leftPrefix.slice(0, shared) === rightPrefix.slice(0, shared)
}

const mayOverlap = (rule: Capability.CapabilityPattern, claim: Capability.CapabilityPattern): boolean =>
  actionsMayOverlap(rule.action, claim.action) && resourcesMayOverlap(rule.resource, claim.resource)

/**
 * How restrictive an effect is. A rule that covers only PART of a claimed
 * set can raise the verdict for that part, and nothing narrower than the
 * whole set can lower it again: a later `ask` over `secret/public` must not
 * erase a `deny` that still covers `secret/private`.
 */
const restriction: Record<Permission.RuleEffect, number> = { allow: 0, ask: 1, deny: 2 }

/**
 * Evaluates one wildcard claim, which names a set of capabilities rather
 * than a single one.
 *
 * A rule that PROVABLY covers the whole claim is the last word for every
 * member, so whole-set matches are last-match-wins exactly as
 * `Permission.evaluate` orders rules for one capability. A `deny` or `ask`
 * that only may overlap part of the claim can only raise the verdict; it
 * cannot lower a restriction that still governs another member.
 */
const evaluatePattern = (
  rules: ReadonlyArray<Permission.Rule>,
  claim: Capability.CapabilityPattern
): Permission.RuleEffect => {
  let verdict: Permission.RuleEffect = "ask"
  for (const rule of rules) {
    if (Capability.subsumes(rule.pattern, claim)) {
      // The rule covers every member of the claim, so it is the last word for
      // all of them: last-match-wins, exactly as `Permission.evaluate` orders
      // rules for one concrete capability.
      verdict = rule.effect
      continue
    }
    // An `allow` that cannot prove it covers the whole set grants nothing.
    if (
      rule.effect !== "allow" && mayOverlap(rule.pattern, claim) &&
      restriction[rule.effect] > restriction[verdict]
    ) {
      verdict = rule.effect
    }
  }
  return verdict
}

/**
 * The rules-backed seam. A claim that names one exact capability is decided
 * by `@smthrs/capability`'s own `Permission.evaluate`, so a host reusing its
 * kernel ruleset gets the same verdict from both engines. A claim that names
 * a SET — a family action or a resource glob — is decided pattern-to-pattern
 * instead, since `evaluate` takes one concrete capability. A rule that
 * subsumes the whole set is last-match-wins; a `deny` or `ask` that may cover
 * only part of the set can only raise the verdict, so an undecidable
 * restriction never erases or falls through another member's restriction.
 *
 * Two orderings, deliberately distinct. Across a REQUEST'S CLAIMS `deny`
 * beats `ask` beats `allow`: any denied claim refuses the call and any
 * asking claim outranks an allowed one. Across RULES a whole-set match wins
 * outright, while a partial restricting match only raises the verdict. Thus
 * a later whole-set allow can override an earlier partial deny, but a later
 * narrow ask cannot erase a deny that still covers the rest of the claim.
 *
 * An unmatched or unparseable claim asks — the kernel's conservative
 * posture.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerRules = (rules: ReadonlyArray<Permission.Rule>): Layer.Layer<Authorize> =>
  Layer.succeed(Authorize)(
    make({
      authorize: Effect.fn("Authorize.authorize")((request) =>
        Effect.gen(function*() {
          // Defensive for direct service users: the chain itself defaults
          // undeclared entries to the broadest claim before calling.
          const claims = request.capabilities.length === 0 ? ["*"] : request.capabilities
          let ask: string | undefined
          for (const declared of claims) {
            const parsed = claimPattern(declared)
            if (Option.isNone(parsed)) {
              ask = ask ?? declared
              continue
            }
            const exact = exactCapability(parsed.value)
            const verdict = Option.isSome(exact)
              ? Permission.evaluate([rules], exact.value)
              : evaluatePattern(rules, parsed.value)
            if (verdict === "deny") {
              return yield* new AuthorizeError({
                code: "denied",
                message: `"${request.name}" is denied for ${declared}`
              })
            }
            if (verdict !== "allow") {
              ask = ask ?? declared
            }
          }
          if (ask !== undefined) {
            return yield* new AuthorizeError({
              code: "approval_required",
              message: `"${request.name}" needs approval for ${ask}`
            })
          }
        })
      )
    })
  )

/**
 * An allow-everything seam for hosts that enforce elsewhere.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerAllowAll: Layer.Layer<Authorize> = Layer.succeed(Authorize)(
  make({ authorize: Effect.fn("Authorize.authorize")(() => Effect.void) })
)
