/**
 * PACKAGE.ts composition flavors: `S.Generate`, `S.Suite`, `S.Alias`,
 * `S.Test`, `S.Materialize`, `S.ImportClosure`, `S.Clean`, and the
 * `S.Files` algebra.
 *
 * Phase W1 is construct-only: constructors validate attrs by schema, record
 * dependency edges and declared inputs through {@link Target.make}'s attr
 * walk, and install {@link Target.notImplemented} implementations.
 *
 * @since 0.1.0
 */
import { Action, type FlowRuntime } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Attr from "./Attr.ts"
import * as Exec from "./Exec.ts"
import * as Filegroup from "./Filegroup.ts"
import * as GeneratedFile from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Shell from "./Shell.ts"
import * as Target from "./Target.ts"

/** The actions a Generate plan-time body may plan. */
type GenerateRequires =
  | Action.Requirement<"smithers-build/not-implemented">
  | Action.Requirement<"smithers-build/exec">
  | Action.Requirement<"smithers-build/generate-check">

/**
 * Schema for a reference to the file rows a resolver-style target produces,
 * `importGraph.files`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TargetFiles = Schema.TaggedStruct("TargetFiles", {
  target: Target.Target
})

/**
 * A reference to the file rows a target produces.
 *
 * @category models
 * @since 0.1.0
 */
export type TargetFiles = typeof TargetFiles.Type

/**
 * Schema for one operand of the file algebra: a file-producing target or a
 * `.files` reference to one.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FileSet = Schema.Union([Target.Target, TargetFiles])

/**
 * One operand of the file algebra.
 *
 * @category models
 * @since 0.1.0
 */
export type FileSet = typeof FileSet.Type

/**
 * Schema for `S.Files.difference(left, right)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FilesDifference = Schema.TaggedStruct("FilesDifference", {
  left: FileSet,
  right: FileSet
})

/**
 * A declared file-set difference.
 *
 * @category models
 * @since 0.1.0
 */
export type FilesDifference = typeof FilesDifference.Type

/** Schema for `S.Files.digest(target)`, a deterministic path→digest table.
 *
 * @category targets
 * @since 0.1.0
 */
export const FilesDigest = Schema.TaggedStruct("FilesDigest", {
  target: Target.Target
})

/** A declared digest projection of a file-producing target.
 *
 * @category targets
 * @since 0.1.0
 */
export type FilesDigest = typeof FilesDigest.Type

const isFileSet = (value: unknown): value is FileSet =>
  Target.isTarget(value) ||
  (typeof value === "object" && value !== null &&
    (value as { readonly _tag?: unknown })._tag === "TargetFiles" &&
    Target.isTarget((value as { readonly target?: unknown }).target))

/**
 * The declared file-set algebra, `S.Files`.
 *
 * `difference(left, right)` is an inert declaration: the sets subtract when
 * the consuming target executes, and the operand targets become ordinary
 * dependency edges through the attr walk.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Files = Object.freeze({
  difference: (left: FileSet, right: FileSet): FilesDifference => {
    if (!isFileSet(left) || !isFileSet(right)) {
      throw new TypeError("Files.difference operands must be targets or target .files references")
    }
    return Object.freeze({ _tag: "FilesDifference", left, right })
  },
  digest: (target: Target.AnyTarget): FilesDigest => {
    if (!Target.isTarget(target)) throw new TypeError("Files.digest requires a target")
    return Object.freeze({ _tag: "FilesDigest", target })
  }
})

/**
 * Attaches the non-enumerable `.files` reference resolver-style targets
 * expose, so `graphTarget.files` is an inert declaration naming the target's
 * file rows.
 *
 * @category constructors
 * @since 0.1.0
 */
export const attachFiles = <T extends Target.AnyTarget>(target: T): T & { readonly files: TargetFiles } => {
  Object.defineProperty(target, "files", {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ _tag: "TargetFiles", target }),
    writable: false
  })
  return target as T & { readonly files: TargetFiles }
}

