/**
 * The staging path every input-channel-less provider feeds standard input
 * through.
 *
 * `AwsSandbox`, `VercelSandbox`, `DaytonaSandbox`, and `CloudflareSandbox` all
 * put a command's standard input in a workspace file because their transports
 * take a command line and nothing else, so a caller's script, patch, or
 * credential blob lives on the machine for as long as this module leaves it
 * there. The provider suites prove the happy path end to end; these cases
 * prove the ones a working transport never reaches.
 */
import { describe, expect, it } from "@effect/vitest"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { stdinRedirect } from "../src/internal/stdinRedirect.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"

/**
 * A target that records what it was asked to do, and can fail the write the
 * way a chunked one does: after some of the bytes are already on the machine.
 */
const recorded = (options: { readonly failWrite?: boolean } = {}) => {
  const writes: Array<string> = []
  const removals: Array<string> = []
  return {
    writes,
    removals,
    target: {
      workdir: "/workspace/",
      writeFile: (path: string, _content: Uint8Array) => {
        writes.push(path)
        return options.failWrite === true
          ? Effect.fail(
            new ProviderError({ code: "unknown", message: "the fourth slice of the write failed" })
          )
          : Effect.void
      },
      remove: (path: string) => {
        removals.push(path)
        return Effect.void
      }
    }
  }
}

describe("stdinRedirect", () => {
  it.effect("leaves a command with no input alone", () =>
    Effect.gen(function*() {
      const { removals, target, writes } = recorded()
      const line = yield* Effect.scoped(stdinRedirect(target)("cat", undefined))

      expect(line).toBe("cat")
      expect(writes).toEqual([])
      expect(removals).toEqual([])
    }))

  it.effect("stages input below the workspace and takes it away when the scope closes", () =>
    Effect.gen(function*() {
      const { removals, target, writes } = recorded()
      const line = yield* Effect.scoped(
        Effect.tap(stdinRedirect(target)("cat > out", new Uint8Array([1, 2, 3])), () =>
          Effect.sync(() => {
            // The file is still there while the command that reads it runs.
            expect(removals).toEqual([])
          }))
      )
      const staged = writes[0]!

      expect(staged).toMatch(/^\/workspace\/\.smthrs-stdin\/[0-9a-f]{32}$/)
      expect(line).toBe(`( cat > out ) < ${CommandLine.quote(staged)}`)
      expect(removals).toEqual([staged])
    }))

  // The removal used to be registered by `Effect.acquireRelease` with the
  // write as its acquire, and Effect registers a release only after its
  // acquire SUCCEEDS. No bundled provider writes atomically: `AwsSandbox`
  // sends one `printf | base64 -d` per `ExecTransport.chunkBytes` bytes and
  // stops at the first non-zero status, so a session that dropped partway
  // through a 32 KiB input left the earlier chunks in the workspace with
  // nothing registered to remove them, for the life of the machine and across
  // a reattach. That is the leak the scoped staging exists to close, and it
  // has to be closed before the first byte is written rather than after the
  // last one.
  it.effect("removes the staging file when the write itself fails partway", () =>
    Effect.gen(function*() {
      const { removals, target, writes } = recorded({ failWrite: true })
      const exit = yield* Effect.exit(
        Effect.scoped(stdinRedirect(target)("cat", new Uint8Array([1, 2, 3])))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(writes).toHaveLength(1)
      expect(removals).toEqual(writes)
    }))

  it.effect("names every staged file differently, so a reattach cannot read the last one", () =>
    Effect.gen(function*() {
      const { target, writes } = recorded()
      const redirect = stdinRedirect(target)
      yield* Effect.scoped(
        Effect.andThen(
          redirect("first", new Uint8Array([1])),
          redirect("second", new Uint8Array([2]))
        )
      )

      expect(writes).toHaveLength(2)
      expect(new Set(writes).size).toBe(2)
    }))
})
