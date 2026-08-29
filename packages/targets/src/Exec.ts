/**
 * Shared tool-execution action for catalog targets.
 *
 * Targets declare tool runs by calling {@link Exec}.call in their pure
 * plan-time bodies. Nothing runs at plan time; the call only records a node
 * requiring the exec implementation. {@link ExecLive} supplies that
 * implementation through `node:child_process` for hosts that execute plans.
 *
 * @since 0.1.0
 */
import { Action, type FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as NodeChildProcess from "node:child_process"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import * as Config from "./Config.ts"
import { failureMessage } from "./GeneratedFile.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Secret from "./Secret.ts"
import * as SecretProxy from "./SecretProxy.ts"

/**
 * Placeholder resolved to the host cache directory immediately before spawn.
 *
 * Keeping the real directory out of an action payload prevents workspace
 * placement from becoming step-key material.
 *
 * @category constants
 * @since 0.1.0
 */
export const cacheDirectoryToken = "{smthrs:cache-directory}"

/**
 * Maximum length kept for captured stdout and stderr, in UTF-16 code units.
 *
 * The bound is code units, not bytes, because what is kept is a decoded
 * string: a run whose output is mostly non-ASCII therefore keeps fewer bytes
 * than a run whose output is ASCII. The unit is fixed rather than incidental,
 * so two hosts truncate one tool's output at the same place and the captured
 * result is the same on both.
 *
 * @category constants
 * @since 0.1.0
 */
export const outputLimit = 200 * 1024

/**
 * Maximum length of each stream tail carried by {@link ExecError}, in UTF-16
 * code units.
 *
 * @category constants
 * @since 0.1.0
 */
export const stderrTailLimit = 8 * 1024

/**
 * Default wall-clock duration of one external tool process.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultTimeoutMs = 10 * 60 * 1000
/**
 * Maximum wall-clock duration accepted for one external tool process.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumTimeoutMs = 24 * 60 * 60 * 1000

const maximumArgvEntries = 4_096
const maximumArgvBytes = 2 * 1024 * 1024
const maximumEnvironmentEntries = 4_096
const maximumEnvironmentBytes = 2 * 1024 * 1024
const maximumTextBytes = 1024 * 1024
const maximumExpectedExitCodes = 256
const maximumSecrets = 64

/**
 * Payload for one declared tool run.
 *
 * `cwd` is resolved against the workspace root at execution time. `argv[0]`
 * is the executable. `env` is merged over a small, documented host bootstrap
 * environment rather than the complete `process.env`.
 * `expectedExitCodes` lists the exit codes treated as success and defaults
 * to `[0]`. `timeoutMs` bounds the process lifetime and defaults to ten
 * minutes. `after` carries the planned result of an upstream step this run
 * must wait for: a planned reference here is a material dependency, so the
 * engine settles the upstream step before it dispatches this one. The spawn
 * never reads it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Payload = Schema.Struct({
  cwd: Schema.NonEmptyString.check(Schema.isMaxLength(maximumTextBytes)),
  argv: Schema.NonEmptyArray(Schema.String.check(Schema.isMaxLength(maximumTextBytes))).check(
    Schema.isMaxLength(maximumArgvEntries)
  ),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  secrets: Schema.Array(Secret.Declaration).check(Schema.isMaxLength(maximumSecrets)).pipe(
    Schema.withConstructorDefault(Effect.succeed([]))
  ),
  expectedExitCodes: Schema.Array(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(0xffff_ffff))
  ).check(Schema.isMaxLength(maximumExpectedExitCodes)).pipe(
    Schema.withConstructorDefault(Effect.succeed([0]))
  ),
  timeoutMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(maximumTimeoutMs)
  ).pipe(Schema.withConstructorDefault(Effect.succeed(defaultTimeoutMs))),
  after: Schema.optional(Schema.Unknown)
})

/**
 * Payload for one declared tool run.
 *
 * @category models
 * @since 0.1.0
 */
export type Payload = typeof Payload.Type

/**
 * Plan-time payload accepted by {@link Exec}.call, with planned
 * placeholders permitted wherever a concrete value is.
 *
 * @category models
 * @since 0.1.0
 */
export type CallPayload = Action.PlannedPayload<(typeof Payload)["~type.make.in"]>

/**
 * Result of one completed tool run whose exit code was expected.
 *
 * `stdout` and `stderr` are truncated to {@link outputLimit}. Timing is
 * execution metadata and deliberately is not part of this semantic value.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Result = Schema.Struct({
  exitCode: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stdout: Schema.String.check(Schema.isMaxLength(outputLimit)),
  stderr: Schema.String.check(Schema.isMaxLength(outputLimit))
})

/**
 * Result of one completed tool run whose exit code was expected.
 *
 * @category models
 * @since 0.1.0
 */
export type Result = typeof Result.Type

/**
 * A tool run failed: it exited with an unexpected code, or it could not be
 * spawned at all, reported as `exitCode` -1.
 *
 * `cwd` is the payload's workspace-relative directory. `stdout` and `stderr`
 * carry the final {@link stderrTailLimit} units of their captured streams.
 * A failure before spawn leaves stdout empty and carries its message in
 * stderr.
 *
 * @category errors
 * @since 0.1.0
 */
export const ExecError = Schema.Struct({
  _tag: Schema.Literal("smithers-build/ExecError"),
  argv: Schema.NonEmptyArray(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String
})

/**
 * A typed external-tool failure.
 *
 * @category errors
 * @since 0.1.0
 */
export type ExecError = typeof ExecError.Type

const execError = (options: Omit<ExecError, "_tag">): ExecError => ({
  _tag: "smithers-build/ExecError",
  ...options
})

const inspect = <A>(what: string, operation: () => A): A => {
  try {
    return operation()
  } catch {
    throw new TypeError(`${what} could not be inspected safely`)
  }
}

const plainRecord = (value: unknown, what: string): Record<PropertyKey, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || NodeUtil.isProxy(value)) {
    throw new TypeError(`${what} must be a plain object`)
  }
  const prototype = inspect(what, () => Object.getPrototypeOf(value))
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${what} must be a plain object`)
  }
  return value as Record<PropertyKey, unknown>
}

const exactKeys = (value: Record<PropertyKey, unknown>, allowed: ReadonlySet<string>, what: string): void => {
  const keys = inspect(what, () => Reflect.ownKeys(value))
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${what} contains an unknown property`)
    }
  }
}

