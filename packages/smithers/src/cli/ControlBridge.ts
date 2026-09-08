/**
 * Adapts the existing Effect command handlers to the unified Incur surface.
 *
 * @since 1.0.0
 */
import { NodeServices } from "@effect/platform-node"
import * as Audience from "@smthrs/build-cli/Audience"
import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { ApprovalAuthority, Control } from "@smthrs/control"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import { Cause, Console, Effect, Exit, Layer, Logger, References, Stream } from "effect"
import { Command } from "effect/unstable/cli"
import { z } from "incur"
import { format } from "node:util"
import * as CliError from "../CliError.ts"
import { cli as legacyCli, doctorCli, migrationCli } from "../Command.ts"
import * as HistoryWorkspace from "../history/History.ts"
import * as CommandStatus from "../internal/CommandStatus.ts"
import * as NodeControl from "../NodeControl.ts"
import { layerTriggerScheduler } from "../operator/Triggers.ts"
import * as Project from "../Project.ts"
import * as Serve from "../Serve.ts"
import * as Ui from "../Ui.ts"
import { packageVersion } from "../Version.ts"
import * as Presentation from "./Presentation.ts"
import * as RunProgress from "./RunProgress.ts"

/**
 * Shared connection options for commands that reach the control plane.
 * @category schemas
 * @since 1.0.0
 */
export const connectionOptions = z.object({
  root: z.string().optional().describe("Project directory; defaults to the nearest Smithers project"),
  remote: z.string().optional().describe("Remote control plane URL; defaults to SMITHERS_REMOTE"),
  credential: z.string().optional().describe("Remote credential; defaults to SMITHERS_API_KEY"),
  mcpConfig: z.string().optional().describe("Path to the configured MCP servers"),
  quiet: z.boolean().default(false).describe("Suppress progress messages")
})

/**
 * Parsed control-plane connection options.
 * @category models
 * @since 1.0.0
 */
export type ConnectionOptions = z.output<typeof connectionOptions>

/**
 * Host inputs used while invoking an adapted command.
 * @category models
 * @since 1.0.0
 */
export interface Runtime extends RuntimeConfig {
  /** Host-owned delegation for local commands and the served gateway, never a request argument. */
  readonly approvalAuthority?: ApprovalAuthority.Service | undefined
  readonly executionRoot?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly exit?: ((code: number) => void) | undefined
}

/**
 * Renders connection options as arguments for the Effect CLI.
 * @category constructors
 * @since 1.0.0
 */
export const connectionArguments = (options: ConnectionOptions): Array<string> => {
  const args: Array<string> = []
  for (
    const [flag, value] of [
      ["root", options.root],
      ["remote", options.remote],
      ["credential", options.credential],
      ["mcp-config", options.mcpConfig]
    ] as const
  ) {
    if (value !== undefined) args.push(`--${flag}`, value)
  }
  if (options.quiet) args.push("--quiet")
  return args
}

// The control plane an MCP session reaches, and the credential it presents,
// are host configuration. Honouring them as tool arguments would let any
// connected client aim the host's SMITHERS_API_KEY at a server it chose.
// Refuse the override rather than silently substituting the host destination,
// so a caller is never told it queried a plane it did not.
const hostConnection = (options: ConnectionOptions): ConnectionOptions => {
  if (Presentation.current()?.transport !== "mcp") return options
  for (const flag of ["remote", "credential"] as const) {
    if (options[flag] !== undefined) {
      throw new CliError.UsageError({
        message:
          `--${flag} is not accepted over MCP; the host selects the control plane with SMITHERS_REMOTE and SMITHERS_API_KEY`
      })
    }
  }
  return options
}

/**
 * Resolves transport and execution roots for an adapted command.
 * @category constructors
 * @since 1.0.0
 */