/**
 * Attrs for {@link Generate}. Three observed forms share the schema: a
 * literal `emit` map, a `script` writing inside `changes`, and a `bin`
 * printing to `stdout` — exactly one of the three selectors is present.
 *
 * `mode` is the write/check pair every generated-file target carries. It
 * defaults to `write`, and the `lint` verb maps it to `check`, so a declaration
 * states what the generator produces and the verb decides whether the run
 * applies it or reports drift.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GenerateAttrs = Schema.Struct({
  emit: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Reference.Symlink]))),
  script: Schema.optional(Input.File),
  bin: Schema.optional(Attr.Executable),
  command: Schema.optional(Schema.NonEmptyString),
  args: Schema.optional(Attr.Args),
  env: Schema.optional(Attr.Env),
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  stdout: Schema.optional(Schema.NonEmptyString),
  data: Schema.optional(Attr.Data),
  changes: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  mode: GeneratedFile.Mode
})

/**
 * Payload for one generator drift check: the process the write form spawns,
 * and the declared outputs the check compares and restores.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GenerateCheckPayload = Schema.Struct({
  run: Exec.Payload,
  changes: Schema.Array(Schema.NonEmptyString)
})

/**
 * Payload for one generator drift check.
 *
 * @category models
 * @since 0.1.0
 */
export type GenerateCheckPayload = typeof GenerateCheckPayload.Type

/**
 * Runs a generator and reports whether its declared outputs were already
 * current.
 *
 * @category actions
 * @since 0.1.0
 */
export const GenerateCheck = Action.make("smithers-build/generate-check", {
  payload: GenerateCheckPayload,
  error: Schema.Union([Exec.ExecError, GeneratedFile.DriftError]),
  tier: "sealed"
})

/** One declared output as it stood before the generator ran. */
interface OutputSnapshot {
  readonly path: string
  readonly bytes: Buffer | undefined
}

/** Maximum code units one excerpted line contributes to a drift message. */
const maximumDriftExcerptCodeUnits = 200

const excerpt = (line: string | undefined): string =>
  line === undefined
    ? "(end of file)"
    : JSON.stringify(
      line.length > maximumDriftExcerptCodeUnits ? `${line.slice(0, maximumDriftExcerptCodeUnits)}...` : line
    )

/**
 * Renders the first line at which a regenerated output differs.
 *
 * The path leads the message because a failure is reported by its message
 * alone, and an operator's next move is to open the file the generator would
 * have rewritten.
 */
const driftMessage = (path: string, previous: Buffer | undefined, current: Buffer | undefined): string => {
  if (previous === undefined) return `${path} is written by the generator and the checkout does not carry it`
  if (current === undefined) return `${path} is carried by the checkout and the generator removes it`
  const checkedIn = previous.toString("utf8").split("\n")
  const regenerated = current.toString("utf8").split("\n")
  const differing = checkedIn.findIndex((line, position) => line !== regenerated[position])
  const line = differing === -1 ? Math.min(checkedIn.length, regenerated.length) : differing
  return `${path} drifted from its generated form: ` +
    `${checkedIn.length} line(s) checked in, ${regenerated.length} regenerated; ` +
    `first difference at line ${line + 1}: ${excerpt(checkedIn[line])} became ${excerpt(regenerated[line])}`
}

/** Reads one declared output, or undefined when the generator has not written it. */
const readOutput = async (absolute: string): Promise<Buffer | undefined> => {
  try {
    return await Fs.readFile(absolute)
  } catch (cause) {
    if (SafeFs.errorCode(cause) === "ENOENT") return undefined
    throw cause
  }
}

/** Expands the declared `changes` patterns against the real tree. */
const outputPaths = async (
  workspaceRoot: string,
  changes: ReadonlyArray<string>,
  signal: AbortSignal | undefined
): Promise<ReadonlyArray<string>> => {
  const paths = new Set<string>()
  for (const pattern of changes) {
    for (const path of await Input.expandGlob(workspaceRoot, "", pattern, { signal })) paths.add(path)
  }
  return [...paths].sort()
}