const requiredDataMember = (value: Record<PropertyKey, unknown>, name: string, what: string): unknown => {
  const descriptor = inspect(`${what}.${name}`, () => Object.getOwnPropertyDescriptor(value, name))
  if (descriptor === undefined) throw new TypeError(`${what}.${name} is missing`)
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`${what}.${name} must be an enumerable data property`)
  }
  return descriptor.value
}

const dataArray = (value: unknown, what: string, limit: number): Array<unknown> => {
  if (!Array.isArray(value) || NodeUtil.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${what} must be an array`)
  }
  if (value.length > limit) throw new TypeError(`${what} has more than ${limit} entries`)
  const names = inspect(what, () => Object.getOwnPropertyNames(value))
  if (
    inspect(what, () => Object.getOwnPropertySymbols(value)).length !== 0 ||
    names.length !== value.length + 1 ||
    !names.includes("length")
  ) {
    throw new TypeError(`${what} must be a dense array without extra properties`)
  }
  const nameSet = new Set(names)
  const output: Array<unknown> = []
  for (let index = 0; index < value.length; index += 1) {
    const name = String(index)
    if (!nameSet.has(name)) throw new TypeError(`${what} must be a dense array without extra properties`)
    const descriptor = inspect(`${what}[${name}]`, () => Object.getOwnPropertyDescriptor(value, name))
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${what}[${name}] must be an enumerable data property`)
    }
    output.push(descriptor.value)
  }
  return output
}

