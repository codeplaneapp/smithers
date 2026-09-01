/**
 * The suite a provider implementation has to pass.
 *
 * Vendor providers live in plugin packages, so this package cannot test them.
 * What it can do is state the contract as behavior and hand the statement to
 * the adapter author. These cases pin the statement itself: a provider that
 * honors the contract reports nothing, and each way of missing it is named.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as ProviderConformance from "../src/ProviderConformance/index.ts"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"

const commands: ProviderConformance.Commands = {
  writes: "greet",
  output: "hello",
  fails: "boom",
  failureCode: 3,
  runs: "serve",
  // Short, because one case below is a provider that will never stop and the
  // suite has to wait out the whole window to say so.
  stopsWithin: "250 millis"
}

const scripts = {
  greet: { stdout: "hello" },
  boom: { exitCode: 3 },
  serve: { pending: true }
}

const gone = () => new ProviderError({ code: "unavailable", message: "session is gone" })

const checks = (violations: ReadonlyArray<ProviderConformance.Violation>) =>
  violations.map((violation) => violation.check)

describe("ProviderConformance", () => {
  it.live("reports nothing for a provider that honors the whole contract", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts, kill: true, ping: Effect.void })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(violations).toEqual([])
    }))

  it.effect("skips the optional capabilities a provider does not declare", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(violations).toEqual([])
      expect(provider.state.kills).toEqual([])
    }))

  it.effect("names a provider whose command writes the wrong bytes", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { ...scripts, greet: { stdout: "goodbye" } }
      })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["writes-its-output"])
      expect(violations[0]?.actual).toContain("goodbye")
    }))

  it.effect("names a provider whose command cannot be started", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { ...scripts, greet: { failure: gone() } }
      })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["writes-its-output"])
      expect(violations[0]?.actual).toContain("a failure")
    }))

  it.effect("names a provider that loses a nonzero exit code", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts: { ...scripts, boom: { exitCode: 0 } }
      })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["reports-a-nonzero-exit"])
      expect(violations[0]?.expected).toContain("3")
    }))

  it.effect("names a provider whose declared ping does not answer", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts, ping: Effect.fail(gone()) })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["answers-a-ping"])
    }))

  it.live("names a provider whose declared kill refuses a live process", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts,
        kill: true,
        killFailure: gone()
      })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["signals-a-running-command"])
      expect(violations[0]?.actual).toContain("a failure")
    }))

  it.live("names a provider whose declared kill is a silent no-op", () =>
    Effect.gen(function*() {
      // The dangerous adapter: `kill` satisfies the type, answers success, and
      // leaves the process running. Accepting it would make every cancelled
      // action leak a process inside the sandbox with the suite reporting
      // conformance.
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        scripts,
        kill: true,
        killIsNoop: true
      })

      const violations = yield* ProviderConformance.check(provider, commands)

      expect(checks(violations)).toEqual(["signals-a-running-command"])
      expect(violations[0]?.actual).toBe("the command was still running after the signal")
      // The signal was delivered and accepted. That is exactly the point.
      expect(provider.state.kills).toContainEqual({ command: "serve", signal: "SIGTERM" })
    }))

  it("names the deadline a signalled command has to stop inside", () => {
    expect(ProviderConformance.defaultStopsWithin).toBe("5 seconds")
  })

  it("renders a report an adapter author can act on", () => {
    expect(ProviderConformance.format([])).toBe("provider conforms")
    expect(
      ProviderConformance.format([{ check: "writes-its-output", expected: "hello", actual: "goodbye" }])
    ).toBe("writes-its-output: expected hello, got goodbye")
  })

  it.effect("convicts a kill whose wrapper died while the command's work survived", () =>
    Effect.gen(function*() {
      // The wrapper stops (a captured exit), and the machine still answers
      // the survivor probe with 0: the shell died, the work did not.
      const surviving = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: {
          holding: { pending: true },
          "still-there": { exitCode: 0 }
        }
      })
      const survivors = yield* ProviderConformance.check(surviving, {
        writes: "printf-fixture",
        output: "",
        fails: "fails-fixture",
        failureCode: 127,
        runs: "holding",
        survivor: "still-there"
      })
      expect(survivors.map(({ check }) => check)).toContain("signals-a-running-command")
      expect(survivors.find(({ check }) => check === "signals-a-running-command")?.actual).toContain(
        "work was still running"
      )

      // A survivor probe that finds nothing leaves a working kill conforming.
      const clean = RemoteChildProcessSpawner.TestRemote.make({
        kill: true,
        scripts: {
          holding: { pending: true },
          "still-there": { exitCode: 1 }
        }
      })
      const none = yield* ProviderConformance.check(clean, {
        writes: "printf-fixture",
        output: "",
        fails: "fails-fixture",
        failureCode: 127,
        runs: "holding",
        survivor: "still-there"
      })
      expect(none.map(({ check }) => check)).not.toContain("signals-a-running-command")
    }))
})