const snapshotOutputs = async (
  workspaceRoot: string,
  changes: ReadonlyArray<string>,
  signal: AbortSignal | undefined
): Promise<ReadonlyArray<OutputSnapshot>> =>
  Promise.all(
    (await outputPaths(workspaceRoot, changes, signal)).map(async (path) => ({
      path,
      bytes: await readOutput(NodePath.join(workspaceRoot, path))
    }))
  )

const unchanged = (previous: Buffer | undefined, current: Buffer | undefined): boolean =>
  previous === undefined ? current === undefined : current !== undefined && previous.equals(current)

/**
 * Restores every declared output and reports the first one the generator
 * rewrote.
 */
const restoreOutputs = async (
  workspaceRoot: string,
  before: ReadonlyArray<OutputSnapshot>,
  changes: ReadonlyArray<string>,
  signal: AbortSignal | undefined
): Promise<GeneratedFile.DriftError | undefined> => {
  const paths = new Set(before.map((entry) => entry.path))
  for (const path of await outputPaths(workspaceRoot, changes, signal)) paths.add(path)
  let drift: GeneratedFile.DriftError | undefined
  for (const path of [...paths].sort()) {
    const absolute = NodePath.join(workspaceRoot, path)
    const previous = before.find((entry) => entry.path === path)?.bytes
    const current = await readOutput(absolute)
    if (unchanged(previous, current)) continue
    drift ??= GeneratedFile.driftError(path, driftMessage(path, previous, current))
    if (previous === undefined) await Fs.rm(absolute, { force: true })
    else await Fs.writeFile(absolute, previous)
  }
  return drift
}

/**
 * Runs a generator and fails when it rewrote a declared output.
 *
 * A generator writes into the real tree, which is the only tree it knows how
 * to write; the check snapshots every declared output first and restores each
 * one before it settles, so a `lint` run leaves the working tree byte for byte
 * as it found it, whether the generator succeeded, drifted, or failed. A
 * generator that writes outside its declared `changes` is outside the
 * contract, exactly as it is under package mode's enforced write set.
 *
 * @category effects
 * @since 0.1.0
 */
export const checkGenerator = (
  options: {
    readonly workspaceRoot: string
    readonly cacheDirectory?: string | undefined
    readonly sensitiveEnv?: ReadonlyArray<string> | undefined
  },
  payload: GenerateCheckPayload
): Effect.Effect<void, Exec.ExecError | GeneratedFile.DriftError> => {
  const failed = (path: string) => (cause: unknown): GeneratedFile.DriftError =>
    GeneratedFile.driftError(path, GeneratedFile.failureMessage(cause))
  const declared = payload.changes[0] ?? "generated output"
  const restore = (before: ReadonlyArray<OutputSnapshot>) =>
    Effect.tryPromise({
      try: (signal) => restoreOutputs(options.workspaceRoot, before, payload.changes, signal),
      catch: failed(declared)
    })
  return Effect.flatMap(
    Effect.tryPromise({
      try: (signal) => snapshotOutputs(options.workspaceRoot, payload.changes, signal),
      catch: failed(declared)
    }),
    (before) =>
      Effect.flatMap(
        Effect.exit(Exec.run(options, payload.run)),
        (ran) =>
          Effect.flatMap(
            restore(before),
            (drift): Effect.Effect<void, Exec.ExecError | GeneratedFile.DriftError> =>
              Exit.isFailure(ran)
                ? Effect.failCause(ran.cause)
                : drift === undefined
                ? Effect.void
                : Effect.fail(drift)
          )
      )
  )
}

/**
 * Implements {@link GenerateCheck} by running the generator against the real
 * tree and restoring its declared outputs.
 *
 * @category layers
 * @since 0.1.0
 */
