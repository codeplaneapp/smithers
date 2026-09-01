import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Path, PlatformError, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle
} from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AwsSandbox from "../src/AwsSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

type RunTaskInput = Parameters<AwsSandbox.Sdk["runTask"]>[0]
type RunTaskOutput = Awaited<ReturnType<AwsSandbox.Sdk["runTask"]>>
type DescribeTasksInput = Parameters<AwsSandbox.Sdk["describeTasks"]>[0]
type DescribeTasksOutput = Awaited<ReturnType<AwsSandbox.Sdk["describeTasks"]>>
type StopTaskInput = Parameters<AwsSandbox.Sdk["stopTask"]>[0]
type RegisterTaskDefinitionInput = Parameters<AwsSandbox.Sdk["registerTaskDefinition"]>[0]
type DeregisterTaskDefinitionInput = Parameters<AwsSandbox.Sdk["deregisterTaskDefinition"]>[0]
type Task = NonNullable<DescribeTasksOutput["tasks"]>[number]

type DescribeStep =
  | "missing"
  | "empty"
  | "pending"
  | "no-containers"
  | "no-agents"
  | "wrong-agent"
  | "wrong-container"
  | "fallback-ready"
  | "stopped"
  | "ready"

interface Fault {
  readonly cause: unknown
}

interface FakeEcs {
  readonly runInputs: Array<RunTaskInput>
  readonly describeInputs: Array<DescribeTasksInput>
  readonly stopInputs: Array<StopTaskInput>
  readonly registerInputs: Array<RegisterTaskDefinitionInput>
  readonly deregisterInputs: Array<DeregisterTaskDefinitionInput>
  readonly events: Array<string>
  readonly describeSteps: Array<DescribeStep>
  runFault?: Fault | undefined
  describeFault?: Fault | undefined
  stopFault?: Fault | undefined
  registerFault?: Fault | undefined
  deregisterFault?: Fault | undefined
  runWithoutTask?: boolean | undefined
  runWithoutArn?: boolean | undefined
  registerWithoutArn?: boolean | undefined
  nextTask: number
  lastContainer: string
}

const fakeEcs = (): FakeEcs => ({
  runInputs: [],
  describeInputs: [],
  stopInputs: [],
  registerInputs: [],
  deregisterInputs: [],
  events: [],
  describeSteps: [],
  nextTask: 0,
  lastContainer: "main"
})

const managed = (name = "ExecuteCommandAgent", lastStatus = "RUNNING") => ({ name, lastStatus })

const taskFor = (taskArn: string, container: string, step: DescribeStep): Task => {
  if (step === "stopped") return { taskArn, lastStatus: "STOPPED", enableExecuteCommand: true }
  if (step === "pending") return { taskArn, lastStatus: "PENDING", enableExecuteCommand: false }
  if (step === "no-containers") return { taskArn, lastStatus: "RUNNING", enableExecuteCommand: true }
  if (step === "no-agents") {
    return { taskArn, lastStatus: "RUNNING", enableExecuteCommand: true, containers: [{ name: container }] }
  }
  if (step === "wrong-agent") {
    return {
      taskArn,
      lastStatus: "RUNNING",
      enableExecuteCommand: true,
      containers: [{
        name: container,
        managedAgents: [managed("OtherAgent", "STOPPED"), managed("ExecuteCommandAgent", "PENDING")]
      }]
    }
  }
  if (step === "wrong-container") {
    return {
      taskArn,
      lastStatus: "RUNNING",
      enableExecuteCommand: true,
      containers: [{ name: "another", managedAgents: [managed()] }]
    }
  }
  return {
    taskArn: step === "fallback-ready" ? `${taskArn}-reported` : taskArn,
    lastStatus: "RUNNING",
    enableExecuteCommand: true,
    containers: [{ name: container, managedAgents: [managed()] }]
  }
}

const takeFault = (target: FakeEcs, key: keyof FakeEcs): unknown | undefined => {
  const fault = target[key] as Fault | undefined
  if (fault === undefined) return undefined
  delete target[key]
  return fault.cause
}

