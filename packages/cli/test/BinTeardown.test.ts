/**
 * The `smithers` entrypoint's exit-status contract, exercised in process.
 *
 * `Bin.test.ts` proves three statuses end to end through a real spawn. These
 * cases pin the whole mapping — signals, interruption, every CLI failure
 * class, and the ordinary success path — by capturing the teardown the
 * entrypoint hands to the Node runtime and running it against each exit shape.
 * The Node runtime is stubbed so importing the module does not start the CLI
 * against the test runner's own arguments.
 */
import { Cause, Effect, Exit } from "effect"
import { CliError as EffectCliError } from "effect/unstable/cli"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { packageVersion } from "../src/Version.ts"

const runMain = vi.fn()

vi.mock("@effect/platform-node", async (importOriginal) => {
  const original = await importOriginal<typeof import("@effect/platform-node")>()
  return { ...original, NodeRuntime: { ...original.NodeRuntime, runMain } }
})

type Teardown = (exit: Exit.Exit<unknown, unknown>, onExit: (code: number) => void) => void

interface Entrypoint {
  readonly main: Effect.Effect<void>
  readonly teardown: Teardown
  readonly onSigint: () => void
  readonly onSigterm: () => void
  /** The failure classes of the same module instance the entrypoint matches on. */
  readonly cliError: typeof import("../src/CliError.ts")
}

/** Imports a fresh copy of the entrypoint and captures what it registered. */
const load = async (): Promise<Entrypoint> => {
  const beforeSigint = process.listeners("SIGINT")
  const beforeSigterm = process.listeners("SIGTERM")
  runMain.mockClear()
  vi.resetModules()
  // The entrypoint matches its own failures with `instanceof`, so the classes
  // it is checked against must come from the same fresh module graph.
  const cliError = await import("../src/CliError.ts")
  await import("../src/bin.ts")
  const call = runMain.mock.calls[0]
  if (call === undefined) throw new Error("the entrypoint did not start a Node runtime")
  const onSigint = process.listeners("SIGINT").find((listener) => !beforeSigint.includes(listener))
  const onSigterm = process.listeners("SIGTERM").find((listener) => !beforeSigterm.includes(listener))
  if (onSigint === undefined || onSigterm === undefined) {
    throw new Error("the entrypoint did not install signal handlers")
  }
  return {
    main: call[0] as Effect.Effect<void>,
    teardown: (call[1] as { readonly teardown: Teardown }).teardown,
    onSigint: onSigint as () => void,
    onSigterm: onSigterm as () => void,
    cliError
  }
}

/** The status one teardown reports for one exit. */
const status = (entrypoint: Entrypoint, exit: Exit.Exit<unknown, unknown>): number => {
  let reported: number | undefined
  entrypoint.teardown(exit, (code) => {
    reported = code
  })
  if (reported === undefined) throw new Error("teardown reported no status")
  return reported
}

const failure = (error: unknown): Exit.Exit<never, unknown> => Exit.failCause(Cause.fail(error))

let entrypoint: Entrypoint
let previousExitCode: number | string | null | undefined

// `load()` imports the entrypoint, which pulls the whole command tree through
// tsx under coverage instrumentation. On a loaded host that import alone can
// outrun the suite's 30 s hook budget, which then reports eleven skipped cases
// rather than a real failure. The budget here is for the import, not for the
// assertions.
beforeAll(async () => {
  previousExitCode = process.exitCode
  entrypoint = await load()
}, 120_000)

afterAll(() => {
  process.exitCode = previousExitCode
})

describe("smithers entrypoint", () => {
  it("starts the command tree on the Node runtime with a teardown", () => {
    expect(runMain).toHaveBeenCalledTimes(1)
    expect(typeof entrypoint.teardown).toBe("function")
  })

  it("reports the accumulated process status on success", () => {
    process.exitCode = 3
    expect(status(entrypoint, Exit.succeed(undefined))).toBe(3)
  })

  it("reports zero on success when nothing set a status", () => {
    process.exitCode = undefined
    expect(status(entrypoint, Exit.succeed(undefined))).toBe(0)
  })

  it("reports the interrupt status for a cause carrying only interrupts", () => {
    expect(status(entrypoint, Exit.failCause(Cause.interrupt(1)))).toBe(130)
  })

  it("reports success for a help request and a usage status for one with errors", () => {
    // `ShowHelp` with no errors is `--help`, which is a successful
    // invocation; with errors it is a rejected one.
    expect(status(entrypoint, failure(new EffectCliError.ShowHelp({ commandPath: ["smithers"], errors: [] })))).toBe(0)
    expect(
      status(
        entrypoint,
        failure(
          new EffectCliError.ShowHelp({
            commandPath: ["smithers"],
            errors: [new EffectCliError.UnrecognizedOption({ option: "--filter", suggestions: [] })]
          })
        )
      )
    ).toBe(2)
  })

  it("reports a usage status for a parse failure that never asked for help", () => {
    expect(
      status(entrypoint, failure(new EffectCliError.UnrecognizedOption({ option: "--filter", suggestions: [] })))
    ).toBe(2)
  })

  it("reports the projection's own status for each failure it owns", () => {
    expect(status(entrypoint, failure(new entrypoint.cliError.UsageError({ message: "bad" })))).toBe(2)
    expect(status(entrypoint, failure(new entrypoint.cliError.UnsupportedError({ message: "no" })))).toBe(1)
  })

  it("reports the generic failure status for anything else", () => {
    expect(status(entrypoint, failure(new Error("boom")))).toBe(1)
  })

  it("prefers a received signal over the exit the runtime produced", async () => {
    const interrupted = await load()
    interrupted.onSigint()
    // A signal outranks a clean exit: the shell must see the run was
    // interrupted, not that it finished.
    process.exitCode = 0
    expect(status(interrupted, Exit.succeed(undefined))).toBe(130)
  })

  it("reports the termination status after SIGTERM", async () => {
    const terminated = await load()
    terminated.onSigterm()
    expect(status(terminated, Exit.succeed(undefined))).toBe(143)
  })

  it("runs the command tree against the process arguments", async () => {
    const fresh = await load()
    const argv = process.argv
    const cwd = process.cwd()
    const project = mkdtempSync(join(tmpdir(), "flows-cli-bin-"))
    const written: Array<string> = []
    const write = vi.spyOn(globalThis.console, "log").mockImplementation((...parts: ReadonlyArray<unknown>) => {
      written.push(parts.map(String).join(" "))
    })
    try {
      process.chdir(project)
      process.argv = [process.execPath, "smithers", "--version"]
      await Effect.runPromise(fresh.main)
    } finally {
      write.mockRestore()
      process.argv = argv
      process.chdir(cwd)
      rmSync(project, { recursive: true, force: true })
    }

    // The entrypoint reads its configuration from the real process arguments
    // and runs the tree over the Node composition those arguments select.
    expect(written.join("")).toContain(packageVersion)
  }, 60_000)
})
