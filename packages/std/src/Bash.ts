/**
 * Bash flow declaration and portable handler.
 *
 * Two ways in, and the difference is where the payload is parsed. `command` is
 * a line for the platform shell, exactly as before. `script` is program text
 * delivered to an interpreter on standard input, as data: nothing quotes it,
 * escapes it, or terminates it with a heredoc marker, so the class of failure
 * that produced `docker exec c bash -lc '…python - <<EOF…'` cannot occur. Its
 * `args` reach the script as arguments rather than as interpolated text.
 *
 * `container` names a container the host knows how to reach, and the argv is
 * built by the injected {@link Container} transport rather than typed by the
 * caller. A host that binds no transport refuses such a call by saying so; the
 * requirement is optional here precisely so a host without containers is not
 * forced to declare one.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Path from "@smthrs/kernel/Path"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Container from "./Container.ts"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Exec from "./internal/Exec.ts"
import { withinEnvelope } from "./internal/Paths.ts"
import { MAX_SHELL_OUTPUT_BYTES, truncateBytes } from "./internal/Text.ts"
import * as Probe from "./Probe.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the bash flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "bash"

/**
 * Model-facing description of the bash flow.
 *
 * Capped at 200 characters and read every frame, which is why the
 * invalid-probe contract is not restated here: the cell contract teaches it
 * once, and a result that has one explains itself.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "Run a shell command, or an interpreter over a script passed as data instead of quoted into a line. container routes it through the host's container transport. mode:hermetic pre-checks path tokens."

const Command = Schema.optional(Schema.String.annotate({
  description: "Shell command line to execute; give this or script, never both"
}))
const Script = Schema.optional(Schema.String.annotate({
  description: "Program text delivered to the interpreter on stdin as data, so it needs no quoting or heredoc"
}))
const Interpreter = Schema.optional(Schema.String.annotate({
  description:
    "Program that reads script on stdin; defaults to bash. python, python3, sh, zsh, node, ruby and perl are known"
}))
const Args = Schema.optional(
  Schema.Array(Schema.String).annotate({
    description: "Arguments passed to the script as data, never interpolated into it"
  })
)
const Stdin = Schema.optional(Schema.String.annotate({
  description: "Text written to the command's standard input; use script instead when the text is the program"
}))
const ContainerName = Schema.optional(Schema.String.annotate({
  description: "Run inside this container through the host's container transport; requires mode:unhermetic"
}))
const Cwd = Schema.optional(Schema.String.annotate({ description: "Working directory for the command" }))
const Env = Schema.optional(
  Schema.Record(Schema.String, Schema.String).annotate({ description: "Environment variables for the command" })
)
const TimeoutMs = Schema.optional(
  Schema.Number.annotate({ description: "Wall-clock timeout in milliseconds" })
)

/**
 * Input schema for the bash flow.
 *
 * The mode named `hermetic` requires explicit read and write envelopes for a
 * lexical pre-check; it does not by itself confine the process. Unhermetic mode
 * deliberately omits those declarations so the distinction stays visible in
 * the input shape.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("hermetic").annotate({
      description: "Lexically pre-check explicit path tokens against declared reads and writes; does not sandbox"
    }),
    command: Command,
    script: Script,
    interpreter: Interpreter,
    args: Args,
    stdin: Stdin,
    container: ContainerName,
    reads: Schema.Array(Schema.String).annotate({ description: "Paths or path globs the command may read" }),
    writes: Schema.Array(Schema.String).annotate({ description: "Paths or path globs the command may write" }),
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs
  }),
  Schema.Struct({
    mode: Schema.Literal("unhermetic").annotate({
      description: "Run without a declared filesystem envelope as an irreversible effect"
    }),
    command: Command,
    script: Script,
    interpreter: Interpreter,
    args: Args,
    stdin: Stdin,
    container: ContainerName,
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs
  })
])

/**
 * Decoded input accepted by the bash handler.
 *
 * @category models
 * @since 0.1.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the bash flow.
 *
 * `invalidProbe` is the one field that is not a fact about the process. It is
 * present only when the exit code describes the command rather than the code
 * the command was meant to check, which is the distinction an exit code alone
 * cannot carry. See `Probe`.
 *
 * The `<stream>Truncated` flags are a wire convention, not a display detail.
 * A truncated capture is a fragment of what the process printed, and the
 * harness reads these flags to refuse a later write of those exact bytes —
 * `@smthrs/harness/TruncatedOutput` is the consuming half. Renaming a flag, or
 * dropping it when the capture is cut, disarms that guard silently.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  exitCode: Schema.Number.annotate({ description: "Command exit code, including non-zero codes" }),
  stdout: Schema.String.annotate({
    description: "Captured stdout; only the tail, and not the whole output, when stdoutTruncated is true"
  }),
  stderr: Schema.String.annotate({
    description: "Captured stderr; only the tail, and not the whole output, when stderrTruncated is true"
  }),
  stdoutTruncated: Schema.Boolean.annotate({
    description:
      "Whether stdout exceeded the capture limit, leaving stdout a fragment that must not be written to a file"
  }),
  stderrTruncated: Schema.Boolean.annotate({
    description:
      "Whether stderr exceeded the capture limit, leaving stderr a fragment that must not be written to a file"
  }),
  stdoutDroppedBytes: Schema.Number.annotate({ description: "UTF-8 bytes omitted from the start of stdout" }),
  stderrDroppedBytes: Schema.Number.annotate({ description: "UTF-8 bytes omitted from the start of stderr" }),
  invalidProbe: Schema.optional(
    Probe.InvalidProbe.annotate({
      description:
        "Present when the command named something that does not exist, so the non-zero exit is about the command and not about the code under test"
    })
  )
})

/**
 * Decoded output returned by the bash handler.
 *
 * @category models
 * @since 0.1.0
 */