export const GenerateCheckLive = (options: {
  readonly workspaceRoot: string
  readonly cacheDirectory?: string | undefined
  readonly sensitiveEnv?: ReadonlyArray<string> | undefined
}): Layer.Layer<Action.Requirement<"smithers-build/generate-check">, never, FlowRuntime.FlowRuntime> =>
  GenerateCheck.toLayer((payload) => checkGenerator(options, payload))

/** Builds the exec payload one Generate declaration's process form spawns. */
const generatePayload = (attrs: typeof GenerateAttrs.Type): Exec.CallPayload | undefined => {
  if (attrs.script !== undefined) {
    return {
      cwd: ".",
      argv: [Shell.scriptInterpreterToken(attrs.script.path), Shell.scriptToken(attrs.script.path)],
      env: attrs.env ?? {},
      secrets: attrs.secrets ?? [],
      timeoutMs: Shell.packageExecTimeoutMs
    }
  }
  if (attrs.bin !== undefined) {
    return Shell.execPayload({
      bin: attrs.bin,
      args: attrs.args,
      env: attrs.env,
      secrets: attrs.secrets
    })
  }
  if (attrs.command !== undefined) {
    return Shell.execPayload({
      command: attrs.command,
      env: attrs.env,
      secrets: attrs.secrets
    })
  }
  return undefined
}

const generateDefinition = Target.make("Generate", {
  attrs: GenerateAttrs,
  kinds: ["run", "lint"],
  // The script and bin forms plan the shared exec node: the generator runs
  // under the workspace runtime (script) or the referenced tool (bin), and
  // the package executor brackets the spawn with write-set enforcement in
  // write mode or a scratch-copy drift check in check mode. A BUILD.ts
  // workspace has no package executor to bracket it, so `check` plans
  // {@link GenerateCheck} instead: the same spawn, with the declared outputs
  // compared and restored around it. The emit form plans no process at all —
  // the package executor writes or checks the declared file bytes and symlinks
  // natively — so its node stays the typed refusal for any path that is not
  // the package executor.
  attrsForKind: (kind, attrs) =>
    kind === "lint" && attrs.mode === "write" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (attrs): Node.Node<unknown, unknown, GenerateRequires> => {
    const payload = generatePayload(attrs)
    if (payload === undefined) return Target.notImplemented("Generate")
    return attrs.mode === "check"
      ? GenerateCheck.call({ run: payload, changes: attrs.changes ?? [] })
      : Target.runTool(payload)
  }
})

/**
 * A generated-output target: check by default, `--write` applies.
 *
 * @category targets
 * @since 0.1.0
 */
export const Generate = (attrs: (typeof GenerateAttrs)["~type.make.in"]): Target.AnyTarget => {
  if (typeof attrs !== "object" || attrs === null) throw new TypeError("Generate attrs must be an object")
  Attr.requireOneExecutable("Generate", attrs, ["emit", "script", "bin", "command"])
  return generateDefinition(attrs)
}

/**
 * Attrs for {@link Suite}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SuiteAttrs = Schema.Struct({
  tests: Schema.Array(Target.Target)
})

const suiteDefinition = Target.make("Suite", {
  attrs: SuiteAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Suite")
})

/**
 * A named group of check-capable targets that run together.
 *
 * @category targets
 * @since 0.1.0
 */
export const Suite = (attrs: (typeof SuiteAttrs)["~type.make.in"]): Target.AnyTarget => suiteDefinition(attrs)

/**
 * Attrs for {@link Alias}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AliasAttrs = Schema.Struct({
  target: Target.Target
})

/**
 * A second name for one target: a distinct target node whose kinds mirror
 * the aliased target and whose only dependency is it.
 *
 * A distinct node is what keeps the one-value-one-label law intact: the
 * alias has its own label, and the aliased target keeps its own.
 *
 * @category targets
 * @since 0.1.0
 */
