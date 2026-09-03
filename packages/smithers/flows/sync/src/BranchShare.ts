/**
 * Share capabilities: the authorization boundary of a shared branch.
 *
 * A share link carries a capability, not a session. The capability names
 * exactly one branch, one access level, and one expiry, and it is signed, so
 * the holder cannot widen it. Every branch operation authorizes through
 * `verify`, which is therefore the single place cross-branch access and
 * expired links are refused.
 *
 * The signature is HMAC-SHA-256 over a length-prefixed encoding of the claims,
 * led by a scheme label. Length prefixes matter: without them a branch id
 * ending in the separator could be re-cut into a different, still-validly-
 * signed claim set. The label matters for the same reason across schemes: a
 * branch capability can never verify as a workspace capability even if one
 * secret is misconfigured into both authorities. Web Crypto is used directly
 * so the same module runs in the browser and on node.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { Access, BranchId, ShareCapability, ShareClaims } from "./BranchProtocol.ts"
import * as shareSigner from "./internal/shareSigner.ts"
import { SyncError } from "./SyncError.ts"

/**
 * The branch and access one authorization request needs.
 *
 * @category models
 * @since 0.1.0
 */
export const AuthorizeRequest = Schema.Struct({ branchId: BranchId, access: Access })

/**
 * The branch and access one authorization request needs.
 *
 * @category models
 * @since 0.1.0
 */
export type AuthorizeRequest = typeof AuthorizeRequest.Type

/**
 * What a freshly minted capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export const MintRequest = Schema.Struct({
  branchId: BranchId,
  capabilityId: Schema.NonEmptyString,
  access: Access,
  ttlMs: Schema.Int.check(Schema.isGreaterThan(0))
})

/**
 * What a freshly minted capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export type MintRequest = typeof MintRequest.Type

/**
 * Share capability operations.
 *
 * `mint` fails with a `SyncError` when the Web Crypto signing operation
 * rejects; `verify` fails with a `SyncError` when signing rejects or the
 * capability is refused.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly mint: (request: MintRequest) => Effect.Effect<ShareCapability, SyncError>
  readonly verify: (
    capability: ShareCapability,
    request: AuthorizeRequest
  ) => Effect.Effect<ShareClaims, SyncError>
}

/**
 * The branch share-capability authority.
 *
 * @category services
 * @since 0.1.0
 */
export class BranchShare extends Context.Service<BranchShare, Service>()("@smthrs/sync/BranchShare") {}

/**
 * Constructs a share authority from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => BranchShare.of(implementation)

const denied = (message: string): SyncError => new SyncError({ code: "unauthorized", message })

/**
 * Constructs a share authority that mints nothing and trusts nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    // Both operations FAIL. `mint` used to die, which contradicted its own
    // declared `Effect<ShareCapability, SyncError>` and left a consumer
    // wired to this authority unable to tell "sharing is off" from a bug.
    mint: () => Effect.fail(denied("Branch sharing is unavailable")),
    verify: () => Effect.fail(denied("Branch sharing is unavailable")),
    ...overrides
  })

/**
 * Provides a share authority that refuses every capability.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<BranchShare> = Layer.succeed(BranchShare, makeNoop())

/**
 * Domain separation: the label leads the signed encoding, so a branch
 * signature can never be replayed as a workspace signature (or any later
 * scheme's) under a shared secret. `WorkspaceShare` has always led with its
 * own label; a one-sided label protects one direction, and the branch side is
 * the one anonymous share-link holders reach.
 */
const schemeLabel = "@smthrs/sync/BranchShare/v1"

/** Length-prefixed so no two distinct claim sets share an encoding. */
const canonical = (claims: ShareClaims): string =>
  shareSigner.lengthPrefixed([
    schemeLabel,
    claims.branchId,
    claims.capabilityId,
    claims.access,
    String(claims.issuedAtMs),
    String(claims.expiresAtMs)
  ])

/**
 * The claim fields, copied out of the capability the caller owns.
 *
 * `Schema.Class` instances are not frozen, and `verify` awaits Web Crypto
 * between signing the claims and authorizing them. Reading the caller's object
 * again after the await let an in-process holder of the same instance widen
 * `access` — or move `expiresAtMs` — between the signature that was checked
 * and the checks that follow it.
 */
const snapshot = (claims: ShareClaims): ShareClaims =>
  new ShareClaims({
    branchId: claims.branchId,
    capabilityId: claims.capabilityId,
    access: claims.access,
    issuedAtMs: claims.issuedAtMs,
    expiresAtMs: claims.expiresAtMs
  })

/**
 * Constructs the HMAC-SHA-256 share authority over a shared secret.
 *
 * The secret is `Redacted`, matching {@link WorkspaceShare}: an authority
 * never holds a plain string that a log, a span, or an inspection of the
 * options object could render.
 *
 * Fails with a `SyncError` carrying the rejection as `cause` when Web Crypto
 * refuses to import the signing key.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeHmac = (
  options: { readonly secret: Redacted.Redacted<string> }
): Effect.Effect<Service, SyncError> =>
  Effect.map(
    shareSigner.importHmacKey(Redacted.value(options.secret)),
    (key) => {
      const sign = (claims: ShareClaims): Effect.Effect<string, SyncError> =>
        shareSigner.signHmac(key, canonical(claims))

      const mint = Effect.fn("BranchShare.mint")(function*(request: MintRequest) {
        yield* Effect.annotateCurrentSpan({ branchId: request.branchId, access: request.access })
        const issuedAtMs = yield* Clock.currentTimeMillis
        const claims = new ShareClaims({
          branchId: request.branchId,
          capabilityId: request.capabilityId,
          access: request.access,
          issuedAtMs,
          expiresAtMs: issuedAtMs + request.ttlMs
        })
        return new ShareCapability({ claims, signature: yield* sign(claims) })
      })

      const verify = Effect.fn("BranchShare.verify")(function*(
        capability: ShareCapability,
        request: AuthorizeRequest
      ) {
        yield* Effect.annotateCurrentSpan({ branchId: request.branchId, access: request.access })
        // Everything authorized below is read from these locals, never from
        // the caller's objects, which may change while Web Crypto is awaited.
        const claims = snapshot(capability.claims)
        const signature = capability.signature
        const branchId = request.branchId
        const access = request.access
        const expected = yield* sign(claims)
        if (!shareSigner.constantTimeEquals(expected, signature)) {
          return yield* Effect.fail(denied("The share capability signature is invalid"))
        }
        if (claims.branchId !== branchId) {
          return yield* Effect.fail(
            denied(`The share capability is scoped to branch ${claims.branchId}`)
          )
        }
        const nowMs = yield* Clock.currentTimeMillis
        if (nowMs >= claims.expiresAtMs) {
          return yield* Effect.fail(denied("The share capability has expired"))
        }
        if (access === "write" && claims.access !== "write") {
          return yield* Effect.fail(denied("The share capability is read-only"))
        }
        return claims
      })

      return make({ mint, verify })
    }
  )

/**
 * Provides the HMAC-SHA-256 share authority.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHmac = (
  options: { readonly secret: Redacted.Redacted<string> }
): Layer.Layer<BranchShare, SyncError> => Layer.effect(BranchShare, makeHmac(options))