const diagnosticMember = (value: unknown, name: string): unknown => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || NodeUtil.isProxy(value)) {
    return undefined
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

const declaredDiagnostic = (value: unknown): { readonly argv: [string, ...Array<string>]; readonly cwd: string } => {
  const candidateArgv = diagnosticMember(value, "argv")
  let argv: [string, ...Array<string>] = ["<invalid exec payload>"]
  if (
    Array.isArray(candidateArgv) &&
    !NodeUtil.isProxy(candidateArgv) &&
    candidateArgv.length > 0 &&
    candidateArgv.length <= maximumArgvEntries
  ) {
    const rendered: Array<string> = []
    for (let index = 0; index < candidateArgv.length; index += 1) {
      const entry = diagnosticMember(candidateArgv, String(index))
      rendered.push(typeof entry === "string" ? head(entry, maximumTextBytes) : "<invalid exec argument>")
    }
    argv = rendered as [string, ...Array<string>]
  }
  const candidateCwd = diagnosticMember(value, "cwd")
  const cwd = typeof candidateCwd === "string" ? head(candidateCwd, maximumTextBytes) : "<invalid exec cwd>"
  return { argv, cwd }
}

/**
 * The one shared action every catalog target uses to run a tool.
 *
 * @category actions
 * @since 0.1.0
 */
export const Exec = Action.make("smithers-build/exec", {
  payload: Payload,
  success: Result,
  error: ExecError,
  tier: "sealed"
})

/**
 * Reports whether slicing `text` at `index` would split a surrogate pair.
 *
 * A bound counted in UTF-16 code units can land between the two halves of an
 * astral code point. Cutting there produces a lone surrogate, which is not
 * valid text and does not survive a round trip through JSON or a cache entry.
 */
const splitsPair = (text: string, index: number): boolean => {
  if (index <= 0 || index >= text.length) return false
  const high = text.charCodeAt(index - 1)
  const low = text.charCodeAt(index)
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
}

/** Keeps the leading `limit` code units without splitting a surrogate pair. */
const head = (text: string, limit: number): string =>
  text.length <= limit ? text : text.slice(0, splitsPair(text, limit) ? limit - 1 : limit)

/** Keeps the trailing `limit` code units without splitting a surrogate pair. */
const keepTail = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const at = text.length - limit
  return text.slice(splitsPair(text, at) ? at + 1 : at)
}

const tail = (text: string): string => keepTail(text, stderrTailLimit)

/**
 * Host variables needed to find executables and satisfy operating-system
 * process startup, plus `CI` — the cross-tool convention that switches a
 * tool into non-interactive mode. Withholding `CI` made pnpm treat a hosted
 * runner as an interactive terminal and abort on its first would-be prompt;
 * the variable carries a mode, not machine identity, so inheriting it keeps
 * tool behavior aligned with the host the run is actually on.
 *
 * `SDKROOT` and `DEVELOPER_DIR` are the same kind of variable one layer down:
 * they say where the platform's C headers and libraries live, the way `PATH`
 * says where its executables live. A macOS `cc` resolved through `PATH` to an
 * Xcode toolchain clang takes its sysroot from `SDKROOT` and looks nowhere
 * else, so withholding it fails any cargo target with a `-sys` dependency on
 * `'stdlib.h' file not found` — a host configuration problem reported as a
 * compile error three processes down.
 *
 * @category constants
 * @since 0.1.0
 */
export const inheritedEnvironmentNames: ReadonlyArray<string> = Object.freeze([
  "APPDATA",
  "CI",
  "COMSPEC",
  "DEVELOPER_DIR",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SDKROOT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME"
])

const usableText = (value: string, what: string): string => {
  if (value.includes("\0") || !value.isWellFormed()) throw new TypeError(`${what} is not usable text`)
  return value
}

