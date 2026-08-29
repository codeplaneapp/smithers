/**
 * Browser-safe persistence port for encrypted credential material.
 *
 * The store only ever sees a {@link SealedRecord}: an opaque connection name
 * plus ciphertext. Plaintext never reaches this boundary, so an adapter can be
 * backed by anything — SQL, Web Storage, a remote vault — without becoming a
 * place a secret can leak from.
 *
 * Writes are compare-and-set on `version`. A writer that read version *n*
 * commits version *n + 1*; a concurrent writer that read the same *n* is
 * refused with {@link ControlError.CredentialConflict} rather than silently
 * overwriting the winner.
 *
 * See `.smithers/tickets/control-credential-storage.md`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Option } from "effect"
import { CredentialConflict, Unavailable } from "./ControlError.ts"

/**
 * One credential at rest: opaque metadata plus the sealed secret.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SealedRecord {
  readonly id: string
  readonly name: string
  /** Base64 ciphertext produced by a `CredentialCipher`. */
  readonly ciphertext: string
  /** Base64 per-record nonce. Never reused across versions. */
  readonly nonce: string
  /** Monotonic write counter; 1 for a freshly created credential. */
  readonly version: number
  readonly updatedAtMs: number
}

/**
 * The persistence operations `Credential` needs.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly list: () => Effect.Effect<ReadonlyArray<SealedRecord>, Unavailable>
  readonly read: (id: string) => Effect.Effect<Option.Option<SealedRecord>, Unavailable>
  /** Commits `record` only if the stored version is `record.version - 1`. */
  readonly write: (record: SealedRecord) => Effect.Effect<void, Unavailable | CredentialConflict>
  readonly remove: (id: string) => Effect.Effect<void, Unavailable>
}

/**
 * Service key for encrypted credential persistence.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class CredentialStore extends Context.Service<CredentialStore, Service>()(
  "/control/CredentialStore"
) {}

/**
 * Constructs a store from an implementation record.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => CredentialStore.of(implementation)

const unavailable = (): Unavailable =>
  new Unavailable({
    feature: "credential storage",
    ticket: "control-credential-storage"
  })

/**
 * A store that reports unavailable persistence for every operation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    list: Effect.fn("CredentialStore.list")(() => Effect.fail(unavailable())),
    read: Effect.fn("CredentialStore.read")(() => Effect.fail(unavailable())),
    write: Effect.fn("CredentialStore.write")(() => Effect.fail(unavailable())),
    remove: Effect.fn("CredentialStore.remove")(() => Effect.fail(unavailable())),
    ...overrides
  })

/**
 * Provides a store that reports unavailable persistence.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<CredentialStore> =>
  Layer.succeed(CredentialStore)(makeNoop(overrides))

/**
 * Constructs a process-local store.
 *
 * Browser-safe and durable for the lifetime of the process only; it exists so
 * the credential contract can be exercised without a host adapter, and as the
 * fallback a short-lived worker can use.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeMemory = (): Service => {
  const records = new Map<string, SealedRecord>()
  return make({
    list: Effect.fn("CredentialStore.list")(() => Effect.sync(() => Array.from(records.values()))),
    read: Effect.fn("CredentialStore.read")((id) => Effect.sync(() => Option.fromNullishOr(records.get(id)))),
    write: Effect.fn("CredentialStore.write")((record) =>
      Effect.suspend(() => {
        const current = records.get(record.id)
        const actual = current?.version ?? 0
        if (actual !== record.version - 1) {
          return Effect.fail(
            new CredentialConflict({
              id: record.id,
              expectedVersion: record.version - 1,
              actualVersion: actual
            })
          )
        }
        records.set(record.id, record)
        return Effect.void
      })
    ),
    remove: Effect.fn("CredentialStore.remove")((id) =>
      Effect.sync(() => {
        records.delete(id)
      })
    )
  })
}

/**
 * Provides a process-local store.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerMemory: Layer.Layer<CredentialStore> = Layer.sync(CredentialStore)(makeMemory)
