/**
 * Every removed verb and flag of rc-contract section 4.2, driven through the
 * real parser.
 *
 * The complete sets live here rather than in `Bin.test.ts` because the fact
 * being pinned — this invocation fails with `UnsupportedError`, whose exit
 * status is 1 and whose message names the replacement — is decided before any
 * process boundary. `Bin.test.ts` proves the boundary carries it.
 */
import { NodeServices } from "@effect/platform-node"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Cause, Effect, Exit, Layer } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import { cli } from "../src/Command.ts"
import * as Output from "../src/Output.ts"
import * as Unsupported from "../src/Unsupported.ts"
import { packageVersion } from "../src/Version.ts"

const runCommand = Command.runWith(cli, { version: packageVersion })

const services = Layer.mergeAll(TestConsole.layer, Output.layer, TestControl.layer({ now: () => 0 }))

/** The failure one invocation produced, or `undefined` when it succeeded. */
const failure = async (args: ReadonlyArray<string>): Promise<unknown> => {
  const exit = await Effect.runPromise(
    Effect.exit(runCommand(args)).pipe(
      Effect.provide(services),
      Effect.provide(NodeServices.layer)
    ) as Effect.Effect<Exit.Exit<void, unknown>>
  )
  return Exit.isSuccess(exit) ? undefined : Cause.squash(exit.cause)
}

/** The two removed entries whose bare form is a live alias, not a refusal. */
const ownGroups = new Set(["gateway", "workflow"])

describe("every removed verb", () => {
  it.each(Unsupported.removedVerbs.map((verb) => [verb.name, verb] as const))(
    "`smithers %s` fails with the migration message and exit status 1",
    async (name, verb) => {
      // Two removed entries have a bare form that still does something:
      // `gateway` is the `serve` alias and `workflow list` is the `ls` alias.
      // Both are driven through a removed subcommand instead, which is the
      // only form section 4.2 removed.
      const error = await failure(
        verb.subcommands === undefined || !ownGroups.has(name) ? [name] : [name, verb.subcommands[0]!]
      )

      expect(error).toBeInstanceOf(CliError.UnsupportedError)
      const message = (error as CliError.UnsupportedError).message
      expect(message).toContain("was removed in 1.0.0-rc.0")
      expect(message).toContain(verb.reason)
      expect(message).toContain(`${Unsupported.migrationUrl}#${verb.name}`)
      expect(CliError.exitCode(error as CliError.UnsupportedError)).toBe(1)
    }
  )

  it("carries the sub-verb into the message of a removed group", async () => {
    for (const [group, sub] of [["agents", "add"], ["cron", "list"], ["human", "resolve"], ["packs", "update"]]) {
      const error = await failure([group!, sub!])

      expect((error as CliError.UnsupportedError).message).toContain(`smithers ${group} ${sub} was removed`)
    }
  })
})

describe("every removed flag", () => {
  /** How each removed flag is spelled on its surviving parent command. */
  const invocation = (flag: Unsupported.RemovedFlag): ReadonlyArray<string> => {
    if (flag.parent === "") return ["--backend", "postgres", "ls"]
    if (flag.parent === "steer") return ["steer", "run-1", "--message", "hello", "--takeover"]
    if (flag.parent === "migrate") return ["migrate", "--to", "postgres"]
    if (flag.parent === "init") return ["init", "example", "--global"]
    if (flag.flag === "max-concurrency") return ["up", "system/test", "--max-concurrency", "4"]
    return ["up", "system/test", `--${flag.flag}`]
  }

  it.each(Unsupported.removedFlags.map((flag) => [`${flag.parent} --${flag.flag}`.trim(), flag] as const))(
    "`%s` fails with the migration message and exit status 1",
    async (_label, flag) => {
      const error = await failure(invocation(flag))

      expect(error).toBeInstanceOf(CliError.UnsupportedError)
      const message = (error as CliError.UnsupportedError).message
      // `--backend` is the one entry whose refusal is the database contract's
      // own error code rather than the removal sentence, because
      // `--backend sqlite` is accepted (rc-contract section 2).
      expect(message).toContain(flag.flag === "backend" ? "unsupported_database" : "was removed in 1.0.0-rc.0")
      expect(message).toContain(`${Unsupported.migrationUrl}#${flag.anchor}`)
      expect(CliError.exitCode(error as CliError.UnsupportedError)).toBe(1)
    }
  )

  it("declares every removed flag on a command that ships, so none is a usage error", () => {
    const shipped = new Set(["", "up", "steer", "migrate", "init"])
    for (const flag of Unsupported.removedFlags) expect(shipped.has(flag.parent)).toBe(true)
  })

  it("refuses to look up a flag the contract does not list", () => {
    expect(() => Unsupported.findFlag("up", "invented")).toThrow(/No removed flag/)
  })
})

describe("the SQLite-only backend flag", () => {
  it("accepts `--backend sqlite` as a no-op", async () => {
    expect(await failure(["--backend", "sqlite", "ls"])).toBeUndefined()
  })

  it("refuses every other backend with unsupported_database", async () => {
    for (const backend of ["pglite", "postgres", "mysql"]) {
      const error = await failure(["--backend", backend, "ls"])

      expect((error as CliError.UnsupportedError).message).toContain("unsupported_database")
      expect((error as CliError.UnsupportedError).message).toContain(backend)
    }
  })
})