/** Re-decodes and applies aggregate limits at the child-process trust boundary. */
const validatedPayload = (untrusted: Payload): Payload => {
  const record = plainRecord(untrusted, "exec payload")
  const allowed = new Set(["after", "argv", "cwd", "env", "expectedExitCodes", "secrets", "timeoutMs"])
  exactKeys(record, allowed, "exec payload")
  const environment = plainRecord(requiredDataMember(record, "env", "exec payload"), "exec environment")
  const environmentEntries = inspect("exec environment", () => Reflect.ownKeys(environment))
  if (environmentEntries.length > maximumEnvironmentEntries) {
    throw new TypeError(`exec environment has more than ${maximumEnvironmentEntries} entries`)
  }
  const untrustedEnv = Object.create(null) as Record<string, unknown>
  for (const name of environmentEntries) {
    if (typeof name !== "string") throw new TypeError("exec environment contains a symbol property")
    untrustedEnv[name] = requiredDataMember(environment, name, "exec environment")
  }
  const after = Object.getOwnPropertyDescriptor(record, "after")
  const candidate = {
    cwd: requiredDataMember(record, "cwd", "exec payload"),
    argv: dataArray(requiredDataMember(record, "argv", "exec payload"), "exec argv", maximumArgvEntries),
    env: untrustedEnv,
    expectedExitCodes: dataArray(
      requiredDataMember(record, "expectedExitCodes", "exec payload"),
      "exec expected exit codes",
      maximumExpectedExitCodes
    ),
    secrets: dataArray(
      requiredDataMember(record, "secrets", "exec payload"),
      "exec secrets",
      maximumSecrets
    ),
    timeoutMs: requiredDataMember(record, "timeoutMs", "exec payload"),
    ...(after === undefined ? {} : { after: requiredDataMember(record, "after", "exec payload") })
  }
  const payload = Schema.decodeUnknownSync(Payload)(candidate)
  usableText(payload.cwd, "exec cwd")
  let argvBytes = 0
  for (const [index, value] of payload.argv.entries()) {
    usableText(value, `exec argv[${index}]`)
    if (index === 0 && value === "") throw new TypeError("exec argv[0] must name an executable")
    argvBytes += Buffer.byteLength(value, "utf8")
    if (!Number.isSafeInteger(argvBytes) || argvBytes > maximumArgvBytes) {
      throw new TypeError(`exec argv exceeds ${maximumArgvBytes} bytes`)
    }
  }
  const env = Object.create(null) as Record<string, string>
  const folded = new Set<string>()
  let environmentBytes = 0
  const entries = Object.entries(payload.env)
  if (entries.length > maximumEnvironmentEntries) {
    throw new TypeError(`exec environment has more than ${maximumEnvironmentEntries} entries`)
  }
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`exec environment name is not portable: ${JSON.stringify(name)}`)
    }
    usableText(value, `exec environment ${name}`)
    const key = name.toUpperCase()
    if (folded.has(key)) {
      throw new TypeError(`exec environment repeats a case-insensitive name: ${JSON.stringify(name)}`)
    }
    folded.add(key)
    environmentBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8")
    if (!Number.isSafeInteger(environmentBytes) || environmentBytes > maximumEnvironmentBytes) {
      throw new TypeError(`exec environment exceeds ${maximumEnvironmentBytes} bytes`)
    }
    env[name] = value
  }
  if (new Set(payload.expectedExitCodes).size !== payload.expectedExitCodes.length) {
    throw new TypeError("exec expected exit codes contain a duplicate")
  }
  const secretNames = new Set<string>()
  for (const secret of payload.secrets) {
    usableText(secret.env, "exec secret name")
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.env)) {
      throw new TypeError(`exec secret name is not portable: ${JSON.stringify(secret.env)}`)
    }
    // Two declarations of one variable would mint one placeholder and read the
    // same value twice. Refusing says so at the boundary instead of silently
    // collapsing them.
    if (secretNames.has(secret.env.toUpperCase())) {
      throw new TypeError(`exec declares the secret ${JSON.stringify(secret.env)} twice`)
    }
    secretNames.add(secret.env.toUpperCase())
    if (Object.hasOwn(env, secret.env)) {
      throw new TypeError(
        `exec sets ${JSON.stringify(secret.env)} in env and also declares it as a secret`
      )
    }
  }
  return {
    ...payload,
    argv: [...payload.argv],
    env,
    secrets: [...payload.secrets],
    expectedExitCodes: [...payload.expectedExitCodes]
  }
}