export const Alias = (target: Target.AnyTarget): Target.AnyTarget => {
  if (!Target.isTarget(target)) throw new TypeError("Alias requires a target")
  const kinds = Target.metadata(target).kinds
  const definition = Target.make("Alias", {
    attrs: AliasAttrs,
    kinds,
    implementation: () => Target.notImplemented("Alias")
  })
  return definition({ target })
}

/**
 * One declared source together with the directory its paths resolve from.
 *
 * `base` is the absolute directory of the PACKAGE.ts that declared the
 * source, or `""` when the source is already workspace anchored (a `//`
 * pattern, an explicit workspace-relative cwd, or a target constructed
 * outside a PACKAGE.ts module, as tests do). The executing layer maps a
 * non-empty `base` onto its workspace-relative package path; it is carried
 * as context for that mapping and is never cache-key material.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AnchoredSource = Schema.Struct({
  base: Schema.String,
  source: Filegroup.Source
})

/**
 * One declared source together with the directory its paths resolve from.
 *
 * @category models
 * @since 0.1.0
 */
export type AnchoredSource = typeof AnchoredSource.Type

/**
 * One file of a resolved import closure: a workspace-relative path and its
 * content digest.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ClosureFile = Schema.Struct({
  path: Schema.String,
  digest: Schema.String
})

/**
 * One file of a resolved import closure.
 *
 * @category models
 * @since 0.1.0
 */
export type ClosureFile = typeof ClosureFile.Type

/**
 * One import a closure could not settle: the file that declared it and the
 * specifier as written (for a dynamic expression, its bounded source text).
 *
 * @category schemas
 * @since 0.1.0
 */
export const ClosureIssue = Schema.Struct({
  file: Schema.String,
  specifier: Schema.String
})

/**
 * One import a closure could not settle.
 *
 * @category models
 * @since 0.1.0
 */
export type ClosureIssue = typeof ClosureIssue.Type

/**
 * A resolved import closure: the sorted reachable file set with digests, the
 * sorted set of node_modules packages the closure imports, and the explicit
 * unresolved and dynamic rows. Unresolved and dynamic outcomes are carried on
 * the result, never dropped: consumers that need a complete file set fail
 * closed on them.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ClosureResult = Schema.Struct({
  files: Schema.Array(ClosureFile),
  packages: Schema.Array(Schema.String),
  unresolved: Schema.Array(ClosureIssue),
  dynamic: Schema.Array(ClosureIssue)
})

/**
 * A resolved import closure.
 *
 * @category models
 * @since 0.1.0
 */
export type ClosureResult = typeof ClosureResult.Type

/**
 * Resolving an import closure failed: an entry does not exist, a file could
 * not be read, the resolver configuration is invalid, or a bound was hit.
 *
 * @category errors
 * @since 0.1.0
 */
export class ImportClosureError extends Schema.TaggedError<ImportClosureError>()(
  "smithers-build/ImportClosureError",
  {
    message: Schema.NonEmptyString
  }
) {}

/**
 * A file-algebra assertion failed, or could not be answered completely.
 *
 * `leftover` lists files in the left set missing from the right set.
 * `unresolved` and `dynamic` carry closure rows the check refused to reason
 * past: a dead-code style consumer fails closed on an incomplete closure
 * rather than reporting live files as dead. Lists are bounded; the message
 * states the full counts.
 *
 * @category errors
 * @since 0.1.0
 */
export class FilesTestError extends Schema.TaggedError<FilesTestError>()(
  "smithers-build/FilesTestError",
  {
    message: Schema.NonEmptyString,
    leftover: Schema.Array(Schema.String),
    unresolved: Schema.Array(ClosureIssue),
    dynamic: Schema.Array(ClosureIssue)
  }
) {}

/**
 * Resolves the transitive import closure of the payload's entry sources.
 *
 * Executing a plan that contains this action requires the resolver layer,
 * `Resolver.ImportClosureLive` in `@smthrs/build-cli`.
 *
 * @category actions
 * @since 0.1.0
 */