export type Output = typeof Output.Type

/**
 * Static conservative effect envelope for the bash flow.
 *
 * The declaration is the registry-time worst case because the mode is not
 * known until an invocation is decoded.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({
  tier: "irreversible",
  mode: "expected",
  reads: [],
  writes: []
})

/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (input: Input) =>
  input.mode === "hermetic"
    ? envelope({
      tier: "compensable",
      mode: "hermetic",
      reads: input.reads,
      writes: input.writes
    })
    : envelope({
      tier: "irreversible",
      mode: "expected",
      reads: [],
      writes: []
    })

/**
 * Capabilities required by the bash flow.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("proc:spawn", "*")]

/**
 * Declaration-only bash flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

type Access = "read" | "write"

interface PathReference {
  readonly access: Access
  readonly value: string
}

const commandSeparators = new Set(["&&", "||", ";", "|", "&"])
const redirections = new Set([">", ">>", "<", "<<"])
const writeCommands = new Set(["chmod", "chown", "mkdir", "rm", "rmdir", "tee", "touch", "truncate", "unlink"])
const destinationCommands = new Set(["cp", "install", "mv"])

const tokenize = (command: string): ReadonlyArray<string> =>
  command.match(/"(?:\\.|[^"\\])*"|'[^']*'|>>|<<|&&|\|\||[<>;|&]|[^\s<>;|&]+/g) ?? []

const unquote = (token: string): string => {
  const first = token[0]
  const last = token[token.length - 1]
  return token.length >= 2 && (first === "'" || first === "\"") && last === first
    ? token.slice(1, -1)
    : token
}

const pathValue = (token: string): string =>
  unquote(token)
    .replace(/^\$\(+/, "")
    .replace(/[),]+$/, "")

const isPathToken = (path: Path.Path, token: string): boolean =>
  token === "." ||
  token === ".." ||
  token.startsWith("./") ||
  token.startsWith("../") ||
  path.isAbsolute(token) ||
  /^[A-Za-z]:[\\/]/.test(token) ||
  token.includes("/")

const segmentReferences = (path: Path.Path, tokens: ReadonlyArray<string>): ReadonlyArray<PathReference> => {
  const commandIndex = tokens.findIndex((token) =>
    !redirections.has(token) &&
    !token.includes("=") &&
    token !== ""
  )
  if (commandIndex === -1) return []

  const command = path.basename(pathValue(tokens[commandIndex]!))
  const candidates: Array<{ readonly index: number; readonly value: string }> = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (index === commandIndex || redirections.has(token) || token.startsWith("-")) continue
    const value = pathValue(token)
    if (value !== "" && isPathToken(path, value)) candidates.push({ index, value })
  }

  const destinationIndex = destinationCommands.has(command)
    ? candidates[candidates.length - 1]?.index
    : undefined

  return candidates
    // /dev/* is the process plumbing every shell one-liner leans on —
    // `2>/dev/null`, `cat /dev/stdin` — not a workspace effect. Requiring it
    // in the declared write set taught agents to redeclare boilerplate one
    // refused frame at a time.
    .filter(({ value }) => !value.startsWith("/dev/"))
    .map(({ index, value }) => {
      const previous = tokens[index - 1]
      const access: Access = previous === ">" || previous === ">>" ||
          writeCommands.has(command) || destinationIndex === index
        ? "write"
        : "read"
      return { access, value }
    })
}

const commandReferences = (path: Path.Path, command: string): ReadonlyArray<PathReference> => {
  const references: Array<PathReference> = []
  let segment: Array<string> = []
  for (const token of tokenize(command)) {
    if (commandSeparators.has(token)) {
      references.push(...segmentReferences(path, segment))
      segment = []
    } else {
      segment.push(token)
    }
  }
  references.push(...segmentReferences(path, segment))
  return references
}

const isDeclared = (
  declared: ReadonlyArray<string>,
  source: string,
  resolved: string
): boolean => withinEnvelope(declared, source) || withinEnvelope(declared, resolved)

const outsideEnvelope = (
  input: Extract<Input, { readonly mode: "hermetic" }>,
  text: string,
  path: Path.Path
): StdError.StdError | undefined => {
  const base = path.resolve(".")
  const cwd = path.resolve(input.cwd ?? ".")
  // Passing the default explicitly is not a declaration the caller owes. A
  // working directory is where the command runs, not a file it reads, and
  // `cwd: "."` names exactly what omitting `cwd` names — so refusing it asked
  // the caller to list the workspace root among its reads to say nothing at
  // all. Agents hit this constantly: one SWE-bench run spent ten of its
  // forty-eight tool calls re-issuing the same command after
  // "Working directory is outside declared reads: <the workspace root>". A
  // cwd that points somewhere else is still declared or refused.
  if (input.cwd !== undefined && cwd !== base && !isDeclared(input.reads, input.cwd, cwd)) {
    return new StdError.StdError({
      code: "outside_declared_reads",
      message: `Working directory is outside declared reads: ${cwd}`,
      path: cwd
    })
  }

  // The Shell contract currently has no sandbox or access-reporting surface.
  // This lexical scan is intentionally only a fail-closed pre-check for
  // explicit path tokens. It cannot prove confinement; a kernel/host sandbox
  // must eventually enforce and report the complete read and write sets.
  for (const reference of commandReferences(path, text)) {
    const resolved = path.isAbsolute(reference.value)
      ? path.normalize(reference.value)
      : path.resolve(cwd, reference.value)
    const declared = reference.access === "write" ? input.writes : input.reads
    if (!isDeclared(declared, reference.value, resolved)) {
      const code = reference.access === "write" ? "outside_declared_writes" : "outside_declared_reads"
      return new StdError.StdError({
        code,
        message: `Command path is outside declared ${reference.access}s: ${resolved}`,
        path: resolved
      })
    }
  }
  return undefined
}

/**
 * How each known interpreter is told to read its program from standard input.
 *
 * No login flag appears here. Inside a container every invocation is wrapped in
 * a login shell by {@link request}, and a local spawn already inherits the
 * host's environment, so the interpreter is asked for nothing but "read the
 * program from stdin".
 */
