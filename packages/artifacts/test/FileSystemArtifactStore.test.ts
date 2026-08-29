/**
 * The filesystem artifact store's durability contract.
 *
 * These properties moved here from `@smthrs/engine-store`'s `StepBoundary`
 * along with the code (issues #117, #131, #132, #138, #144, #145): atomic
 * publication through temp+rename, unique temp paths per writer, healing
 * rewrites of a corrupt address, and the conservative orphan sweep. Two
 * properties are new, both from Bazel's `DiskCacheClient`: the two-hex fanout
 * layout and the fsync of the temp file before the rename. The
 * once-per-lifetime verification memo the code arrived with (issues #143,
 * #155) is gone: the objects directory is workspace-shared, and a remembered
 * proof let a `put` report success over a blob corrupted behind the store's
 * back without healing it, so verification now runs on every put.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { TestClock } from "effect/testing"
import * as ArtifactStore from "../src/ArtifactStore.ts"
import { bytes, sha256, text, withCrypto } from "./Crypto.ts"

const artifact = "shared-oversized-artifact-content"
const digest = sha256(bytes(artifact))
const blobPath = `.flows/objects/${digest.slice(0, 2)}/${digest}`

/**
 * An in-memory host filesystem with per-path instrumentation. Final state
 * alone cannot distinguish a dedupe skip from an unconditional rewrite, so the
 * read and write logs are what the memo cells assert on (issue #143).
 */
const memoryFs = (options: {
  readonly seed?: Record<string, string>
  readonly mtimes?: Record<string, number>
  readonly failRenameTo?: string
  readonly failReadOf?: string
  readonly failDirectoryRead?: boolean
  readonly supportsOpen?: boolean
  readonly failSyncOf?: (path: string) => boolean
} = {}) => {
  const files = new Map<string, Uint8Array>(
    Object.entries(options.seed ?? {}).map(([path, content]) => [path, bytes(content)])
  )
  const directories = new Set<string>()
  const writes: Array<string> = []
  const reads: Array<string> = []
  const syncs: Array<string> = []
  let directoryReads = 0
  const fs = FileSystem.makeNoop({
    exists: ((path: string) => Effect.succeed(files.has(path))) as never,
    readFile: ((path: string) =>
      Effect.suspend(() => {
        reads.push(path)
        return files.has(path) && path !== options.failReadOf
          ? Effect.succeed(files.get(path)!)
          : Effect.fail(new Error(`ENOENT: ${path}`))
      })) as never,
    makeDirectory: ((path: string) =>
      Effect.sync(() => {
        directories.add(path)
      })) as never,
    readDirectory: ((directory: string) =>
      Effect.suspend(() => {
        directoryReads++
        if (options.failDirectoryRead === true) return Effect.fail(new Error("ENOENT: no objects directory"))
        const prefix = `${directory}/`
        return Effect.succeed(
          [...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length))
        )
      })) as never,
    stat: ((path: string) => {
      const mtime = options.mtimes?.[path]
      return mtime === undefined
        ? Effect.fail(new Error(`ENOENT: ${path}`))
        : Effect.succeed({ mtime: Option.some(new Date(mtime)) })
    }) as never,
    open: ((path: string) =>
      options.supportsOpen === true
        ? Effect.sync(() => ({
          sync: Effect.sync(() => {
            if (options.failSyncOf?.(path) === true) throw new Error(`EIO: sync ${path}`)
            syncs.push(path)
          })
        }))
        : Effect.fail(new Error(`ENOTSUP: open ${path}`))) as never,
    writeFile: ((path: string, content: Uint8Array) =>
      Effect.sync(() => {
        writes.push(path)
        files.set(path, content)
      })) as never,
    rename: ((from: string, to: string) =>
      Effect.suspend(() => {
        if (to === options.failRenameTo) return Effect.fail(new Error(`EIO: ${to}`))
        const content = files.get(from)
        if (content === undefined) return Effect.fail(new Error(`ENOENT: ${from}`))
        files.set(to, content)
        files.delete(from)
        return Effect.void
      })) as never,
    remove: ((path: string) =>
      Effect.sync(() => {
        files.delete(path)
      })) as never
  })
  return { files, directories, writes, reads, syncs, directoryReads: () => directoryReads, fs }
}

