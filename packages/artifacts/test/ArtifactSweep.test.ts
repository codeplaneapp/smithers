/**
 * The sweep surface's contract, and the `put`-side freshening it depends on.
 *
 * The mechanics mirror the two references named in the module: Bazel's
 * disk-cache collector walks the local directory and fences on mtime, and git
 * freshens a loose object's mtime when a write deduplicates against it so
 * `git prune`'s expiry window keeps protecting re-referenced bytes.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import * as ArtifactSweep from "../src/ArtifactSweep.ts"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"

const artifact = "sweepable-artifact-content"
const digest = sha256(bytes(artifact))
const blobPath = `.flows/objects/${digest.slice(0, 2)}/${digest}`

const other = "second-sweepable-artifact"
const otherDigest = sha256(bytes(other))
const otherPath = `.flows/objects/${otherDigest.slice(0, 2)}/${otherDigest}`

const systemError = (tag: PlatformError.SystemErrorTag, method: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: tag, module: "FileSystem", method })

/**
 * An in-memory host filesystem tracking per-path mtimes, so the sweep's age
 * fence and the store's freshening are observable without a real clock or
 * disk. Writes and renames stamp the wall clock the way a real filesystem
 * does; `utimes` re-stamps explicitly, which is the freshen.
 */
const memoryFs = (options: {
  readonly seed?: Record<string, string>
  readonly mtimes?: Record<string, number>
  readonly withoutMtimeFor?: string
  readonly utimesUnsupported?: boolean
  readonly utimesVanishes?: boolean
  /** Extra entries the directory listing reports as subdirectories. */
  readonly directories?: ReadonlyArray<string>
  /** Extra listed entries whose stat then fails — vanished between the two. */
  readonly phantoms?: ReadonlyArray<string>
  readonly failRemoveOf?: string
  readonly failExists?: boolean
  /** Existence probes succeed this many times, then start failing. */
  readonly failExistsAfter?: number
} = {}) => {
  const files = new Map<string, Uint8Array>(
    Object.entries(options.seed ?? {}).map(([path, content]) => [path, bytes(content)])
  )
  const mtimes = new Map<string, number>(Object.entries(options.mtimes ?? {}))
  const writes: Array<string> = []
  const utimesCalls: Array<string> = []
  let existsCalls = 0
  const hooks: { beforeRemove?: ((path: string) => Effect.Effect<void>) | undefined } = {}
  const fs = FileSystem.makeNoop({
    exists: ((path: string) =>
      Effect.suspend(() => {
        existsCalls++
        const budget = options.failExistsAfter
        if (options.failExists === true || (budget !== undefined && existsCalls > budget)) {
          return Effect.fail(new Error(`EIO: ${path}`))
        }
        return Effect.succeed(files.has(path))
      })) as never,
    readFile: ((path: string) =>
      Effect.suspend(() =>
        files.has(path)
          ? Effect.succeed(files.get(path)!)
          : Effect.fail(new Error(`ENOENT: ${path}`))
      )) as never,
    makeDirectory: (() => Effect.void) as never,
    readDirectory: ((directory: string) =>
      Effect.suspend(() => {
        const prefix = `${directory}/`
        return Effect.succeed([
          ...[...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)),
          ...(options.directories ?? []),
          ...(options.phantoms ?? [])
        ])
      })) as never,
    stat: ((path: string) =>
      Effect.suspend(() => {
        const relative = path.startsWith(".flows/objects/") ? path.slice(".flows/objects/".length) : path
        if (options.directories?.includes(relative) === true) {
          return Effect.succeed({ type: "Directory", mtime: Option.some(new Date(0)), size: BigInt(0) })
        }
        return files.has(path)
          ? Effect.succeed({
            type: "File",
            mtime: path === options.withoutMtimeFor
              ? Option.none()
              : Option.some(new Date(mtimes.get(path) ?? 0)),
            size: BigInt(files.get(path)!.length)
          })
          : Effect.fail(new Error(`ENOENT: ${path}`))
      })) as never,
    utimes: ((path: string, _atime: Date | number, mtime: Date | number) =>
      Effect.suspend(() => {
        utimesCalls.push(path)
        if (options.utimesVanishes === true) {
          files.delete(path)
          return Effect.fail(new Error(`ENOENT: ${path}`))
        }
        if (options.utimesUnsupported === true || !files.has(path)) {
          return Effect.fail(new Error(`ENOTSUP: utimes ${path}`))
        }
        mtimes.set(path, typeof mtime === "number" ? mtime : mtime.getTime())
        return Effect.void
      })) as never,
    writeFile: ((path: string, content: Uint8Array) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => {
          writes.push(path)
          files.set(path, content)
          mtimes.set(path, now)
        }))) as never,
    rename: ((from: string, to: string) =>
      Effect.suspend(() => {
        const content = files.get(from)
        if (content === undefined) {
          return Effect.fail(new Error(`ENOENT: ${from}`))
        }
        return Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() => {
            files.set(to, content)
            mtimes.set(to, now)
            files.delete(from)
          }))
      })) as never,
    remove: ((path: string) =>
      Effect.suspend(() => {
        if (path === options.failRemoveOf) {
          return Effect.fail(new Error(`EIO: ${path}`))
        }
        const hook = hooks.beforeRemove === undefined ? Effect.void : hooks.beforeRemove(path)
        return hook.pipe(Effect.andThen(Effect.suspend(() =>
          files.delete(path)
            ? Effect.void
            : Effect.fail(new Error(`ENOENT: ${path}`))
        )))
      })) as never
  })
  return { files, mtimes, writes, utimesCalls, hooks, fs }
}

