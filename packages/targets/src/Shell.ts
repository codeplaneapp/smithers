/**
 * PACKAGE.ts shell target flavors: `S.Shell.Build`, `S.Shell.Test`,
 * `S.Shell.Run`, `S.Shell.Serve`, and `S.Shell.Diff`.
 *
 * Phase W2 gives `Build`, `Test`, `Run`, and `Diff` real plan-time bodies:
 * each plans the one shared {@link Target.runTool} exec node whose payload is
 * built by {@link execPayload}. Tool references, flag references, and bun
 * templates appear in the payload as sentinel argv tokens; the package
 * executor resolves them against the workspace immediately before spawn and
 * records the resolutions as key material. `Serve` stays a typed
 * `NotImplemented` refusal — service execution is a later lane.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import type * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Runtime from "./Runtime.ts"
import type * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

/** The attr fields every Shell flavor shares. */
const sharedFields = {
  bin: Schema.optional(Attr.Executable),
  bun: Schema.optional(Schema.NonEmptyString),
  command: Schema.optional(Schema.NonEmptyString),
  script: Schema.optional(Input.File),
  using: Schema.optional(Attr.Using),
  args: Schema.optional(Attr.Args),
  runtimeArgs: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Attr.Env),
  data: Schema.optional(Attr.Data),
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  runtime: Schema.optional(Schema.Union([Runtime.Runtime, Runtime.NodeDeclaration, Runtime.BunDeclaration])),
  timeout: Schema.optional(Schema.NonEmptyString.check(Schema.isPattern(/^\d+(?:ms|s|m|h)$/)))
} as const

/**
 * Attrs for {@link Build}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  ...sharedFields,
  outDirs: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  outFiles: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/**
 * Attrs for {@link Test}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestAttrs = Schema.Struct({
  ...sharedFields,
  services: Schema.optional(Attr.Services),
  gates: Schema.optional(Attr.Gates),
  shards: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))
})

/**
 * Attrs for {@link Run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RunAttrs = Schema.Struct({
  ...sharedFields,
  approval: Schema.optional(Attr.Approval),
  services: Schema.optional(Attr.Services),
  gates: Schema.optional(Attr.Gates)
})

/**
 * Attrs for {@link Serve}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ServeAttrs = Schema.Struct({
  ...sharedFields,
  services: Schema.optional(Attr.Services),
  readiness: Schema.optional(Attr.Readiness),
  health: Schema.optional(Attr.Health),
  stop: Schema.optional(Attr.Stop)
})

/**
 * Attrs for {@link Diff}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DiffAttrs = Schema.Struct({
  ...sharedFields,
  changes: Schema.Array(Schema.NonEmptyString)
})

/**
 * Renders the sentinel argv token for one tool reference.
 *
 * The token is inert text: the plan-time body records it in the exec payload,
 * and the package executor replaces it with the resolved absolute executable
 * path immediately before spawn. The resolution — path, package version, or
 * host probe output — is key material at that point; the token itself never
 * reaches a spawned process.
 *
 * @category tokens
 * @since 0.1.0
 */
export const toolToken = (tool: Reference.Tool): string => `{smthrs:tool:${JSON.stringify(tool)}}`

/**
 * The sentinel argv token for a build target used as a tool edge,
 * `bin: sdk.buildCli`.
 *
 * A target cannot be serialized into a token the way a reference can, and it
 * does not have to be: a declaration names exactly one `bin`, so the planner
 * knows which dependency the token stands for and substitutes the executable
 * that target declares it produces.
 *
 * @category tokens
 * @since 0.1.0
 */
export const targetBinToken = "{smthrs:target-bin}"

/**
 * The sentinel argv token for a workspace flag reference, `S.Flags.<name>`.
 *
 * @category tokens
 * @since 0.1.0
 */
export const flagToken = (name: string): string => `{smthrs:flag:${name}}`

/**
 * The sentinel argv token for the bun binary that runs `bun:` templates.
 *
 * @category tokens
 * @since 0.1.0
 */
export const bunToken = "{smthrs:bun}"

/**
 * The sentinel argv token for the generated bun template program file.
 *
 * @category tokens
 * @since 0.1.0
 */
