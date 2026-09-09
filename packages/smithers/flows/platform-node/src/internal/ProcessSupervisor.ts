/**
 * Private parent connection for a POSIX process owner. Effect retains ownership
 * of the caller's streams; the socket carries only launch and lifetime control.
 * @since 1.0.0
 */
import type { Lifecycle } from "@smthrs/kernel/ContainedSpawner"
import * as Channel from "effect/Channel"
import * as Effect from "effect/Effect"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { type ChildProcessHandle, ExitCode, makeHandle } from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, mkdtempSync, rmdirSync, rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { resolve } from "node:path"
import type { Policy, System } from "./ProcessCleanup.ts"
import { source } from "./SupervisorProgram.ts"

const startupMs = 5000
const deliveryMs = 500
const exitAllowanceMs = 2500
// Host-wide process observations can exceed a socket-delivery deadline on a
// loaded machine. Keep verification bounded without mistaking that delay for
// an unclean exit; an unknown observation still never counts as success.
const verificationMs = 2500
const targets = new WeakMap<ChildProcessHandle, Control>()

/**
 * Actual service pid, distinct from the owner recorded by the host.
 * @private
 * @since 1.0.0
 */
export const targetPidOf = (handle: ChildProcessHandle): number | undefined => targets.get(handle)?.targetPid

/** Native error fields remain data on the public PlatformError cause. */
const nativeError = (cause: unknown): Error & { code?: string; syscall?: string } => {
  if (cause instanceof Error) return cause
  const value = cause as { message?: string } | null
  return Object.assign(new Error(value?.message ?? "The process supervisor failed"), cause)
}

/**
 * Preserve the platform's errno and signal vocabulary across the private wire.
 * @private
 * @since 1.0.0
 */
export const failure = (method: string, command: string, cause: unknown): PlatformError.PlatformError => {
  const error = nativeError(cause)
  const tags: Readonly<Record<string, PlatformError.SystemErrorTag>> = {
    ENOENT: "NotFound",
    EACCES: "PermissionDenied",
    EEXIST: "AlreadyExists",
    EISDIR: "BadResource",
    ENOTDIR: "BadResource",
    ELOOP: "BadResource",
    EBUSY: "Busy"
  }
  return PlatformError.systemError({
    _tag: tags[error.code ?? ""] ?? "Unknown",
    module: "ChildProcess",
    method,
    pathOrDescriptor: command,
    syscall: error.syscall,
    cause: error
  })
}

const promise = <A>() => {
  let resolve!: (value: A) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<A>((yes, no) => {
    resolve = yes
    reject = no
  })
  // A status may arrive before its Effect consumer starts waiting.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

const wait = <A>(value: Promise<A>, method: string, command: string) =>
  Effect.tryPromise({ try: () => value, catch: (cause) => failure(method, command, cause) })

const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>, millis: number, method: string, command: string) =>
  effect.pipe(Effect.timeoutOrElse({
    duration: millis,
    orElse: () => Effect.fail(failure(method, command, new Error(`Process supervisor ${method} timed out`)))
  }))

/**
 * Standalone application executables do not implement the runtime's eval CLI.
 * Refuse them before spawning rather than recursively launching the application.
 * @private
 * @since 1.0.0
 */
export const bootstrapArguments = (runtime: { readonly bun: boolean; readonly main: string; readonly sea: boolean }) =>
  runtime.sea || runtime.main.startsWith("/$bunfs/")
    ? Effect.fail(
      failure(
        "spawn",
        process.execPath,
        new Error("Process supervision requires a Node or Bun runtime executable, not a compiled application")
      )
    )
    : Effect.succeed(runtime.bun ? ["--no-env-file", "--config=/dev/null"] : [])

/**
 * Kept separate from Effect scopes so native socket callbacks only settle
 * promises; none can start an unowned fiber or signal an observed process id.
 * @private
 * @since 1.0.0
 */
export class Control {
  readonly ready = promise<number>()
  readonly started = promise<void>()
  readonly exited = promise<ExitCode>()
  readonly lost = promise<never>()
  readonly ended = promise<void>()
  readonly directory: string
  readonly path: string
  readonly server
  readonly listening: Promise<void>
  socket: Socket | undefined
  targetDone = false
  targetPid: number | undefined
  ownerDone = false
  spawnFailed = false
  cleanupFailed = false
  cleanupAcknowledged = false
  activationSent = false
  closeSent = false
  fault: unknown
  onTargetExit: () => void = () => {}
  private receivedReady = false
  private receivedStarted = false
  private withdrawn = false