describe("inventory", () => {
  it.effect("lists blobs with their age and size, and nothing else", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        seed: {
          [blobPath]: artifact,
          [otherPath]: other,
          // A crashed writer's scratch file, a foreign file, and a blob filed
          // under the wrong fanout are all invisible to the sweep.
          [`${blobPath}.tmp-abc123-0`]: "in-flight",
          ".flows/objects/README": "not a blob",
          [`.flows/objects/zz/${digest}`]: artifact
        },
        mtimes: { [blobPath]: 1_000, [otherPath]: 2_000 }
      })
      const listed = yield* withCrypto(ArtifactSweep.makeFileSystem(host.fs).inventory)
      expect(listed.map((blob) => [blob.digest, blob.modifiedAtMs, blob.sizeBytes])).toEqual([
        [digest, 1_000, bytes(artifact).length],
        [otherDigest, 2_000, bytes(other).length]
      ])
    }))

  it.effect("reports an empty inventory when the store never published", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      expect(yield* withCrypto(ArtifactSweep.makeFileSystem(host.fs).inventory)).toEqual([])
    }))

  it.effect("reports an empty inventory when the objects directory cannot be read", () =>
    Effect.gen(function*() {
      const failing = FileSystem.makeNoop({
        readDirectory: (() => Effect.fail(systemError("NotFound", "readDirectory"))) as never
      })
      expect(yield* withCrypto(ArtifactSweep.makeFileSystem(failing).inventory)).toEqual([])
    }))

  it.effect("fails inventory when the objects directory cannot be read for another reason", () =>
    Effect.gen(function*() {
      const failing = FileSystem.makeNoop({
        readDirectory: (() => Effect.fail(systemError("PermissionDenied", "readDirectory"))) as never
      })
      const exit = yield* withCrypto(ArtifactSweep.makeFileSystem(failing).inventory.pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("excludes foreign files that are not lowercase SHA-256 addresses", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        seed: {
          [blobPath]: artifact,
          ".flows/objects/ab/abc": "foreign",
          [`.flows/objects/${digest.slice(0, 2)}/${digest.toUpperCase()}`]: "foreign"
        },
        mtimes: { [blobPath]: 1_000 }
      })
      const listed = yield* withCrypto(ArtifactSweep.makeFileSystem(host.fs).inventory)
      expect(listed.map((blob) => blob.digest)).toEqual([digest])
    }))

  it.effect("excludes a blob whose age the host cannot measure", () =>
    Effect.gen(function*() {
      // No mtime means no age evidence, and the sweep must never judge what it
      // cannot measure — the same conservatism as the orphan-temp sweep.
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        withoutMtimeFor: blobPath
      })
      expect(yield* withCrypto(ArtifactSweep.makeFileSystem(host.fs).inventory)).toEqual([])
    }))

  it.effect("skips nested paths, directories at blob addresses, and vanished entries", () =>
    Effect.gen(function*() {
      const directoryShaped = `ab/ab${"c".repeat(62)}`
      const host = memoryFs({
        seed: {
          [blobPath]: artifact,
          // A path nested one level too deep is not in the fanout shape.
          [`.flows/objects/${digest.slice(0, 2)}/extra/${digest}`]: artifact
        },
        mtimes: { [blobPath]: 1_000 },
        // A directory that happens to sit at a blob-shaped path, and an entry
        // removed between the listing and its stat.
        directories: [directoryShaped],
        phantoms: [`${otherDigest.slice(0, 2)}/${otherDigest}`]
      })
      const listed = yield* withCrypto(ArtifactSweep.makeFileSystem(host.fs).inventory)
      expect(listed.map((blob) => blob.digest)).toEqual([digest])
    }))
})

