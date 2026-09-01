/**
 * Runs a child flow's own code inside a provisioned sandbox machine.
 *
 * `Sandbox.layerHost` places a body's SIDE EFFECTS on a machine: its file
 * operations and child processes go to one held session while its TypeScript
 * keeps running in the engine host. This module is the tier above that. The
 * child flow's code EXECUTES inside the guest: the entry module that declares
 * it is bundled into one self-contained file, the bundle is written into the
 * session's workspace beside a request JSON, the guest runtime runs it with
 * `SMITHERS_SANDBOX_REQUEST_PATH` and `SMITHERS_SANDBOX_RESULT_PATH` naming
 * the two files, and the result JSON comes back through the same session to be
 * validated against the flow's own success schema. Smithers 0.x had this tier
 * as `<Sandbox workflow={child}>`; the 1.0 shape keeps its runner protocol and
 * its env variable names and drops two of its mistakes: a provider is a
 * `Sandbox.Provider` VALUE passed in, never a string looked up in a registry,
 * and the authoring is `Flow.make` and `Action.make`, never a component.
 *
 * The runner protocol, as shipped:
 *
 * 1. The entry module is bundled with esbuild (`platform: "node"`, ESM) into
 *    `.smithers-sandbox/bundle.mjs` under the session's workdir, together with
 *    a small main that imports the entry and hands its exports to the guest
 *    runner in `internal/SandboxedFlowGuest.ts`.
 * 2. `.smithers-sandbox/request.json` carries `{ flow, executionId, payload }`,
 *    the payload encoded through `Schema.toCodecJson` of the flow's payload
 *    schema.
 * 3. The guest runtime, `node` unless {@link ExecuteOptions.runtime} says
 *    otherwise, runs the bundle with the workdir as its working directory and
 *    the two env variables set. The runner finds the flow by tag among the
 *    entry's exports, decodes the payload, runs the flow under an in-memory
 *    engine, and writes `.smithers-sandbox/result.json`: either
 *    `{ status: "finished", output }` with the success value encoded through
 *    the success schema's JSON codec, or `{ status: "failed", error }`.
 * 4. The host reads the result back, refuses a non-zero exit, an unparseable
 *    file, or a result the limits reject, decodes `output` through the same
 *    codec, and, when {@link ExecuteOptions.collectDiff} is set, reads the
 *    files the guest created or resized in the workspace and returns them as
 *    data beside the output.
 *
 * What the guest image must contain is a statement, not code: the runtime the
 * bundle is started with, `node` (22 or later) or `bun`, has to be on the
 * guest's `PATH`. Nothing here installs one. A missing runtime is reported as
 * a `guest_failed` failure that names it.
 *
 * The workspace diff is DATA, not an applied change. Applying it on the host,
 * or gating it behind review the way the 0.x component's `reviewDiffs` did, is
 * the caller's, and the review gate is the recorded follow-up of this pass.
 *
 * @since 1.0.0
 */