export const bunProgramToken = "{smthrs:bun-program}"

/**
 * The sentinel argv token for a package-relative generator script path.
 *
 * @category tokens
 * @since 0.1.0
 */
export const scriptToken = (path: string): string => `{smthrs:script:${path}}`

/**
 * The argv[0] a declared `script` runs under, chosen from its extension.
 *
 * A repository writes generator and harness scripts in both dialects — the
 * design corpus has `.sh` scripts on `S.Shell.*` and on `S.Generate`, and
 * `.mjs` scripts on `S.Generate` — and the same file must spawn the same way
 * under either rule. A shell script runs under `/bin/sh`; anything else runs
 * under the workspace runtime, which is what a JavaScript generator needs.
 *
 * @category tokens
 * @since 0.1.0
 */
export const scriptInterpreterToken = (path: string): string =>
  /\.(?:sh|bash)$/.test(path) ? "/bin/sh" : toolToken(Reference.runtimeBin)

/**
 * Wall-clock bound for one package-mode tool process.
 *
 * Package-mode targets include multi-minute compiles (tsc, relay-compiler
 * over a production tree), so the bound is deliberately far above the
 * ten-minute exec default.
 *
 * @category constants
 * @since 0.1.0
 */
export const packageExecTimeoutMs = 30 * 60 * 1000

/**
 * The attr fields {@link execPayload} reads. Every Shell flavor and the
 * Generate bin form share this shape.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecAttrs {
  readonly bin?: Reference.Tool | Target.AnyTarget | undefined
  readonly bun?: string | undefined
  readonly command?: string | undefined
  readonly script?: Input.File | undefined
  readonly using?: Readonly<Record<string, Reference.Tool>> | undefined
  readonly args?: ReadonlyArray<string | Reference.FlagRef> | undefined
  readonly runtimeArgs?: ReadonlyArray<string> | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly secrets?: ReadonlyArray<Secret.Secret> | undefined
}

const resolveArgs = (args: ReadonlyArray<string | Reference.FlagRef> | undefined): Array<string> =>
  (args ?? []).map((entry) => typeof entry === "string" ? entry : flagToken(entry.name))

/**
 * Builds the canonical exec payload one shell-shaped declaration plans.
 *
 * The same builder backs the target's plan-time body and the package
 * executor's spawn, so the two can never drift: the executor takes this
 * payload, substitutes the sentinel tokens with resolved tool paths, applies
 * the sandbox wrapper, and hands the result to the shared exec
 * implementation.
 *
 * - `command` runs through `/bin/sh -c`, so the declared text keeps its
 *   shell semantics (`$TMPDIR` expansion, globs).
 * - `bun` templates run as `bun <generated program>`; the program file is
 *   generated by the executor from the resolved `using` tools plus the
 *   template text.
 * - `bin` spawns the referenced tool directly; `runtimeArgs` are runtime
 *   flags, so a non-runtime `bin` with `runtimeArgs` runs under the
 *   workspace runtime binary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const execPayload = (attrs: ExecAttrs): Exec.CallPayload => {
  const environment = attrs.env === undefined ? {} : { ...attrs.env }
  const args = resolveArgs(attrs.args)
  let argv: [string, ...Array<string>]
  if (attrs.command !== undefined) {
    argv = ["/bin/sh", "-c", attrs.command]
  } else if (attrs.script !== undefined) {
    argv = [scriptInterpreterToken(attrs.script.path), scriptToken(attrs.script.path), ...args]
  } else if (attrs.bun !== undefined) {
    argv = [bunToken, bunProgramToken]
  } else if (attrs.bin !== undefined) {
    const runtimeArgs = attrs.runtimeArgs ?? []
    // A build target as the tool edge is never a JavaScript runtime, so it
    // never takes runtime flags; it is the program itself. Running it under
    // the workspace runtime would spawn the wrong program and dropping the
    // flags would spawn the right one with a different argv, so the
    // declaration is rejected instead.
    if (Target.isTarget(attrs.bin)) {
      if (runtimeArgs.length > 0) {
        throw new Error(
          "a shell declaration whose bin is a build target cannot take runtimeArgs; " +
            "they are flags for a JavaScript runtime the built binary is not"
        )
      }
      argv = [targetBinToken, ...args]
    } else if (attrs.bin._tag === "RuntimeBin") {
      argv = [toolToken(attrs.bin), ...runtimeArgs, ...args]
    } else if (runtimeArgs.length > 0) {
      argv = [toolToken(Reference.runtimeBin), ...runtimeArgs, toolToken(attrs.bin), ...args]
    } else {
      argv = [toolToken(attrs.bin), ...args]
    }
  } else {
    throw new Error("shell declaration names no executable")
  }
  return {
    cwd: ".",
    argv,
    env: environment,
    timeoutMs: packageExecTimeoutMs
  }
}

/** Plans the shared exec node for one shell-shaped declaration. */
const planExec = (attrs: ExecAttrs) =>
  Target.runTool({
    ...execPayload(attrs),
    secrets: attrs.secrets === undefined ? [] : [...attrs.secrets]
  })