const validatedSensitiveNames = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (names.length > maximumEnvironmentEntries) throw new TypeError("too many sensitive environment names")
  const output: Array<string> = []
  const seen = new Set<string>()
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`sensitive environment name is not portable: ${JSON.stringify(name)}`)
    }
    const key = process.platform === "win32" ? name.toUpperCase() : name
    if (!seen.has(key)) {
      seen.add(key)
      output.push(name)
    }
  }
  return output
}

const hostValue = (name: string): string | undefined => {
  if (process.platform !== "win32") return process.env[name]
  const found = Object.keys(process.env).find((entry) => entry.toUpperCase() === name)
  return found === undefined ? undefined : process.env[found]
}

/**
 * Constructs the deliberately narrow ambient environment visible to a tool.
 *
 * `secretEnv` is applied last, after withholding, because a declared secret is
 * the one case where a variable is meant to reach the child. What reaches it is
 * a minted placeholder and the loopback proxy endpoint, never a credential, so
 * ordering it after the withholding pass grants no ambient authority.
 */
const toolEnvironment = (
  declared: Readonly<Record<string, string>>,
  sensitiveEnv: ReadonlyArray<string>,
  secretEnv: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv => {
  const env = Object.create(null) as NodeJS.ProcessEnv
  for (const name of inheritedEnvironmentNames) {
    const value = hostValue(name)
    if (value !== undefined) env[name] = value
  }
  env["CLICOLOR"] = "0"
  env["FORCE_COLOR"] = "0"
  env["LANG"] = "C"
  env["LC_ALL"] = "C"
  env["NO_COLOR"] = "1"
  for (const [name, value] of Object.entries(declared)) env[name] = value
  const withheld = new Set(
    ["SMITHERS_CACHE_URL", "SMITHERS_CACHE_TOKEN", ...sensitiveEnv].map((name) =>
      process.platform === "win32" ? name.toUpperCase() : name
    )
  )
  for (const name of Object.keys(env)) {
    const key = process.platform === "win32" ? name.toUpperCase() : name
    if (withheld.has(key)) delete env[name]
  }
  for (const [name, value] of Object.entries(secretEnv)) env[name] = value
  return env
}

const inside = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative))
}

/** Resolves symlinks through the nearest existing ancestor of one path. */
const realpath = (absolute: string): string => {
  let current = absolute
  const suffix: Array<string> = []
  while (true) {
    try {
      return NodePath.resolve(NodeFs.realpathSync(current), ...suffix)
    } catch (cause) {
      const code = SafeFs.errorCode(cause)
      if (code !== "ENOENT" && code !== "ENOTDIR") throw cause
      const parent = NodePath.dirname(current)
      if (parent === current) throw cause
      suffix.unshift(NodePath.basename(current))
      current = parent
    }
  }
}

/**
 * Resolves a path against a workspace and refuses lexical or symlink escapes.
 *
 * The returned path keeps its lexical spelling so a generated-file rename can
 * replace an in-workspace symlink rather than unexpectedly writing through it.
 * Validation resolves the nearest existing ancestor, so a missing output below
 * a symlinked directory is checked against the symlink's real destination.
 *
 * @category validation
 * @since 0.1.0
 */
export const resolveWorkspacePath = (workspaceRoot: string, value: string): string => {
  const root = NodeFs.realpathSync(NodePath.resolve(workspaceRoot))
  const absolute = NodePath.resolve(root, value)
  if (!inside(root, absolute) || !inside(root, realpath(absolute))) {
    throw new Error(`path leaves the workspace: ${value}`)
  }
  return absolute
}

/**
 * Bounded head and tail of one decoded stream.
 *
 * The decoder is per stream and stateful. `Buffer.toString("utf8")` on each
 * chunk independently is wrong for the same reason reading a stream one packet
 * at a time is: a code point split across a chunk boundary decodes as two
 * replacement characters, so the captured text depends on how the kernel
 * happened to break the pipe up. That made one tool's output differ between
 * runs, and a cached result differ from the run that produced it. A streaming
 * decoder holds the partial sequence until the rest of it arrives.
 *
 * @category models
 * @since 0.1.0
 */
