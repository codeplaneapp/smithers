/**
 * Gate 4's seam: per-call authorization against declared capabilities.
 *
 * The check runs outside the journal on purpose — the cell harness
 * lesson: a permission requirement must be re-decidable against a later
 * grant, so a parked chain re-asks on resume instead of replaying a
 * refusal forever. A policy denial becomes a journaled observation the
 * model routes around; a required approval parks the run without ending
 * the link, so resuming re-executes the call under the new grant
 * (`docs/specs/Concepts/Chain Harness Build.md`, PR 8).
 *
 * @since 0.1.0
 */
import * as Capability from "@smthrs/capability/Capability"
import type * as Permission from "@smthrs/capability/Permission"
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

/**
 * The rules-backed seam, evaluated pattern-to-pattern with the capability
 * package's `subsumes`: an `allow` rule must subsume the whole claim, a
 * `deny` rule fires on any overlap in either direction, `deny` beats
 * `ask` beats `allow` across a request's claims, and an unmatched or
 * unparseable claim asks — the kernel's conservative posture.
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
            let verdict: Permission.RuleEffect | undefined
            for (const rule of rules) {
              const covers = Capability.subsumes(rule.pattern, parsed.value)
              const overlaps = covers || Capability.subsumes(parsed.value, rule.pattern)
              if (rule.effect === "deny" ? overlaps : covers) {
                verdict = rule.effect
              }
            }
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
