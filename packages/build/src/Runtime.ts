/**
 * The JavaScript runtime seam.
 *
 * A workspace declares which interpreter its tools run under and which version
 * it requires. This module is the service that answers for the host: it reports
 * the platform facts a fetch can vary by, measures the interpreter actually
 * installed, and refuses to proceed when the host does not satisfy the
 * declaration.
 *
 * It exists because the interpreter was previously an ambient fact. The
 * package-manager layer took a `platform` option and every target spelled `node`
 * into its own argv, so nothing in the system could say which interpreter
 * produced a result, and nothing could check that the interpreter on this
 * machine was the one the workspace asked for. Both are now one service that
 * anything needing an interpreter takes as a dependency.
 *
 * Host access is Effect's own: `effect/unstable/process/ChildProcessSpawner`
 * for the version probe. The platform arrives as a layer construction option
 * rather than from `globalThis.process`, because this module has to stay
 * browser-bundleable even though the interpreters it measures do not.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/**
 * Schema for the supported JavaScript runtimes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Name = Schema.Literals(["node", "bun"])

/**
 * The supported JavaScript runtimes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Name = typeof Name.Type

/**
 * Schema for the host facts a fetch or a build can vary by.
 *
 * This lives with the runtime rather than with the package manager because it
 * describes the machine, not the manager. A manager whose fetch varies by
 * platform asks this service for the facts; it does not carry its own copy.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Platform = Schema.Struct({
  /** The operating system, spelled as Node spells it: `darwin`, `linux`. */
  os: Schema.NonEmptyString,
  /** The CPU architecture, spelled as Node spells it: `arm64`, `x64`. */
  arch: Schema.NonEmptyString,
  /** The C library flavour where one is distinguishable: `glibc`, `musl`. */
  libc: Schema.NullOr(Schema.NonEmptyString)
})

/**
 * The host facts a fetch or a build can vary by.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Platform = typeof Platform.Type

/**
 * Schema for the stable error codes a runtime operation reports.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ErrorCode = Schema.Literals([
  "probe_failed",
  "unsatisfied",
  "unsupported_requirement"
])

/**
 * The stable error codes a runtime operation reports.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ErrorCode = typeof ErrorCode.Type

/**
 * Error raised by a runtime operation.
 *
 * The identity string is frozen: it is journaled and folded into recorded
 * results, so renaming it invalidates cached work.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class RuntimeError extends Schema.TaggedError<RuntimeError>()(
  "smithers-build/RuntimeError",
  {
    code: ErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Maximum stdout bytes accepted from a version probe.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumVersionOutputBytes = 64 * 1024

/**
 * Wall-clock deadline for one version probe.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const probeTimeoutMs = 30_000

/**
 * The contract every runtime implements.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Service {
  /** Which runtime this is. */
  readonly name: Name
  /** The executable spawned to run it. */
  readonly executable: string
  /** The version the workspace declared it requires. */
  readonly requirement: string
  /** The host facts this layer was constructed for. */
  readonly platform: Platform
  /** The exact interpreter version, measured by running it. */
  readonly version: Effect.Effect<string, RuntimeError>
  /**
   * Measures the host interpreter and fails when it does not satisfy
   * {@link Service.requirement}.
   *
   * Anything that runs a tool calls this first. A declaration that is never
   * checked is a comment.
   */
  readonly verify: Effect.Effect<string, RuntimeError>
}

/**
 * The runtime service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Runtime extends Context.Service<Runtime, Service>()(
  "smithers-build/Runtime"
) {}

/**
 * Layer construction options.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  /** The version the workspace declared. */
  readonly requirement: string
  /**
   * The host facts. An option rather than a read of `globalThis.process` so
   * this module never touches the host outside a service call.
   */
  readonly platform: Platform
  /** The interpreter executable, when it is not on `PATH` under its own name. */
  readonly executable?: string | undefined
}

/** The comparators a declared requirement may use. */
const comparators = [">=", "<=", ">", "<", "="] as const

/**
 * Splits a dotted numeric version into comparable parts.
 *
 * A trailing prerelease or build suffix is dropped: `1.3.0-canary.2` compares
 * as `1.3.0`. Comparing prerelease precedence correctly is a semver problem
 * this seam does not need, and guessing at it would silently accept a
 * prerelease where an exact requirement was written.
 */
const numericParts = (value: string): ReadonlyArray<number> | undefined => {
  const core = value.trim().replace(/^v/, "").split(/[-+]/)[0]
  if (core === undefined || core === "") return undefined
  const parts = core.split(".")
  const numbers: Array<number> = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    const parsed = Number(part)
    if (!Number.isSafeInteger(parsed)) return undefined
    numbers.push(parsed)
  }
  return numbers
}