const sdkOf = (fake: FakeEcs): AwsSandbox.Sdk => ({
  async runTask(input): Promise<RunTaskOutput> {
    fake.runInputs.push(input)
    fake.events.push("run")
    const fault = takeFault(fake, "runFault")
    if (fault !== undefined) throw fault
    if (fake.runWithoutTask === true) return { failures: [{ reason: "CAPACITY" }] }
    const taskArn = `arn:aws:ecs:us-west-2:123456789012:task/cluster/task-${fake.nextTask++}`
    fake.lastContainer = input.overrides?.containerOverrides?.[0]?.name ?? fake.lastContainer
    return fake.runWithoutArn === true
      ? { tasks: [{ lastStatus: "PROVISIONING" }], failures: [{ reason: "MISSING_ARN" }] }
      : { tasks: [{ taskArn, lastStatus: "PROVISIONING", enableExecuteCommand: true }] }
  },
  async describeTasks(input): Promise<DescribeTasksOutput> {
    fake.describeInputs.push(input)
    fake.events.push("describe")
    const fault = takeFault(fake, "describeFault")
    if (fault !== undefined) throw fault
    const step = fake.describeSteps.shift() ?? "ready"
    if (step === "missing") return { failures: [{ arn: input.tasks[0], reason: "MISSING" }] }
    if (step === "empty") return { tasks: [] }
    return { tasks: [taskFor(input.tasks[0]!, fake.lastContainer, step)] }
  },
  async stopTask(input) {
    fake.stopInputs.push(input)
    fake.events.push("stop")
    const fault = takeFault(fake, "stopFault")
    if (fault !== undefined) throw fault
    return { task: { taskArn: input.task, lastStatus: "STOPPED" } }
  },
  async registerTaskDefinition(input) {
    fake.registerInputs.push(input)
    fake.events.push("register")
    const fault = takeFault(fake, "registerFault")
    if (fault !== undefined) throw fault
    fake.lastContainer = input.containerDefinitions[0]!.name
    return fake.registerWithoutArn === true
      ? { taskDefinition: {} }
      : {
        taskDefinition: { taskDefinitionArn: `arn:aws:ecs:us-west-2:123456789012:task-definition/${input.family}:1` }
      }
  },
  async deregisterTaskDefinition(input) {
    fake.deregisterInputs.push(input)
    fake.events.push("deregister")
    const fault = takeFault(fake, "deregisterFault")
    if (fault !== undefined) throw fault
    return { taskDefinition: { taskDefinitionArn: input.taskDefinition, status: "INACTIVE" } }
  }
})

// -----------------------------------------------------------------------------
// The AWS CLI as a fake: real shells behind the Session Manager framing.
// -----------------------------------------------------------------------------

// The provider's guest scripts run through a real `sh` against a real
// directory, so `base64`, `wait`, the pidfile, and the signal are all genuine;
// what the fake adds is exactly what `session-manager-plugin` adds on top of
// them: the banner, the footer, `\r\n` line endings from the pseudo-terminal,
// standard error folded into standard output, and a zero exit whatever the
// command did. A fake that mirrored the provider's parsing would prove
// nothing; this one reproduces the transport the provider has to survive.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-aws-sandbox-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)
const local = Effect.runSync(
  Effect.gen(function*() {
    return yield* ChildProcessSpawner
  }).pipe(Effect.provide(platform))
)

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface CliFaults {
  /** The plugin exits with this code and prints this to standard error. */
  readonly pluginFailure?: { readonly code: number; readonly stderr: string } | undefined
  /** The session drops before the wrapper's sentinel line is printed. */
  readonly dropSentinel?: boolean | undefined
  /** An older plugin that prints no banner line. */
  readonly noBanner?: boolean | undefined
}

interface CliCall {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly remote: string
}

const crlf = (bytes: Uint8Array): Uint8Array => {
  const out: Array<number> = []
  for (const byte of bytes) {
    if (byte === 0x0a) out.push(0x0d)
    out.push(byte)
  }
  return Uint8Array.from(out)
}