import { Action, type Flow, FlowRuntime } from "@smthrs/flow"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import { Sandbox } from "@smthrs/sandbox"
import type { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import * as Guest from "./internal/SandboxedFlowGuest.ts"

/**
 * Why a sandboxed execution did not produce a validated result.
 *
 * - `bundle_failed`: the entry module could not be bundled.
 * - `session_failed`: the provider could not acquire the machine, or a file
 *   or process operation on it failed.
 * - `guest_failed`: the guest runtime exited non-zero, including exit 127 for a
 *   runtime the image does not contain.
 * - `flow_failed`: the child flow ran and reported a failure.
 * - `result_unreadable`: the guest exited 0 but wrote no result, or wrote one
 *   that is not the protocol's JSON.
 * - `result_invalid`: the result's `output` does not decode through the flow's
 *   success schema.
 * - `result_overflow`: the result file exceeds {@link Limits.resultBytes}.
 * - `diff_overflow`: the workspace diff exceeds {@link Limits.files} or
 *   {@link Limits.diffBytes}.
 * - `deadline_exceeded`: the whole session outlived {@link ExecuteOptions.timeout}.
 *
 * @category errors
 * @since 1.0.0
 */
export class SandboxedFlowError extends Schema.TaggedError<SandboxedFlowError>()(
  "@smthrs/flows/SandboxedFlowError",
  {
    code: Schema.Literals([
      "bundle_failed",
      "session_failed",
      "guest_failed",
      "flow_failed",
      "result_unreadable",
      "result_invalid",
      "result_overflow",
      "diff_overflow",
      "deadline_exceeded"
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * Bounds on what comes back from the guest.
 *
 * The defaults mirror the 0.x bundle limits: 5 MB for the structured result
 * (the old manifest limit), 100 MB for the collected files (the old bundle
 * total), and 1,000 files (the old patch-file count).
 *
 * @category models
 * @since 1.0.0
 */
export interface Limits {
  /** The largest result JSON accepted, in bytes. Default 5 MiB. */
  readonly resultBytes?: number | undefined
  /** The most workspace-diff bytes collected. Default 100 MiB. */
  readonly diffBytes?: number | undefined
  /** The most created-or-resized files collected. Default 1,000. */
  readonly files?: number | undefined
}

/**
 * {@link Limits} with every bound decided.
 *
 * @category models
 * @since 1.0.0
 */
export interface ResolvedLimits {
  readonly resultBytes: number
  readonly diffBytes: number
  readonly files: number
}

/**
 * The limits {@link execute} applies where {@link ExecuteOptions.limits} names none.
 *
 * @category models
 * @since 1.0.0
 */
export const defaultLimits: ResolvedLimits = Object.freeze({
  resultBytes: 5 * 1024 * 1024,
  diffBytes: 100 * 1024 * 1024,
  files: 1000
})

/** The caller's bounds over the defaults, an omitted or undefined bound keeping the default. */
const resolveLimits = (limits: Limits | undefined): ResolvedLimits => ({
  resultBytes: limits?.resultBytes ?? defaultLimits.resultBytes,
  diffBytes: limits?.diffBytes ?? defaultLimits.diffBytes,
  files: limits?.files ?? defaultLimits.files
})

/**
 * How one child flow execution is placed.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecuteOptions {
  /** The provider that provisions the machine. A value, never a name. */
  readonly provider: Sandbox.Provider
  /**
   * The session key the machine is acquired under. It is an exclusive claim:
   * two live executions with one key share a machine and the first to finish
   * tears it down under the other. Reusing a key is what resume looks like: a
   * crash that left the machine behind is reattached by the next execution
   * with the same key, workspace included.
   */
  readonly session: string
  /**
   * The module to bundle: a `file:` URL or an absolute path. It must export
   * the flow being executed, under any name, and may export `layer`, an
   * Effect `Layer` providing the implementations of the actions the flow's
   * body names.
   */
  readonly entry: URL | string
  /**
   * The guest command that runs the bundle: `"node"` (default), `"bun"`, or
   * any command line the guest shell resolves. The bundle path is appended,
   * quoted.
   */
  readonly runtime?: string | undefined
  /** Whether to collect the files the guest created or resized. Default `false`. */
  readonly collectDiff?: boolean | undefined
  /** Bounds on the result and the diff; see {@link defaultLimits}. */
  readonly limits?: Limits | undefined
  /**
   * The wall-clock budget for the whole session, acquisition through result
   * readback. Default ten minutes. It is measured on the platform timer, not
   * the ambient `Clock`, so it fires under a frozen test clock too.
   */
  readonly timeout?: Duration.Input | undefined
}

/**
 * One file the guest created or resized, as it stood when the guest exited.
 *
 * @category models
 * @since 1.0.0
 */
export interface DiffEntry {
  /** The path relative to the session workdir. */
  readonly path: string
  readonly bytes: Uint8Array
}

/**
 * What a sandboxed execution returns: the child's success value, decoded
 * through its own schema, and the workspace diff when it was asked for.
 *
 * @category models
 * @since 1.0.0
 */
export interface Result<A> {
  readonly output: A
  readonly diff: ReadonlyArray<DiffEntry>
}

/**
 * The schema of a {@link DiffEntry}, JSON-encodable for the journal: the
 * bytes serialize as base64.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DiffEntry = Schema.Struct({ path: Schema.String, bytes: Schema.Uint8Array })

/**
 * The schema of a {@link Result}'s `diff`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Diff = Schema.Array(DiffEntry)

/**
 * The schema of a {@link Result} over a flow's success schema.
 *
 * @category schemas
 * @since 1.0.0
 */
export type ResultSchema<Success extends Schema.Top> = Schema.Struct<{
  readonly output: Success
  readonly diff: typeof Diff
}>

/**
 * Builds the {@link Result} schema over a flow's success schema.
 *
 * @category schemas
 * @since 1.0.0
 */
export const resultSchema = <Success extends Schema.Top>(success: Success): ResultSchema<Success> =>
  Schema.Struct({ output: success, diff: Diff })

/** The workspace-relative directory the runner protocol's files live in. */
const controlDirectory = ".smithers-sandbox"

/** The most bytes of guest stdout or stderr a failure message quotes. */
const quotedOutputBytes = 4096

/** The last `quotedOutputBytes` of a stream's text, for a failure message. */
const tail = (text: string): string =>
  text.length > quotedOutputBytes ? `…${text.slice(text.length - quotedOutputBytes)}` : text

const failure = (
  code: SandboxedFlowError["code"],
  message: string,
  cause?: unknown
): SandboxedFlowError => new SandboxedFlowError({ code, message, ...(cause === undefined ? {} : { cause }) })

const sessionFailure = (context: string) => (cause: ProviderError): SandboxedFlowError =>
  failure("session_failed", `${context}: ${cause.message}`, cause)

/**
 * The bundler's surface this module uses.
 *
 * `esbuild` is a dependency of this package, and the import is nonetheless a
 * dynamic one with a non-literal specifier. The browser contract gate bundles
 * every documented Node-only entry point for the browser and accepts only
 * unresolvable `node:` built-ins as the reason it fails; esbuild's own entry
 * resolves bare `fs` and `child_process`, which the gate would report as a
 * foreign failure. A specifier the bundler cannot analyze is left in place,
 * and the deferral also keeps the bundler unloaded until the first execution.
 */
interface Bundler {
  readonly build: (options: {
    readonly stdin: {
      readonly contents: string
      readonly resolveDir: string
      readonly loader: "ts"
      readonly sourcefile: string
    }
    readonly bundle: true
    readonly platform: "node"
    readonly format: "esm"
    readonly target: string
    readonly write: false
    readonly logLevel: "silent"
  }) => Promise<{ readonly outputFiles: ReadonlyArray<{ readonly contents: Uint8Array }> }>
}

const bundlerSpecifier = "esbuild"

const loadBundler = (): Promise<Bundler> => import(bundlerSpecifier) as Promise<Bundler>

/**
 * The guest runner beside this module, as source when this module runs as
 * source and as the built file when it runs from `dist`.
 */
const runnerPath = (): string => {
  const here = import.meta.url
  /* v8 ignore next -- the `.js` arm runs only from `dist`, where this module has been built */
  const extension = here.endsWith(".ts") ? ".ts" : ".js"
  return fileURLToPath(new URL(`./internal/SandboxedFlowGuest${extension}`, here))
}

/** The bundle's main: the entry's exports and the guest environment, handed to the runner. */
const main = (entryPath: string): string =>
  `import * as entry from ${JSON.stringify(entryPath)}\n` +
  `import { run } from ${JSON.stringify(runnerPath())}\n` +
  "await run(entry, process.env)\n"

const bundle = (entry: URL | string): Effect.Effect<Uint8Array, SandboxedFlowError> =>
  Effect.tryPromise({
    try: async () => {
      const entryPath = typeof entry === "string" ? entry : fileURLToPath(entry)
      const bundler = await loadBundler()
      const built = await bundler.build({
        stdin: {
          contents: main(entryPath),
          resolveDir: dirname(entryPath),
          loader: "ts",
          sourcefile: "sandboxed-flow-main.ts"
        },
        bundle: true,
        platform: "node",
        format: "esm",
        target: "es2022",
        write: false,
        logLevel: "silent"
      })
      return built.outputFiles[0]!.contents
    },
    catch: (cause) =>
      failure(
        "bundle_failed",
        `the entry ${typeof entry === "string" ? entry : entry.href} could not be bundled: ${
          (cause as { readonly errors?: ReadonlyArray<{ readonly text: string }> }).errors?.[0]?.text ??
            String(cause)
        }`,
        cause
      )
  })

/**
 * A deadline on the wall clock, not the ambient `Clock`, for the reason
 * `SandboxConformance` states: `it.effect` runs under a frozen test clock
 * where `Effect.timeout` never fires, and a hang guard that depends on the
 * layer a host may freeze fails exactly when it is needed.
 */
const expired = (deadline: Duration.Input): Effect.Effect<never, SandboxedFlowError> =>
  Effect.flatMap(
    Effect.callback<void>((resume) => {
      const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(deadline))
      return Effect.sync(() => clearTimeout(timer))
    }),
    () =>
      Effect.fail(
        failure(
          "deadline_exceeded",
          `the sandboxed execution did not finish within ${Duration.toMillis(deadline)} milliseconds`
        )
      )
  )

/** Sizes by workspace-relative path of every regular file outside the control directory. */
const snapshot = (
  files: FileSystem.FileSystem,
  workdir: string
): Effect.Effect<ReadonlyMap<string, number>, SandboxedFlowError> =>
  Effect.gen(function*() {
    const entries = yield* files.readDirectory(workdir, { recursive: true })
    const sizes = new Map<string, number>()
    for (const entry of entries) {
      if (entry === controlDirectory || entry.startsWith(`${controlDirectory}/`)) continue
      const info = yield* files.stat(entry)
      if (info.type === "File") sizes.set(entry, Number(info.size))
    }
    return sizes
  }).pipe(
    Effect.mapError((cause) => failure("session_failed", `the workspace could not be listed: ${cause.message}`, cause))
  )

/** Reads every file the guest created or resized, within the limits. */
const collect = (
  session: Sandbox.Session,
  workdir: string,
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  limits: ResolvedLimits
): Effect.Effect<ReadonlyArray<DiffEntry>, SandboxedFlowError> =>
  Effect.gen(function*() {
    const changed = [...after].filter(([path, size]) => before.get(path) !== size)
    if (changed.length > limits.files) {
      return yield* Effect.fail(
        failure("diff_overflow", `the guest changed ${changed.length} files; the limit is ${limits.files}`)
      )
    }
    const total = changed.reduce((sum, [, size]) => sum + size, 0)
    if (total > limits.diffBytes) {
      return yield* Effect.fail(
        failure("diff_overflow", `the changed files hold ${total} bytes; the limit is ${limits.diffBytes}`)
      )
    }
    const diff: Array<DiffEntry> = []
    for (const [path] of changed) {
      const bytes = yield* session.readFile(`${workdir}/${path}`).pipe(
        Effect.mapError(sessionFailure(`the changed file ${path} could not be read back`))
      )
      // A plain copy: a provider answers with whatever its transport holds,
      // a pooled `Buffer` for the local directory, and the diff is data the
      // caller keeps.
      diff.push({ path, bytes: new Uint8Array(bytes) })
    }
    return diff
  })

/** The result file, checked against the size limit and the protocol's shape. */
const readResult = (
  session: Sandbox.Session,
  resultPath: string,
  limits: ResolvedLimits,
  run: { readonly code: number; readonly stdout: string; readonly stderr: string }
): Effect.Effect<typeof Guest.Result.Type, SandboxedFlowError> =>
  Effect.gen(function*() {
    const outputs = `stdout: ${tail(run.stdout).trim() || "(empty)"}; stderr: ${tail(run.stderr).trim() || "(empty)"}`
    const bytes = yield* session.readFile(resultPath).pipe(
      Effect.mapError((cause) =>
        cause.code === "not_found"
          ? failure("result_unreadable", `the guest exited 0 without writing a result; ${outputs}`, cause)
          : sessionFailure("the result could not be read back")(cause)
      )
    )
    if (bytes.length > limits.resultBytes) {
      return yield* Effect.fail(
        failure("result_overflow", `the result holds ${bytes.length} bytes; the limit is ${limits.resultBytes}`)
      )
    }
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Guest.Result)(JSON.parse(new TextDecoder().decode(bytes))),
      catch: (cause) =>
        failure("result_unreadable", `the guest wrote a result that is not the protocol's JSON; ${outputs}`, cause)
    })
  })