/** Compares two dotted numeric versions, shorter treated as zero-padded. */
const compare = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number => {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * Reports whether a measured version satisfies a declared requirement.
 *
 * The supported forms are an exact version and one comparator: `24.9.0`,
 * `=24.9.0`, `>=22.19.0`, `>22`, `<=24`, `<25`. Ranges, unions, and the `^`
 * and `~` operators are deliberately unsupported rather than approximated: a
 * half-implemented caret would accept versions the author meant to exclude.
 * An unsupported requirement is an error at verification, not a silent pass.
 *
 * @category validation
 * @since 0.1.0
 * @slop
 */
export const satisfies = (
  requirement: string,
  version: string
): boolean | "unsupported_requirement" => {
  const measured = numericParts(version)
  if (measured === undefined) return "unsupported_requirement"
  const trimmed = requirement.trim()
  const comparator = comparators.find((candidate) => trimmed.startsWith(candidate))
  const bound = numericParts(comparator === undefined ? trimmed : trimmed.slice(comparator.length))
  if (bound === undefined) return "unsupported_requirement"
  const ordering = compare(measured, bound)
  switch (comparator) {
    case ">=":
      return ordering >= 0
    case "<=":
      return ordering <= 0
    case ">":
      return ordering > 0
    case "<":
      return ordering < 0
    default:
      return ordering === 0
  }
}

/** @private */
const probeFailed = (label: string, cause: unknown): RuntimeError =>
  new RuntimeError({
    code: "probe_failed",
    message: `${label} failed: ${
      typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
        ? cause.message
        : "unknown failure"
    }`,
    cause
  })

/**
 * Measures the interpreter version by running it.
 *
 * The child receives no ambient environment beyond executable lookup. A
 * version probe needs nothing else, and inheriting the process environment
 * would hand a `--version` run the same capabilities a build gets.
 *
 * @private
 */
const measureVersion = (
  spawner: ChildProcessSpawner["Service"],
  executable: string
): Effect.Effect<string, RuntimeError> => {
  const label = `${executable} --version`
  const command = ChildProcess.make(executable, ["--version"], {
    extendEnv: false,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    killSignal: "SIGKILL"
  })
  const captured = Effect.scoped(
    Effect.flatMap(spawner.spawn(command), (handle) =>
      Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: "unbounded" }
      ))
  )
  return captured.pipe(
    Effect.mapError((cause) => probeFailed(label, cause)),
    Effect.timeoutOrElse({
      duration: probeTimeoutMs,
      orElse: () =>
        Effect.fail(
          new RuntimeError({
            code: "probe_failed",
            message: `${label} did not finish within ${probeTimeoutMs}ms`
          })
        )
    }),
    Effect.flatMap(([output, status]) => {
      // A non-zero exit is reported as an exit, not as unparsable output. The
      // spawner returns whatever the tool printed regardless of status, so
      // without this check a probe that failed outright would be reported as a
      // tool that printed no version.
      if (status !== 0) {
        return Effect.fail(
          new RuntimeError({
            code: "probe_failed",
            message: `${label} exited with status ${status}`
          })
        )
      }
      // Node prints `v24.9.0` and Bun prints `1.3.0`. Taking the first
      // version-shaped token on the first line covers both without a
      // per-runtime parser.
      const first = output.split("\n", 1)[0] ?? ""
      const token = first.trim().split(/\s+/).find((word) => /^v?\d+(\.\d+)*$/.test(word))
      return token === undefined
        ? Effect.fail(
          new RuntimeError({
            code: "probe_failed",
            message: `${label} printed no version: ${JSON.stringify(first.slice(0, 200))}`
          })
        )
        : Effect.succeed(token.replace(/^v/, ""))
    })
  )
}

/**
 * Builds a runtime implementation that measures the host.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (
  name: Name,
  options: Options
): Effect.Effect<Service, never, ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const executable = options.executable ?? name
    const version = measureVersion(spawner, executable)
    return {
      name,
      executable,
      requirement: options.requirement,
      platform: options.platform,
      version,
      verify: Effect.flatMap(version, (measured) => {
        const outcome = satisfies(options.requirement, measured)
        if (outcome === "unsupported_requirement") {
          return Effect.fail(
            new RuntimeError({
              code: "unsupported_requirement",
              message: `the declared ${name} version ${
                JSON.stringify(options.requirement)
              } is not an exact version or a single comparator, and ${
                JSON.stringify(measured)
              } cannot be checked against it`
            })
          )
        }
        return outcome
          ? Effect.succeed(measured)
          : Effect.fail(
            new RuntimeError({
              code: "unsatisfied",
              message: `this host runs ${name} ${measured}, and the workspace declares ${options.requirement}`
            })
          )
      })
    }
  })

/**
 * Provides Node as the workspace runtime.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNode = (
  options: Options
): Layer.Layer<Runtime, never, ChildProcessSpawner> => Layer.effect(Runtime)(make("node", options))

/**
 * Provides Bun as the workspace runtime.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerBun = (
  options: Options
): Layer.Layer<Runtime, never, ChildProcessSpawner> => Layer.effect(Runtime)(make("bun", options))

/**
 * Builds a runtime that reports a fixed version and never spawns anything.
 *
 * Tests and browser compositions use it. `verify` applies the same comparison
 * the measuring implementation does, so a test can assert the refusal path
 * without a host interpreter.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (
  name: Name,
  options: Options & { readonly version: string }
): Service => {
  const version = Effect.succeed(options.version)
  return {
    name,
    executable: options.executable ?? name,
    requirement: options.requirement,
    platform: options.platform,
    version,
    verify: satisfies(options.requirement, options.version) === true
      ? version
      : Effect.fail(
        new RuntimeError({
          code: "unsatisfied",
          message: `this host runs ${name} ${options.version}, and the workspace declares ${options.requirement}`
        })
      )
  }
}

/**
 * Provides a runtime that reports a fixed version and never spawns anything.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (
  name: Name,
  options: Options & { readonly version: string }
): Layer.Layer<Runtime> => Layer.effect(Runtime)(Effect.sync(() => makeNoop(name, options)))