const store = (host: ReturnType<typeof memoryFs>, options?: ArtifactStore.FileSystemOptions) =>
  ArtifactStore.makeFileSystem(host.fs, { durability: "best-effort", ...options })

const tempsOf = (host: ReturnType<typeof memoryFs>) => [...host.files.keys()].filter((path) => path.includes(".tmp-"))

describe("content addressing and layout", () => {
  it.effect("publishes under a two-hex fanout directory, not one flat directory", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const published = yield* withCrypto(store(host).put(bytes(artifact)))
      expect(published).toBe(digest)
      expect(host.files.has(blobPath)).toBe(true)
      // The parent directory is created recursively before the temp write.
      expect(host.directories.has(`.flows/objects/${digest.slice(0, 2)}`)).toBe(true)
      // And the flat address the store used to publish at is gone for good.
      expect(host.files.has(`.flows/objects/${digest}`)).toBe(false)
    }))

  it.effect("honours a caller-supplied directory", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      yield* withCrypto(store(host, { directory: ".objects" }).put(bytes(artifact)))
      expect(host.files.has(`.objects/${digest.slice(0, 2)}/${digest}`)).toBe(true)
    }))

  it.effect("round-trips the bytes it stored", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))
})

describe("atomic publication (issues #117, #131, #138)", () => {
  it.effect("writes through a temp path and renames into place", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(host.writes).toHaveLength(1)
      expect(host.writes[0]!.includes(".tmp-")).toBe(true)
      expect(tempsOf(host)).toEqual([])
    }))

  it.effect("gives two store instances distinct temp paths for one digest", () =>
    Effect.gen(function*() {
      // The cross-process shape: each instance's temp counter starts fresh,
      // exactly as two processes' counters both start at 0. Before the random
      // per-instance token, both wrote `<blob>.tmp-0`, one truncating open
      // clobbered the other's completed temp file, and the first rename
      // published torn bytes at the canonical content address (issue #131). The
      // latch pins that interleaving: neither writer may rename until both have
      // written their temp file.
      const host = memoryFs()
      const parked: Array<string> = []
      let release: (() => void) | undefined
      const bothWritten = new Promise<void>((resolve) => {
        release = resolve
      })
      const latched = FileSystem.makeNoop({
        ...host.fs,
        writeFile: ((path: string, content: Uint8Array) =>
          Effect.promise(async () => {
            parked.push(path)
            host.files.set(path, content)
            host.writes.push(path)
            if (parked.length >= 2) release!()
            await bothWritten
          })) as never
      })
      // Distinct filesystem service identities model separate processes: the
      // in-process digest lock cannot coordinate them, so their unique temp
      // paths remain the crash-safety boundary this test exercises.
      const firstProcess = FileSystem.makeNoop({ ...latched })
      const secondProcess = FileSystem.makeNoop({ ...latched })
      const exit = yield* withCrypto(
        Effect.all(
          [
            ArtifactStore.makeFileSystem(firstProcess, { durability: "best-effort" }).put(bytes(artifact)),
            ArtifactStore.makeFileSystem(secondProcess, { durability: "best-effort" }).put(bytes(artifact))
          ],
          { concurrency: 2 }
        ).pipe(Effect.exit)
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(new Set(parked).size).toBe(2)
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))

  it.effect("removes the temp file when the publishing rename fails", () =>
    Effect.gen(function*() {
      const host = memoryFs({ failRenameTo: blobPath })
      const exit = yield* withCrypto(store(host).put(bytes(artifact)).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(tempsOf(host)).toEqual([])
    }))

  it.effect("fsyncs the temp file before renaming it, where the host has writable handles", () =>
    Effect.gen(function*() {
      // Bazel's `DiskCacheClient.saveFile`: "fsync temp before we rename it to
      // avoid data loss in the case of machine crashes (the OS may reorder the
      // writes and the rename)".
      const host = memoryFs({ supportsOpen: true })
      yield* withCrypto(store(host, { durability: "required" }).put(bytes(artifact)))
      expect(host.syncs).toHaveLength(2)
      expect(host.syncs[0]!.includes(".tmp-")).toBe(true)
      expect(host.syncs[1]).toBe(`.flows/objects/${digest.slice(0, 2)}`)
    }))

  it.effect("still publishes on a host with no writable file handles", () =>
    Effect.gen(function*() {
      // `BrowserFileSystem` fails `open` rather than pretending. Such a host
      // keeps the temp+rename atomicity and simply forgoes the durability bound.
      const host = memoryFs({ supportsOpen: false })
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(host.syncs).toEqual([])
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))

  it.effect("fails publication when a required durability barrier fails", () =>
    Effect.gen(function*() {
      const host = memoryFs({
        supportsOpen: true,
        failSyncOf: (path) => path === `.flows/objects/${digest.slice(0, 2)}`
      })
      const exit = yield* withCrypto(
        store(host, { durability: "required" }).put(bytes(artifact)).pipe(Effect.exit)
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("verification and healing (issues #132, #144, #145)", () => {
  it.effect("leaves a healthy existing blob unwritten", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact } })
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(host.writes).toEqual([])
      expect(tempsOf(host)).toEqual([])
    }))

  it.effect("heals a corrupt existing blob at the canonical address", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: "torn-partial-bytes" } })
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(text(host.files.get(blobPath))).toBe(artifact)
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))

  it.effect("rewrites an existing blob the host cannot read back", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, failReadOf: blobPath })
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
    }))

  it.effect("digest-verifies an existing blob on every put, never trusting a stale proof", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact } })
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.reads.filter((path) => path === blobPath)).toHaveLength(2)
      expect(host.writes).toEqual([])
    }))

  it.effect("re-verifies even its own publication on the next put of the digest", () =>
    Effect.gen(function*() {
      // The objects directory is workspace-shared: this store's own atomic
      // rename proves nothing about what the blob holds by the time the next
      // put arrives, so the proof is re-measured rather than remembered.
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.reads.filter((path) => path === blobPath)).toHaveLength(1)
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(1)
    }))

  it.effect("heals a blob corrupted behind its back, even having verified the digest before", () =>
    Effect.gen(function*() {
      // The regression that killed the verification memo: with a remembered
      // proof, the third put reported success while the address kept serving
      // corrupt bytes, and no put would ever repair it.
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      yield* withCrypto(artifacts.put(bytes(artifact)))
      host.files.set(blobPath, bytes("CORRUPTED"))
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(text(host.files.get(blobPath))).toBe(artifact)
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))

  it.effect("heals on the put after a read found corruption", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      host.files.set(blobPath, bytes("torn-partial-bytes"))
      const refused = yield* withCrypto(artifacts.get(digest).pipe(Effect.exit))
      expect(Exit.isFailure(refused)).toBe(true)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
      expect(text(yield* withCrypto(artifacts.get(digest)))).toBe(artifact)
    }))

  it.effect("rewrites on every put while the blob stays unreadable", () =>
    Effect.gen(function*() {
      const host = memoryFs({ failReadOf: blobPath })
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(Exit.isFailure(yield* withCrypto(artifacts.get(digest).pipe(Effect.exit)))).toBe(true)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
    }))

  it.effect("republishes when the blob vanishes behind its back", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      host.files.delete(blobPath)
      expect(Exit.isFailure(yield* withCrypto(artifacts.get(digest).pipe(Effect.exit)))).toBe(true)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.writes.filter((path) => path.includes(".tmp-"))).toHaveLength(2)
    }))
})