const stdinArguments = (interpreter: string): ReadonlyArray<string> => {
  switch (interpreter) {
    case "bash":
    case "zsh":
    case "sh":
    case "dash":
      return ["-s"]
    case "python":
    case "python3":
      return ["-"]
    default:
      // node, ruby, perl and their kin read a program from standard input when
      // they are given no file to run.
      return []
  }
}

/** Whether a script is shell text the lexical pre-check can actually read. */
const shells = new Set(["bash", "zsh", "sh", "dash"])

/** What one invocation runs, before any container transport rewrites it. */
interface Plan {
  readonly file: string
  readonly args: ReadonlyArray<string> | undefined
  readonly stdin: string | undefined
  readonly quoted: string
}

const invalid = (message: string): StdError.StdError => new StdError.StdError({ code: "invalid_input", message })

/** The invocation an input names, or the failure explaining why it names none. */
const plan = (input: Input): Plan | StdError.StdError => {
  const interpreter = input.interpreter ?? "bash"
  if (input.command !== undefined && input.script !== undefined) {
    return invalid("Give command or script, never both: a script is program text, a command is a shell line")
  }
  if (input.command === undefined && input.script === undefined) {
    return invalid("Give either command (a shell line) or script (program text run by interpreter)")
  }
  if (input.script !== undefined && input.stdin !== undefined) {
    return invalid("A script already arrives on standard input, so it cannot also carry stdin")
  }
  if (input.command !== undefined && input.args !== undefined) {
    return invalid("args belong to a script; a command carries its own arguments in the line")
  }
  if (input.command !== undefined && input.interpreter !== undefined) {
    return invalid("interpreter runs a script; a command runs in the platform shell")
  }
  if (input.mode === "hermetic" && input.container !== undefined) {
    return invalid(
      "A container has its own filesystem, so declared reads and writes cannot describe it. Use mode:unhermetic for a containerised command"
    )
  }
  if (input.mode === "hermetic" && input.script !== undefined && !shells.has(interpreter)) {
    return invalid(
      `The hermetic pre-check reads shell text, and ${interpreter} is not a shell. Run this script with mode:unhermetic, or express it as shell`
    )
  }
  if (input.command !== undefined) {
    return { file: input.command, args: undefined, stdin: input.stdin, quoted: input.command }
  }
  const args = [...stdinArguments(interpreter), ...(input.args ?? [])]
  return {
    file: interpreter,
    args,
    stdin: input.script,
    quoted: [interpreter, ...args].join(" ")
  }
}