interface Capture {
  readonly decoder: TextDecoder
  head: string
  headComplete: boolean
  tail: string
}

const capture = (): Capture => ({ decoder: new TextDecoder("utf-8"), head: "", headComplete: false, tail: "" })

/** Adds decoded text to the bounded prefix exactly until its first overflow. */
const appendHead = (target: Capture, text: string): void => {
  if (target.headComplete) return
  const remaining = outputLimit - target.head.length
  if (text.length <= remaining) {
    target.head += text
    return
  }
  target.head += head(text, remaining)
  // When the boundary splits a pair, `head` deliberately leaves one code unit
  // unused. That slot may not be filled from a later chunk: doing so would make
  // the captured prefix depend on where the kernel split the pipe.
  target.headComplete = true
}

/** Adds one stream chunk while keeping only bounded head and tail buffers. */
const append = (target: Capture, chunk: Uint8Array): void => {
  const text = target.decoder.decode(chunk, { stream: true })
  if (text === "") return
  appendHead(target, text)
  target.tail = keepTail(target.tail + text, stderrTailLimit)
}

/** Flushes any trailing partial sequence as the replacement character. */
const finish = (target: Capture): void => {
  const text = target.decoder.decode()
  if (text === "") return
  appendHead(target, text)
  target.tail = keepTail(target.tail + text, stderrTailLimit)
}

interface Spawned {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTail: string
  readonly stderrTail: string
}

/**
 * Kills one child and, where the host has process groups, everything it
 * started.
 *
 * The child is spawned detached so it leads its own process group and a single
 * negative-pid signal reaches its descendants too. Windows has no process
 * groups and no signals: `detached` there means a separate console, the
 * negative-pid call fails, and the fallback terminates only the child itself.
 * A grandchild started on Windows outlives the kill, and no Node API changes
 * that.
 */
const killTree = (child: NodeChildProcess.ChildProcess): void => {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL")
      return
    } catch {
      // Fall through when process groups are unavailable on this host.
    }
  }
  try {
    child.kill("SIGKILL")
  } catch {
    // The process may have settled between the state check and the signal.
  }
}

/** Spawns argv in the resolved directory, never through a shell. */
const spawnTool = (
  cwd: string,
  payload: Payload,
  sensitiveEnv: ReadonlyArray<string>,
  secretEnv: Readonly<Record<string, string>>,
  onStdout?: ((chunk: Uint8Array) => void) | undefined,
  onStderr?: ((chunk: Uint8Array) => void) | undefined
): Effect.Effect<Spawned, ExecError> =>
  Effect.callback<Spawned, ExecError>((resume) => {
    const [executable, ...args] = payload.argv
    const env = toolEnvironment(payload.env, sensitiveEnv, secretEnv)
    let child: NodeChildProcess.ChildProcess
    try {
      child = NodeChildProcess.spawn(executable, args, {
        cwd,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      })
    } catch (cause) {
      resume(Effect.fail(
        execError({
          argv: payload.argv,
          cwd: payload.cwd,
          exitCode: -1,
          stdout: "",
          stderr: tail(failureMessage(cause))
        })
      ))
      return Effect.void
    }
    const stdout = capture()
    const stderr = capture()
    // A failed spawn emits `error` and then `close`, and a stream error can
    // arrive alongside either. Both would resume the same callback twice, which
    // is a defect rather than a second answer, so the first settlement wins and
    // every listener is dropped with it.
    let settled = false
    const settle = (outcome: Effect.Effect<Spawned, ExecError>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resume(outcome)
    }
    const failure = (message: string, out: string): void =>
      settle(Effect.fail(
        execError({
          argv: payload.argv,
          cwd: payload.cwd,
          exitCode: -1,
          stdout: out,
          stderr: tail(message)
        })
      ))
    // A pipe that fails mid-run would otherwise emit an unhandled `error` and
    // take the whole process down. The run fails instead: the captured text is
    // incomplete, and reporting it as a result would cache a truncated stream.
    let streamFailure: string | undefined
    const pipeFailed = (stream: "stdout" | "stderr") => (error: NodeJS.ErrnoException): void => {
      if (settled) return
      streamFailure ??= `${stream} could not be read: ${error.message}`
      killTree(child)
    }
    const timer = setTimeout(() => {
      killTree(child)
      failure(`the tool timed out after ${payload.timeoutMs}ms`, stdout.tail)
    }, payload.timeoutMs)
    if (child.stdout === null || child.stderr === null) {
      killTree(child)
      failure("the child was spawned without a stdout and stderr pipe", "")
      return Effect.sync(() => killTree(child))
    }
    child.stdout.on("data", (chunk: Buffer) => {
      if (!settled) {
        append(stdout, chunk)
        onStdout?.(chunk)
      }
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (!settled) {
        append(stderr, chunk)
        onStderr?.(chunk)
      }
    })
    child.stdout.on("error", pipeFailed("stdout"))
    child.stderr.on("error", pipeFailed("stderr"))
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return
      // Flush both decoders as the close path does, so a trailing partial
      // sequence shows up as the replacement character instead of vanishing
      // from the tail the diagnostic carries.
      finish(stdout)
      finish(stderr)
      failure(error.message, stdout.tail)
    })
    child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      finish(stdout)
      finish(stderr)
      if (streamFailure !== undefined) return failure(streamFailure, stdout.tail)
      // A signalled child has no exit code. Reporting only -1 loses the one
      // fact that explains the failure, so the signal is named in the tail the
      // diagnostic carries.
      if (exitCode === null && signal !== null) {
        return failure(`${stderr.tail}\nthe tool was terminated by ${signal}`, stdout.tail)
      }
      settle(Effect.succeed({
        exitCode: exitCode ?? -1,
        stdout: stdout.head,
        stderr: stderr.head,
        stdoutTail: stdout.tail,
        stderrTail: stderr.tail
      }))
    })
    return Effect.sync(() => {
      settled = true
      clearTimeout(timer)
      killTree(child)
    })
  })