/**
 * Runs `flow` with `payload` inside a machine `options.provider` provisions.
 *
 * The child's code executes in the guest; see the module documentation for
 * the runner protocol. The session is acquired for the duration of the call
 * and released when it returns, so a normal completion tears the machine
 * down, and only a host crash leaves one behind for a later execution with the
 * same session key to reattach.
 *
 * `payload` is the decoded payload, and it is encoded through the flow's
 * payload schema for the wire. A value the schema's own JSON codec refuses
 * is a programmer error and dies, the same posture `Flow.executionId` takes.
 *
 * Change detection for the diff compares sizes by path against a snapshot
 * taken before the guest ran: a created file and a file whose size changed
 * are collected, and a file rewritten in place at its previous size on a
 * REATTACHED workspace is the one edit this misses. A fresh workspace holds
 * nothing but the protocol's own files, so every file the child writes there
 * is a creation.
 *
 * @category constructors
 * @since 1.0.0
 */
export const execute = <
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  payload: Payload["Type"],
  options: ExecuteOptions
): Effect.Effect<Result<Success["Type"]>, SandboxedFlowError> =>
  Effect.gen(function*() {
    const limits = resolveLimits(options.limits)
    const runtime = options.runtime ?? "node"
    // The wire codecs of a flow's schemas are service-free for the same reason
    // a body's payload placeholders are: a JSON codec that needs a service to
    // encode has no way to be satisfied on the other side of a machine
    // boundary, so the dynamic schema-service parameters are erased here the
    // way the interpreter erases them for a handoff.
    const encodedPayload =
      yield* (Schema.encodeEffect(Schema.toCodecJson(flow.payloadSchema))(payload) as Effect.Effect<
        unknown,
        Schema.SchemaError
      >).pipe(Effect.orDie)
    const built = yield* bundle(options.entry)
    return yield* Effect.raceFirst(
      Effect.scoped(
        Effect.gen(function*() {
          const session = yield* options.provider.acquire(options.session).pipe(
            Effect.mapError(sessionFailure(`the session ${options.session} could not be acquired`))
          )
          const workdir = session.workdir.replace(/\/+$/, "")
          const control = `${workdir}/${controlDirectory}`
          const bundlePath = `${control}/bundle.mjs`
          const requestPath = `${control}/request.json`
          const resultPath = `${control}/result.json`
          const files = Sandbox.fileSystem(session)
          const request: typeof Guest.Request.Type = {
            flow: flow._tag,
            executionId: options.session,
            payload: encodedPayload
          }
          yield* session.writeFile(bundlePath, built).pipe(
            Effect.mapError(sessionFailure("the bundle could not be written into the workspace"))
          )
          yield* session.writeFile(requestPath, new TextEncoder().encode(JSON.stringify(request))).pipe(
            Effect.mapError(sessionFailure("the request could not be written into the workspace"))
          )
          const before = options.collectDiff === true ? yield* snapshot(files, workdir) : new Map<string, number>()
          const command = `${runtime} ${CommandLine.quote(bundlePath)}`
          const run = yield* Effect.scoped(
            Effect.gen(function*() {
              const process = yield* session.spawn(command, {
                env: {
                  SMITHERS_SANDBOX_REQUEST_PATH: requestPath,
                  SMITHERS_SANDBOX_RESULT_PATH: resultPath
                }
              })
              const [stdout, stderr, code] = yield* Effect.all(
                [
                  Stream.mkString(Stream.decodeText(process.stdout)),
                  Stream.mkString(Stream.decodeText(process.stderr)),
                  process.exitCode
                ],
                { concurrency: "unbounded" }
              )
              return { stdout, stderr, code }
            })
          ).pipe(Effect.mapError(sessionFailure(`\`${command}\` could not be run in the session`)))
          if (run.code !== 0) {
            const reason = run.code === 127 || run.code === 126
              ? `the guest image has no runnable \`${runtime}\`; SandboxedFlow starts the runtime it is told to and installs none`
              : `the guest runtime exited ${run.code}`
            return yield* Effect.fail(
              failure("guest_failed", `${reason}; stderr: ${tail(run.stderr).trim() || "(empty)"}`)
            )
          }
          const result = yield* readResult(session, resultPath, limits, run)
          if (result.status === "failed") {
            return yield* Effect.fail(
              failure(
                "flow_failed",
                `the child flow ${flow._tag} failed in the guest: ${result.error}; stdout: ${
                  tail(run.stdout).trim() || "(empty)"
                }; stderr: ${tail(run.stderr).trim() || "(empty)"}`
              )
            )
          }
          const output = yield* (Schema.decodeUnknownEffect(Schema.toCodecJson(flow.successSchema))(
            result.output
          ) as Effect.Effect<Success["Type"], Schema.SchemaError>).pipe(
            Effect.mapError((cause) =>
              failure(
                "result_invalid",
                `the guest's output does not decode through the success schema of ${flow._tag}: ${cause.message}`,
                cause
              )
            )
          )
          const diff = options.collectDiff === true
            ? yield* collect(session, workdir, before, yield* snapshot(files, workdir), limits)
            : []
          return { output, diff }
        })
      ),
      expired(options.timeout ?? Duration.minutes(10))
    )
  })

