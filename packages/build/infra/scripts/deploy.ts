import { type ChildProcess, spawn } from "node:child_process"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { failureMessage } from "./failure-message.ts"
import { redactAlchemyState } from "./redact-state.ts"

const infraDirectory = NodePath.dirname(NodePath.dirname(fileURLToPath(import.meta.url)))
const alchemyCli = NodePath.join(infraDirectory, "node_modules", "alchemy", "bin", "cli.js")
const terminationSignals = ["SIGHUP", "SIGINT", "SIGTERM"] as const
const escalationDelayMs = 10_000

/** How the Alchemy command ended, as the exit code the wrapper reports for it. */
type CommandResult = { readonly exitCode: number }

const signalExitCode = (signal: NodeJS.Signals): number => {
  switch (signal) {
    case "SIGHUP":
      return 129
    case "SIGINT":
      return 130
    case "SIGTERM":
      return 143
    default:
      return 1
  }
}

const terminateProcessTree = (child: ChildProcess, signal: NodeJS.Signals): void => {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The command may already have exited between the close check and kill.
    }
  }
}

/**
 * Substitutions for the process the wrapper drives.
 *
 * Every field defaults to the production deployment. Naming them keeps the
 * wrapper's own guarantees testable without deploying anything: signal
 * forwarding, escalation, and redaction on every exit path.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeployOptions {
  readonly cli?: string | undefined
  readonly cwd?: string | undefined
  readonly redact?: (() => Promise<number>) | undefined
  readonly escalationDelayMs?: number | undefined
}

/**
 * {@link DeployOptions} with every omission filled in.
 *
 * @category models
 * @since 0.1.0
 */
export interface ResolvedDeployOptions {
  readonly cli: string
  readonly cwd: string
  readonly redact: () => Promise<number>
  readonly escalationDelayMs: number
}

/**
 * Fills every omitted substitution from the production deployment: the pinned
 * Alchemy CLI, this directory, and real state redaction.
 *
 * @category constructors
 * @since 0.1.0
 */
export const resolveDeployOptions = (options: DeployOptions): ResolvedDeployOptions => ({
  cli: options.cli ?? alchemyCli,
  cwd: options.cwd ?? infraDirectory,
  redact: options.redact ?? redactAlchemyState,
  escalationDelayMs: options.escalationDelayMs ?? escalationDelayMs
})

const runAlchemy = (
  command: { readonly cli: string; readonly cwd: string },
  args: ReadonlyArray<string>,
  onSpawn: (child: ChildProcess) => void,
  onFinish: (child: ChildProcess) => void
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(process.execPath, [command.cli, "deploy", "alchemy.run.ts", ...args], {
        cwd: command.cwd,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: "inherit"
      })
    } catch (error) {
      reject(error)
      return
    }
    let finished = false
    const finish = (complete: () => void): void => {
      if (finished) return
      finished = true
      onFinish(child)
      complete()
    }
    onSpawn(child)
    child.once("error", (error) => finish(() => reject(error)))
    child.once("close", (code, signal) =>
      finish(() =>
        resolve({
          /* v8 ignore next -- Node reports a code or a signal on close, never neither, so the fallback is unreachable */
          exitCode: signal !== null ? signalExitCode(signal) : code ?? 1
        })
      ))
  })

/**
 * Runs Alchemy and always scrubs legacy local state before returning.
 *
 * Termination signals are held while cleanup runs and are forwarded to the
 * complete detached Alchemy process group. A command that ignores the first
 * signal is killed after a bounded grace period.
 *
 * @category commands
 * @since 0.1.0
 */
export const deploy = async (
  args: ReadonlyArray<string> = process.argv.slice(2),
  options: DeployOptions = {}
): Promise<number> => {
  const { cli, cwd, escalationDelayMs: escalationDelay, redact } = resolveDeployOptions(options)
  const target = { cli, cwd }
  let activeChild: ChildProcess | undefined
  let requestedSignal: NodeJS.Signals | undefined
  let escalationTimer: ReturnType<typeof setTimeout> | undefined

  const clearEscalation = (): void => {
    if (escalationTimer !== undefined) clearTimeout(escalationTimer)
    escalationTimer = undefined
  }
  const forward = (signal: NodeJS.Signals): void => {
    const child = activeChild
    if (child === undefined) return
    terminateProcessTree(child, signal)
    if (signal !== "SIGKILL") {
      clearEscalation()
      escalationTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), escalationDelay)
      escalationTimer.unref()
    }
  }
  const handlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of terminationSignals) {
    const handler = (): void => {
      if (requestedSignal === undefined) {
        requestedSignal = signal
        forward(signal)
      } else {
        forward("SIGKILL")
      }
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }

  let command: CommandResult | undefined
  let commandFailure: unknown
  let redactionFailure: unknown
  try {
    try {
      // The handlers above are installed and the child is spawned in the
      // same synchronous run, so no signal can arrive before `onSpawn`, and
      // one wrapper drives one child, so `onFinish` always ends the active one.
      command = await runAlchemy(
        target,
        args,
        (child) => {
          activeChild = child
        },
        () => {
          activeChild = undefined
          clearEscalation()
        }
      )
    } catch (error) {
      commandFailure = error
    }

    try {
      const redactedFiles = await redact()
      process.stdout.write(`Redacted ${redactedFiles} Alchemy Worker state file(s).\n`)
    } catch (error) {
      redactionFailure = error
    }
  } finally {
    clearEscalation()
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }

  if (commandFailure !== undefined) {
    process.stderr.write(`Alchemy deployment failed: ${failureMessage(commandFailure)}\n`)
  }
  if (redactionFailure !== undefined) {
    process.stderr.write(`Alchemy state redaction failed: ${failureMessage(redactionFailure)}\n`)
  }
  if (command === undefined || redactionFailure !== undefined) return 1
  if (requestedSignal !== undefined) return signalExitCode(requestedSignal)
  return command.exitCode
}

const invokedPath = process.argv[1]
/* v8 ignore next 3 -- the process entry runs the pinned Alchemy CLI against the operator's own state; the suite drives every wrapper path through `deploy` with substitutes instead */
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await deploy()
}
