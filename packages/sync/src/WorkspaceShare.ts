/**
 * Workspace share capabilities: the credential a sync connection presents to
 * read the workspace's non-branch runs.
 *
 * The scheme extends the branch share shape rather than inventing a parallel
 * one: a claim set and an HMAC-SHA-256 signature over its length-prefixed
 * canonical encoding, verified with a constant-time comparison. Two things
 * are added. A `kid` names the signing key inside the claims, so keys rotate
 * without invalidating capabilities minted under a retired key that is still
 * in the verification keyring. And the canonical encoding starts with a
 * scheme label, so a workspace capability can never verify as a branch
 * capability even if one secret is misconfigured into both authorities.
 *
 * Secrets enter through {@link Key} as `Redacted` values — a keyring never
 * holds a plain string — and {@link layerConfig} provisions the keyring from
 * configuration without any secret appearing in code.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { Access } from "./BranchProtocol.ts"
import * as shareSigner from "./internal/shareSigner.ts"
import { SyncError } from "./SyncError.ts"

/**
 * Schema for the claims a workspace capability carries.
 *
 * `kid` names the key that signed the claims and is itself signed, so a
 * verifier both selects the right key and refuses a capability whose key
 * name was swapped after minting.
 *
 * @category schemas
 * @since 0.1.0
 */
