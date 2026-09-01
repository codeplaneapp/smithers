/**
 * Builds an AWS Fargate sandbox provider.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { Scope } from "effect/Scope"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { decodeBase64, encodeBase64 } from "../internal/base64.ts"
import { checkEnvironmentNames } from "../internal/environmentNames.ts"
import { killScript } from "../internal/killScript.ts"
import { gather, type GatheredRun, providerFailure } from "../internal/localProcess.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { stdinRedirect } from "../internal/stdinRedirect.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { ExecTransport } from "./ExecTransport.ts"
import type { Sdk } from "./Sdk.ts"

interface CommonOptions {
  readonly sdk: Sdk
  /**
   * How commands reach the task. Without it the provider provisions and tears
   * down tasks but refuses to run anything in them, because the ECS API alone
   * cannot; see {@link ExecTransport}.
   */
  readonly exec?: ExecTransport | undefined
  readonly region: string
  readonly cluster: string
  readonly subnets: ReadonlyArray<string>
  readonly securityGroups?: ReadonlyArray<string> | undefined
  readonly assignPublicIp?: boolean | undefined
  readonly container?: string | undefined
  readonly workdir?: string | undefined
  readonly platformVersion?: string | undefined
  readonly taskRoleArn?: string | undefined
  readonly executionRoleArn?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly pollIntervalMs?: number | undefined
  readonly maxPollAttempts?: number | undefined
}

interface TaskDefinitionOptions extends CommonOptions {
  readonly taskDefinition: string
  readonly image?: never
}

interface ImageOptions extends CommonOptions {
  readonly image: string
  readonly taskDefinition?: never
  readonly taskRoleArn: string
  readonly cpu?: string | undefined
  readonly memory?: string | undefined
}

type Options = TaskDefinitionOptions | ImageOptions

type RunTaskOutput = Awaited<ReturnType<Sdk["runTask"]>>
type DescribeTasksOutput = Awaited<ReturnType<Sdk["describeTasks"]>>
type Task = NonNullable<DescribeTasksOutput["tasks"]>[number]
type RegisterTaskDefinitionOutput = Awaited<ReturnType<Sdk["registerTaskDefinition"]>>

const failure = (code: ProviderError["code"], message: string, cause?: unknown): ProviderError =>
  new ProviderError({ code, message: `aws sandbox: ${message}`, cause })

const attempt = <A>(thunk: () => Promise<A>, code: ProviderError["code"], message: string) =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => failure(code, message, cause)
  })

const startedByOf = (session: string): string => {
  const slug = sessionSlug(session).replaceAll(/[^A-Za-z0-9/_-]/g, "-")
  if (slug.length <= 36) return slug
  const separator = slug.lastIndexOf("-")
  const digest = slug.slice(separator + 1)
  return `${slug.slice(0, 35 - digest.length)}-${digest}`
}

const taskArnsOf = (output: RunTaskOutput): ReadonlyArray<string> =>
  (output.tasks ?? []).flatMap((task) => task.taskArn === undefined ? [] : [task.taskArn])