/**
 * Mints placeholders for one run's declared secrets and brackets the spawn with
 * the substituting proxy.
 *
 * The vault lives exactly as long as the child. Nothing is minted when the
 * payload declares no secret, so the ordinary tool run starts no server and
 * pays nothing.
 *
 * The child receives the placeholder under the declared variable name and the
 * proxy endpoint under the conventional proxy variables. It never receives the
 * credential, so a tool that dumps its environment, writes it to a log, or
 * passes it to a subprocess leaks a value that is worthless off this host.
 */
const withSecretEnvironment = <A, E>(
  secrets: ReadonlyArray<Secret.Secret>,
  diagnostic: { readonly argv: readonly [string, ...Array<string>]; readonly cwd: string },
  use: (secretEnv: Readonly<Record<string, string>>) => Effect.Effect<A, E>
): Effect.Effect<A, E | ExecError> => {
  if (secrets.length === 0) return use({})
  const vault = SecretProxy.makeVault()
  const minted: Record<string, string> = {}
  for (const secret of secrets) minted[secret.env] = vault.mint(secret)
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => SecretProxy.startProxy(vault),
      catch: (cause) =>
        execError({
          argv: diagnostic.argv,
          cwd: diagnostic.cwd,
          exitCode: -1,
          stdout: "",
          stderr: tail(`the secret substitution proxy did not start: ${failureMessage(cause)}`)
        })
    }),
    (proxy) => {
      const secretEnv: Record<string, string> = { ...minted, HTTP_PROXY: proxy.endpoint, HTTPS_PROXY: proxy.endpoint }
      // Tools split on which spelling they read, and a host with
      // case-insensitive environment variables would see the two as one name.
      if (process.platform !== "win32") {
        secretEnv["http_proxy"] = proxy.endpoint
        secretEnv["https_proxy"] = proxy.endpoint
      }
      return use(secretEnv)
    },
    (proxy) => Effect.promise(() => proxy.close())
  )
}

/**
 * Executes one payload with workspace confinement and bounded stream capture.
 *
 * This shared implementation backs both sealed and irreversible exec actions.
 * It strips the remote-cache credential after merging the payload environment,
 * so a BUILD.ts declaration cannot add the credential back to a child.
 *
 * @category execution
 * @since 0.1.0
 */