describe("the orphan sweep (issue #138)", () => {
  const stale = `.flows/objects/aa/old.tmp-dead-0`
  const fresh = `.flows/objects/aa/live.tmp-live-0`

  it.effect("sweeps stale orphans on first put, keeps fresh temps, and sweeps once", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 hours")
      const now = yield* Clock.currentTimeMillis
      const host = memoryFs({
        seed: { [stale]: "torn", [fresh]: "in-flight" },
        mtimes: { [stale]: now - 2 * 60 * 60 * 1000, [fresh]: now }
      })
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(host.files.has(stale)).toBe(false)
      expect(host.files.has(fresh)).toBe(true)
      yield* withCrypto(artifacts.put(bytes("a second artifact body")))
      expect(host.directoryReads()).toBe(1)
    }))

  it.effect("keeps a temp file whose age cannot be measured", () =>
    Effect.gen(function*() {
      // `stat` failing says nothing about the writer's liveness, so the
      // conservative sweep never deletes what it cannot age.
      const host = memoryFs({ seed: { [`.flows/objects/aa/unknown.tmp-mystery-0`]: "unknown-age" } })
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(host.files.has(`.flows/objects/aa/unknown.tmp-mystery-0`)).toBe(true)
    }))

  it.effect("survives a directory it cannot list", () =>
    Effect.gen(function*() {
      const host = memoryFs({ failDirectoryRead: true })
      yield* withCrypto(store(host).put(bytes(artifact)))
      expect(text(host.files.get(blobPath))).toBe(artifact)
    }))
})

const errorOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  return (reason as { readonly error: unknown }).error
}

describe("reads, probes, and refusals", () => {
  it.effect("reports a typed miss for an address it does not hold", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const exit = yield* withCrypto(store(host).get(digest).pipe(Effect.exit))
      expect(Exit.isFailure(exit)).toBe(true)
      expect((errorOf(exit) as ArtifactStore.ArtifactMissing)._tag).toBe("@smthrs/artifacts/ArtifactMissing")
    }))

  it.effect("reports typed corruption when the bytes no longer hash to the address", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: "torn-partial-bytes" } })
      const exit = yield* withCrypto(store(host).get(digest).pipe(Effect.exit))
      const error = errorOf(exit) as ArtifactStore.ArtifactCorruption
      expect(error._tag).toBe("@smthrs/artifacts/ArtifactCorruption")
      expect(error.recordedDigest).toBe(digest)
      expect(error.measuredDigest).toBe(sha256(bytes("torn-partial-bytes")))
    }))

  it.effect("surfaces a host refusal as an ordinary store failure, not corruption", () =>
    Effect.gen(function*() {
      const host = memoryFs({ seed: { [blobPath]: artifact }, failReadOf: blobPath })
      const exit = yield* withCrypto(store(host).get(digest).pipe(Effect.exit))
      expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("unavailable")
    }))

  it.effect.each<[string, string]>([
    ["an empty string", ""],
    ["a path separator", "ab/cd"],
    ["a windows separator", "ab\\cd"],
    ["the current directory", "."],
    ["the parent directory", ".."]
  ])("refuses %s as a content address", ([_label, candidate]) =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      const exits: Array<Exit.Exit<unknown, unknown>> = [
        yield* withCrypto(artifacts.get(candidate).pipe(Effect.exit)),
        yield* withCrypto(artifacts.has(candidate).pipe(Effect.exit))
      ]
      for (const exit of exits) {
        expect((errorOf(exit) as ArtifactStore.ArtifactStoreError).code).toBe("invalid_digest")
      }
    }))

  it.effect("answers `has` from the canonical address", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      expect(yield* withCrypto(artifacts.has(digest))).toBe(false)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      expect(yield* withCrypto(artifacts.has(digest))).toBe(true)
    }))

  it.effect("returns a deduplicated subset of the probed digests", () =>
    Effect.gen(function*() {
      const host = memoryFs()
      const artifacts = store(host)
      yield* withCrypto(artifacts.put(bytes(artifact)))
      const absent = sha256(bytes("never stored"))
      const missing = yield* withCrypto(artifacts.findMissing([digest, absent, absent, digest]))
      expect(missing).toEqual([absent])
    }))
})

describe("layers", () => {
  it.effect("layerFileSystem builds the store from the FileSystem tag", () =>
    Effect.gen(function*() {
      const host = memoryFs({ supportsOpen: true })
      const published = yield* withCrypto(
        Effect.flatMap(ArtifactStore.ArtifactStore, (artifacts) => artifacts.put(bytes(artifact))).pipe(
          Effect.provide(
            ArtifactStore.layerFileSystem().pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem)(host.fs)))
          )
        )
      )
      expect(published).toBe(digest)
      expect(host.files.has(blobPath)).toBe(true)
    }))
})
