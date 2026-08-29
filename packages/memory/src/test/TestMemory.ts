/**
 * In-memory SQLite memory layer for tests.
 *
 * @since 0.1.0
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as MemoryStore from "../MemoryStore.ts"

/**
 * Provides the authoritative memory store over a fresh in-memory database.
 *
 * @category layers
 * @since 0.1.0
 */
let nonce = 0
const crypto = Layer.succeed(Crypto.Crypto)(Crypto.make({
  randomBytes: (size) => {
    nonce += 1
    return new Uint8Array(size).fill(nonce & 0xff)
  },
  digest: (_algorithm, data) => Effect.succeed(data)
}))

/**
 * Provides the authoritative memory store with deterministic test services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = MemoryStore.layer.pipe(Layer.provide(Layer.merge(TestDatabase.layer, crypto)))

/**
 * Provides both the authoritative memory store and its in-memory Database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWithDatabase = Layer.provideMerge(MemoryStore.layer, Layer.merge(TestDatabase.layer, crypto))