describe("fenced removal", () => {
  it.effect("removes a blob and reports the deletion", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, mtimes: { [blobPath]: 1_000 } })
      const sweep = ArtifactSweep.makeFileSystem(host.fs)
      expect(yield* withCrypto(sweep.remove(digest))).toBe(true)
      expect(host.files.has(blobPath)).toBe(false)
      // Removing what is already gone is a completed deletion, not a failure —
      // a crashed sweep re-runs over its own progress.
      expect(yield* withCrypto(sweep.remove(digest))).toBe(false)
    }))

  it.effect("refuses the fence when the blob was freshened past the bound", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, mtimes: { [blobPath]: 5_000 } })
      const sweep = ArtifactSweep.makeFileSystem(host.fs)
      expect(yield* withCrypto(sweep.remove(digest, { ifUnmodifiedSinceMs: 4_000 }))).toBe(false)
      expect(host.files.has(blobPath)).toBe(true)
      expect(yield* withCrypto(sweep.remove(digest, { ifUnmodifiedSinceMs: 5_000 }))).toBe(true)
      expect(host.files.has(blobPath)).toBe(false)
    }))

  it.effect("serializes a concurrent put with fenced deletion so the digest remains readable", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, mtimes: { [blobPath]: 1_000 } })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      host.hooks.beforeRemove = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
      const sweep = ArtifactSweep.makeFileSystem(host.fs)
      const store = ArtifactStore.makeFileSystem(host.fs, { durability: "best-effort" })

      const removing = yield* sweep.remove(digest, { ifUnmodifiedSinceMs: 1_000 }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      const publishing = yield* withCrypto(store.put(bytes(artifact))).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      expect(publishing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)

      expect(yield* Fiber.join(removing)).toBe(true)
      expect(yield* Fiber.join(publishing)).toBe(digest)
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))

  it.effect("refuses the fence when the blob's age cannot be measured", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, withoutMtimeFor: blobPath })
      const sweep = ArtifactSweep.makeFileSystem(host.fs)
      expect(yield* withCrypto(sweep.remove(digest, { ifUnmodifiedSinceMs: Number.MAX_SAFE_INTEGER }))).toBe(false)
      expect(host.files.has(blobPath)).toBe(true)
    }))

  it.effect("refuses the fence when the blob is already gone", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const sweep = ArtifactSweep.makeFileSystem(host.fs)
      expect(yield* withCrypto(sweep.remove(digest, { ifUnmodifiedSinceMs: Number.MAX_SAFE_INTEGER }))).toBe(false)
    }))

  it.effect("rejects an address that is not usable as a path segment", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const exit = yield* withCrypto(
        ArtifactSweep.makeFileSystem(host.fs).remove("../escape").pipe(Effect.exit)
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("fails when the host refuses to delete bytes that still exist", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        mtimes: { [blobPath]: 1_000 },
        failRemoveOf: blobPath
      })
      const exit = yield* withCrypto(ArtifactSweep.makeFileSystem(host.fs).remove(digest).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(host.files.has(blobPath)).toBe(true)
    }))

  it.effect("fails when a deletion refusal cannot be verified by an existence probe", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        mtimes: { [blobPath]: 1_000 },
        failRemoveOf: blobPath,
        failExists: true
      })
      const exit = yield* withCrypto(ArtifactSweep.makeFileSystem(host.fs).remove(digest).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("layers", () => {
  it.effect("provides the filesystem sweep through the service tag", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, mtimes: { [blobPath]: 1_000 } })
      const listed = yield* withCrypto(
        Effect.gen(function*() {
          const sweep = yield* ArtifactSweep.ArtifactSweep
          return yield* sweep.inventory
        }).pipe(
          Effect.provide(
            ArtifactSweep.layerFileSystem().pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem)(host.fs)))
          )
        )
      )
      expect(listed.map((blob) => blob.digest)).toEqual([digest])
    }))

  it.effect("fails every no-op operation while honouring overrides", () =>
    Effect.gen(function*() {
      const overridden = ArtifactSweep.makeNoop({ inventory: Effect.succeed([]) })
      expect(yield* withCrypto(overridden.inventory)).toEqual([])
      const noop = yield* withCrypto(
        Effect.gen(function*() {
          const sweep = yield* ArtifactSweep.ArtifactSweep
          const listed = yield* sweep.inventory.pipe(Effect.exit)
          const removed = yield* sweep.remove(digest).pipe(Effect.exit)
          return [Exit.isFailure(listed), Exit.isFailure(removed)]
        }).pipe(Effect.provide(ArtifactSweep.layerNoop()))
      )
      expect(noop).toEqual([true, true])
    }))
})

