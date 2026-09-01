import { describe, expect, it } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Logger from "effect/Logger"
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

/**
 * Collects what the heartbeat reports instead of printing it. A lock lost
 * underneath a live holder is the one condition in this module an operator has
 * to be able to see, so the tests that drive it assert the record.
 */
const capture = () => {
  const messages: Array<unknown> = []
  return { messages, logger: Logger.layer([Logger.make<unknown, void>(({ message }) => messages.push(message))]) }
}

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
      let owner = ""
      const fixture = host({
        writeFileString: ((_path: string, value: string) =>
          Effect.sync(() => {
            owner = value
          }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)))) as never,
        readFileString: (() => Effect.sync(() => owner)) as never
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

  it.effect("stops heartbeating once the lock names a different owner", () =>
    Effect.gen(function*() {
      // A holder stalled past the stale bound has its lock reaped and replaced.
      // If its heartbeat kept touching that pathname it would freshen a lock it
      // does not own, and the replacement could never be judged stale while the
      // zombie ran — a hard-killed replacement would hold the digest until the
      // zombie's own operation ended, two minutes at a time for every waiter.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = host({
        writeFileString: (() => Deferred.succeed(entered, undefined).pipe(Effect.asVoid)) as never,
        readFileString: (() => Effect.succeed("a-replacement-owner")) as never
      })
      const log = capture()
      const running = yield* run(fixture.fs, Deferred.await(release)).pipe(
        Effect.provide(log.logger),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("60 seconds")
      expect(fixture.heartbeats()).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      // And it must not delete the replacement on the way out either.
      expect(fixture.removes()).toBe(0)
      // The protected effect is still running unfenced at this point, so the
      // heartbeat must not retire silently.
      expect(log.messages).toEqual([[
        "Artifact lock was reclaimed while its holder was still running",
        { digest, state: "foreign" }
      ]])
    }))

  it.effect("stops heartbeating once the lock is gone", () =>
    Effect.gen(function*() {
      // A reaped lock leaves nothing to freshen. Reading it back fails
      // `NotFound`, which ends the heartbeat rather than retrying forever.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fixture = host({
        writeFileString: (() => Deferred.succeed(entered, undefined).pipe(Effect.asVoid)) as never,
        readFileString: (() => Effect.fail(platformError("NotFound", "readFileString"))) as never
      })
      const log = capture()
      const running = yield* run(fixture.fs, Deferred.await(release)).pipe(
        Effect.provide(log.logger),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("60 seconds")
      expect(fixture.heartbeats()).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      expect(log.messages).toEqual([[
        "Artifact lock was reclaimed while its holder was still running",
        { digest, state: "gone" }
      ]])
    }))

  it.effect("keeps heartbeating across a read the host transiently refused", () =>
    Effect.gen(function*() {
      // A refused read is no evidence about ownership either way. Ending the
      // heartbeat on it would retire a lock this call still holds: the file
      // goes stale in 60 seconds, another process reaps it, and this holder
      // keeps working unfenced. The beat is skipped and the next one retries.
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let owner = ""
      let reads = 0
      const fixture = host({
        writeFileString: ((_path: string, value: string) =>
          Effect.sync(() => {
            owner = value
          }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)))) as never,
        readFileString: (() =>
          Effect.suspend(() => {
            reads += 1
            return reads <= 2
              ? Effect.fail(platformError("PermissionDenied", "readFileString"))
              : Effect.succeed(owner)
          })) as never
      })
      const log = capture()
      const running = yield* run(fixture.fs, Deferred.await(release)).pipe(
        Effect.provide(log.logger),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("20 seconds")
      expect(fixture.heartbeats()).toBe(0)
      yield* TestClock.adjust("20 seconds")
      expect(fixture.heartbeats()).toBeGreaterThan(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      // A refused read is not evidence the lock was lost, so it must not raise
      // the warning that means it was.
      expect(log.messages).toEqual([])
    }))

  it.effect("gives a digest one in-process lock even when an effect value is reused", () =>
    Effect.gen(function*() {
      // The bookkeeping that decides which callers share a semaphore has to be
      // per-execution, not per-construction. `ArtifactBackupLease` builds its
      // gate once and runs it on every heartbeat, so a per-construction count
      // retires the entry while a holder is still inside it, and the next
      // caller mints a second semaphore for the same digest. Two writers then
      // serialize against nothing.
      const fixture = host()
      let runs = 0
      let concurrent = 0
      let peak = 0
      const holding = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const body = Effect.gen(function*() {
        runs += 1
        // The first run exists only to retire the entry behind the reused value.
        if (runs === 1) return
        concurrent += 1
        peak = Math.max(peak, concurrent)
        yield* Deferred.succeed(holding, undefined)
        yield* Deferred.await(finish)
        concurrent -= 1
      })
      const reused = ArtifactLocks.withDigest(fixture.fs, directory, digest, body, (cause) => cause, "process")
      yield* reused
      const holder = yield* Effect.forkChild(reused, { startImmediately: true })
      yield* Deferred.await(holding)
      const contender = yield* Effect.forkChild(
        ArtifactLocks.withDigest(fixture.fs, directory, digest, body, (cause) => cause, "process"),
        { startImmediately: true }
      )
      yield* Effect.yieldNow
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(holder)
      yield* Fiber.join(contender)
      expect(peak).toBe(1)
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

  it.effect("propagates a release failure while the lock still exists", () =>
    Effect.gen(function*() {
      const fixture = host({
        readFileString: (() => Effect.fail(platformError("PermissionDenied", "readFileString"))) as never
      })
      expect(Exit.isFailure(yield* run(fixture.fs, Effect.void).pipe(Effect.exit))).toBe(true)
    }))
})
