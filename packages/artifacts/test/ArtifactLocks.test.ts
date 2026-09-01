import { describe, expect, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import * as ArtifactLocks from "../src/internal/ArtifactLocks.ts"

const digest = "0".repeat(64)
const directory = ".objects"

const platformError = (tag: PlatformError.SystemErrorTag, method: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: tag, module: "test", method })

const fileInfo = (mtime: Date) =>
  ({
    type: "File",
    mtime: Option.some(mtime),
    size: BigInt(0)
  }) as FileSystem.File.Info

const host = (overrides: Partial<FileSystem.FileSystem> = {}) => {
  let owner = ""
  let removes = 0
  let heartbeats = 0
  const fs = FileSystem.makeNoop({
    makeDirectory: (() => Effect.void) as never,
    writeFileString: ((_path: string, value: string) =>
      Effect.sync(() => {
        owner = value
      })) as never,
    readFileString: (() => Effect.sync(() => owner)) as never,
    remove: (() =>
      Effect.sync(() => {
        removes++
      })) as never,
    stat: (() => Effect.succeed(fileInfo(new Date()))) as never,
    rename: (() => Effect.void) as never,
    utimes: (() =>
      Effect.sync(() => {
        heartbeats++
      })) as never,
    ...overrides
  })
  return { fs, owner: () => owner, removes: () => removes, heartbeats: () => heartbeats }
}

const run = <A, E, R>(fs: FileSystem.FileSystem, effect: Effect.Effect<A, E, R>) =>
  ArtifactLocks.withDigest(fs, directory, digest, effect, (cause) => cause)

describe("artifact lockfile failure and race handling", () => {
  it.effect("propagates an atomic-create failure other than AlreadyExists", () =>
    Effect.gen(function*() {
      const fixture = host({
        writeFileString: (() => Effect.fail(platformError("PermissionDenied", "writeFileString"))) as never
      })
      expect(Exit.isFailure(yield* run(fixture.fs, Effect.void).pipe(Effect.exit))).toBe(true)
    }))

  it.effect("retries when a contended lock vanishes before stat", () =>
    Effect.gen(function*() {
      let writes = 0
      let owner = ""
      const fixture = host({
        writeFileString: ((_path: string, value: string) =>
          Effect.suspend(() => {
            writes++
            if (writes === 1) return Effect.fail(platformError("AlreadyExists", "writeFileString"))
            owner = value
            return Effect.void
          })) as never,
        stat: (() => Effect.fail(platformError("NotFound", "stat"))) as never,
        readFileString: (() => Effect.sync(() => owner)) as never
      })
      const running = yield* run(fixture.fs, Effect.void).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("25 millis")
      yield* Fiber.join(running)
      expect(writes).toBe(2)
    }))

  it.effect("propagates a contended-lock stat refusal", () =>
    Effect.gen(function*() {
      const fixture = host({
        writeFileString: (() => Effect.fail(platformError("AlreadyExists", "writeFileString"))) as never,
        stat: (() => Effect.fail(platformError("PermissionDenied", "stat"))) as never
      })
      expect(Exit.isFailure(yield* run(fixture.fs, Effect.void).pipe(Effect.exit))).toBe(true)
    }))

  it.effect("retries when a stale lock vanishes before its atomic rename", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 minutes")
      let writes = 0
      let owner = ""
      const fixture = host({
        writeFileString: ((_path: string, value: string) =>
          Effect.suspend(() => {
            writes++
            if (writes === 1) return Effect.fail(platformError("AlreadyExists", "writeFileString"))
            owner = value
            return Effect.void
          })) as never,
        stat: (() => Effect.succeed(fileInfo(new Date(0)))) as never,
        rename: (() => Effect.fail(platformError("NotFound", "rename"))) as never,
        readFileString: (() => Effect.sync(() => owner)) as never
      })
      yield* run(fixture.fs, Effect.void)
      expect(writes).toBe(2)
    }))

  it.effect("propagates a stale-lock rename refusal", () =>
    Effect.gen(function*() {
      yield* TestClock.adjust("2 minutes")
      const fixture = host({
        writeFileString: (() => Effect.fail(platformError("AlreadyExists", "writeFileString"))) as never,
        stat: (() => Effect.succeed(fileInfo(new Date(0)))) as never,
        rename: (() => Effect.fail(platformError("PermissionDenied", "rename"))) as never
      })
      expect(Exit.isFailure(yield* run(fixture.fs, Effect.void).pipe(Effect.exit))).toBe(true)
    }))

  it.effect("bounds acquisition when a live owner never releases", () =>
    Effect.gen(function*() {
      const fixture = host({
        writeFileString: (() => Effect.fail(platformError("AlreadyExists", "writeFileString"))) as never,
        stat: (() => Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.succeed(fileInfo(new Date(now))))) as never
      })
      const waiting = yield* run(fixture.fs, Effect.void).pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("2 minutes")
      expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true)
    }))

  it.effect("heartbeats while the protected operation remains active", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = host({
        writeFileString: ((_path: string, value: string) =>
          Effect.sync(() => {
            void value
          }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)))) as never
      })
      const running = yield* run(fixture.fs, Deferred.await(release)).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("10 seconds")
      expect(fixture.heartbeats()).toBeGreaterThan(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
    }))

  it.effect("does not delete a replacement lock owned by another process", () =>
    Effect.gen(function*() {
      const fixture = host({ readFileString: (() => Effect.succeed("different-owner")) as never })
      yield* run(fixture.fs, Effect.void)
      expect(fixture.removes()).toBe(0)
    }))

  it.effect("swallows a missing lock during release", () =>
    Effect.gen(function*() {
      const fixture = host({
        readFileString: (() => Effect.fail(platformError("NotFound", "readFileString"))) as never
      })
      yield* run(fixture.fs, Effect.void)
    }))
})
