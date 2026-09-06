import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"
import { fixture, pause, until } from "./helpers/ContainedCommand.ts"

describe.skipIf(process.platform === "win32")("build process ownership", () => {
  it.each(["explicit stop", "natural exit"] as const)("releases a service's stubborn child after %s", async (kind) => {
    const child = await fixture({ natural: false, inheritedOutput: true })
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire({
          key: `//:contained-${child.token}`,
          cwd: child.directory,
          argv: child.argv,
          stop: { signal: "SIGTERM", grace: "100ms" }
        })
        yield* Effect.promise(child.ready)
        expect(handle.pid).toBe((yield* Effect.promise(child.leader))?.pid)
        if (kind === "natural exit") {
          yield* Effect.promise(child.exit)
          yield* Effect.promise(() =>
            until(async () => {
              const leader = await child.leader()
              return leader !== undefined && child.stopped(leader)
            })
          )
        }
      })))
      const first = await child.beat()
      expect(first?.token).toBe(child.token)
      expect(child.stopped(first!)).toBe(true)
      await pause(120)
      expect(await child.beat()).toEqual(first)
    } finally {
      await child.dispose()
    }
  })

  it("fails a service consumer when the actual target exits while a child holds stdout", async () => {
    const child = await fixture({ natural: false, inheritedOutput: true })
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire({
          key: `//:health-${child.token}`,
          cwd: child.directory,
          argv: child.argv,
          stop: { signal: "SIGTERM", grace: "2s" }
        })
        yield* Effect.promise(child.ready)
        yield* Effect.promise(child.exit)
        const result = yield* Effect.exit(handle.whileHealthy(Effect.sleep(500)))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(JSON.stringify(result.cause)).toContain("\"reason\":\"exited\"")
      })))
      const beat = await child.beat()
      expect(beat?.token).toBe(child.token)
      expect(child.stopped(beat!)).toBe(true)
    } finally {
      await child.dispose()
    }
  })

  it.each([false, true])(
    "discovery closes the tree after natural exit (inherited output: %s)",
    async (inheritedOutput) => {
      const child = await fixture({ natural: true, inheritedOutput })
      try {
        let stdout = ""
        const code = await ContainedProcess.run({
          command: child.argv[0],
          args: child.argv.slice(1),
          cwd: child.directory,
          timeoutMs: 10_000,
          stdout: (text) => {
            stdout += text
          },
          stderr: () => {}
        })
        expect(code).toBe(0)
        expect(stdout).toBe("target-complete\n")
        const first = await child.beat()
        expect(first?.token).toBe(child.token)
        expect(child.stopped(first!)).toBe(true)
        await pause(120)
        expect(await child.beat()).toEqual(first)
      } finally {
        await child.dispose()
      }
    }
  )
})