  constructor() {
    this.directory = mkdtempSync("/tmp/sm-p-")
    this.path = `${this.directory}/s`
    try {
      chmodSync(this.directory, 0o700)
      this.server = createServer((socket) => this.accept(socket))
      this.listening = new Promise<void>((resolve, reject) => {
        this.server.once("error", reject)
        this.server.listen(this.path, resolve)
      })
    } catch (cause) {
      rmSync(this.directory, { recursive: true, force: true })
      throw cause
    }
  }

  /** Validate the stored READY after the raw spawn effect has returned its pid. */
  withdraw(pid: number, actual: number): void {
    if (pid !== actual) throw new Error("Wrong supervisor identity")
    this.server.close()
    this.server.unref()
    // Node may unlink the owned socket synchronously inside server.close().
    rmSync(this.path, { force: true })
    rmdirSync(this.directory)
    this.withdrawn = true
  }

  /** EOF is itself a cleanup request, including a failed/partial stop write. */
  disconnect(): void {
    this.socket?.destroy()
  }

  dispose(): void {
    this.disconnect()
    this.server.close()
    if (!this.withdrawn) rmSync(this.directory, { recursive: true, force: true })
  }

  rawEnded(): void {
    this.ownerDone = true
    // An accepted socket may still have buffered status frames. Its close event
    // rejects missing outcomes only after Node has delivered those frames.
    if (this.socket === undefined) this.closed()
  }

  write(message: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socket
      if (socket === undefined || socket.destroyed || !socket.writable) {
        reject(new Error("Private process control channel closed"))
        return
      }
      const data = `${JSON.stringify(message)}\n`
      if (Buffer.byteLength(data) > 4 * 1024 * 1024) {
        reject(new Error("Process configuration exceeds the private frame limit"))
        return
      }
      socket.write(data, (error) => error ? reject(error) : resolve())
    })
  }

  private closed(): void {
    const cause = this.fault ?? new Error("Process supervisor closed before reporting its outcome")
    if (this.activationSent && !this.targetDone && !this.spawnFailed) this.lost.reject(cause)
    this.ready.reject(cause)
    this.started.reject(cause)
    this.exited.reject(cause)
    this.ended.resolve()
  }

  private accept(socket: Socket): void {
    if (this.socket !== undefined) {
      socket.destroy()
      return
    }
    this.socket = socket
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (data: string) => {
      try {
        buffer += data
        if (Buffer.byteLength(buffer) > 16 * 1024) throw new Error("Process status frame exceeds its limit")
        for (;;) {
          const end = buffer.indexOf("\n")
          if (end < 0) break
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          this.receive(JSON.parse(line))
        }
      } catch (cause) {
        this.fault = cause
        socket.destroy()
      }
    })
    socket.on("error", (cause) => {
      this.fault = cause
    })
    socket.once("close", () => this.closed())
  }

  private receive(value: unknown): void {
    if (typeof value !== "object" || value === null) throw new Error("Invalid process status")
    const message = value as Record<string, unknown>
    switch (message.type) {
      case "ready":
        if (
          this.receivedReady || message.version !== 1 || !Number.isSafeInteger(message.pid) || Number(message.pid) <= 1
        ) {
          throw new Error("Invalid process readiness")
        }
        this.receivedReady = true
        this.ready.resolve(Number(message.pid))
        return
      case "spawned":
        if (
          !this.activationSent || this.receivedStarted || !Number.isSafeInteger(message.pid) || Number(message.pid) <= 1
        ) {
          throw new Error("Invalid target startup")
        }
        this.receivedStarted = true
        this.targetPid = Number(message.pid)
        this.started.resolve()
        return
      case "spawn_error":
        if (!this.activationSent || this.receivedStarted) throw new Error("Invalid target spawn failure")
        this.spawnFailed = true
        this.fault = message
        this.started.reject(message)
        this.exited.reject(message)
        return
      case "fault":
        this.fault = message
        this.started.reject(message)
        this.exited.reject(message)
        return
      case "exit":
        if (
          !this.receivedStarted || this.targetDone ||
          !(Number.isInteger(message.code) && Number(message.code) >= 0 && message.signal === null ||
            message.code === null && typeof message.signal === "string" && /^SIG[A-Z0-9]+$/.test(message.signal))
        ) {
          throw new Error("Invalid target exit status")
        }
        this.targetDone = true
        if (message.code === null) {
          this.exited.reject({
            message: `Process interrupted due to receipt of signal: '${message.signal}'`,
            signal: message.signal
          })
        } else this.exited.resolve(ExitCode(Number(message.code)))
        this.onTargetExit()
        return
      case "cleanup_error":
        this.cleanupFailed = true
        this.fault = message
        return
      case "cleanup":
        this.cleanupAcknowledged = true
        return
      default:
        throw new Error("Unknown process status")
    }
  }
}

