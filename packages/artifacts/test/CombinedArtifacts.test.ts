/**
 * Local-first, remote-second, with write-back — the shape of Bazel's
 * `CombinedCache` (`reference/bazel/.../remote/CombinedCache.java`).
 */
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as CombinedArtifacts from "../src/CombinedArtifacts.ts"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"

const artifact = "an artifact that travels"
const digest = sha256(bytes(artifact))

/** A memory store with a call log, so tier routing is observable. */
const countingMemory = () => {
  const inner = ArtifactStore.makeMemory()
  const calls: Array<string> = []
  const store: ArtifactStore.Service = {
    put: (payload) => Effect.tap(inner.put(payload), () => Effect.sync(() => calls.push("put"))),
    get: (address) => Effect.tap(inner.get(address), () => Effect.sync(() => calls.push("get"))),
    has: (address) => Effect.tap(inner.has(address), () => Effect.sync(() => calls.push("has"))),
    findMissing: (addresses) =>
      Effect.tap(inner.findMissing(addresses), () => Effect.sync(() => calls.push("findMissing")))
  }
  return { calls, store, inner }
}

describe("reads", () => {
  it.effect("answers from the local tier without touching the remote one", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = countingMemory()
      const combined = CombinedArtifacts.make({ local: local.store, remote: remote.store })
      yield* withCrypto(local.store.put(bytes(artifact)))
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(remote.calls).toEqual([])
    }))

  it.effect("falls through to the remote tier and writes back locally", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = countingMemory()
      const combined = CombinedArtifacts.make({ local: local.store, remote: remote.store })
      yield* withCrypto(remote.store.put(bytes(artifact)))
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      // The write-back means the next read is local.
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
      const remoteReads = remote.calls.filter((call) => call === "get").length
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
      expect(remote.calls.filter((call) => call === "get")).toHaveLength(remoteReads)
    }))

  it.effect("heals a corrupt local address from the remote tier", () =>
    Effect.gen(function*() {
      // Local corruption falls through exactly like a miss: the write-back hands
      // the correct bytes to `local.put`, whose own verification finds the
      // mismatched blob and rewrites it.
      const corrupt = ArtifactStore.makeNoop({
        get: () =>
          Effect.fail(
            new ArtifactStore.ArtifactCorruption({
              code: "artifact_corruption",
              recordedDigest: digest,
              measuredDigest: sha256(bytes("torn"))
            })
          ),
        put: ArtifactStore.makeMemory().put
      })
      const remote = countingMemory()
      yield* withCrypto(remote.store.put(bytes(artifact)))
      const combined = CombinedArtifacts.make({ local: corrupt, remote: remote.store })
      expect(text(yield* withCrypto(combined.get(digest)))).toBe(artifact)
    }))

  it.effect("propagates a remote miss", () =>
    Effect.gen(function*() {
      const combined = CombinedArtifacts.make({
        local: ArtifactStore.makeMemory(),
        remote: ArtifactStore.makeMemory()
      })
      const exit = yield* withCrypto(combined.get(digest).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("writes", () => {
  it.effect("stores locally and uploads to the shared tier", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const remote = countingMemory()
      const combined = CombinedArtifacts.make({ local: local.store, remote: remote.store })
      expect(yield* withCrypto(combined.put(bytes(artifact)))).toBe(digest)
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
      expect(yield* withCrypto(remote.store.has(digest))).toBe(true)
    }))

  it.effect("records the artifact locally even when the shared tier refuses the upload", () =>
    Effect.gen(function*() {
      // Failing here would fail whatever produced the bytes — a step's `settle`,
      // say — because a cache was unreachable. The artifact is recorded where
      // this machine's replays resolve it, and the publication protocol's
      // findMissing → upload → confirm is what actually gates a shared entry.
      const local = countingMemory()
      const combined = CombinedArtifacts.make({ local: local.store, remote: ArtifactStore.makeNoop() })
      expect(yield* withCrypto(combined.put(bytes(artifact)))).toBe(digest)
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
    }))

  it.effect("deduplicates concurrent uploads of one digest", () =>
    Effect.gen(function*() {
      const local = countingMemory()
      const uploads: Array<string> = []
      const gate = yield* (Deferred.make<void>())
      const remote = ArtifactStore.makeNoop({
        put: (payload) =>
          Effect.gen(function*() {
            uploads.push("put")
            yield* Deferred.await(gate)
            return yield* ArtifactStore.makeMemory().put(payload)
          })
      })
      const combined = CombinedArtifacts.make({ local: local.store, remote })
      const running = yield* Effect.forkChild(
        withCrypto(
          Effect.all([combined.put(bytes(artifact)), combined.put(bytes(artifact))], { concurrency: 2 })
        ),
        { startImmediately: true }
      )
      yield* (Deferred.succeed(gate, undefined))
      expect(yield* Fiber.join(running)).toEqual([digest, digest])
      // The second caller joined the first upload instead of repeating it.
      expect(uploads).toHaveLength(1)
    }))

  it.effect("starts a fresh upload after an interrupted one, instead of joining a dead deferred", () =>
    Effect.gen(function*() {
      // Interruption striking mid-upload — the deadline firing, the caller's
      // scope closing — must not orphan the shared deferred: on the defective
      // code the entry stayed registered forever and every later put of the
      // digest joined a deferred nobody would ever complete.
      const uploads: Array<string> = []
      const gate = yield* (Deferred.make<void>())
      const started = yield* (Deferred.make<void>())
      const remote = ArtifactStore.makeNoop({
        put: (payload) =>
          Effect.gen(function*() {
            uploads.push("put")
            if (uploads.length === 1) {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
            }
            return yield* ArtifactStore.makeMemory().put(payload)
          })
      })
      const combined = CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote })
      const published = yield* withCrypto(
        Effect.gen(function*() {
          const leader = yield* combined.put(bytes(artifact)).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(leader)
          return yield* combined.put(bytes(artifact)).pipe(Effect.timeout("2 seconds"))
        })
      )
      expect(published).toBe(digest)
      expect(uploads).toHaveLength(2)
    }))

  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("releases a joined waiter when the shared upload is interrupted", () =>
    Effect.gen(function*() {
      // The waiter joined the leader's deferred; the leader's interruption must
      // resolve it — as the typed refusal `put` already drops — rather than
      // leave the waiter parked on it forever.
      const uploads: Array<string> = []
      const gate = yield* (Deferred.make<void>())
      const started = yield* (Deferred.make<void>())
      const remote = ArtifactStore.makeNoop({
        put: (payload) =>
          Effect.gen(function*() {
            uploads.push("put")
            if (uploads.length === 1) {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
            }
            return yield* ArtifactStore.makeMemory().put(payload)
          })
      })
      const combined = CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote })
      const published = yield* withCrypto(
        Effect.gen(function*() {
          const leader = yield* combined.put(bytes(artifact)).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(started)
          const waiter = yield* combined.put(bytes(artifact)).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.sleep("20 millis")
          yield* Fiber.interrupt(leader)
          return yield* Fiber.join(waiter).pipe(Effect.timeout("2 seconds"))
        })
      )
      expect(published).toBe(digest)
    }))

  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("bounds the opportunistic upload with the configured deadline", () =>
    Effect.gen(function*() {
      // A remote that stalls instead of refusing must not hold the local answer
      // hostage: the upload is abandoned at the deadline like any refusal, and
      // the put answers with the local digest it already holds.
      const gate = yield* (Deferred.make<void>())
      const remote = ArtifactStore.makeNoop({
        put: (payload) => Effect.andThen(Deferred.await(gate), ArtifactStore.makeMemory().put(payload))
      })
      const local = countingMemory()
      const combined = CombinedArtifacts.make({ local: local.store, remote, uploadTimeout: "50 millis" })
      expect(yield* withCrypto(combined.put(bytes(artifact)))).toBe(digest)
      expect(yield* withCrypto(local.store.has(digest))).toBe(true)
    }))

  it.effect("starts a fresh upload once the in-flight one has settled", () =>
    Effect.gen(function*() {
      const uploads: Array<string> = []
      const remote = ArtifactStore.makeNoop({
        put: (payload) =>
          Effect.gen(function*() {
            uploads.push("put")
            return yield* ArtifactStore.makeMemory().put(payload)
          })
      })
      const combined = CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote })
      yield* withCrypto(combined.put(bytes(artifact)))
      yield* withCrypto(combined.put(bytes(artifact)))
      expect(uploads).toHaveLength(2)
    }))
})

