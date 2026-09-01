/**
 * What a generated CI job needs before it can run a target.
 *
 * A hosted runner starts empty. Something has to check the tree out, install an
 * interpreter, install the workspace, and put `cargo` or `jj` on `PATH` before
 * the first target executes. That "something" used to be a list of hand-written
 * steps in a BUILD.ts file, half `uses:` references and half shell.
 *
 * This module replaces the list with a declaration of what the job REQUIRES.
 * {@link GithubCiGen} derives the steps: the install argv comes from
 * {@link PackageManager.install}, the interpreter version from the declared
 * {@link Runtime}, the Rust install from {@link RustToolchain.install}. A
 * BUILD.ts file states requirements; only the generator knows how a runner
 * satisfies them, which is the same division {@link Runtime} draws between a
 * declared requirement and the service that measures the host.
 *
 * Every version a runner downloads is enumerated here rather than written as
 * free text, for the reason {@link Runtime.NodeVersion} is enumerated: the set
 * of versions a workspace may pin is reviewed. A pin that names a release the
 * publisher does not have is a CI failure at 03:00; a pin that is not in this
 * list is a type error at the call site.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Runtime from "./Runtime.ts"
import * as RustToolchain from "./RustToolchain.ts"

/**
 * Schema for the Node releases a runner may install.
 *
 * The entry is the floor `Runtime.NodeVersion` requires, spelled as the exact
 * release the setup action downloads. A range would let the runner resolve a
 * version nobody chose.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NodeRelease = Schema.Literals(["22.19.0"])

/**
 * The Node releases a runner may install.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeRelease = typeof NodeRelease.Type

/**
 * Schema for the Bun releases a runner may install.
 *
 * The pin has to name a published `oven-sh/bun` release: the setup action
 * downloads the release asset, so a version that exists only as a local build
 * 404s.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BunRelease = Schema.Literals(["1.3.14"])

/**
 * The Bun releases a runner may install.
 *
 * @category models
 * @since 0.1.0
 */
export type BunRelease = typeof BunRelease.Type

/**
 * Schema for a declared Node installation.
 *
 * `runtime` is the workspace's own declaration, so a job cannot install an
 * interpreter the workspace never declared. `cachePackageStore` asks the setup
 * action to restore the package manager's store, which only a job that installs
 * the workspace should do.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NodeSetup = Schema.Struct({
  name: Schema.Literal("node"),
  runtime: Runtime.NodeRuntime,
  release: NodeRelease,
  cachePackageStore: Schema.Boolean
})

/**
 * One declared Node installation.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeSetup = typeof NodeSetup.Type

/**
 * Schema for a declared Bun installation.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BunSetup = Schema.Struct({
  name: Schema.Literal("bun"),
  runtime: Runtime.BunRuntime,
  release: BunRelease
})

/**
 * One declared Bun installation.
 *
 * @category models
 * @since 0.1.0
 */
export type BunSetup = typeof BunSetup.Type

/**
 * Schema for one declared interpreter installation.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RuntimeSetup = Schema.Union([NodeSetup, BunSetup])

/**
 * One declared interpreter installation.
 *
 * @category models
 * @since 0.1.0
 */
export type RuntimeSetup = typeof RuntimeSetup.Type

/**
 * Declares that a job installs Node.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
 *
 * export const node = Smithers.CiToolchain.Node({ runtime, release: "22.19.0" })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Node = (options: {
  readonly runtime: Runtime.NodeRuntime
  readonly release: NodeRelease
  /** @default true */
  readonly cachePackageStore?: boolean | undefined
}): NodeSetup =>
  NodeSetup.make({
    name: "node",
    runtime: options.runtime,
    release: options.release,
    cachePackageStore: options.cachePackageStore ?? true
  })

/**
 * Declares that a job installs Bun.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Bun = (options: {
  readonly runtime: Runtime.BunRuntime
  readonly release: BunRelease
}): BunSetup => BunSetup.make({ name: "bun", runtime: options.runtime, release: options.release })

/**
 * Schema for the jj-cli releases a runner may install.
 *
 * @category schemas
 * @since 0.1.0
 */
export const JjRelease = Schema.Literals(["0.39.0"])

/**
 * The jj-cli releases a runner may install.
 *
 * @category models
 * @since 0.1.0
 */
export type JjRelease = typeof JjRelease.Type

/**
 * The ripgrep releases a runner may install.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RipgrepRelease = Schema.Literals(["14.1.1"])

/**
 * The ripgrep releases a runner may install.
 *
 * @category models
 * @since 0.1.0
 */
export type RipgrepRelease = typeof RipgrepRelease.Type

/**
 * Schema for a declared ripgrep installation.
 *
 * `@smthrs/std` ships two search implementations and its conformance suite runs
 * both against each other: the portable one it implements, and the native one
 * that drives a real `rg`. The parity is the gate, so a runner without the
 * binary does not weaken the suite, it removes the only check that proves the
 * portable implementation still matches ripgrep.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RipgrepSetup = Schema.Struct({ release: RipgrepRelease })

/**
 * One declared ripgrep installation.
 *
 * @category models
 * @since 0.1.0
 */
