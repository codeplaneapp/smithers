#!/usr/bin/env node
/**
 * The `smithers` executable. It builds the CLI application, runs it on the Node
 * runtime, and maps a failed exit to a process exit code.
 *
 * @since 0.1.0
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Cause, Effect, Exit, Logger, Runtime } from "effect"
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
 * The name an operator reads for a failure.
 *
 * Every `@smthrs/control` failure is a `Schema.TaggedError` whose `_tag` is a
 * namespaced path, and Effect uses that whole path as the error's `name`. The
 * operator wants the class, not the namespace it lives in, so the last segment
 * is what this prints: `NoMatchingWait`, not `/control/NoMatchingWait`.
 */
const errorName = (error: Error): string => {
  const tag = (error as { readonly _tag?: unknown })._tag
  return typeof tag === "string" && tag.length > 0 ? tag.slice(tag.lastIndexOf("/") + 1) : error.name
}

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
    // A refused database open is a defect by design: `NodeDatabase.layer` keeps
    // the `never` error channel eleven packages compose against, so the refusal
    // arrives here rather than as a typed failure. Render it by its contract
    // code, which is what rc-contract section 2 promises an operator and what a
    // script greps for; the tagged-error name is an implementation detail of
    // how the value travelled.
    : NodeDatabase.isUnsupportedDatabase(error)
    ? `${error.code}: ${error.message}`
    : error instanceof Error
    ? `${errorName(error)}: ${error.message}`
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

/**
 * Whether this invocation only asks the CLI to describe itself.
 *
 * `--version` and `--help` are documents. They need the command tree and
 * nothing else, so they must not resolve a project, scan its flows, or open a
 * database — work that took more than ten minutes in the Phase 7 smoke when
 * the invocation directory held no project marker, the root walk climbed to
 * `$HOME`, and discovery scanned the operator's whole home tree.
 *
 * The scan stops at the first flag that is not one of the two: every other
 * flag may take a value, and a value spelled `--help` is a value, not a
 * request for the help document. Missing a document invocation here only
 * costs the old startup; misreading a value as one would run a handler with
 * no services behind it.
 */
const documentRequested = (args: ReadonlyArray<string>): boolean => {
  for (const argument of args) {
    if (!argument.startsWith("-")) continue
    return argument === "--help" || argument === "--version"
  }
  return false
}

const main = Effect.gen(function*() {
  const argv = process.argv.slice(2)
  if (documentRequested(argv)) {
    // `effect/unstable/cli` renders the document and fails with `ShowHelp`
    // before any handler runs, so the durable services the handlers declare
    // are never requested. Discharging them by type is what keeps the
    // document off the project, the registry, and the databases.
    return yield* (Command.run(cli, { version: packageVersion }).pipe(
      Effect.provide(NodeServices.layer)
    ) as Effect.Effect<void, EffectCliError.CliError>)
  }
  const applicationConfig = yield* NodeControl.config
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

/**
 * Diagnostics go to stderr, so stdout carries only the document.
 *
 * `report` above already keeps CLI failures off stdout, but the runtime logger
 * is the other writer. A run's own lifecycle warnings, `An agent run failed`
 * and its rendered cause, are logged by `@smthrs/agent` through the default
 * logger, which calls `console.log`. Under `--json` that put forty lines of
 * warning inside the one document an attached launch prints, so a pipeline
 * step parsing `smithers up <flow> --json` read a syntax error instead of the
 * receipt it was promised (rc-contract section 4, the `up` row). `LogToStderr`
 * is the reference Effect provides for exactly this: keep stdout for protocol
 * output and send every built-in logger to `console.error`.
 */
NodeRuntime.runMain(Effect.provideService(main, Logger.LogToStderr, true), {
  teardown,
  disableErrorReporting: true
})