const stopTasks = (options: Options, taskArns: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.ignore(
    Effect.forEach(
      taskArns,
      (task) =>
        attempt(
          () => options.sdk.stopTask({ cluster: options.cluster, task, reason: "Smithers scope released" }),
          "unknown",
          `could not stop ${task}`
        ),
      { discard: true }
    ),
    { log: "Warn" }
  )

/**
 * The task a previous acquire of this session key left running, if any.
 *
 * `RunTask` tags every task with `startedBy`, which is derived from the key,
 * so a crash-interrupted run can find its machine again instead of starting a
 * second one beside it. Only a task whose ECS Exec agent is already ready is
 * adopted: a task still provisioning belongs to whatever is still driving it,
 * and a stopped one is not a machine.
 */
const leftoverTask = (
  options: Options,
  startedBy: string,
  container: string | undefined
): Effect.Effect<string | undefined, ProviderError> =>
  Effect.gen(function*() {
    const listed = yield* attempt(
      () => options.sdk.listTasks({ cluster: options.cluster, startedBy, desiredStatus: "RUNNING" }),
      "unavailable",
      `could not list tasks started by ${startedBy}`
    )
    const arns = listed.taskArns ?? []
    if (arns.length === 0) return undefined
    const described = yield* attempt(
      () => options.sdk.describeTasks({ cluster: options.cluster, tasks: [...arns] }),
      "unavailable",
      `could not describe the tasks started by ${startedBy}`
    )
    return described.tasks?.find((task) => agentReady(task, container))?.taskArn
  })

const registeredArnOf = (output: RegisterTaskDefinitionOutput): string | undefined =>
  output.taskDefinition?.taskDefinitionArn

const deregisterDefinition = (
  options: ImageOptions,
  output: RegisterTaskDefinitionOutput
): Effect.Effect<void> => {
  const taskDefinition = registeredArnOf(output)
  return taskDefinition === undefined
    ? Effect.void
    : Effect.ignore(
      attempt(
        () => options.sdk.deregisterTaskDefinition({ taskDefinition }),
        "unknown",
        `could not deregister ${taskDefinition}`
      ),
      { log: "Warn" }
    )
}

const agentReady = (task: Task, container: string | undefined): boolean =>
  task.lastStatus === "RUNNING" &&
  task.enableExecuteCommand === true &&
  (task.containers ?? []).some((candidate) =>
    (container === undefined || candidate.name === container) &&
    (candidate.managedAgents ?? []).some((agent) =>
      agent.name === "ExecuteCommandAgent" && agent.lastStatus === "RUNNING"
    )
  )

const describedTask = (output: DescribeTasksOutput, taskArn: string): Task | undefined =>
  output.tasks?.find((task) => task.taskArn === taskArn) ?? output.tasks?.[0]

const describe = (
  options: Options,
  taskArn: string
): Effect.Effect<DescribeTasksOutput, ProviderError> =>
  attempt(
    () => options.sdk.describeTasks({ cluster: options.cluster, tasks: [taskArn] }),
    "unavailable",
    `could not describe ${taskArn}`
  )

const awaitReady = (
  options: Options,
  taskArn: string,
  container: string | undefined
): Effect.Effect<Task, ProviderError> => {
  const interval = options.pollIntervalMs ?? 1_000
  const attempts = options.maxPollAttempts ?? 60

  const poll = (index: number): Effect.Effect<Task, ProviderError> =>
    Effect.flatMap(describe(options, taskArn), (output) => {
      const task = describedTask(output, taskArn)
      if (task?.lastStatus === "STOPPED") {
        return Effect.fail(failure("unavailable", `${taskArn} stopped before ECS Exec became ready`, task))
      }
      if (task !== undefined && agentReady(task, container)) return Effect.succeed(task)
      if (index + 1 >= attempts) {
        return Effect.fail(failure("timeout", `${taskArn} did not make its ECS Exec agent ready`, output.failures))
      }
      const delay = Math.min(interval * (2 ** index), 10_000)
      return Effect.andThen(Effect.sleep(Duration.millis(delay)), poll(index + 1))
    })

  return poll(0)
}

const registerDefinition = (
  options: ImageOptions,
  startedBy: string,
  workdir: string,
  container: string
): Effect.Effect<string, ProviderError, Scope> =>
  Effect.gen(function*() {
    const output = yield* Effect.acquireRelease(
      attempt(
        () =>
          options.sdk.registerTaskDefinition({
            family: `smthrs-${startedBy}`,
            networkMode: "awsvpc",
            requiresCompatibilities: ["FARGATE"],
            cpu: options.cpu ?? "256",
            memory: options.memory ?? "512",
            taskRoleArn: options.taskRoleArn,
            ...options.executionRoleArn === undefined ? {} : { executionRoleArn: options.executionRoleArn },
            containerDefinitions: [{
              name: container,
              image: options.image,
              essential: true,
              command: ["sleep", "infinity"],
              workingDirectory: workdir,
              linuxParameters: { initProcessEnabled: true }
            }]
          }),
        "unavailable",
        `could not register ${options.image}`
      ),
      (output) => deregisterDefinition(options, output)
    )
    const taskDefinition = registeredArnOf(output)
    return taskDefinition === undefined
      ? yield* Effect.fail(failure("unavailable", "RegisterTaskDefinition returned no task definition ARN", output))
      : taskDefinition
  })

const runTask = (
  options: Options,
  taskDefinition: string,
  startedBy: string,
  container: string | undefined
): Effect.Effect<RunTaskOutput, ProviderError> => {
  const roleOverrides = {
    ...options.taskRoleArn === undefined ? {} : { taskRoleArn: options.taskRoleArn },
    ...options.executionRoleArn === undefined ? {} : { executionRoleArn: options.executionRoleArn },
    ...container === undefined || options.env === undefined
      ? {}
      : {
        containerOverrides: [{
          name: container,
          environment: Object.entries(options.env).map(([name, value]) => ({ name, value }))
        }]
      }
  }
  return attempt(
    () =>
      options.sdk.runTask({
        cluster: options.cluster,
        taskDefinition,
        count: 1,
        enableExecuteCommand: true,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: [...options.subnets],
            ...options.securityGroups === undefined ? {} : { securityGroups: [...options.securityGroups] },
            assignPublicIp: options.assignPublicIp === true ? "ENABLED" : "DISABLED"
          }
        },
        startedBy,
        ...options.platformVersion === undefined ? {} : { platformVersion: options.platformVersion },
        ...Object.keys(roleOverrides).length === 0 ? {} : { overrides: roleOverrides }
      }),
    "unavailable",
    `RunTask failed for ${taskDefinition}`
  )
}