const fakeCli = (faults: CliFaults = {}) => {
  const calls: Array<CliCall> = []
  const spawner = makeSpawner((command: ChildProcess.Command) =>
    Effect.gen(function*() {
      if (command._tag !== "StandardCommand") {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "no pipelines" })
        )
      }
      const remoteIndex = command.args.indexOf("--command")
      // Guest pids live under a fixed guest path; on this host they live
      // under the test's own root instead.
      const remote = command.args[remoteIndex + 1]!.replaceAll("/tmp/.smthrs-sbx", `${root}/.pids`)
      calls.push({ file: command.command, args: command.args, remote })
      const sessionId = `ecs-execute-command-${calls.length}`
      if (faults.pluginFailure !== undefined) {
        return makeHandle({
          pid: 0 as never,
          exitCode: Effect.succeed(ExitCode(faults.pluginFailure.code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.make(encoder.encode(faults.pluginFailure.stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      }
      const child = yield* local.spawn(ChildProcess.make("sh", ["-c", remote], { cwd: root }))
      const banner = faults.noBanner === true
        ? Stream.empty
        : Stream.make(encoder.encode(`\r\nStarting session with SessionId: ${sessionId}\r\n`))
      const footer = Stream.make(encoder.encode(`\r\n\r\nExiting session with sessionId: ${sessionId}.\r\n`))
      const merged = Stream.merge(child.stdout, child.stderr).pipe(
        Stream.map(crlf),
        Stream.map((bytes) =>
          faults.dropSentinel === true
            ? encoder.encode(decoder.decode(bytes).replaceAll("__smthrs_exit_", "__dropped_"))
            : bytes
        )
      )
      return makeHandle({
        pid: child.pid,
        // The plugin reports its own success, never the remote command's.
        exitCode: Effect.map(child.exitCode, () => ExitCode(0)),
        isRunning: child.isRunning,
        kill: (options) => child.kill(options),
        stdin: Sink.drain,
        stdout: Stream.concat(Stream.concat(banner, merged), footer),
        stderr: Stream.empty,
        all: Stream.concat(Stream.concat(banner, merged), footer),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: child.unref
      })
    })
  )
  return { spawner, calls }
}

const taskDefinitionProvider = (fake: FakeEcs, overrides: Record<string, unknown> = {}) =>
  AwsSandbox.make({
    sdk: sdkOf(fake),
    region: "us-west-2",
    cluster: "cluster-arn",
    taskDefinition: "family:7",
    subnets: ["subnet-a"],
    ...overrides
  })

const transportProvider = (
  fake: FakeEcs,
  cli: ReturnType<typeof fakeCli>,
  overrides: Record<string, unknown> = {},
  transport: Record<string, unknown> = {}
) =>
  taskDefinitionProvider(fake, {
    workdir: root,
    pollIntervalMs: 0,
    maxPollAttempts: 3,
    exec: { spawner: cli.spawner, ...transport },
    ...overrides
  })

const acquired = <A, E>(
  provider: ReturnType<typeof AwsSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>,
  session = "aws/session"
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire(session), body))

const output = (session: Session, command: string, options: Parameters<Session["spawn"]>[1] = {}) =>
  Effect.scoped(
    Effect.gen(function*() {
      const process = yield* session.spawn(command, options)
      const stdout = yield* Stream.mkString(Stream.decodeText(process.stdout))
      const code = yield* process.exitCode
      return { stdout, code }
    })
  )

describe("AwsSandbox", () => {
  it.effect("provisions a Fargate task and refuses to reach into it without a transport", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const provider = taskDefinitionProvider(fake, {
        securityGroups: ["sg-a"],
        assignPublicIp: true,
        container: "runner",
        workdir: "/work dir",
        platformVersion: "1.4.0",
        taskRoleArn: "arn:task-role",
        executionRoleArn: "arn:execution-role",
        env: { BOOT: "yes" }
      })
      const longSession = "../../this-is-a-very-long-session-key-that-needs-a-safe-started-by-value"
      yield* acquired(
        provider,
        (session) =>
          Effect.gen(function*() {
            expect(session.id).toBe(longSession)
            expect(session.remoteId).toContain(":task/")
            expect(session.workdir).toBe("/work dir")
            yield* session.ping!
            const refusals = [
              yield* Effect.flip(Effect.scoped(session.spawn("printf 'hello'", {}))),
              yield* Effect.flip(session.readFile("/work dir/file")),
              yield* Effect.flip(session.writeFile("/work dir/file", new Uint8Array()))
            ]
            for (const refusal of refusals) {
              expect(refusal).toMatchObject({ code: "unavailable" })
              expect(refusal.message).toContain("no command transport")
            }
            fake.describeSteps.push("pending")
            expect(yield* Effect.flip(session.ping!)).toMatchObject({ code: "unavailable" })
          }),
        longSession
      )

      expect(fake.runInputs[0]).toMatchObject({
        cluster: "cluster-arn",
        taskDefinition: "family:7",
        count: 1,
        enableExecuteCommand: true,
        launchType: "FARGATE",
        startedBy: expect.stringMatching(/^[A-Za-z0-9/_-]{1,36}$/),
        platformVersion: "1.4.0",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: ["subnet-a"],
            securityGroups: ["sg-a"],
            assignPublicIp: "ENABLED"
          }
        },
        overrides: {
          taskRoleArn: "arn:task-role",
          executionRoleArn: "arn:execution-role",
          containerOverrides: [{ name: "runner", environment: [{ name: "BOOT", value: "yes" }] }]
        }
      })
      expect(fake.stopInputs).toHaveLength(1)
    }))

  it.effect("runs commands, moves bytes, and signals through the CLI session transport", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      // The fake reports the container it last saw named; name it up front so
      // readiness for `runner` is observable without an environment override.
      fake.lastContainer = "runner"
      const cli = fakeCli()
      const provider = transportProvider(fake, cli, { container: "runner" }, {
        program: "aws-wrapper",
        globalArgs: ["--profile", "sandbox"],
        chunkBytes: 5
      })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          // The workspace and pid directory are prepared before the session
          // is handed out, through the same transport.
          expect(cli.calls[0]!.remote).toContain("mkdir -p")
          const greeting = yield* output(session, `printf 'hello\\nfrom %s' "$WHO"`, {
            cwd: root,
            env: { WHO: "fargate", DROP: undefined }
          })
          expect(greeting).toEqual({ stdout: "hello\nfrom fargate", code: 0 })
          expect(yield* output(session, "pwd")).toEqual({ stdout: `${root}\n`, code: 0 })
          expect((yield* output(session, "exit 23")).code).toBe(23)
          expect((yield* output(session, "true")).stdout).toBe("")
          expect((yield* output(session, "true", { cwd: `${root}/nowhere` })).code).toBe(127)

          const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 13, 0, 7, 8, 9])
          yield* session.writeFile(`${root}/deep/tree/out.bin`, bytes)
          expect(Array.from(yield* session.readFile(`${root}/deep/tree/out.bin`))).toEqual(Array.from(bytes))
          yield* session.writeFile(`${root}/empty.bin`, new Uint8Array())
          expect(Array.from(yield* session.readFile(`${root}/empty.bin`))).toEqual([])
          // A path with no parent to create takes the bare write.
          yield* session.writeFile("rooted.bin", new Uint8Array([42]))
          expect(Array.from(yield* session.readFile(`${root}/rooted.bin`))).toEqual([42])
          const absent = yield* Effect.flip(session.readFile(`${root}/absent.bin`))
          expect(absent).toMatchObject({ code: "not_found" })
          writeFileSync(`${root}/sealed.bin`, "sealed")
          chmodSync(`${root}/sealed.bin`, 0)
          const unreadable = yield* Effect.flip(session.readFile(`${root}/sealed.bin`))
          expect(unreadable).toMatchObject({ code: "unknown" })
          writeFileSync(`${root}/blocker`, "a file, not a directory")
          const unwritable = yield* Effect.flip(session.writeFile(`${root}/blocker/child`, new Uint8Array([1])))
          expect(unwritable).toMatchObject({ code: "unknown" })

          // A signalled command still reports a status, because the wrapper
          // waits for it rather than dying with it.
          const signalled = yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn("sleep 30", {})
              yield* session.kill!(process, "SIGTERM")
              return yield* process.exitCode
            })
          )
          expect(signalled).toBe(143)
        }))

      const shapes = cli.calls.map((call) => call.args)
      for (const args of shapes) {
        expect(args.slice(0, 12)).toEqual([
          "--profile",
          "sandbox",
          "--region",
          "us-west-2",
          "ecs",
          "execute-command",
          "--cluster",
          "cluster-arn",
          "--task",
          expect.stringContaining(":task/"),
          "--container",
          "runner"
        ])
        expect(args.slice(12, 14)).toEqual(["--interactive", "--command"])
      }
      expect(cli.calls.every((call) => call.file === "aws-wrapper")).toBe(true)
      // Twelve bytes at five per slice is three commands for the first write.
      const writes = cli.calls.filter((call) => call.remote.includes("base64 -d"))
      expect(writes.filter((call) => call.remote.includes("deep/tree/out.bin"))).toHaveLength(3)
      expect(cli.calls.some((call) => call.remote.includes("kids()"))).toBe(true)
      expect(fake.stopInputs).toHaveLength(1)
    }), 60_000)

  it.effect("uses the CLI defaults and omits the container flag when none is named", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const cli = fakeCli()
      yield* acquired(transportProvider(fake, cli), (session) => output(session, "true"))
      expect(cli.calls[0]!.file).toBe("aws")
      expect(cli.calls[0]!.args.slice(0, 2)).toEqual(["--region", "us-west-2"])
      expect(cli.calls[0]!.args).not.toContain("--container")
    }), 30_000)

  it.effect("reports transport failures as what they are", () =>
    Effect.gen(function*() {
      // The plugin itself failing to run is a transport failure, and it stops
      // acquisition at the workspace preparation.
      const missingPlugin = fakeCli({ pluginFailure: { code: 254, stderr: "SessionManagerPlugin is not found" } })
      const pluginFailure = yield* Effect.flip(
        acquired(transportProvider(fakeEcs(), missingPlugin), () => Effect.void)
      )
      expect(pluginFailure).toMatchObject({ code: "unavailable" })
      expect(pluginFailure.message).toContain("SessionManagerPlugin is not found")

      // A session that drops before the status line is never a success.
      const dropping = fakeCli({ dropSentinel: true })
      const droppedFailure = yield* Effect.flip(
        acquired(transportProvider(fakeEcs(), dropping), () => Effect.void)
      )
      expect(droppedFailure).toMatchObject({ code: "unavailable" })
      expect(droppedFailure.message).toContain("could not be prepared")

      // Drop the sentinel only once the session exists, so every operation's
      // own reaction to a dropped session is observable.
      let drop = false
      const flaky = fakeCli()
      const flakyWithDrops = fakeCli({ dropSentinel: true })
      const provider = transportProvider(fakeEcs(), {
        calls: flaky.calls,
        spawner: makeSpawner((command) => drop ? flakyWithDrops.spawner.spawn(command) : flaky.spawner.spawn(command))
      })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          drop = true
          const process = yield* Effect.scoped(
            Effect.flatMap(session.spawn("printf 'x'", {}), (process) => Effect.flip(process.exitCode))
          )
          expect(process).toMatchObject({ code: "aborted" })
          expect(yield* Effect.flip(session.readFile(`${root}/rooted.bin`))).toMatchObject({ code: "aborted" })
          expect(yield* Effect.flip(session.writeFile(`${root}/x.bin`, new Uint8Array([1])))).toMatchObject({
            code: "aborted"
          })
          const killFailure = yield* Effect.scoped(
            Effect.flatMap(session.spawn("true", {}), (running) => Effect.flip(session.kill!(running, "SIGTERM")))
          )
          expect(killFailure).toMatchObject({ code: "aborted" })
          drop = false
        }))

      // An older plugin with no banner line still parses.
      const bannerless = fakeCli({ noBanner: true })
      const plain = yield* acquired(transportProvider(fakeEcs(), bannerless), (session) =>
        output(session, "printf 'no banner'"))
      expect(plain).toEqual({ stdout: "no banner", code: 0 })

      // A workspace that cannot be prepared refuses the session.
      writeFileSync(`${root}/not-a-dir`, "")
      const unpreparable = yield* Effect.flip(
        acquired(transportProvider(fakeEcs(), fakeCli(), { workdir: `${root}/not-a-dir` }), () =>
          Effect.void)
      )
      expect(unpreparable).toMatchObject({ code: "unavailable" })
      expect(unpreparable.message).toContain("could not be prepared")
    }), 60_000)

  it.effect("registers image task definitions and finalizes task before definition", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      const provider = AwsSandbox.make({
        sdk: sdkOf(fake),
        region: "us-east-1",
        cluster: "cluster",
        image: "registry.example/sandbox:1",
        taskRoleArn: "arn:task-role",
        executionRoleArn: "arn:execution-role",
        subnets: ["subnet-a"],
        securityGroups: [],
        cpu: "512",
        memory: "1024",
        pollIntervalMs: 0,
        maxPollAttempts: 2
      })
      yield* acquired(provider, (session) => session.ping!)

      expect(fake.registerInputs[0]).toEqual({
        family: expect.stringMatching(/^smthrs-/),
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: "512",
        memory: "1024",
        taskRoleArn: "arn:task-role",
        executionRoleArn: "arn:execution-role",
        containerDefinitions: [{
          name: "sandbox",
          image: "registry.example/sandbox:1",
          essential: true,
          command: ["sleep", "infinity"],
          workingDirectory: "/workspace",
          linuxParameters: { initProcessEnabled: true }
        }]
      })
      expect(fake.runInputs[0]!.taskDefinition).toContain(":task-definition/")
      expect(fake.events.indexOf("stop")).toBeLessThan(fake.events.indexOf("deregister"))
      expect(fake.deregisterInputs).toHaveLength(1)

      const defaults = fakeEcs()
      const defaultProvider = AwsSandbox.make({
        sdk: sdkOf(defaults),
        region: "us-east-1",
        cluster: "cluster",
        image: "image:latest",
        taskRoleArn: "role",
        subnets: ["subnet-a"]
      })
      yield* acquired(defaultProvider, () => Effect.void, "short")
      expect(defaults.registerInputs[0]).toMatchObject({ cpu: "256", memory: "512" })
      expect(defaults.runInputs[0]!.networkConfiguration.awsvpcConfiguration).toEqual({
        subnets: ["subnet-a"],
        assignPublicIp: "DISABLED"
      })
    }))

  it.effect("polls documented ECS task and managed-agent readiness states", () =>
    Effect.gen(function*() {
      const fake = fakeEcs()
      fake.describeSteps.push(
        "missing",
        "empty",
        "pending",
        "no-containers",
        "no-agents",
        "wrong-agent",
        "wrong-container",
        "fallback-ready"
      )
      const provider = taskDefinitionProvider(fake, {
        container: "main",
        pollIntervalMs: 0,
        maxPollAttempts: 9
      })
      yield* acquired(provider, (session) => session.ping!)
      expect(fake.describeInputs.length).toBe(9)

      const stopped = fakeEcs()
      stopped.describeSteps.push("stopped")
      const stoppedFailure = yield* Effect.flip(acquired(
        taskDefinitionProvider(stopped),
        () => Effect.void
      ))
      expect(stoppedFailure).toMatchObject({ code: "unavailable" })
      expect(stopped.stopInputs).toHaveLength(1)

      const timedOut = fakeEcs()
      timedOut.describeSteps.push("missing")
      const timeoutFailure = yield* Effect.flip(acquired(
        taskDefinitionProvider(timedOut, { pollIntervalMs: 0, maxPollAttempts: 1 }),
        () => Effect.void
      ))
      expect(timeoutFailure).toMatchObject({ code: "timeout" })
    }))

  it.effect("finalizes every successfully created AWS resource on later failure", () =>
    Effect.gen(function*() {
      const describeFailed = fakeEcs()
      describeFailed.describeFault = { cause: new Error("describe failed") }
      describeFailed.stopFault = { cause: new Error("stop failed") }
      expect(yield* Effect.flip(acquired(taskDefinitionProvider(describeFailed), () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      expect(describeFailed.stopInputs).toHaveLength(1)

      const runFailed = fakeEcs()
      runFailed.runFault = { cause: new Error("run failed") }
      expect(yield* Effect.flip(acquired(taskDefinitionProvider(runFailed), () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      expect(runFailed.stopInputs).toHaveLength(0)

      const noTask = fakeEcs()
      noTask.runWithoutTask = true
      expect(yield* Effect.flip(acquired(taskDefinitionProvider(noTask), () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      expect(noTask.stopInputs).toHaveLength(0)

      const noArn = fakeEcs()
      noArn.runWithoutArn = true
      expect(yield* Effect.flip(acquired(taskDefinitionProvider(noArn), () => Effect.void))).toMatchObject({
        code: "unavailable"
      })

      const registerFailed = fakeEcs()
      registerFailed.registerFault = { cause: new Error("register failed") }
      const registerProvider = AwsSandbox.make({
        sdk: sdkOf(registerFailed),
        region: "region",
        cluster: "cluster",
        image: "image",
        taskRoleArn: "role",
        subnets: ["subnet"]
      })
      expect(yield* Effect.flip(acquired(registerProvider, () => Effect.void))).toMatchObject({
        code: "unavailable"
      })

      const missingDefinition = fakeEcs()
      missingDefinition.registerWithoutArn = true
      const missingProvider = AwsSandbox.make({
        sdk: sdkOf(missingDefinition),
        region: "region",
        cluster: "cluster",
        image: "image",
        taskRoleArn: "role",
        subnets: ["subnet"]
      })
      expect(yield* Effect.flip(acquired(missingProvider, () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      expect(missingDefinition.deregisterInputs).toHaveLength(0)

      const runAfterRegister = fakeEcs()
      runAfterRegister.runFault = { cause: new Error("run failed") }
      runAfterRegister.deregisterFault = { cause: new Error("deregister failed") }
      const runAfterRegisterProvider = AwsSandbox.make({
        sdk: sdkOf(runAfterRegister),
        region: "region",
        cluster: "cluster",
        image: "image",
        taskRoleArn: "role",
        subnets: ["subnet"]
      })
      expect(yield* Effect.flip(acquired(runAfterRegisterProvider, () => Effect.void))).toMatchObject({
        code: "unavailable"
      })
      expect(runAfterRegister.deregisterInputs).toHaveLength(1)
    }))

  it.effect("passes the sandbox conformance suite through the CLI session transport", () =>
    Effect.gen(function*() {
      const violations = yield* SandboxConformance.check(transportProvider(fakeEcs(), fakeCli()), {
        provides: { ping: true, kill: true }
      })
      expect(violations).toEqual([])
    }), 120_000)

  it.effect("names every obligation a transport-less provider cannot meet", () =>
    Effect.gen(function*() {
      const violations = yield* SandboxConformance.check(taskDefinitionProvider(fakeEcs()), {
        provides: { ping: true }
      })
      expect(violations.map(({ check }) => check)).toEqual([
        "round-trips-binary-bytes",
        "reports-an-absent-file",
        "creates-parent-directories",
        "runs-in-its-workdir",
        "delivers-the-environment",
        "reacquires-its-session",
        "writes-its-output",
        "reports-a-nonzero-exit"
      ])
    }))
})