export const configuration = (options: ConnectionOptions, runtime: Runtime) => {
  const config = NodeControl.makeConfig(
    connectionArguments(hostConnection(options)),
    runtime.environment ?? process.env,
    process.cwd()
  )
  if (config.remote === undefined) Project.assertRoot(config.root ?? process.cwd())
  return {
    ...config,
    executionRoot: runtime.executionRoot,
    approvalAuthority: runtime.approvalAuthority,
    principal: Presentation.current()?.transport === "mcp" ? { id: "mcp", kind: "agent" as const } : undefined
  }
}

/**
 * Reuses the tested flow control handlers without starting a second process.
 * @category constructors
 * @since 1.0.0
 */
export const invoke = async (
  args: ReadonlyArray<string>,
  options: ConnectionOptions,
  runtime: Runtime = {}
): Promise<unknown> => {
  const session = Presentation.current()
  const policy = session?.policy ?? runtime.presentation ?? Audience.resolve({ env: runtime.environment })
  const display = options.quiet ? { ...policy, progress: "silent" as const, interactive: false } : policy
  const progressOutput = session?.stderr ?? process.stderr
  let config = configuration(options, runtime)
  if (config.remote === undefined && runtime.executionRoot === undefined) {
    let runId: string | undefined
    if (["resume", "cancel", "signal", "steer"].includes(args[0] ?? "")) runId = args[1]
    if (args[0] === "approve" || args[0] === "deny") {
      try {
        const input = JSON.parse(args[1] ?? "") as { target?: { _tag?: string; runId?: unknown } }
        if (input.target?._tag === "Node" && typeof input.target.runId === "string") runId = input.target.runId
      } catch { /* The existing approval decoder owns malformed-payload diagnostics. */ }
    }
    if (runId !== undefined) {
      config = { ...config, ...HistoryWorkspace.prepare(Project.root(config.root, process.cwd()), runId) }
    }
  }
  const values: Array<unknown> = []
  const outputConsole: Console.Console = Object.assign(Object.create(console), {
    error: (...items: ReadonlyArray<unknown>) => {
      if (args[0] === "bug") {
        // The bug handler emits its endpoint and already-redacted consent
        // document here. Preserve the exact report even under quiet output so
        // the operator can inspect everything a subsequent POST will send.
        progressOutput.write(`${format(...items)}\n`)
      } else if (display.progress !== "silent") progressOutput.write(`${RunProgress.text(format(...items), 500)}\n`)
    },
    log: (...items: ReadonlyArray<unknown>) => {
      for (const item of items) {
        if (typeof item !== "string") values.push(item)
        else {
          try {
            values.push(JSON.parse(item))
          } catch {
            values.push(item)
          }
        }
      }
    }
  })
  const commandArguments = [
    "--json",
    // Quiet suppresses progress, not the returned data. Silence the progress
    // sink without changing the handler's result projection.
    ...connectionArguments({ ...options, quiet: false }),
    ...args
  ]
  const command = args[0] === "migrate"
    ? Command.runWith(migrationCli, { version: packageVersion })(commandArguments).pipe(
      Effect.provide(
        Project.layer(
          config.root ?? process.cwd(),
          config.migrationRoot ?? Project.legacyRoot(undefined, config.root ?? process.cwd())
        )
      )
    )
    : args[0] === "doctor" && config.remote === undefined
    ? Command.runWith(doctorCli, { version: packageVersion })(commandArguments).pipe(
      Effect.provide([
        Project.layer(
          config.root ?? process.cwd(),
          config.migrationRoot ?? Project.legacyRoot(undefined, config.root ?? process.cwd())
        ),
        NodeControl.layerRegistry(config.root ?? process.cwd()),
        NodeControl.layerOutput
      ])
    )
    : Command.runWith(legacyCli, { version: packageVersion })(commandArguments).pipe(
      Effect.provide(NodeControl.layer(config))
    )
  const run = command.pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(Console.Console, outputConsole),
    Effect.provideService(CommandStatus.CommandStatus, (code) => runtime.exit?.(code)),
    Effect.provideService(RunProgress.Configuration, { policy: display, output: progressOutput }),
    Effect.provideService(References.MinimumLogLevel, display.progress === "silent" ? "Error" : "Info"),
    Effect.provideService(
      Ui.Ui,
      Ui.make({ output: progressOutput, input: process.stdin, interactive: display.interactive })
    ),
    Effect.provideService(Logger.LogToStderr, true),
    Effect.provide(RedactedLogger.layer())
  )
  const result = await Effect.runPromiseExit(run, { signal: runtime.signal })
  if (Exit.isFailure(result)) {
    const error = Cause.squash(result.cause)
    // These inspections deliberately render a complete report before failing.
    // Keep that document available to scripts, including on a nonzero exit.
    if (
      (args[0] === "doctor" || args[0] === "gc") && values.length > 0 &&
      typeof error === "object" && error !== null && "_tag" in error && error._tag === "/cli/UnsupportedError"
    ) runtime.exit?.(1)
    else throw error
  }
  return values.length === 1 ? values[0] : values
}