const noTransport = (operation: string): ProviderError =>
  failure(
    "unavailable",
    `cannot ${operation}: no command transport was supplied, and the ECS API alone carries no command output; pass \`exec\` (the AWS CLI over a spawner)`
  )

/** The session-private guest directory spawned commands record their pids in. */
const pidDirectory = "/tmp/.smthrs-sbx"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const parentOf = (path: string): string | undefined => {
  const separator = path.lastIndexOf("/")
  return separator > 0 ? path.slice(0, separator) : undefined
}

/**
 * The line a wrapped command prints after it ends, carrying its exit status.
 *
 * `session-manager-plugin` exits zero whatever the remote command did, so the
 * status has to travel in-band. The nonce keeps a command that happens to
 * print a sentinel of its own from being mistaken for the wrapper's.
 */
const sentinel = (nonce: number): string => `__smthrs_exit_${nonce}_`

/**
 * What the transport handed back once the plugin's own framing is removed.
 * `code` is absent when the session ended without the wrapper's sentinel: the
 * remote shell died or the session dropped, and neither is a success.
 */
interface Unframed {
  readonly payload: string
  readonly code: number | undefined
}

/**
 * Strips the Session Manager banner and footer and reads the sentinel back.
 *
 * The session is a pseudo-terminal, so the plugin prints its own
 * `Starting session with SessionId` line before the command's output and an
 * `Exiting session` line after, and every newline arrives as `\r\n`. The
 * command's output is what lies between the banner and the sentinel.
 */
const unframe = (run: GatheredRun, nonce: number): Unframed => {
  const text = decoder.decode(run.stdout).replaceAll("\r\n", "\n")
  const banner = text.match(/^Starting session with SessionId: .*$/m)
  const start = banner === null || banner.index === undefined
    ? 0
    : banner.index + banner[0].length + 1
  const marker = new RegExp(`\\n${sentinel(nonce)}(\\d+)__`, "g")
  let last: RegExpExecArray | null = null
  for (let match = marker.exec(text); match !== null; match = marker.exec(text)) last = match
  if (last === null) return { payload: text.slice(Math.min(start, text.length)), code: undefined }
  return {
    payload: text.slice(Math.min(start, last.index), last.index),
    code: Number.parseInt(last[1]!, 10)
  }
}