export const run = (
  options: {
    readonly workspaceRoot: string
    readonly cacheDirectory?: string | undefined
    readonly sensitiveEnv?: ReadonlyArray<string> | undefined
    /** Receives stdout bytes as the child produces them. */
    readonly onStdout?: ((chunk: Uint8Array) => void) | undefined
    /** Receives stderr bytes as the child produces them. */
    readonly onStderr?: ((chunk: Uint8Array) => void) | undefined
  },
  untrustedPayload: Payload
): Effect.Effect<Result, ExecError> => {
  const diagnostic = declaredDiagnostic(untrustedPayload)
  return Effect.flatMap(
    Effect.try({
      try: () => {
        const payload = validatedPayload(untrustedPayload)
        const sensitiveEnv = validatedSensitiveNames(options.sensitiveEnv ?? [])
        const cacheDirectory = options.cacheDirectory === undefined
          ? Config.defaultCacheDirectory
          : Config.normalizeCacheDirectory(options.cacheDirectory)
        // The token is replaced by a real host directory that a tool will then
        // write into, so the directory gets the same confinement check every
        // other path crossing this boundary gets. `normalizeCacheDirectory`
        // settles the lexical question only: a `.flows` that is a symbolic
        // link to somewhere else entirely is refused here.
        resolveWorkspacePath(options.workspaceRoot, cacheDirectory)
        const substitute = (value: string): string => value.replaceAll(cacheDirectoryToken, cacheDirectory)
        const [executable, ...args] = payload.argv
        const resolved: Payload = {
          ...payload,
          argv: [substitute(executable), ...args.map(substitute)]
        }
        return { resolved, sensitiveEnv, cwd: resolveWorkspacePath(options.workspaceRoot, resolved.cwd) }
      },
      catch: (cause) =>
        execError({
          argv: diagnostic.argv,
          cwd: diagnostic.cwd,
          exitCode: -1,
          stdout: "",
          stderr: tail(failureMessage(cause))
        })
    }),
    ({ cwd, resolved, sensitiveEnv }) =>
      withSecretEnvironment(resolved.secrets, diagnostic, (secretEnv) =>
        Effect.flatMap(
          spawnTool(cwd, resolved, sensitiveEnv, secretEnv, options.onStdout, options.onStderr),
          (output) =>
            resolved.expectedExitCodes.includes(output.exitCode)
              ? Effect.succeed({
                exitCode: output.exitCode,
                stdout: output.stdout,
                stderr: output.stderr
              })
              : Effect.fail(
                execError({
                  argv: resolved.argv,
                  cwd: resolved.cwd,
                  exitCode: output.exitCode,
                  stdout: output.stdoutTail,
                  stderr: output.stderrTail
                })
              )
        ))
  )
}

/**
 * Implements {@link Exec} with `node:child_process` spawn.
 *
 * The payload `cwd` resolves inside the real workspace root. The payload `env`
 * merges over only the host variables needed for executable lookup, temporary
 * files, and operating-system startup; arbitrary ambient variables are not
 * exposed. Fixed locale and no-color values make output stable. The boundary
 * then drops both built-in remote-cache variables and every name in
 * `sensitiveEnv`, even when the payload tried to add one back. Any
 * {@link cacheDirectoryToken} in an argument is replaced by the host directory
 * immediately before spawn, keeping the real path out of the action payload
 * and step key. That directory is confined to the workspace first, symbolic
 * links included, so substitution can never hand a tool a path outside it.
 * Killing the fiber or reaching `timeoutMs` kills the child's process group.
 *
 * @category layers
 * @since 0.1.0
 */
export const ExecLive = (options: {
  readonly workspaceRoot: string
  readonly cacheDirectory?: string | undefined
  readonly sensitiveEnv?: ReadonlyArray<string> | undefined
}): Layer.Layer<Action.Requirement<"smithers-build/exec">, never, FlowRuntime.FlowRuntime> =>
  Exec.toLayer((payload) => run(options, payload))