export type RipgrepSetup = typeof RipgrepSetup.Type

/**
 * Schema for a declared jj installation.
 *
 * `colocate` asks the generator for the `jj git init --colocate` step: a GitHub
 * checkout is a git repository and not a jj one, so a suite that drives a real
 * jj binary finds no repository without it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const JjSetup = Schema.Struct({
  release: JjRelease,
  colocate: Schema.Boolean
})

/**
 * One declared jj installation.
 *
 * @category models
 * @since 0.1.0
 */
export type JjSetup = typeof JjSetup.Type

/**
 * Declares that a job installs ripgrep.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Ripgrep = (options: { readonly release: RipgrepRelease }): RipgrepSetup =>
  RipgrepSetup.make({ release: options.release })

/**
 * Declares that a job installs the jj CLI.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Jj = (options: {
  readonly release: JjRelease
  /** @default true */
  readonly colocate?: boolean | undefined
}): JjSetup => JjSetup.make({ release: options.release, colocate: options.colocate ?? true })

/**
 * Schema for a declared Rust installation.
 *
 * `cache` restores the registry and the compiled dependency tree, keyed on
 * `Cargo.lock`. A job whose entire point is an uncached rebuild declares
 * `cache: false`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RustSetup = Schema.Struct({
  toolchain: RustToolchain.RustToolchain,
  cache: Schema.Boolean
})

/**
 * One declared Rust installation.
 *
 * @category models
 * @since 0.1.0
 */
export type RustSetup = typeof RustSetup.Type

/**
 * Declares that a job installs the pinned Rust toolchain.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Rust = (options: {
  readonly toolchain: RustToolchain.RustToolchain
  /** @default true */
  readonly cache?: boolean | undefined
}): RustSetup => RustSetup.make({ toolchain: options.toolchain, cache: options.cache ?? true })

/**
 * A workspace-relative path a generated step may name.
 *
 * A leading `/` is allowed, for the absolute paths a runner image fixes. `*` is
 * allowed because an artifact source is a set of files. Nothing else that a
 * shell would treat as syntax is: no quote, no `$`, no backtick, no `;`, `&`,
 * `|`, `(`, `)`, `<`, `>`, and no whitespace, so a declared path is always one
 * word and always the word that was declared.
 *
 * @category constants
 * @since 0.1.0
 */