/** The plan as the host will spawn it, once the container transport has had it. */
const routed = (
  plan: Plan,
  input: Input,
  transport: Option.Option<Container.Container>
): Effect.Effect<Plan, StdError.StdError> => {
  if (input.container === undefined) return Effect.succeed(plan)
  if (Option.isNone(transport)) return Effect.fail(Container.unavailable(input.container))
  return Effect.map(
    transport.value.exec(request(plan, input)),
    (routing): Plan => ({
      file: routing.file,
      args: routing.args,
      stdin: plan.stdin,
      quoted: [routing.file, ...routing.args].join(" ")
    })
  )
}

/**
 * One containerised request, always through a login shell.
 *
 * A container's environment is what its profile makes it. The images this
 * harness runs against activate the project's interpreter — a conda env, a
 * virtualenv, a modified `PATH` — from `/etc/profile.d`, so a program spawned
 * directly by `docker exec` gets a different Python from the one that owns the
 * repository's dependencies. That is measured, not theoretical: r90 typed
 * `docker exec … bash -lc '…'` by hand and got the activation for free, r91
 * routed `interpreter: "python3"` straight at the container and filled its
 * traces with `ModuleNotFoundError: No module named 'numpy'` and
 * `exec: "/usr/local/bin/python": no such file or directory`. Thirty of 45
 * instances then spent 138 cells scanning `/opt` for the real interpreter.
 *
 * So the login shell is the transport's, not the caller's. A command line is
 * one argument to `bash -lc`, as before. A program run under an interpreter
 * becomes `bash -lc 'exec "$@"' bash <interpreter> <args…>`: the shell reads
 * the profile, then `exec` replaces it with the interpreter, so the script
 * still arrives on the inherited standard input and no argument is ever
 * re-parsed as shell text.
 */
const request = (plan: Plan, input: Input): Container.Request => ({
  container: input.container ?? "",
  file: "bash",
  args: plan.args === undefined
    ? ["-lc", plan.file]
    : ["-lc", `exec "$@"`, "bash", plan.file, ...plan.args],
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  ...(input.env === undefined ? {} : { env: input.env }),
  stdin: plan.stdin !== undefined
})

const hostError = (command: string, error: unknown): StdError.StdError => {
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  return new StdError.StdError({
    code: code === "timeout" ? "timeout" : "command_failed",
    message: code === "timeout"
      ? `Command timed out: ${command}`
      : `Command failed to start: ${message}`
  })
}

/**
 * Executes a shell command through the permission-aware kernel service.
 *
 * Non-zero exit codes remain successful values. Only timeout, host, permission,
 * and declared-envelope pre-check failures use the typed error channel.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("Bash.run")(function*(
  input: Input
): Effect.fn.Return<Output, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner | Path.Path> {
  const path = yield* Path.Path
  const intent = plan(input)
  if (intent instanceof StdError.StdError) return yield* Effect.fail(intent)
  if (input.mode === "hermetic") {
    const violation = outsideEnvelope(input, input.command ?? input.script ?? "", path)
    if (violation !== undefined) return yield* Effect.fail(violation)
  }
  // A container owns the working directory and the environment of what runs in
  // it, so those travel in the transport's argv rather than in the host spawn.
  const contained = input.container !== undefined
  const spawned = yield* routed(intent, input, yield* Effect.serviceOption(Container.Container))

  const result = yield* Exec.exec(spawned.file, {
    ...(input.cwd === undefined || contained ? {} : { cwd: input.cwd }),
    ...(input.env === undefined || contained ? {} : { env: input.env }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(spawned.args === undefined ? {} : { args: spawned.args }),
    ...(spawned.stdin === undefined ? {} : { stdin: spawned.stdin })
  }).pipe(Effect.mapError((error) => hostError(spawned.quoted, error)))
  const stdout = truncateBytes(result.stdout, MAX_SHELL_OUTPUT_BYTES, { keep: "tail" })
  const stderr = truncateBytes(result.stderr, MAX_SHELL_OUTPUT_BYTES, { keep: "tail" })
  // Classified against the text this call returns rather than the text it
  // captured, so the evidence line is always quotable from what the caller can
  // read. Truncation keeps the tail, which is where a runner prints its refusal.
  const probe = Probe.classify({ exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text })
  return {
    exitCode: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutDroppedBytes: stdout.droppedBytes,
    stderrDroppedBytes: stderr.droppedBytes,
    ...(probe === undefined ? {} : { invalidProbe: probe })
  }
})
