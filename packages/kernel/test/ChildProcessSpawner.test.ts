import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Effect, Option, type PlatformError, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner as HostChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import { GrantStore } from "../src/GrantStore.ts"

const itEffect = (name: string, effect: () => Effect.Effect<void, unknown, never>) => it.effect(name, () => effect())

/**
 * Effect's spawner tag fixes its error channel to `PlatformError`, so the
 * kernel projects a refusal into one and keeps the structured original on the
 * cause.
 */
const denial = (error: unknown) => Option.getOrThrow(Permission.fromPlatformError(error as PlatformError.PlatformError))

const scriptedStore = (allowed: ReadonlySet<string>, checks: Array<Capability.Capability>) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return allowed.has(`${capability.action}:${capability.resource}`)
        ? Effect.void
        : Effect.fail(Permission.permissionDenied(capability, "denied by test"))
    },
    reply: () => Effect.die("not used by decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

/** A host spawner whose handle just replays a scripted stdout. */
const hostSpawner = (options: { readonly stdout: string; readonly onSpawn?: () => void }) =>
  makeSpawner(() =>
    Effect.sync(() => {
      options.onSpawn?.()
      const output = Stream.fromArray([new TextEncoder().encode(options.stdout)])
      return makeHandle({
        pid: ProcessId(1),
        exitCode: Effect.succeed(ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: output,
        stderr: Stream.empty,
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )

describe("ChildProcessSpawner", () => {
  itEffect("checks before spawning and does not delegate a denied command", () => {
    let invoked = false
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      expect(
        denial(
          yield* Effect.flip(
            spawner.string(ChildProcess.make("blocked", ["--now"], { cwd: "/work" }))
          )
        )
      ).toMatchObject({
        code: "permission_denied",
        capability: { action: "proc:spawn", resource: "blocked --now" },
        reason: "denied by test"
      })
      expect(invoked).toBe(false)
      expect(checks).toEqual([{ action: "proc:spawn", resource: "blocked --now" }])
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "never", onSpawn: () => (invoked = true) })
      ),
      Effect.provideService(GrantStore, scriptedStore(new Set(), checks))
    )
  })

  itEffect("preserves PermissionRequired through the PlatformError projection", () => {
    let invoked = false
    const store = GrantStore.of({
      check: (capability) =>
        Effect.fail(Permission.permissionRequired({
          requestId: "permission-7",
          runId: "run-1",
          capability,
          tier: "irreversible",
          meta: { surface: "process" }
        })),
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const failure = denial(yield* Effect.flip(spawner.exitCode(ChildProcess.make("blocked"))))
      expect(failure).toBeInstanceOf(Permission.PermissionRequired)
      expect(failure).toMatchObject({
        code: "permission_required",
        requestId: "permission-7",
        runId: "run-1",
        capability: { action: "proc:spawn", resource: "blocked" },
        meta: { surface: "process" }
      })
      expect(invoked).toBe(false)
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "never", onSpawn: () => (invoked = true) })
      ),
      Effect.provideService(GrantStore, store)
    )
  })

  itEffect("preserves GrantStoreError through the PlatformError projection", () => {
    let invoked = false
    const store = GrantStore.of({
      check: () =>
        Effect.fail(
          new Permission.GrantStoreError({
            code: "journal_failed",
            message: "permission journal unavailable"
          })
        ),
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const failure = denial(yield* Effect.flip(spawner.exitCode(ChildProcess.make("blocked"))))
      expect(failure).toBeInstanceOf(Permission.GrantStoreError)
      expect(failure).toMatchObject({
        code: "journal_failed",
        message: "permission journal unavailable"
      })
      expect(invoked).toBe(false)
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "never", onSpawn: () => (invoked = true) })
      ),
      Effect.provideService(GrantStore, store)
    )
  })

  itEffect("delegates allowed commands without changing their result", () => {
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      expect(yield* spawner.string(ChildProcess.make("tool"))).toBe("out")
      expect(checks).toEqual([{ action: "proc:spawn", resource: "tool" }])
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })

  itEffect("checks every derived helper, not just `spawn`", () => {
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const command = ChildProcess.make("tool")
      yield* Effect.scoped(spawner.spawn(command))
      yield* spawner.exitCode(command)
      yield* spawner.string(command)
      yield* spawner.lines(command)
      yield* Stream.runDrain(spawner.streamString(command))
      yield* Stream.runDrain(spawner.streamLines(command))
      expect(checks).toHaveLength(6)
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })

  itEffect("acquires stream permission only when the stream is consumed", () => {
    let delegated = false
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const stream = spawner.streamString(ChildProcess.make("tool"))
      expect(checks).toEqual([])
      expect(delegated).toBe(false)
      expect(yield* Stream.mkString(stream)).toBe("out")
      expect(checks).toEqual([{ action: "proc:spawn", resource: "tool" }])
      expect(delegated).toBe(true)
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "out", onSpawn: () => (delegated = true) })
      ),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })

  itEffect("decorates Effect's own spawner tag, so there is nothing else to reach for", () => {
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      // One tag: the kernel re-export and Effect's own module name the same
      // service, and the guarded implementation is what both resolve to.
      expect(ChildProcessSpawner.ChildProcessSpawner).toBe(HostChildProcessSpawner)
      const raw = yield* HostChildProcessSpawner
      const failure = yield* Effect.flip(raw.string(ChildProcess.make("blocked")))
      expect(failure).toMatchObject({
        _tag: "PlatformError",
        reason: { _tag: "PermissionDenied", module: "ChildProcessSpawner", method: "spawn" }
      })
      expect(denial(failure)).toMatchObject({ code: "permission_denied" })
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, scriptedStore(new Set(), checks))
    )
  })

  itEffect("passes the command's cwd to the grant check", () => {
    const seen: Array<unknown> = []
    const store = GrantStore.of({
      check: (capability, context) => {
        seen.push({ capability, context })
        return Effect.void
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.string(ChildProcess.make("tool", [], { cwd: "/work" }))
      expect(seen).toEqual([{
        capability: { action: "proc:spawn", resource: "tool" },
        context: { cwd: "/work" }
      }])
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, store)
    )
  })

  itEffect("checks a shell command under the exact unquoted line the shell executes", () => {
    const checks: Array<Capability.Capability> = []
    const line = "echo safe; run privileged"

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.exitCode(ChildProcess.make("echo", ["safe;", "run", "privileged"], { shell: true }))
      expect(checks).toEqual([{ action: "proc:spawn", resource: line }])
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "" })),
      Effect.provideService(GrantStore, scriptedStore(new Set([`proc:spawn:${line}`]), checks))
    )
  })

  itEffect("includes a custom shell executable in the checked resource", () => {
    const checks: Array<Capability.Capability> = []
    const line = "/custom/shell -c 'echo hello world'"

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.exitCode(ChildProcess.make("echo", ["hello", "world"], { shell: "/custom/shell" }))
      expect(checks).toEqual([{ action: "proc:spawn", resource: line }])
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "" })),
      Effect.provideService(GrantStore, scriptedStore(new Set([`proc:spawn:${line}`]), checks))
    )
  })
})
