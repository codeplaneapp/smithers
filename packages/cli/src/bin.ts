#!/usr/bin/env node
/**
 * The `flows` executable. It builds the CLI application, runs it on the Node
 * runtime, and maps a failed exit to a process exit code.
 *
 * @since 0.1.0
 */
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Exit, Runtime } from "effect"
import { CliError as EffectCliError, Command } from "effect/unstable/cli"
import * as CliError from "./CliError.ts"
import { cli } from "./Command.ts"
import * as NodeControl from "./NodeControl.ts"
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
    onExit(error._tag === "ShowHelp" && error.errors.length === 0 ? 0 : 2)
    return
  }
  if (error instanceof CliError.UsageError || error instanceof CliError.UnsupportedError) {
    onExit(CliError.exitCode(error))
    return
  }
  onExit(Runtime.getErrorExitCode(error))
}

const main = Effect.gen(function*() {
  const applicationConfig = yield* NodeControl.config
  yield* Command.run(cli, { version: packageVersion }).pipe(
    Effect.provide(NodeControl.layer(applicationConfig))
  )
})

NodeRuntime.runMain(main, { teardown })