/**
 * Prepare a private, independently bounded process owner before target launch.
 * @private
 * @since 1.0.0
 */
export const prepare = (
  system: System,
  policy: (
    options: ChildProcess.KillOptions,
    defaults?: ChildProcess.KillOptions
  ) => Effect.Effect<Policy, PlatformError.PlatformError>
): Lifecycle =>
(command, spawn) =>
  Effect.gen(function*() {
    const initial = yield* policy(command.options)
    const bun = process.versions.bun !== undefined
    const sea = bun ? false : (yield* Effect.tryPromise({
      try: () => import("node:sea"),
      catch: (cause) => failure("spawn", process.execPath, cause)
    })).isSea()
    const bootstrap = yield* bootstrapArguments({
      bun,
      sea,
      main: (globalThis as { readonly Bun?: { readonly main?: string } }).Bun?.main ?? ""
    })
    const grouped = command.options.detached ?? true
    const control = yield* Effect.acquireRelease(
      Effect.try({ try: () => new Control(), catch: (cause) => failure("spawn", command.command, cause) }),
      (control) => Effect.sync(() => control.dispose())
    )
    yield* bounded(wait(control.listening, "spawn", command.command), startupMs, "spawn", command.command)
    const raw = yield* spawn(ChildProcess.make(process.execPath, [
      ...bootstrap,
      "-e",
      source,
      control.path,
      grouped ? "group" : "direct"
    ], {
      ...command.options,
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", HOME: "/", XDG_CONFIG_HOME: "/", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      extendEnv: false,
      shell: false,
      detached: grouped,
      killSignal: "SIGTERM",
      forceKillAfter: initial.graceMs
    }))
    yield* Effect.exit(raw.exitCode).pipe(Effect.andThen(Effect.sync(() => control.rawEnded())), Effect.forkScoped)
    let settled = false
    let referenced = true
    let reref: Effect.Effect<void, PlatformError.PlatformError> = Effect.void
    let selected = initial
    let requireCleanupReceipt = false
    const snapshot = () => system.snapshot(raw.pid)
    const alone = () => {
      if (!grouped) return control.targetDone
      const observed = snapshot()
      if (observed === undefined || observed.ownGroup === raw.pid) return false
      const running = observed.members.filter((member) => !member.zombie)
      return running.length === 1 && running[0]!.pid === raw.pid
    }
    // This observation only shortens the owner's deadline. The live owner makes
    // the signal, so neither a stale observation nor a reused pid grants a kill.
    control.onTargetExit = () => {
      // Target exit is reported once. This distinct fast request must still be
      // sent after an explicit TERM request; the helper keeps any escaped-child
      // deadline when that extra explicit-stop work remains.
      if (!alone()) return
      control.closeSent = true
      void control.write({ type: "stop", killSignal: "SIGKILL", fast: true }).catch(() => control.disconnect())
    }
    const finish = yield* Effect.cached(Effect.gen(function*() {
      yield* bounded(Effect.exit(raw.exitCode), selected.graceMs + exitAllowanceMs, "kill", command.command)
      yield* bounded(wait(control.ended.promise, "kill", command.command), deliveryMs, "kill", command.command).pipe(
        Effect.ignore
      )
      const deadline = Date.now() + verificationMs
      for (;;) {
        const observed = grouped ? snapshot() : undefined
        settled = !control.cleanupFailed && (!requireCleanupReceipt || control.cleanupAcknowledged) && (grouped
          ? observed !== undefined && observed.ownGroup !== raw.pid && observed.members.every((member) => member.zombie)
          : control.targetDone || control.spawnFailed || !control.activationSent)
        if (settled) return
        if (Date.now() >= deadline) {
          return yield* Effect.fail(
            failure(
              "kill",
              command.command,
              new Error("Process cleanup could not be verified; its ledger record is retained", {
                cause: {
                  fault: control.fault,
                  cleanupFailed: control.cleanupFailed,
                  cleanupRequired: requireCleanupReceipt,
                  cleanupAcknowledged: control.cleanupAcknowledged,
                  targetDone: control.targetDone,
                  ownerObserved: observed !== undefined,
                  members: observed?.members
                }
              })
            )
          )
        }
        yield* Effect.sleep(10)
      }
    }))
    const kill = (options: ChildProcess.KillOptions = {}) =>
      Effect.gen(function*() {
        const requested = yield* policy(options, command.options)
        if (!referenced) {
          control.socket?.ref()
          yield* reref
          referenced = true
        }
        if (!control.closeSent) {
          control.closeSent = true
          selected = requested
          // An empty original group cannot prove an explicit escaped-descendant
          // sweep succeeded if its status frames were lost. Startup and natural
          // completion have no such additional contract.
          requireCleanupReceipt = grouped && control.activationSent && !control.spawnFailed && !control.targetDone
          yield* bounded(
            wait(
              control.write({
                type: "stop",
                explicit: true,
                ...requested,
                killSignal: alone() ? "SIGKILL" : requested.killSignal
              }),
              "kill",
              command.command
            ),
            deliveryMs,
            "kill",
            command.command
          )
            .pipe(Effect.catch(() => Effect.sync(() => control.disconnect())))
        }
        yield* finish
      }).pipe(Effect.uninterruptible)
    yield* Effect.addFinalizer(() =>
      kill().pipe(
        // A stuck owner keeps its ledger entry. Disable the underlying spawner's
        // unconditional group-kill finalizer rather than signal a stale identity.
        Effect.ensuring(
          Effect.suspend(() =>
            settled ? Effect.void : Effect.andThen(raw.unref, Effect.sync(() => control.disconnect()))
          ).pipe(Effect.orDie)
        ),
        Effect.orDie
      )
    )
    const ready = yield* bounded(
      wait(control.ready.promise, "spawn", command.command),
      startupMs,
      "spawn",
      command.command
    )
    yield* Effect.try({
      try: () => control.withdraw(ready, raw.pid),
      catch: (cause) => failure("spawn", command.command, cause)
    })
    const options = command.options
    // Match Effect/Node's undefined-vs-empty environment semantics in the host,
    // before replacing the helper's environment with its isolated bootstrap.
    const env = options.extendEnv ? { ...process.env, ...options.env } : options.env ?? { ...process.env }
    yield* bounded(
      wait(
        control.write({
          type: "configure",
          command: command.command,
          args: command.args,
          cwd: resolve(options.cwd ?? process.cwd()),
          env,
          shell: options.shell,
          userFds: [
            ...new Set(
              Object.keys(options.additionalFds ?? {}).map(ChildProcess.parseFdName)
                .filter((fd): fd is number => fd !== undefined)
            )
          ],
          ...initial
        }),
        "spawn",
        command.command
      ),
      deliveryMs,
      "spawn",
      command.command
    )
    const activate = yield* Effect.cached(Effect.gen(function*() {
      control.activationSent = true
      yield* bounded(
        wait(control.write({ type: "start" }), "spawn", command.command),
        deliveryMs,
        "spawn",
        command.command
      )
      yield* bounded(wait(control.started.promise, "spawn", command.command), startupMs, "spawn", command.command)
    }))
    const unref = Effect.gen(function*() {
      if (referenced) {
        reref = yield* raw.unref
        control.socket?.unref()
        referenced = false
      }
      return Effect.gen(function*() {
        if (!referenced) {
          control.socket?.ref()
          yield* reref
          referenced = true
        }
      })
    })
    const output = <A>(stream: Stream.Stream<A, PlatformError.PlatformError>) =>
      stream.pipe(
        Stream.interruptWhen(wait(control.lost.promise, "read", command.command))
      )
    const input = <A>(sink: Sink.Sink<A, Uint8Array, never, PlatformError.PlatformError>) =>
      Sink.fromChannel(
        Sink.toChannel(sink).pipe(Channel.interruptWhen(wait(control.lost.promise, "write", command.command)))
      )
    const handle = makeHandle({
      ...raw,
      exitCode: wait(control.exited.promise, "exitCode", command.command),
      isRunning: Effect.sync(() => !control.targetDone && !control.ownerDone),
      stdin: input(raw.stdin),
      getInputFd: (fd) => input(raw.getInputFd(fd)),
      stdout: output(raw.stdout),
      stderr: output(raw.stderr),
      all: output(raw.all),
      getOutputFd: (fd) => output(raw.getOutputFd(fd)),
      kill,
      unref
    })
    targets.set(handle, control)
    return {
      handle,
      activate,
      settled: Effect.sync(() => settled)
    }
  })