describe("put freshens a deduplicated blob (git's loose-object freshening)", () => {
  it.effect("re-stamps the mtime instead of rewriting, so the grace fence protects it", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, mtimes: { [blobPath]: 1_000 } })
      const store = ArtifactStore.makeFileSystem(host.fs, { durability: "best-effort" })
      yield* TestClock.adjust("2 seconds")
      const before = yield* Clock.currentTimeMillis
      yield* withCrypto(store.put(bytes(artifact)))
      expect(host.writes).toEqual([])
      expect(host.utimesCalls).toEqual([blobPath])
      expect(host.mtimes.get(blobPath)!).toBeGreaterThanOrEqual(before)
      // The liveness half: a sweep that computed its bound before the freshen
      // now fails its fence, exactly like a laggard's fenced cache evict.
      const sweep = ArtifactSweep.makeFileSystem(host.fs)
      expect(yield* withCrypto(sweep.remove(digest, { ifUnmodifiedSinceMs: 1_000 }))).toBe(false)
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))

  it.effect("keeps the dedupe skip on a host without utimes while the blob exists", () =>
    Effect.gen(function*() {
      // The browser filesystem fails `utimes` rather than pretending. Such a
      // host forgoes freshening — and accepts git's freshen-versus-prune race —
      // but must not pay a rewrite on every deduplicated put.
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        mtimes: { [blobPath]: 1_000 },
        utimesUnsupported: true
      })
      yield* withCrypto(ArtifactStore.makeFileSystem(host.fs, { durability: "best-effort" }).put(bytes(artifact)))
      expect(host.writes).toEqual([])
      expect(host.mtimes.get(blobPath)).toBe(1_000)
    }))

  it.effect("keeps the dedupe skip when the freshen and the existence probe both fail", () =>
    Effect.gen(function*() {
      // Neither call proves the blob is gone, so the verified proof stands —
      // rewriting on a flaky probe would trade every dedupe on such a host for
      // a spurious republication.
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        mtimes: { [blobPath]: 1_000 },
        utimesUnsupported: true,
        failExistsAfter: 1
      })
      yield* withCrypto(ArtifactStore.makeFileSystem(host.fs, { durability: "best-effort" }).put(bytes(artifact)))
      expect(host.writes).toEqual([])
      expect(host.mtimes.get(blobPath)).toBe(1_000)
    }))

  it.effect("republishes when the blob vanished between verification and freshen", () =>
    Effect.gen(function*() {
      // The sweep won the race: the blob existed at the dedupe check and was
      // gone by the freshen. Trusting the stale proof would return a digest
      // nothing can read; the failed freshen drops it and the atomic rewrite
      // heals the address.
      const host = memoryFs({
        seed: { [blobPath]: artifact },
        mtimes: { [blobPath]: 1_000 },
        utimesVanishes: true
      })
      const published = yield* withCrypto(
        ArtifactStore.makeFileSystem(host.fs, { durability: "best-effort" }).put(bytes(artifact))
      )
      expect(published).toBe(digest)
      expect(host.writes).toHaveLength(1)
      expect(host.writes[0]!.includes(".tmp-")).toBe(true)
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))
})