/**
 * A durable action whose implementation is one sandboxed execution of `flow`.
 *
 * Its payload schema is the flow's, its success schema is {@link resultSchema}
 * over the flow's, and its error schema is {@link SandboxedFlowError}. The
 * parent flow's body calls it like any other action; {@link toLayer} supplies
 * the implementation.
 *
 * @category models
 * @since 1.0.0
 */
export type SandboxedAction<
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top
> = Action.Declared<Tag, Payload, ResultSchema<Success>, typeof SandboxedFlowError>

/**
 * Declares the durable action a parent flow calls to run `flow` in a sandbox.
 *
 * From the parent's point of view the whole sandboxed execution is ONE
 * action: the engine journals one attempt, applies one retry policy, and
 * replays one recorded result. The action's tag is `<flow tag>/sandboxed`
 * unless `options.name` says otherwise.
 *
 * @category constructors
 * @since 1.0.0
 */
export const action = <
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  options: { readonly name?: string | undefined } = {}
): SandboxedAction<string, Payload, Success> =>
  // `Action.make` answers with `Payload extends Fields ? Struct<Payload> :
  // Payload`, which is `Payload` itself for a schema rather than a field
  // record. The compiler defers that conditional while the type parameter is
  // unresolved, so the identity is asserted here, as `Action.make` itself
  // does for the flow form of a declaration.
  Action.make(options.name ?? `${flow._tag}/sandboxed`, {
    payload: flow.payloadSchema,
    success: resultSchema(flow.successSchema),
    error: SandboxedFlowError
  }) as unknown as SandboxedAction<string, Payload, Success>

