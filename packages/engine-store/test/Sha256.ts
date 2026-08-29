import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Sha256 } from "@smthrs/crypto"
import { Key, type Key as KeyType } from "@smthrs/keys"
import { Crypto, Effect, Schema } from "effect"

/** Hashes test fixtures with the concrete Node crypto layer. */
export const sha256 = (input: string | Uint8Array): string =>
  Effect.runSync(
    Schema.decodeUnknownEffect(Sha256)(input).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.orDie
    )
  )

/** Provides concrete Node cryptography to a test Effect. */
export const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
  Effect.provide(effect, NodeCrypto.layer)

/** Runs a synchronous test Effect with concrete Node cryptography. */
export const runSync = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): A =>
  Effect.runSync(Effect.provide(effect, NodeCrypto.layer))

/** Runs an asynchronous test Effect with concrete Node cryptography. */
export const runPromise = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, NodeCrypto.layer))

/** Derives a canonical key with concrete test cryptography. */
export const key = (input: unknown): KeyType =>
  Effect.runSync(Schema.decodeUnknownEffect(Key)(input).pipe(Effect.provide(NodeCrypto.layer), Effect.orDie))

/** Mirrors the engine's private invocation-key encoding. */
export const invocationKey = (input: unknown): KeyType => key({ kind: "invocation", ...(input as object) })