export const pathShape = /^[A-Za-z0-9_./*-][A-Za-z0-9_./*-]*$/

/**
 * Validates one declared path, or throws naming what rejected it.
 *
 * @category validation
 * @since 0.1.0
 */
export const validatePath = (value: string, what: string): string => {
  if (!pathShape.test(value) || value.includes("..")) {
    throw new Error(`CiToolchain: ${JSON.stringify(value)} is not a usable ${what}`)
  }
  return value
}

/**
 * A path a generated step spawns rather than matches.
 *
 * {@link pathShape} admits `*` and a leading `-` because it also validates
 * artifact globs, and neither belongs in something the shell is asked to
 * execute: `*` expands against the runner's working directory, so the step
 * would test and then run whichever entry sorts first, and a leading `-` turns
 * the value into an option to `[`. Two capabilities, two shapes.
 *
 * @category constants
 * @since 0.1.0
 */
export const executableShape = /^[A-Za-z0-9_./][A-Za-z0-9_./-]*$/

/**
 * Validates one declared executable path, or throws naming what rejected it.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateExecutable = (value: string, what: string): string => {
  if (!executableShape.test(value) || value.includes("..")) {
    throw new Error(`CiToolchain: ${JSON.stringify(value)} is not a usable ${what}`)
  }
  return value
}

/**
 * Schema for a declared system browser requirement.
 *
 * The runner image is expected to ship it; the generated step asserts the path
 * exists and prints its version, so an image change fails with a readable
 * message instead of inside a connect timeout.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SystemBrowser = Schema.Struct({
  executable: Schema.NonEmptyString,
  reason: Schema.NonEmptyString
})

/**
 * One declared system browser requirement.
 *
 * @category models
 * @since 0.1.0
 */
export type SystemBrowser = typeof SystemBrowser.Type

/**
 * Declares that a job requires a browser the runner image already ships.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Browser = (options: {
  readonly executable: string
  readonly reason: string
}): SystemBrowser =>
  SystemBrowser.make({
    executable: validateExecutable(options.executable, "browser executable"),
    reason: options.reason
  })

/**
 * Schema for one source an artifact upload collects.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ArtifactSource = Schema.Struct({
  from: Schema.NonEmptyString,
  as: Schema.optional(Schema.NonEmptyString)
})

/**
 * One source an artifact upload collects.
 *
 * @category models
 * @since 0.1.0
 */
export type ArtifactSource = typeof ArtifactSource.Type

/**
 * Schema for a declared artifact upload.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ArtifactUpload = Schema.Struct({
  artifact: Schema.NonEmptyString,
  sources: Schema.Array(ArtifactSource)
})

/**
 * One declared artifact upload.
 *
 * @category models
 * @since 0.1.0
 */
export type ArtifactUpload = typeof ArtifactUpload.Type

/**
 * Declares that a job collects and uploads artifacts after its targets run.
 *
 * Collection is strict: every declared source must exist and copy successfully.
 * The upload action still ignores an empty collection for jobs that declare no
 * sources, while a misspelled or failed source never masquerades as success.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Artifacts = (options: {
  readonly artifact: string
  readonly sources: ReadonlyArray<{ readonly from: string; readonly as?: string | undefined }>
}): ArtifactUpload =>
  ArtifactUpload.make({
    artifact: options.artifact,
    sources: options.sources.map((source) => ({
      from: validatePath(source.from, "artifact source"),
      ...(source.as === undefined ? {} : { as: validatePath(source.as, "artifact destination") })
    }))
  })

/**
 * Schema for the actionlint releases a runner may run.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ActionlintRelease = Schema.Literals(["1.7.11"])

/**
 * The actionlint releases a runner may run.
 *
 * @category models
 * @since 0.1.0
 */
export type ActionlintRelease = typeof ActionlintRelease.Type

/**
 * Schema for a declared workflow-lint requirement.
 *
 * `workflows` names every file to lint. It is declared rather than globbed
 * because a workflow that nobody named is a workflow whose expression errors
 * surface on a schedule instead of in review.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WorkflowLint = Schema.Struct({
  release: ActionlintRelease,
  workflows: Schema.Array(Schema.NonEmptyString)
})

/**
 * One declared workflow-lint requirement.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkflowLint = typeof WorkflowLint.Type

/**
 * Declares that a job lints the repository's workflow files.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Actionlint = (options: {
  readonly release: ActionlintRelease
  readonly workflows: ReadonlyArray<string>
}): WorkflowLint =>
  WorkflowLint.make({
    release: options.release,
    workflows: options.workflows.map((workflow) => validatePath(workflow, "workflow path"))
  })

/**
 * Schema for everything one generated job requires before its targets run.
 *
 * Every field is a requirement, never a step. `submodules` is here because the
 * crates build against a vendored git submodule and a checkout without it dies
 * on a missing manifest; `install` is here because a job that runs no workspace
 * binary should not spend a minute installing one.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Toolchain = Schema.Struct({
  /** Check the tree out with its git submodules. */
  submodules: Schema.Boolean,
  /** Set the package manager up and run the frozen workspace install. */
  install: Schema.Boolean,
  /** The interpreters this job installs. */
  runtimes: Schema.Array(RuntimeSetup),
  rust: Schema.optional(RustSetup),
  jj: Schema.optional(JjSetup),
  ripgrep: Schema.optional(RipgrepSetup),
  browser: Schema.optional(SystemBrowser),
  workflowLint: Schema.optional(WorkflowLint),
  artifacts: Schema.optional(ArtifactUpload)
})

/**
 * Everything one generated job requires before its targets run.
 *
 * @category models
 * @since 0.1.0
 */
export type Toolchain = typeof Toolchain.Type

/**
 * Declares what one generated job requires.
 *
 * The defaults are what a job that runs workspace targets needs: the workspace
 * installed, no submodules, and no toolchain beyond the interpreters it names.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
 *
 * export const needs = Smithers.CiToolchain.Needs({
 *   runtimes: [Smithers.CiToolchain.Node({ runtime, release: "22.19.0" })]
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Needs = (options: {
  /** @default false */
  readonly submodules?: boolean | undefined
  /** @default true */
  readonly install?: boolean | undefined
  /** @default [] */
  readonly runtimes?: ReadonlyArray<RuntimeSetup> | undefined
  readonly rust?: RustSetup | undefined
  readonly jj?: JjSetup | undefined
  readonly ripgrep?: RipgrepSetup | undefined
  readonly browser?: SystemBrowser | undefined
  readonly workflowLint?: WorkflowLint | undefined
  readonly artifacts?: ArtifactUpload | undefined
} = {}): Toolchain =>
  Toolchain.make({
    submodules: options.submodules ?? false,
    install: options.install ?? true,
    runtimes: options.runtimes ?? [],
    ...(options.rust === undefined ? {} : { rust: options.rust }),
    ...(options.jj === undefined ? {} : { jj: options.jj }),
    ...(options.ripgrep === undefined ? {} : { ripgrep: options.ripgrep }),
    ...(options.browser === undefined ? {} : { browser: options.browser }),
    ...(options.workflowLint === undefined ? {} : { workflowLint: options.workflowLint }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts })
  })