/**
 * What {@link toLayer} hands an options function: the decoded payload of the
 * call and the parent execution's id, which is the natural material for a
 * session key that is exclusive per execution and stable across a resume.
 *
 * @category models
 * @since 1.0.0
 */
export interface ExecuteContext<Payload> {
  readonly payload: Payload
  readonly executionId: string
}

/**
 * Implements a {@link action} declaration with {@link execute}.
 *
 * `options` is either the placement itself or a function of the call's
 * {@link ExecuteContext}, for a session key derived from the parent execution:
 *
 * ```ts
 * SandboxedFlow.toLayer(RunChild, Child, ({ executionId }) => ({
 *   provider,
 *   session: `child:${executionId}`,
 *   entry: new URL("./child.ts", import.meta.url)
 * }))
 * ```
 *
 * Compose the returned layer beside `Interpreter.layer(parent)` over one
 * `Action.layerImplementations`, exactly as any other action implementation.
 *
 * @category layers
 * @since 1.0.0
 */
export const toLayer = <
  ActionTag extends string,
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(
  declared: SandboxedAction<ActionTag, Payload, Success>,
  flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
  options: ExecuteOptions | ((context: ExecuteContext<Payload["Type"]>) => ExecuteOptions)
): Layer.Layer<
  Action.Requirement<ActionTag>,
  never,
  | FlowRuntime.FlowRuntime
  | Payload["DecodingServices"]
  | Payload["EncodingServices"]
  | Success["DecodingServices"]
  | Success["EncodingServices"]
> =>
  declared.toLayer((payload) =>
    Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      const placement = typeof options === "function"
        ? options({ payload, executionId: instance.executionId })
        : options
      return yield* execute(flow, payload, placement)
    })
  )
