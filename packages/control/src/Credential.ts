/**
 * Credential storage boundary.
 *
 * Credentials are capabilities. They must never enter flow input, plan
 * digests, journal payloads, or model context, so only a {@link CredentialRef}
 * — an id and a human-readable connection name — crosses the browser-safe
 * contract. Plaintext exists in exactly two places: inside a `Redacted` handed
 * to `create`/`rotate`, and inside the `Redacted` returned by `resolve`.
 *
 * The implementation composes two ports:
 *
 * - {@link CredentialStore} persists an opaque sealed record and enforces
 *   compare-and-set on writes, so concurrent rotations cannot interleave.
 * - {@link CredentialCipher} seals and opens the secret under host-managed
 *   keys. `WebCryptoCipher` is the browser and Node adapter; a host with no
 *   secure key material fails with the typed `Unavailable`.
 *
 * Authorization is a host decision, injected as {@link Options.authorize}. A
 * reference is also authenticated on every operation: a caller cannot present
 * a forged or stale `CredentialRef` and have it resolve, because the name on
 * the reference must still match the stored record.
 *
 * See `.smithers/tickets/control-credential-storage.md`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Option, type Redacted } from "effect"
import { type CredentialConflict, Unauthorized, Unavailable } from "./ControlError.ts"
import * as CredentialCipher from "./CredentialCipher.ts"
import * as CredentialStore from "./CredentialStore.ts"

/**
 * A journal-safe name for a stored connection credential.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CredentialRef {
  readonly id: string
  readonly name: string
}

/**
 * One credential operation, as seen by a host authorization policy.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Operation = "list" | "get" | "create" | "resolve" | "rotate" | "revoke"

/**
 * Adapter-bound credential resolution. References are safe to list and
 * persist; only `resolve` crosses into a secret-bearing adapter boundary.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Credential {
  readonly list: () => Effect.Effect<ReadonlyArray<CredentialRef>, Unavailable | Unauthorized>
  readonly get: (id: string) => Effect.Effect<CredentialRef, Unavailable | Unauthorized>
  readonly create: (
    options: { readonly id: string; readonly name: string; readonly secret: Redacted.Redacted<string> }
  ) => Effect.Effect<CredentialRef, Unavailable | Unauthorized | CredentialConflict>
  readonly resolve: (
    reference: CredentialRef
  ) => Effect.Effect<Redacted.Redacted<string>, Unavailable | Unauthorized>
  readonly rotate: (
    reference: CredentialRef,
    secret: Redacted.Redacted<string>
  ) => Effect.Effect<CredentialRef, Unavailable | Unauthorized | CredentialConflict>
  readonly revoke: (reference: CredentialRef) => Effect.Effect<void, Unavailable | Unauthorized>
}

/**
 * Service tag for credential resolution.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const Credential: Context.Service<Credential, Credential> = Context.Service("/control/Credential")

const unavailable = (): Unavailable =>
  new Unavailable({
    feature: "credential storage",
    ticket: "control-credential-storage"
  })

/**
 * A credential implementation that explicitly reports unavailable storage.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (): Credential =>
  Credential.of({
    list: Effect.fn("Credential.list")(() => Effect.fail(unavailable())),
    get: Effect.fn("Credential.get")(() => Effect.fail(unavailable())),
    create: Effect.fn("Credential.create")(() => Effect.fail(unavailable())),
    resolve: Effect.fn("Credential.resolve")(() => Effect.fail(unavailable())),
    rotate: Effect.fn("Credential.rotate")(() => Effect.fail(unavailable())),
    revoke: Effect.fn("Credential.revoke")(() => Effect.fail(unavailable()))
  })

/**
 * Layer for the unavailable credential-storage boundary.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = Layer.succeed(Credential, makeNoop())

/**
 * The collaborators a working credential boundary needs.
 *
 * `authorize` is the host's policy hook. It defaults to allowing every
 * operation, which is correct for a single-principal local process; a server
 * composition supplies its own and gets typed `Unauthorized` failures for free.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly store: CredentialStore.Service
  readonly cipher: CredentialCipher.Service
  readonly authorize?:
    | ((operation: Operation, reference: Option.Option<CredentialRef>) => Effect.Effect<void, Unauthorized>)
    | undefined
}

const referenceOf = (record: CredentialStore.SealedRecord): CredentialRef => ({
  id: record.id,
  name: record.name
})

const missing = (id: string): Unauthorized =>
  // Deliberately indistinguishable from a denied reference: telling an
  // unauthorized caller which ids exist is itself a leak.
  new Unauthorized({ message: `Credential ${id} is not available to this caller` })

/**
 * Constructs a working credential boundary over a store and a cipher.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: Options): Credential => {
  const authorize = options.authorize ?? (() => Effect.void)
  const store = options.store
  const cipher = options.cipher

  /** Reads the record `reference` names, refusing a forged or stale one. */
  const authenticate = (
    operation: Operation,
    reference: CredentialRef
  ): Effect.Effect<CredentialStore.SealedRecord, Unavailable | Unauthorized> =>
    Effect.gen(function*() {
      yield* authorize(operation, Option.some(reference))
      const record = yield* store.read(reference.id)
      if (Option.isNone(record)) return yield* Effect.fail(missing(reference.id))
      if (record.value.name !== reference.name) return yield* Effect.fail(missing(reference.id))
      return record.value
    })

  const put = (
    record: CredentialStore.SealedRecord,
    secret: Redacted.Redacted<string>
  ): Effect.Effect<CredentialRef, Unavailable | CredentialConflict> =>
    Effect.gen(function*() {
      const sealed = yield* cipher.seal(secret)
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      yield* store.write({ ...record, ...sealed, updatedAtMs: now })
      return referenceOf(record)
    })

  return Credential.of({
    list: Effect.fn("Credential.list")(function*() {
      yield* authorize("list", Option.none())
      const records = yield* store.list()
      return records.map(referenceOf)
    }),
    get: Effect.fn("Credential.get")(function*(id) {
      yield* authorize("get", Option.none())
      const record = yield* store.read(id)
      if (Option.isNone(record)) return yield* Effect.fail(missing(id))
      return referenceOf(record.value)
    }),
    create: Effect.fn("Credential.create")(function*(input) {
      yield* authorize("create", Option.some({ id: input.id, name: input.name }))
      return yield* put(
        { id: input.id, name: input.name, ciphertext: "", nonce: "", version: 1, updatedAtMs: 0 },
        input.secret
      )
    }),
    resolve: Effect.fn("Credential.resolve")(function*(reference) {
      const record = yield* authenticate("resolve", reference)
      return yield* cipher.open({ ciphertext: record.ciphertext, nonce: record.nonce })
    }),
    rotate: Effect.fn("Credential.rotate")(function*(reference, secret) {
      const record = yield* authenticate("rotate", reference)
      return yield* put({ ...record, version: record.version + 1 }, secret)
    }),
    revoke: Effect.fn("Credential.revoke")(function*(reference) {
      const record = yield* authenticate("revoke", reference)
      yield* store.remove(record.id)
    })
  })
}

/**
 * Provides a working credential boundary over the ambient store and cipher.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (
  options: { readonly authorize?: Options["authorize"] } = {}
): Layer.Layer<
  Credential,
  never,
  CredentialStore.CredentialStore | CredentialCipher.CredentialCipher
> =>
  Layer.effect(Credential)(Effect.gen(function*() {
    const store = yield* CredentialStore.CredentialStore
    const cipher = yield* CredentialCipher.CredentialCipher
    return make({ store, cipher, ...(options.authorize === undefined ? {} : { authorize: options.authorize }) })
  }))