/**
 * Renders the spawn environment as shell assignments.
 *
 * `export` is a POSIX special builtin: a name it refuses ends the whole
 * non-interactive script, taking the sentinel this transport frames its exit
 * status with. `spawn` refuses such a name before building the script, so
 * every name that reaches here is one `export` accepts.
 */
const exportsOf = (env: Readonly<Record<string, string | undefined>> | undefined): string =>
  Object.entries(env ?? {})
    .flatMap(([name, value]) => value === undefined ? [] : [`export ${CommandLine.quote(`${name}=${value}`)}; `])
    .join("")

/**
 * Wraps a one-shot guest script so its status comes back in-band. The
 * subshell keeps an `exit` inside the script from skipping the sentinel.
 */
const framedScript = (script: string, nonce: number): string =>
  `sh -c ${CommandLine.quote(`( ${script} ); printf '\\n${sentinel(nonce)}%s__\\n' "$?"`)}`

/**
 * Wraps a spawned command so it can be signalled and still report its status.
 *
 * The command runs as a background job whose pid is recorded for `kill`, and
 * the wrapper waits for it, so a signal delivered to the command lets the
 * wrapper print `128 + signal` rather than taking the sentinel down with it.
 * A `cd` that fails reports 127 the way a shell reports a command it could
 * not start.
 */
const spawnScript = (
  command: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  pidfile: string,
  nonce: number
): string =>
  `sh -c ${
    CommandLine.quote(
      `if cd ${CommandLine.quote(cwd)}; then ${exportsOf(env)}sh -c ${CommandLine.quote(command)} & p=$!; ` +
        `echo "$p" > ${pidfile}; wait "$p"; c=$?; else c=127; fi; printf '\\n${sentinel(nonce)}%s__\\n' "$c"`
    )
  }`

