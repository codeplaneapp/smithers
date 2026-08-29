/**
 * Share capabilities: the authorization boundary of a shared branch.
 *
 * A share link carries a capability, not a session. The capability names
 * exactly one branch, one access level, and one expiry, and it is signed, so
 * the holder cannot widen it. Every branch operation authorizes through
 * `verify`, which is therefore the single place cross-branch access and
 * expired links are refused.
 *
 * The signature is HMAC-SHA-256 over a length-prefixed encoding of the claims.
 * Length prefixes matter: without them a branch id ending in the separator
 * could be re-cut into a different, still-validly-signed claim set. Web Crypto
 * is used directly so the same module runs in the browser and on node.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
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
    mint: () => Effect.die(denied("Branch sharing is unavailable")),
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

/** Length-prefixed so no two distinct claim sets share an encoding. */
const canonical = (claims: ShareClaims): string =>
  shareSigner.lengthPrefixed(
    [claims.branchId, claims.capabilityId, claims.access, String(claims.issuedAtMs), String(claims.expiresAtMs)]
  )

/**
 * Constructs the HMAC-SHA-256 share authority over a shared secret.
 *
 * Fails with a `SyncError` carrying the rejection as `cause` when Web Crypto
 * refuses to import the signing key.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeHmac = (options: { readonly secret: string }): Effect.Effect<Service, SyncError> =>
  Effect.map(
    shareSigner.importHmacKey(options.secret),
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
        const claims = capability.claims
        const expected = yield* sign(claims)
        if (!shareSigner.constantTimeEquals(expected, capability.signature)) {
          return yield* Effect.fail(denied("The share capability signature is invalid"))
        }
        if (claims.branchId !== request.branchId) {
          return yield* Effect.fail(
            denied(`The share capability is scoped to branch ${claims.branchId}`)
          )
        }
        const nowMs = yield* Clock.currentTimeMillis
        if (nowMs >= claims.expiresAtMs) {
          return yield* Effect.fail(denied("The share capability has expired"))
        }
        if (request.access === "write" && claims.access !== "write") {
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
export const layerHmac = (options: { readonly secret: string }): Layer.Layer<BranchShare, SyncError> =>
  Layer.effect(BranchShare, makeHmac(options))