/**
 * Runs a control query against the same local or remote host as flow commands.
 * @category constructors
 * @since 1.0.0
 */
export const query = async <A, E>(
  operation: Effect.Effect<A, E, Control.Control>,
  options: ConnectionOptions,
  runtime: Runtime = {}
): Promise<A> => {
  const result = await Effect.runPromiseExit(
    operation.pipe(
      Effect.provide(NodeControl.layer(configuration(options, runtime))),
      Effect.provideService(Logger.LogToStderr, true),
      Effect.provideService(
        References.MinimumLogLevel,
        (Presentation.current()?.policy ?? runtime.presentation)?.progress === "silent" ? "Error" : "Info"
      ),
      Effect.provide(RedactedLogger.layer())
    ),
    { signal: runtime.signal }
  )
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
  return result.value
}

/**
 * A scoped stream closes its transports when the consumer stops following.
 * @category constructors
 * @since 1.0.0
 */
export const events = (
  runId: string,
  follow: boolean,
  options: ConnectionOptions,
  runtime: Runtime = {},
  afterSequence?: number
) => {
  const stream = Stream.unwrap(Effect.map(Control.Control, (control) =>
    control.watch({
      runId,
      follow,
      ...(afterSequence === undefined ? {} : { afterSequence })
    }))).pipe(Stream.provide(NodeControl.layer(configuration(options, runtime))))
  const signal = runtime.signal
  if (signal === undefined) return Stream.toAsyncIterable(stream)
  const interrupted = Effect.callback<void>((resume) => {
    const abort = () => resume(Effect.void)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })
  return Stream.toAsyncIterable(stream.pipe(Stream.interruptWhen(interrupted)))
}

/**
 * Serves the gateway and durable trigger scheduler on one shared local Control host.
 * @category constructors
 * @since 1.0.0
 */
export const host = async (bind: Serve.Bind, options: ConnectionOptions, runtime: Runtime = {}): Promise<void> => {
  const config = configuration(options, runtime)
  if (config.remote !== undefined) {
    throw new Error("serve must run on the host owning the project; --remote is not supported")
  }
  const refusal = Serve.refuse(bind)
  if (refusal !== undefined) throw refusal
  // A gateway credential authenticates callers; only the host may delegate
  // approval authority. Do not inherit NodeControl's credential-based default.
  const control = NodeControl.layer({
    ...config,
    approvalAuthority: config.approvalAuthority ?? ApprovalAuthority.local
  })
  const root = Project.root(config.root, process.cwd())
  const host = Layer.merge(control, layerTriggerScheduler(root).pipe(Layer.provide(control)))
  if (!options.quiet) process.stderr.write(`${Serve.banner(bind)}\n`)
  const result = await Effect.runPromiseExit(
    Serve.host(bind, root).pipe(
      Effect.provide(host),
      Effect.provide(RedactedLogger.layer()),
      Effect.provideService(Logger.LogToStderr, true)
    ),
    { signal: runtime.signal }
  )
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
}