export const ResolveImportClosure = Action.make("smithers-build/import-closure", {
  payload: Schema.Struct({ entries: Schema.Array(AnchoredSource) }),
  success: ClosureResult,
  error: ImportClosureError,
  tier: "sealed"
})

/**
 * One side of a declared file-set difference, reduced to an executable
 * description: a declared source set expanded as files, or the import
 * closure of declared entry sources.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FilesCheckOperand = Schema.Union([
  Schema.TaggedStruct("SourceSet", { sources: Schema.Array(AnchoredSource) }),
  Schema.TaggedStruct("Closure", { entries: Schema.Array(AnchoredSource) })
])

/**
 * One side of a declared file-set difference.
 *
 * @category models
 * @since 0.1.0
 */
export type FilesCheckOperand = typeof FilesCheckOperand.Type

/**
 * Expands both operands, subtracts right from left by path, and requires the
 * remainder to match `toBe`. A closure operand with unresolved or dynamic
 * rows fails the check instead of answering from an incomplete set.
 *
 * Executing a plan that contains this action requires the resolver layer,
 * `Resolver.CheckFilesDifferenceLive` in `@smthrs/build-cli`.
 *
 * @category actions
 * @since 0.1.0
 */
export const CheckFilesDifference = Action.make("smithers-build/files-difference", {
  payload: Schema.Struct({
    left: FilesCheckOperand,
    right: FilesCheckOperand,
    toBe: Schema.Literal("empty")
  }),
  success: Schema.Void,
  error: FilesTestError,
  tier: "sealed"
})

/**
 * The target id every {@link ImportClosure} target reports as
 * `Target.Metadata.target`.
 *
 * @category constants
 * @since 0.1.0
 */
export const importClosureRuleId = "ImportClosure"

/**
 * Checks whether a value is an {@link ImportClosure} target.
 *
 * @category guards
 * @since 0.1.0
 */
export const isImportClosure = (value: unknown): value is Target.AnyTarget =>
  Target.isTarget(value) && Target.metadata(value).target === importClosureRuleId

/** The entries union {@link ImportClosureAttrs} decodes to. */
type ImportClosureEntries =
  | Target.AnyTarget
  | Filegroup.Source
  | ReadonlyArray<Filegroup.Source | Target.AnyTarget>

/** Rewrites one declared source so its paths resolve from a workspace-relative cwd. */
const sourceAgainstCwd = (cwd: string, source: Filegroup.Source): Filegroup.Source =>
  source._tag === "File"
    ? { _tag: "File", path: Input.resolvePath(cwd, source.path) }
    : {
      _tag: "Glob",
      pattern: Input.resolvePath(cwd, source.pattern),
      exclude: source.exclude.map((entry) => Input.resolvePath(cwd, entry))
    }

/**
 * Walks one file group depth first, keeping each nested group's own anchor.
 *
 * A group whose `cwd` is the default `.` contributes package-relative sources
 * anchored at its declaring PACKAGE.ts directory; a group with an explicit
 * cwd contributes workspace-anchored sources, matching how the planner
 * expands group declarations. Nested groups are entered once each, targets
 * that are not groups contribute nothing, exactly as `Filegroup.sources`.
 */
const filegroupAnchoredSources = (
  group: Target.AnyTarget,
  into: Array<AnchoredSource>,
  seen: Set<Target.AnyTarget>
): void => {
  const metadata = Target.metadata(group)
  const attrs = metadata.attrs as Filegroup.Attrs
  const packageRelative = attrs.cwd === "."
  const base = packageRelative && metadata.sourceFile !== undefined
    ? NodePath.dirname(metadata.sourceFile)
    : ""
  for (const member of attrs.srcs) {
    if (Target.isTarget(member)) {
      if (!Filegroup.isFilegroup(member) || seen.has(member)) continue
      seen.add(member)
      filegroupAnchoredSources(member, into, seen)
      continue
    }
    into.push({ base, source: packageRelative ? member : sourceAgainstCwd(attrs.cwd, member) })
  }
}

