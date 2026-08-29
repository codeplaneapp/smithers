// Deep reviewed and polished by a human on 2026-08-10.

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Key, type Key as KeyType } from "@smthrs/keys"
import { Crypto, Effect, Schema } from "effect"

/** Provides concrete Node cryptography to a test Effect. */
export const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
  Effect.provide(effect, NodeCrypto.layer)

/** Runs a synchronous test Effect with concrete Node cryptography. */
export const runSync = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): A =>
  Effect.runSync(Effect.provide(effect, NodeCrypto.layer))

/** Derives a canonical key with concrete test cryptography. */
export const key = (input: unknown): KeyType => runSync(Schema.decodeUnknownEffect(Key)(input).pipe(Effect.orDie))

/** Mirrors the engine's private invocation-key encoding. */
export const invocationKey = (input: unknown): KeyType => key({ kind: "invocation", ...(input as object) })
