#!/usr/bin/env node
/**
 * The `smithers` executable. It builds the CLI application, runs it on the Node
 * runtime, and maps a failed exit to a process exit code.
 *
 * @since 0.1.0
 */
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Exit, Runtime } from "effect"
import { CliError as EffectCliError, Command } from "effect/unstable/cli"
import * as CliError from "./CliError.ts"
import { cli } from "./Command.ts"
import * as McpServer from "./McpServer.ts"
import * as NodeControl from "./NodeControl.ts"
import * as Verb from "./Verb.ts"
import { packageVersion } from "./Version.ts"

let signalExitCode: 130 | 143 | undefined

const onSigint = () => {
  signalExitCode = 130
}

const onSigterm = () => {
  signalExitCode = 143
}

process.once("SIGINT", onSigint)
process.once("SIGTERM", onSigterm)

/**
 * A CLI failure is a sentence for the operator, on stderr.
 *
 * Effect's default error reporting logs the cause through the runtime logger,
 * which writes to STDOUT with a timestamp and a stack. For a command-line tool
 * that is two bugs at once: a script reading `--json` gets a log line in its
 * document, and an operator gets a stack trace where the contract promised a
 * migration message. Reporting is therefore disabled below and the message is
 * written here instead.
 */
const report = (error: unknown): void => {
  const message = error instanceof CliError.UsageError || error instanceof CliError.UnsupportedError
    ? error.message
    : error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error)
  process.stderr.write(`${message}\n`)
}

const teardown: Runtime.Teardown = (exit, onExit) => {
  process.removeListener("SIGINT", onSigint)
  process.removeListener("SIGTERM", onSigterm)

  if (signalExitCode !== undefined) {
    onExit(signalExitCode)
    return
  }
  if (Exit.isSuccess(exit)) {
    onExit(typeof process.exitCode === "number" ? process.exitCode : Number(process.exitCode ?? 0))
    return
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    onExit(130)
    return
  }

  const error = Cause.squash(exit.cause)
  if (EffectCliError.isCliError(error)) {
    // `effect/unstable/cli` renders its own help and usage output; only the
    // status is this module's to decide.
    onExit(error._tag === "ShowHelp" && error.errors.length === 0 ? 0 : 2)
    return
  }
  report(error)
  if (error instanceof CliError.UsageError || error instanceof CliError.UnsupportedError) {
    onExit(CliError.exitCode(error))
    return
  }
  onExit(Runtime.getErrorExitCode(error))
}

const main = Effect.gen(function*() {
  const applicationConfig = yield* NodeControl.config
  const argv = process.argv.slice(2)
  // `--mcp` is a mode, not a verb: every MCP client configures a launch
  // command, so the flag has to be readable before the command tree parses
  // anything. The server then talks to the same Control layer the verbs do.
  if (McpServer.requested(argv)) {
    return yield* McpServer.serve({
      ...McpServer.optionsFromArguments(argv),
      verbs: Verb.shipped,
      version: packageVersion
    }).pipe(Effect.provide(NodeControl.layer(applicationConfig)))
  }
  yield* Command.run(cli, { version: packageVersion }).pipe(
    Effect.provide(NodeControl.layer(applicationConfig))
  )
})

NodeRuntime.runMain(main, { teardown, disableErrorReporting: true })