/**
 * Reduces declared closure entries to anchored sources, or names the reason
 * they cannot be reduced yet.
 *
 * Plain globs anchor at the declaring PACKAGE.ts directory. File groups
 * flatten with each nested group's own anchor. Any other target — a bundler
 * resolve, a build output — cannot provide entry files until its lane lands,
 * and the returned reason becomes a loud typed refusal, never an empty set.
 *
 * @category expansion
 * @since 0.1.0
 */
export const closureEntrySources = (
  entries: ImportClosureEntries,
  context: Target.ImplementationContext
): ReadonlyArray<AnchoredSource> | string => {
  const list = Array.isArray(entries) ? entries : [entries as Filegroup.Source | Target.AnyTarget]
  const anchored: Array<AnchoredSource> = []
  for (const entry of list) {
    if (Target.isTarget(entry)) {
      if (!Filegroup.isFilegroup(entry)) {
        return `target ${Target.metadata(entry).target} cannot provide entry files yet`
      }
      filegroupAnchoredSources(entry, anchored, new Set([entry]))
      continue
    }
    anchored.push({ base: context.packageDirectory ?? "", source: entry })
  }
  return anchored
}

/**
 * Reduces one file-algebra operand to an executable description, or names
 * the reason it cannot be reduced yet.
 *
 * A file group becomes its anchored source set. An import-closure target, or
 * a `.files` reference to one, becomes a closure description over its entry
 * sources. Every other target is refused by name until its lane lands.
 *
 * @category expansion
 * @since 0.1.0
 */
export const checkOperand = (value: FileSet): FilesCheckOperand | string => {
  const target = Target.isTarget(value) ? value : value.target
  if (Filegroup.isFilegroup(target)) {
    const sources: Array<AnchoredSource> = []
    filegroupAnchoredSources(target, sources, new Set([target]))
    return { _tag: "SourceSet", sources }
  }
  if (isImportClosure(target)) {
    const metadata = Target.metadata(target)
    const entries = closureEntrySources(
      (metadata.attrs as { readonly entries: ImportClosureEntries }).entries,
      {
        sourceFile: metadata.sourceFile,
        packageDirectory: metadata.sourceFile === undefined ? undefined : NodePath.dirname(metadata.sourceFile)
      }
    )
    return typeof entries === "string" ? entries : { _tag: "Closure", entries: [...entries] }
  }
  return `target ${Target.metadata(target).target} does not expose a resolvable file set yet`
}

/**
 * Attrs for {@link Test}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestAttrs = Schema.Struct({
  expect: Schema.Union([FilesDifference, FilesDigest]),
  toBe: Schema.Union([Schema.Literal("empty"), Input.File])
})

const testDefinition = Target.make("Test", {
  attrs: TestAttrs,
  kinds: ["test"],
  success: Schema.Void,
  // NotImplemented is in the union so an operand kind whose lane has not
  // landed refuses with the typed error instead of failing the error-channel
  // schema decode.
  error: Schema.Union([FilesTestError, Target.NotImplemented]),
  implementation: (
    attrs
  ): Node.Node<
    unknown,
    unknown,
    Action.Requirement<"smithers-build/not-implemented"> | Action.Requirement<"smithers-build/files-difference">
  > => {
    if (attrs.expect._tag === "FilesDigest") {
      return Target.notImplemented("Test: Files.digest comparison is executed by package mode")
    }
    if (attrs.toBe !== "empty") {
      return Target.notImplemented("Test: a file-set difference can only compare to empty")
    }
    const left = checkOperand(attrs.expect.left)
    if (typeof left === "string") return Target.notImplemented(`Test: ${left}`)
    const right = checkOperand(attrs.expect.right)
    if (typeof right === "string") return Target.notImplemented(`Test: ${right}`)
    return CheckFilesDifference.call({ left, right, toBe: attrs.toBe })
  }
})

/**
 * A declarative assertion over the file algebra.
 *
 * `expect` subtracts the right file set from the left at execution time and
 * `toBe: "empty"` requires no remainder. A closure operand that contains
 * unresolved or dynamic rows fails the assertion — dead-code style checks
 * fail closed on incomplete closures. Operand kinds no lane has implemented
 * yet refuse with a typed NotImplemented error.
 *
 * @category targets
 * @since 0.1.0
 */
