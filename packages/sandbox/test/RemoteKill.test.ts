/**
 * Signalling a remote process, and pinging the session it runs in.
 *
 * The adapter used to answer every `kill` with `BadArgument`: a remote session
 * ended only by closing its scope, so a provider that CAN stop one command
 * without tearing down the whole session had no way to say so. These cases pin
 * both halves of the optional contract — a provider that implements `kill` gets
 * the signal, and a provider that does not keeps the old, honest refusal.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, PlatformError, Ref } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as SandboxHealth from "../src/SandboxHealth/index.ts"

const reason = (error: unknown): string =>
  error instanceof PlatformError.PlatformError ? error.reason._tag : `not a PlatformError: ${String(error)}`

describe("RemoteChildProcessSpawner kill", () => {
  it.effect("signals a live remote process when its scope closes", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: { serve: { pending: true } }
      })

      yield* Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.spawn(ChildProcess.make("serve"))).pipe(
        Effect.scoped,
        Effect.provide(RemoteChildProcessSpawner.layer(provider))
      )

      expect(provider.state.kills).toEqual([{ command: "serve", signal: "SIGTERM" }])
      expect(provider.state.cancellations).toBe(1)
    }))

  it.effect("signals with the kill signal the command configured", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: { serve: { pending: true } }
      })

      yield* Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.spawn(ChildProcess.make("serve", [], { killSignal: "SIGHUP" }))
      ).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))

      expect(provider.state.kills).toEqual([{ command: "serve", signal: "SIGHUP" }])
    }))

  it.effect("kills through the handle on request", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: { serve: { pending: true } }
      })

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("serve"))
        yield* handle.kill({ killSignal: "SIGKILL" })
      }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))

      expect(provider.state.kills[0]).toEqual({ command: "serve", signal: "SIGKILL" })
    }))

  it.effect("leaves a process that already exited unsignalled", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: { greet: { stdout: "hi" } }
      })

      const code = yield* Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.exitCode(ChildProcess.make("greet"))
      ).pipe(Effect.provide(RemoteChildProcessSpawner.layer(provider)))

      expect(code).toBe(0)
      expect(provider.state.kills).toEqual([])
    }))

  it.effect("reports a provider kill failure as a PlatformError", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        killFailure: new ProviderError({ code: "unavailable", message: "session is gone" }),
        scripts: { serve: { pending: true } }
      })

      const error = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("serve"))
        return yield* Effect.flip(handle.kill())
      }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))

      expect(reason(error)).toBe("NotFound")
      expect(error.message).toContain("session is gone")
    }))

  it.effect("still runs the session finalizer for a provider that cannot kill", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { serve: { pending: true } } })

      const error = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("serve"))
        return yield* Effect.flip(handle.kill())
      }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider)))

      expect(reason(error)).toBe("BadArgument")
      expect(provider.state.kills).toEqual([])
      expect(provider.state.cancellations).toBe(1)
    }))
})

describe("SandboxHealth from a provider", () => {
  it.effect("probes a provider that answers its ping", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ ping: Effect.void })

      const state = yield* SandboxHealth.fromProvider(provider).check

      expect(state._tag).toBe("Healthy")
    }))

  it.effect("reports a failed provider ping as unhealthy", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.fail(new ProviderError({ code: "unavailable", message: "no session" }))
      })

      const state = yield* SandboxHealth.fromProvider(provider).check

      expect(state).toMatchObject({ _tag: "Unhealthy", reason: "ping_failed", message: "no session" })
    }))

  it.effect("reports a provider that cannot be pinged as healthy, the way an unsandboxed host is", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({})

      const state = yield* SandboxHealth.fromProvider(provider).check

      expect(state._tag).toBe("Healthy")
    }))

  it.effect("provides the provider-backed service as a layer", () =>
    Effect.gen(function*() {
      const pings = yield* Ref.make(0)
      const provider = RemoteChildProcessSpawner.TestRemote.make({ ping: Ref.update(pings, (n) => n + 1) })

      const state = yield* Effect.flatMap(SandboxHealth.SandboxHealth, (health) => health.check).pipe(
        Effect.provide(SandboxHealth.layerFromProvider(provider))
      )

      expect(state._tag).toBe("Healthy")
      expect(yield* Ref.get(pings)).toBe(1)
    }))
})