const buildDefinition = Target.make("Shell.Build", {
  attrs: BuildAttrs,
  kinds: ["build"],
  implementation: (attrs) => planExec(attrs)
})

const testDefinition = Target.make("Shell.Test", {
  attrs: TestAttrs,
  kinds: ["test"],
  implementation: (attrs) => planExec(attrs)
})

const runDefinition = Target.make("Shell.Run", {
  attrs: RunAttrs,
  kinds: ["run"],
  implementation: (attrs) => planExec(attrs)
})

const serveDefinition = Target.make("Shell.Serve", {
  attrs: ServeAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Shell.Serve")
})

const diffDefinition = Target.make("Shell.Diff", {
  attrs: DiffAttrs,
  kinds: ["run", "lint"],
  implementation: (attrs) => planExec(attrs)
})

const withOneExecutable = <A>(id: string, attrs: unknown, construct: () => A): A => {
  if (typeof attrs !== "object" || attrs === null) {
    throw new TypeError(`${id} attrs must be an object`)
  }
  Attr.requireOneExecutable(id, attrs as Record<string, unknown>, ["bin", "bun", "command", "script"])
  return construct()
}

/**
 * A tool run producing the declared output directories.
 *
 * @category targets
 * @since 0.1.0
 */
export const Build = (attrs: (typeof BuildAttrs)["~type.make.in"]): Target.AnyTarget =>
  withOneExecutable("Shell.Build", attrs, () => {
    if ((attrs.outDirs?.length ?? 0) + (attrs.outFiles?.length ?? 0) === 0) {
      throw new TypeError("Shell.Build requires at least one outDirs or outFiles entry")
    }
    return buildDefinition(attrs)
  })

/**
 * A tool run whose exit status is the test verdict.
 *
 * @category targets
 * @since 0.1.0
 */
export const Test = (attrs: (typeof TestAttrs)["~type.make.in"]): Target.AnyTarget =>
  withOneExecutable("Shell.Test", attrs, () => testDefinition(attrs) as unknown as Target.AnyTarget)

/**
 * A tool run executed only when named explicitly.
 *
 * @category targets
 * @since 0.1.0
 */
export const Run = (attrs: (typeof RunAttrs)["~type.make.in"]): Target.AnyTarget =>
  withOneExecutable("Shell.Run", attrs, () => runDefinition(attrs) as unknown as Target.AnyTarget)

/**
 * A scoped long-running service with the readiness/health/stop probe
 * contract.
 *
 * @category targets
 * @since 0.1.0
 */
export const Serve = (attrs: (typeof ServeAttrs)["~type.make.in"]): Target.AnyTarget =>
  withOneExecutable("Shell.Serve", attrs, () => serveDefinition(attrs) as unknown as Target.AnyTarget)

/**
 * A tool run whose writes are mechanically confined to the declared
 * `changes` write-set; check mode diffs, write mode applies.
 *
 * @category targets
 * @since 0.1.0
 */
export const Diff = (attrs: (typeof DiffAttrs)["~type.make.in"]): Target.AnyTarget =>
  withOneExecutable("Shell.Diff", attrs, () => diffDefinition(attrs) as unknown as Target.AnyTarget)