describe("probes", () => {
  it.effect("answers `has` locally, then remotely", () =>
    Effect.gen(function*() {
      const remote = countingMemory()
      yield* withCrypto(remote.store.put(bytes(artifact)))
      const combined = CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote: remote.store })
      expect(yield* withCrypto(combined.has(digest))).toBe(true)
      const local = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(bytes(artifact)))
      const localFirst = CombinedArtifacts.make({ local, remote: remote.store })
      const before = remote.calls.length
      expect(yield* withCrypto(localFirst.has(digest))).toBe(true)
      expect(remote.calls).toHaveLength(before)
    }))

  it.effect("probes the remote tier only about what the local tier lacks", () =>
    Effect.gen(function*() {
      const other = sha256(bytes("another artifact"))
      const local = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(bytes(artifact)))
      const remote = countingMemory()
      yield* withCrypto(remote.store.put(bytes("another artifact")))
      const combined = CombinedArtifacts.make({ local, remote: remote.store })
      expect(yield* withCrypto(combined.findMissing([digest, other]))).toEqual([])
    }))

  it.effect("skips the remote round trip when the local tier holds everything", () =>
    Effect.gen(function*() {
      const local = ArtifactStore.makeMemory()
      yield* withCrypto(local.put(bytes(artifact)))
      const remote = countingMemory()
      const combined = CombinedArtifacts.make({ local, remote: remote.store })
      expect(yield* withCrypto(combined.findMissing([digest]))).toEqual([])
      expect(remote.calls).toEqual([])
    }))

  it.effect("reports what neither tier holds", () =>
    Effect.gen(function*() {
      const combined = CombinedArtifacts.make({
        local: ArtifactStore.makeMemory(),
        remote: ArtifactStore.makeMemory()
      })
      expect(yield* withCrypto(combined.findMissing([digest]))).toEqual([digest])
    }))
})

describe("layer", () => {
  it.effect("builds both tiers from effects and provides one tag", () =>
    Effect.gen(function*() {
      const remote = ArtifactStore.makeMemory()
      const published = yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (store) => store.put(bytes(artifact))).pipe(
          Effect.provide(
            CombinedArtifacts.layer({
              local: Effect.sync(ArtifactStore.makeMemory),
              remote: Effect.succeed(remote)
            })
          )
        )
      )
      expect(published).toBe(digest)
      expect(yield* withCrypto(remote.has(digest))).toBe(true)
    }))
})