export class WorkspaceClaims extends Schema.Class<WorkspaceClaims>("@smthrs/sync/WorkspaceShare/WorkspaceClaims")({
  kid: Schema.NonEmptyString,
  capabilityId: Schema.NonEmptyString,
  access: Access,
  issuedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  expiresAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

/**
 * Schema for a signed, expiring, workspace-scoped capability.
 *
 * @category schemas
 * @since 0.1.0
 */
export class WorkspaceCapability extends Schema.Class<WorkspaceCapability>(
  "@smthrs/sync/WorkspaceShare/WorkspaceCapability"
)({
  claims: WorkspaceClaims,
  signature: Schema.String
}) {}

/**
 * The access one authorization request needs.
 *
 * @category models
 * @since 0.1.0
 */
export const AuthorizeRequest = Schema.Struct({ access: Access })

/**
 * The access one authorization request needs.
 *
 * @category models
 * @since 0.1.0
 */
export type AuthorizeRequest = typeof AuthorizeRequest.Type

/**
 * What a freshly minted workspace capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export const MintRequest = Schema.Struct({
  capabilityId: Schema.NonEmptyString,
  access: Access,
  ttlMs: Schema.Int.check(Schema.isGreaterThan(0))
})

/**
 * What a freshly minted workspace capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export type MintRequest = typeof MintRequest.Type

/**
 * Workspace share capability operations.
 *
 * `mint` fails with a `SyncError` when the Web Crypto signing operation
 * rejects; `verify` fails with a `SyncError` when signing rejects or the
 * capability is refused.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly mint: (request: MintRequest) => Effect.Effect<WorkspaceCapability, SyncError>
  readonly verify: (
    capability: WorkspaceCapability,
    request: AuthorizeRequest
  ) => Effect.Effect<WorkspaceClaims, SyncError>
}

/**
 * The workspace share-capability authority.
 *
 * @category services
 * @since 0.1.0
 */
export class WorkspaceShare extends Context.Service<WorkspaceShare, Service>()("@smthrs/sync/WorkspaceShare") {}

/**
 * Constructs a workspace share authority from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => WorkspaceShare.of(implementation)

const denied = (message: string): SyncError => new SyncError({ code: "unauthorized", message })

/**
 * Constructs a workspace share authority that mints nothing and trusts
 * nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    // Both operations FAIL. `mint` used to die, and this is the authority the
    // shipped CLI gateway wires, so a consumer handling `SyncError` on that
    // composition got a crash where the type promised a refusal.
    mint: () => Effect.fail(denied("Workspace sharing is unavailable")),
    verify: () => Effect.fail(denied("Workspace sharing is unavailable")),
    ...overrides
  })

/**
 * Provides a workspace share authority that refuses every capability.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<WorkspaceShare> = Layer.succeed(WorkspaceShare, makeNoop())

/**
 * One named signing key. The secret is `Redacted` so a keyring never renders
 * it into logs or inspection output.
 *
 * @category models
 * @since 0.1.0
 */
export interface Key {
  readonly kid: string
  readonly secret: Redacted.Redacted<string>
}

/**
 * A keyring: the key that signs new capabilities plus every key still
 * accepted for verification. Rotation adds a new active key and keeps the
 * retired one in `keys` until its outstanding capabilities expire.
 *
 * @category models
 * @since 0.1.0
 */
export interface Keyring {
  readonly activeKid: string
  readonly keys: ReadonlyArray<Key>
}

/**
 * Domain separation: the label leads the signed encoding, so a workspace
 * signature can never be replayed as any other scheme's signature under a
 * shared secret.
 */
const schemeLabel = "@smthrs/sync/WorkspaceShare/v1"

const canonical = (claims: WorkspaceClaims): string =>
  shareSigner.lengthPrefixed([
    schemeLabel,
    claims.kid,
    claims.capabilityId,
    claims.access,
    String(claims.issuedAtMs),
    String(claims.expiresAtMs)
  ])

/**
 * The claim fields, copied out of the capability the caller owns.
 *
 * `Schema.Class` instances are not frozen, and `verify` awaits Web Crypto
 * between signing the claims and authorizing them, so the checks must read a
 * snapshot rather than an object the caller can still mutate.
 */
const snapshot = (claims: WorkspaceClaims): WorkspaceClaims =>
  new WorkspaceClaims({
    kid: claims.kid,
    capabilityId: claims.capabilityId,
    access: claims.access,
    issuedAtMs: claims.issuedAtMs,
    expiresAtMs: claims.expiresAtMs
  })

/**
 * Constructs the HMAC-SHA-256 workspace share authority over a keyring.
 *
 * Every key is imported up front, so a misconfigured keyring — an unknown
 * active kid, a duplicate kid, or a key Web Crypto refuses — fails at
 * construction rather than at the first request.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeHmac = (keyring: Keyring): Effect.Effect<Service, SyncError> =>
  Effect.gen(function*() {
    const imported = new Map<string, CryptoKey>()
    for (const key of keyring.keys) {
      if (imported.has(key.kid)) {
        return yield* Effect.fail(
          new SyncError({ code: "invalid_request", message: `The workspace keyring names kid ${key.kid} twice` })
        )
      }
      imported.set(key.kid, yield* shareSigner.importHmacKey(Redacted.value(key.secret)))
    }
    // Copied at construction: the keyring belongs to the caller, and the
    // authority must keep signing under the kid it validated here.
    const activeKid = keyring.activeKid
    const active = imported.get(activeKid)
    if (active === undefined) {
      return yield* Effect.fail(
        new SyncError({
          code: "invalid_request",
          message: "The workspace keyring's active kid names no key in the ring"
        })
      )
    }

    const mint = Effect.fn("WorkspaceShare.mint")(function*(request: MintRequest) {
      yield* Effect.annotateCurrentSpan({ access: request.access })
      const issuedAtMs = yield* Clock.currentTimeMillis
      const claims = new WorkspaceClaims({
        kid: activeKid,
        capabilityId: request.capabilityId,
        access: request.access,
        issuedAtMs,
        expiresAtMs: issuedAtMs + request.ttlMs
      })
      return new WorkspaceCapability({ claims, signature: yield* shareSigner.signHmac(active, canonical(claims)) })
    })

    const verify = Effect.fn("WorkspaceShare.verify")(function*(
      capability: WorkspaceCapability,
      request: AuthorizeRequest
    ) {
      yield* Effect.annotateCurrentSpan({ access: request.access })
      // Everything authorized below is read from these locals, never from the
      // caller's objects, which may change while Web Crypto is awaited.
      const claims = snapshot(capability.claims)
      const signature = capability.signature
      const access = request.access
      const key = imported.get(claims.kid)
      if (key === undefined) {
        return yield* Effect.fail(denied("The workspace capability names an unknown signing key"))
      }
      const expected = yield* shareSigner.signHmac(key, canonical(claims))
      if (!shareSigner.constantTimeEquals(expected, signature)) {
        return yield* Effect.fail(denied("The workspace capability signature is invalid"))
      }
      const nowMs = yield* Clock.currentTimeMillis
      if (nowMs >= claims.expiresAtMs) {
        return yield* Effect.fail(denied("The workspace capability has expired"))
      }
      if (access === "write" && claims.access !== "write") {
        return yield* Effect.fail(denied("The workspace capability is read-only"))
      }
      return claims
    })

    return make({ mint, verify })
  })

/**
 * Provides the HMAC-SHA-256 workspace share authority over a keyring.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHmac = (keyring: Keyring): Layer.Layer<WorkspaceShare, SyncError> =>
  Layer.effect(WorkspaceShare, makeHmac(keyring))

/**
 * Provides the workspace share authority from configuration: the secret from
 * `FLOWS_SYNC_SECRET` (read as `Redacted`, never logged) and the key name
 * from `FLOWS_SYNC_KEY_ID`, defaulting to `primary`. Rotation beyond one
 * configured key uses {@link layerHmac} with an explicit keyring.
 *
 * There is deliberately no default secret: a deployment that configures
 * nothing fails to construct the authority, and the read path stays closed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerConfig: Layer.Layer<WorkspaceShare, SyncError | Config.ConfigError> = Layer.effect(
  WorkspaceShare,
  Effect.gen(function*() {
    const secret = yield* Config.redacted("FLOWS_SYNC_SECRET")
    const kid = yield* Config.string("FLOWS_SYNC_KEY_ID").pipe(Config.withDefault("primary"))
    return yield* makeHmac({ activeKid: kid, keys: [{ kid, secret }] })
  })
)