/**
 * Builds a Fargate provider using an injected AWS ECS aggregate client.
 *
 * Acquisition uses `RunTask`, polls `DescribeTasks` until the ECS Exec managed
 * agent is ready, and registers `StopTask` on the acquiring scope. Supplying
 * an image registers a minimal Fargate task definition and deregisters it after
 * the task finalizer runs.
 *
 * Commands, reads, and writes travel through {@link ExecTransport}: the AWS
 * CLI and its Session Manager plugin over an injected spawner, because the ECS
 * API returns SSM session metadata and nothing more. Reads come back as
 * base64 and writes go in as base64 in bounded slices, so bytes survive the
 * pseudo-terminal in both directions; `kill` records each command's guest pid
 * and signals it through a second session. Without a transport the session
 * refuses `spawn`, `readFile`, and `writeFile` explicitly rather than
 * fabricating a process or corrupting bytes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Provider => ({
  acquire: (sessionKey) =>
    Effect.gen(function*() {
      const workdir = options.workdir ?? "/workspace"
      const startedBy = startedByOf(sessionKey)
      const generatedContainer = options.container ?? "sandbox"
      let imageOptions: ImageOptions | undefined
      let taskDefinition: string
      if (options.taskDefinition === undefined) {
        imageOptions = options
        taskDefinition = yield* registerDefinition(options, startedBy, workdir, generatedContainer)
      } else {
        imageOptions = undefined
        taskDefinition = options.taskDefinition
      }
      const container = options.container ?? (imageOptions === undefined ? undefined : generatedContainer)
      // Reattach before provisioning: the same key names the same machine
      // wherever one is still running. An adopted task is released the same
      // way a fresh one is, so closing the scope always leaves nothing behind.
      const leftover = yield* leftoverTask(options, startedBy, container)
      const taskArn = leftover !== undefined
        ? yield* Effect.acquireRelease(Effect.succeed(leftover), (arn) => stopTasks(options, [arn]))
        : yield* Effect.gen(function*() {
          const output = yield* Effect.acquireRelease(
            runTask(options, taskDefinition, startedBy, container),
            (output) => stopTasks(options, taskArnsOf(output))
          )
          const started = taskArnsOf(output)[0]
          if (started === undefined) {
            return yield* Effect.fail(failure("unavailable", "RunTask returned no task ARN", output.failures))
          }
          yield* awaitReady(options, started, container)
          return started
        })
      const ping = Effect.flatMap(describe(options, taskArn), (description) => {
        const task = describedTask(description, taskArn)
        return task !== undefined && agentReady(task, container)
          ? Effect.void
          : Effect.fail(failure("unavailable", `${taskArn} is not ready`, description.failures))
      })

      const transport = options.exec
      if (transport === undefined) {
        const session: Session = {
          id: sessionKey,
          remoteId: taskArn,
          workdir,
          spawn: () => Effect.fail(noTransport("spawn a command")),
          readFile: (path) => Effect.fail(noTransport(`read ${path}`)),
          writeFile: (path) => Effect.fail(noTransport(`write ${path}`)),
          ping
        }
        return session
      }

      const program = transport.program ?? "aws"
      const chunkBytes = transport.chunkBytes ?? 3072
      const cli = (remote: string): ChildProcess.Command =>
        ChildProcess.make(program, [
          ...transport.globalArgs ?? [],
          "--region",
          options.region,
          "ecs",
          "execute-command",
          "--cluster",
          options.cluster,
          "--task",
          taskArn,
          ...container === undefined ? [] : ["--container", container],
          "--interactive",
          "--command",
          remote
        ])
      const transportFailure = (run: GatheredRun): ProviderError =>
        failure("unavailable", `\`${program} ecs execute-command\` exited ${run.code}: ${run.stderr.trim()}`)
      // One-shot guest scripts: reads, writes, kills, and the workspace
      // preparation. Each opens its own session and reports its own status.
      let nextNonce = 0
      const run = (script: string): Effect.Effect<Unframed, ProviderError> =>
        Effect.scoped(
          Effect.gen(function*() {
            const nonce = nextNonce++
            const handle = yield* transport.spawner.spawn(cli(framedScript(script, nonce))).pipe(
              Effect.mapError(providerFailure("spawn_error", `\`${program} ecs execute-command\` could not start`))
            )
            const gathered = yield* gather(handle, `${program} ecs execute-command`)
            if (gathered.code !== 0) return yield* Effect.fail(transportFailure(gathered))
            return unframe(gathered, nonce)
          })
        )
      const settled = (what: string, result: Unframed): Effect.Effect<Unframed, ProviderError> =>
        result.code === undefined
          ? Effect.fail(failure("aborted", `${what}: the session ended before the command reported its status`))
          : Effect.succeed(result)
      yield* Effect.flatMap(
        run(`mkdir -p ${CommandLine.quote(workdir)} && rm -rf ${pidDirectory} && mkdir -p ${pidDirectory}`),
        (result) =>
          result.code === 0 ? Effect.void : Effect.fail(
            failure(
              "unavailable",
              `the workspace ${workdir} could not be prepared in ${taskArn}: ${result.payload.trim()}`
            )
          )
      )

      const writeFile: Session["writeFile"] = (path, content) =>
        Effect.gen(function*() {
          const target = CommandLine.quote(path)
          const parent = parentOf(path)
          const prepare = parent === undefined ? "" : `mkdir -p ${CommandLine.quote(parent)} && `
          const slices: Array<string> = []
          for (let offset = 0; offset < content.length; offset += chunkBytes) {
            slices.push(encodeBase64(content.slice(offset, offset + chunkBytes)))
          }
          const scripts = slices.length === 0
            ? [`${prepare}: > ${target}`]
            : slices.map((slice, index) =>
              `${index === 0 ? prepare : ""}printf %s ${CommandLine.quote(slice)} | base64 -d ${
                index === 0 ? ">" : ">>"
              } ${target}`
            )
          for (const script of scripts) {
            const result = yield* Effect.flatMap(run(script), (result) => settled(`writing ${path}`, result))
            if (result.code !== 0) {
              return yield* Effect.fail(failure("unknown", `could not write ${path}: ${result.payload.trim()}`))
            }
          }
        })
      // The session is a pseudo-terminal with no input channel of its own, so
      // standard input is staged as a workspace file and redirected.
      const redirect = stdinRedirect({ workdir, writeFile })
      const resolveCwd = (cwd: string | undefined): string =>
        cwd === undefined || cwd.startsWith("/")
          ? cwd ?? workdir
          : `${workdir}/${cwd.replace(/^(\.\/)+/, "")}`.replace(/\/\.?$/, "")
      const kill = (pidfile: string, signal: string): Effect.Effect<void, ProviderError> =>
        Effect.asVoid(
          Effect.flatMap(
            run(killScript(pidfile, signal.replace(/^SIG/, ""))),
            (result) => settled(`signalling with ${signal}`, result)
          )
        )

      const pidfiles = new WeakMap<RemoteProcess, string>()
      const session: Session = {
        id: sessionKey,
        remoteId: taskArn,
        workdir,
        spawn: Effect.fnUntraced(function*(command, spawnOptions) {
          yield* checkEnvironmentNames(spawnOptions.env)
          const nonce = nextNonce++
          const pidfile = `${pidDirectory}/${nonce}.pid`
          const fed = yield* redirect(command, spawnOptions.stdin)
          const remote = spawnScript(fed, resolveCwd(spawnOptions.cwd), spawnOptions.env, pidfile, nonce)
          const handle = yield* transport.spawner.spawn(cli(remote)).pipe(
            Effect.mapError(providerFailure("spawn_error", `\`${command}\` could not start in ${taskArn}`))
          )
          // The session's whole output is needed before any of it can be
          // read back (the banner leads and the sentinel trails), so the
          // three pieces of the process share one gathering of the local
          // client, taken when the first of them is consumed.
          const gathered = yield* Effect.cached(
            Effect.flatMap(
              gather(handle, `${program} ecs execute-command`),
              (result) =>
                result.code === 0 ? Effect.succeed(unframe(result, nonce)) : Effect.fail(transportFailure(result))
            )
          )
          // Closing the process scope ends the local client, which the guest
          // does not notice. The contract says the scope IS the process's
          // lifetime, so the finalizer signals the guest side too, unless the
          // command has already been seen to end.
          let ended = false
          const observed = Effect.tap(gathered, () =>
            Effect.sync(() => {
              ended = true
            }))
          yield* Effect.addFinalizer(() =>
            ended ? Effect.void : Effect.ignore(kill(pidfile, "SIGTERM"), { log: "Warn" })
          )
          const process: RemoteProcess = {
            stdout: Stream.unwrap(
              Effect.map(
                observed,
                (result) => result.payload.length === 0 ? Stream.empty : Stream.make(encoder.encode(result.payload))
              )
            ),
            // The pseudo-terminal merges standard error into standard output.
            stderr: Stream.empty,
            exitCode: Effect.flatMap(observed, (result) =>
              result.code === undefined
                ? Effect.fail(failure("aborted", `\`${command}\` ended without reporting its status`))
                : Effect.succeed(result.code))
          }
          pidfiles.set(process, pidfile)
          return process
        }),
        readFile: (path) =>
          Effect.flatMap(
            // Redirected, not positional: BSD `base64` takes no file operand,
            // and the redirect reads the same on every guest.
            run(`test -e ${CommandLine.quote(path)} || exit 9; base64 < ${CommandLine.quote(path)}`),
            (result) =>
              result.code === 0
                ? decodeBase64(result.payload, `while reading ${path}`)
                : result.code === 9
                ? Effect.fail(new ProviderError({ code: "not_found", message: `the task holds nothing at ${path}` }))
                : Effect.fail(
                  failure(
                    result.code === undefined ? "aborted" : "unknown",
                    `could not read ${path}: ${result.payload.trim()}`
                  )
                )
          ),
        writeFile,
        kill: (process, signal) =>
          Effect.suspend(() => {
            const pidfile = pidfiles.get(process)
            /* v8 ignore next 3 -- `spawn` records every process it returns and a `RemoteProcess` has no other source, so the guard only discharges the optional a map read carries */
            if (pidfile === undefined) {
              return Effect.fail(failure("unknown", "unrecognized process"))
            }
            return kill(pidfile, signal)
          }),
        ping
      }
      return session
    })
})