export const Test = (attrs: (typeof TestAttrs)["~type.make.in"]): Target.AnyTarget => testDefinition(attrs)

/**
 * Attrs for {@link Materialize}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const MaterializeAttrs = Schema.Struct({
  target: Target.Target
})

const materializeDefinition = Target.make("Materialize", {
  attrs: MaterializeAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Materialize")
})

/**
 * Places a build target's cached output tree into the working tree.
 *
 * @category targets
 * @since 0.1.0
 */
export const Materialize = (target: Target.AnyTarget): Target.AnyTarget => {
  if (!Target.isTarget(target)) throw new TypeError("Materialize requires a target")
  return materializeDefinition({ target })
}

/**
 * Attrs for {@link ImportClosure}. `entries` is a file-producing target or a
 * declared glob list.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ImportClosureAttrs = Schema.Struct({
  entries: Schema.Union([
    Target.Target,
    Filegroup.Source,
    Schema.Array(Schema.Union([Filegroup.Source, Target.Target]))
  ])
})

const importClosureDefinition = Target.make(importClosureRuleId, {
  attrs: ImportClosureAttrs,
  kinds: ["build"],
  success: ClosureResult,
  // NotImplemented is in the union so an entry kind whose lane has not
  // landed refuses with the typed error instead of failing the error-channel
  // schema decode.
  error: Schema.Union([ImportClosureError, Target.NotImplemented]),
  implementation: (
    attrs,
    context
  ): Node.Node<
    unknown,
    unknown,
    Action.Requirement<"smithers-build/not-implemented"> | Action.Requirement<"smithers-build/import-closure">
  > => {
    const entries = closureEntrySources(attrs.entries, context)
    return typeof entries === "string"
      ? Target.notImplemented(`ImportClosure: ${entries}`)
      : ResolveImportClosure.call({ entries: [...entries] })
  }
})

/**
 * The transitive import closure of the entry files, as per-file rows.
 *
 * The constructed target exposes `.files` like a bundler resolve target.
 * Execution resolves entries to files, parses each reachable module for its
 * import, export-from, require, and dynamic-import specifiers, and follows
 * resolved file edges to a fixed point. The result is the sorted reachable
 * file set with digests, the imported node_modules packages as package-level
 * names, and explicit unresolved and dynamic rows. The target itself is not
 * marked cacheable: its complete input set is the closure it computes, which
 * declared inputs alone do not identify; per-file resolver rows are cached
 * by the executing layer instead, keyed on file digest and resolver
 * configuration.
 *
 * @category targets
 * @since 0.1.0
 */
export const ImportClosure = (
  attrs: (typeof ImportClosureAttrs)["~type.make.in"]
): Target.AnyTarget & { readonly files: TargetFiles } =>
  attachFiles(importClosureDefinition(attrs) as unknown as Target.AnyTarget)

/**
 * Attrs for {@link Clean}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CleanAttrs = Schema.Struct({
  targets: Schema.optional(Schema.Array(Target.Target)),
  paths: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

const cleanDefinition = Target.make("Clean", {
  attrs: CleanAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Clean")
})

/**
 * Removes the declared targets' outputs and the named scratch paths, and
 * nothing else.
 *
 * @category targets
 * @since 0.1.0
 */
export const Clean = (attrs: (typeof CleanAttrs)["~type.make.in"]): Target.AnyTarget => cleanDefinition(attrs)
