/**
 * Target declarations built on the flows Flow API.
 *
 * @since 0.1.0
 */
import { Action, Flow, type FlowRuntime } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { createHash } from "node:crypto"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { getCallSites } from "node:util"
import * as NodeUtil from "node:util/types"
import * as Config from "./Config.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"

/**
 * CLI verbs a target can participate in.
 *
 * `docs` is the documentation-parity verb. It remains independently
 * addressable and also participates in the aggregate `ci` command.
 *
 * @category models
 * @since 0.1.0
 */
export const Kind = Schema.Literals(["build", "test", "lint", "run", "docs"])

/**
 * CLI verbs a target can participate in.
 *
 * @category models
 * @since 0.1.0
 */
export type Kind = typeof Kind.Type

/** Runtime membership check kept independent of schema internals. */
const kindNames: ReadonlySet<string> = new Set(["build", "test", "lint", "run", "docs"])

const isKind = (value: unknown): value is Kind => typeof value === "string" && kindNames.has(value)

/**
 * Runtime marker shared by source and installed copies of this package.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TargetTypeId: unique symbol = Symbol.for("smithers-build/Target") as never

/**
 * The output tree a target promises one execution will produce.
 *
 * `cwd` is the workspace-relative directory the declared paths resolve
 * against, and `paths` is the complete, ordered list of them. This is target
 * metadata rather than something read back out of attrs at admission time: an
 * untrusted cache entry must never get to choose which paths are verified, and
 * an implementation must not get to decide after the fact that it produced
 * fewer outputs than it declared.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeclaredOutputs {
  readonly cwd: string
  readonly paths: ReadonlyArray<string>
}

/** Matches an absolute path on any host this can run on. */
const absolutePath = /^([/\\]|[A-Za-z]:)/

/**
 * Splits one workspace-relative declaration into segments, or names the reason
 * it is unusable.
 *
 * `.` and empty segments are dropped, so `dist`, `./dist`, and `dist/` all
 * reduce to the same segments and are recognised as the same declaration.
 */
const segmentsOf = (value: string): ReadonlyArray<string> | string => {
  if (value === "") return "is empty"
  if (absolutePath.test(value)) return "is absolute"
  if (value.includes("\0")) return "contains a null byte"
  const segments = value.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".")
  if (segments.includes("..")) return "leaves the directory it is declared against"
  return segments
}

/**
 * Directories a declared output may never name or sit inside.
 *
 * The default cache directory is the result store: an output captured from
 * inside it would be digested out of the same tree that stores the digest, and
 * a cache admission would then verify a stored entry against a copy of itself.
 * `.git` is refused for the same structural reason.
 */
const reservedRoots: ReadonlySet<string> = new Set([Config.defaultCacheDirectory, ".git"])

/**
 * Returns the reason one declared output path is unusable, or undefined.
 *
 * This is the single definition of a legal declaration. Target metadata applies
 * it when a target is constructed, and execution applies it again to the paths
 * that arrive in an action payload or a cache entry.
 *
 * @category validation
 * @since 0.1.0
 */
export const declaredOutputFailure = (cwd: string, path: string): string | undefined => {
  const base = segmentsOf(cwd)
  if (typeof base === "string") return `the output cwd ${JSON.stringify(cwd)} ${base}`
  const own = segmentsOf(path)
  if (typeof own === "string") return `the output path ${JSON.stringify(path)} ${own}`
  if (own.length === 0) return `the output path ${JSON.stringify(path)} names its own directory rather than an output`
  const resolved = [...base, ...own]
  if (reservedRoots.has(resolved[0]!)) {
    return `the output path ${JSON.stringify(path)} resolves inside the reserved directory ${resolved[0]}`
  }
  return undefined
}

/**
 * Returns the reason one declared output set is unusable, or undefined.
 *
 * A duplicate is refused because the manifest contract is an exact, positional
 * match: a target that names one output twice could never be satisfied by a
 * manifest that also refuses duplicates. Duplication is judged after the
 * declarations resolve, so `dist` and `./dist` collide. An overlap is refused
 * for the same reason one step out: `dist` and `dist/index.js` would put one
 * file in the manifest twice, under two different digests that no longer have
 * to agree.
 *
 * @category validation
 * @since 0.1.0
 */
export const declaredOutputsFailure = (value: DeclaredOutputs): string | undefined => {
  const base = segmentsOf(value.cwd)
  if (typeof base === "string") return `the output cwd ${JSON.stringify(value.cwd)} ${base}`
  const resolved: Array<{ readonly path: string; readonly segments: ReadonlyArray<string> }> = []
  for (const path of value.paths) {
    const failure = declaredOutputFailure(value.cwd, path)
    if (failure !== undefined) return failure
    const own = segmentsOf(path) as ReadonlyArray<string>
    resolved.push({ path, segments: [...base, ...own].map((segment) => segment.normalize("NFC")) })
  }
  for (const [index, entry] of resolved.entries()) {
    for (const other of resolved.slice(index + 1)) {
      const shorter = entry.segments.length <= other.segments.length ? entry : other
      const longer = shorter === entry ? other : entry
      if (!shorter.segments.every((segment, at) => longer.segments[at] === segment)) continue
      return shorter.segments.length === longer.segments.length
        ? `the output paths ${JSON.stringify(entry.path)} and ${JSON.stringify(other.path)} name the same output`
        : `the output path ${JSON.stringify(longer.path)} is already covered by ${JSON.stringify(shorter.path)}`
    }
  }
  return undefined
}

/**
 * Validates one declared output set, or throws naming the target that declared
 * it.
 *
 * @category validation
 * @since 0.1.0
 */
export const declaredOutputs = (target: string, value: DeclaredOutputs): DeclaredOutputs => {
  const failure = declaredOutputsFailure(value)
  if (failure !== undefined) throw new Error(`${target} declared outputs it cannot produce: ${failure}`)
  return { cwd: value.cwd, paths: [...value.paths] }
}

/**
 * The attrs, declared inputs, declared outputs, and cacheability one verb sees
 * for a target.
 *
 * @category models
 * @since 0.1.0
 */
export interface KindView {
  readonly attrs: unknown
  readonly dependencies: ReadonlyArray<AnyTarget>
  readonly inputs: ReadonlyArray<Input.Declared>
  readonly cacheable: boolean
  readonly outputs: DeclaredOutputs | undefined
}

/**
 * Planner metadata attached to a target Flow.
 *
 * `forKind` resolves the attrs a verb executes with. A target without an
 * `attrsForKind` mapping returns the declared view for every verb. A target
 * with one, for example a generator whose `build` writes and whose `lint`
 * checks drift, returns re-derived inputs, outputs, and cacheability for the
 * mapped attrs. `implementationDigest` identifies the implementation and every
 * optional function that derives attrs, inputs, outputs, or cacheability.
 * `outputs` is the declared output tree, undefined for a target that promises
 * none. Dependencies are re-derived from verb-effective attrs and may vary by
 * verb. `verbGate`, when present, is the complete set of verbs
 * whose graph may include this target, including through a dependency edge.
 *
 * @category models
 * @since 0.1.0
 */
export interface Metadata {
  readonly target: string
  readonly implementationDigest: string
  /** JSON-schema identity of the payload, success, and error contracts. */
  readonly schemaIdentity: unknown
  readonly kinds: ReadonlyArray<Kind>
  readonly attrs: unknown
  readonly attrsSchema: Flow.AnyStructSchema
  /** Validates an untrusted cached value against the success type in this package's Schema runtime. */
  readonly decodeSuccess: (value: unknown) => unknown
  readonly dependencies: ReadonlyArray<AnyTarget>
  readonly inputs: ReadonlyArray<Input.Declared>
  readonly cacheable: boolean
  readonly outputs: DeclaredOutputs | undefined
  readonly verbGate: ReadonlyArray<Kind> | undefined
  readonly sourceFile: string | undefined
  readonly forKind: (kind: Kind) => KindView
}

/**
 * A Flow returned by a target invocation and exported from a BUILD.ts file.
 *
 * @category models
 * @since 0.1.0
 */
export type Target<
  Id extends string = string,
  Attrs extends Flow.AnyStructSchema = Flow.AnyStructSchema,
  Success extends Schema.Top = Schema.Top,
  Error extends Schema.Top = Schema.Top,
  Requires = unknown
> = Flow.Flow<Id, Attrs, Success, Error, Requires> & {
  readonly [TargetTypeId]: Metadata
}

/**
 * Type-erased target used for dependency edges and discovery.
 *
 * @category models
 * @since 0.1.0
 */
export type AnyTarget = Flow.Any & { readonly [TargetTypeId]: Metadata }

/**
 * Opaque Effect Schema for direct target references in target attrs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Target = Schema.declare<AnyTarget>(
  (value): value is AnyTarget => isTarget(value),
  {
    identifier: "smithers-build/Target",
    title: "BUILD.ts target reference",
    description: "A direct import of another BUILD.ts target"
  }
)

/**
 * Error returned by every catalog stub when someone executes it.
 *
 * @category errors
 * @since 0.1.0
 */
export class NotImplemented extends Schema.TaggedError<NotImplemented>()(
  "smithers-build/NotImplemented",
  {
    target: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }
) {}

/**
 * Shared action used by catalog stubs.
 *
 * @category actions
 * @since 0.1.0
 */
export const NotImplementedAction = Action.make("smithers-build/not-implemented", {
  payload: { target: Schema.NonEmptyString },
  error: NotImplemented,
  tier: "sealed"
})

/**
 * Layer that turns a catalog stub node into its typed failure.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNotImplemented: Layer.Layer<
  Action.Requirement<"smithers-build/not-implemented">,
  never,
  FlowRuntime.FlowRuntime
> = NotImplementedAction.toLayer(({ target }) =>
  Effect.fail(new NotImplemented({ target, message: `NotImplemented: ${target}` }))
)

/**
 * Produces the plan node shared by catalog target stubs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const notImplemented = (
  target: string
): Node.Node<void, NotImplemented, Action.Requirement<"smithers-build/not-implemented">> =>
  NotImplementedAction.call({ target })

/**
 * Declares one tool run through the shared {@link Exec.Exec} action.
 *
 * Target implementations call this in their pure plan-time bodies to record an
 * exec node. Executing the resulting plan requires {@link Exec.ExecLive}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const runTool = (
  payload: Exec.CallPayload
): Node.Node<Exec.Result, Exec.ExecError, Action.Requirement<"smithers-build/exec">> => Exec.Exec.call(payload)

/**
 * Checks whether a value is a BUILD.ts target.
 *
 * @category guards
 * @since 0.1.0
 */
export const isTarget = (value: unknown): value is AnyTarget => {
  if (!(typeof value === "function" || Predicate.isObject(value)) || NodeUtil.isProxy(value)) return false
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, TargetTypeId)
  } catch {
    return false
  }
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== false ||
    descriptor.configurable !== false ||
    descriptor.writable !== false
  ) return false
  return isMetadata(descriptor.value)
}

const missingProperty: unique symbol = Symbol("missing metadata property")

/** Reads an own data property without invoking user code. */
const ownData = (value: object, key: PropertyKey): unknown | typeof missingProperty => {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    return missingProperty
  }
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : missingProperty
}

/** Whether a value is a non-proxy array whose entries satisfy a predicate. */
const isArrayOf = <A>(value: unknown, guard: (entry: unknown) => entry is A): value is ReadonlyArray<A> => {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    NodeUtil.isProxy(value) ||
    !Array.isArray(value)
  ) return false
  const length = ownData(value, "length")
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return false
  for (let index = 0; index < length; index += 1) {
    const entry = ownData(value, String(index))
    if (entry === missingProperty || !guard(entry)) return false
  }
  return true
}

/** Validates the metadata object carried by a target marker. */
const isMetadata = (value: unknown): value is Metadata => {
  if (!Predicate.isObject(value) || NodeUtil.isProxy(value)) return false
  const target = ownData(value, "target")
  const implementationDigest = ownData(value, "implementationDigest")
  const kinds = ownData(value, "kinds")
  const dependencies = ownData(value, "dependencies")
  const inputs = ownData(value, "inputs")
  const cacheable = ownData(value, "cacheable")
  const outputs = ownData(value, "outputs")
  const verbGate = ownData(value, "verbGate")
  const source = ownData(value, "sourceFile")
  const attrsSchema = ownData(value, "attrsSchema")
  const decodeSuccess = ownData(value, "decodeSuccess")
  const forKind = ownData(value, "forKind")
  if (
    typeof target !== "string" || target === "" ||
    typeof implementationDigest !== "string" || !/^[0-9a-f]{64}$/.test(implementationDigest) ||
    !isArrayOf(kinds, isKind) ||
    !isArrayOf(dependencies, (_entry): _entry is AnyTarget => true) ||
    !isArrayOf(inputs, (_entry): _entry is Input.Declared => true) ||
    typeof cacheable !== "boolean" ||
    (source !== undefined && typeof source !== "string") ||
    attrsSchema === missingProperty ||
    typeof decodeSuccess !== "function" ||
    typeof forKind !== "function"
  ) return false
  if (
    verbGate !== undefined &&
    !isArrayOf(verbGate, isKind)
  ) return false
  if (outputs !== undefined) {
    if (!Predicate.isObject(outputs) || NodeUtil.isProxy(outputs)) return false
    const cwd = ownData(outputs, "cwd")
    const paths = ownData(outputs, "paths")
    if (typeof cwd !== "string" || !isArrayOf(paths, (path): path is string => typeof path === "string")) return false
  }
  return ownData(value, "attrs") !== missingProperty && ownData(value, "schemaIdentity") !== missingProperty
}

/**
 * Reads the planner metadata attached by {@link make}.
 *
 * @category accessors
 * @since 0.1.0
 */
export const metadata = (target: AnyTarget): Metadata => {
  if (!isTarget(target)) throw new TypeError("value is not a well-formed smithers build target")
  return ownData(target, TargetTypeId) as Metadata
}

/**
 * A callable target definition.
 *
 * @category models
 * @since 0.1.0
 */
export interface Definition<
  Id extends string,
  Attrs extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
> {
  (attrs: Attrs["~type.make.in"]): Target<Id, Attrs, Success, Error, Requires>
  readonly id: Id
  readonly attrs: Attrs
  readonly kinds: ReadonlyArray<Kind>
}

/**
 * Declaration-site context passed to a target implementation.
 *
 * `packageDirectory` is the absolute directory containing the declaring
 * BUILD.ts file. It is undefined only when a target was constructed outside a
 * BUILD.ts module.
 *
 * @category models
 * @since 0.1.0
 */
export interface ImplementationContext {
  readonly sourceFile: string | undefined
  readonly packageDirectory: string | undefined
}

/**
 * Options accepted by {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<
  Attrs extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
> {
  readonly attrs: Attrs
  readonly kinds: ReadonlyArray<Kind>
  readonly success?: Success | undefined
  readonly error?: Error | undefined
  readonly implementation: (
    attrs: Attrs["Type"],
    context: ImplementationContext
  ) => Node.Node<unknown, unknown, Requires>
  readonly inputs?: ((attrs: Attrs["Type"]) => ReadonlyArray<Input.Declared>) | undefined
  /**
   * The complete output tree this target promises to produce, derived from
   * decoded attrs. A target that declares one must return a matching output
   * manifest from every successful execution; see
   * {@link ToolBuild.captureOutputs}.
   */
  readonly outputs?: ((attrs: Attrs["Type"]) => DeclaredOutputs) | undefined
  /**
   * Whether executor results may be replayed across runs. The default is
   * false: arbitrary target bodies can consult tools, services, or host state
   * that attrs and declared inputs do not identify. A target opts in only after
   * its implementation has a complete deterministic input contract.
   */
  readonly cache?: boolean | ((attrs: Attrs["Type"]) => boolean) | undefined
  readonly attrsForKind?: ((kind: Kind, attrs: Attrs["Type"]) => Attrs["Type"]) | undefined
  readonly verbGate?:
    | ReadonlyArray<Kind>
    | ((attrs: Attrs["Type"]) => ReadonlyArray<Kind> | undefined)
    | undefined
}

const collect = (
  value: unknown,
  inputs: Array<Input.Declared>,
  dependencies: Array<AnyTarget>,
  seen: Set<object>
): void => {
  if (
    (typeof value === "object" && value !== null || typeof value === "function") &&
    NodeUtil.isProxy(value)
  ) {
    throw new TypeError("target attrs must not contain a Proxy")
  }
  if (isTarget(value)) {
    dependencies.push(value)
    return
  }
  if (Input.isDeclared(value)) {
    inputs.push(value)
    return
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value)
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      names.length !== value.length + 1 ||
      names.at(-1) !== "length" ||
      Object.getOwnPropertySymbols(value).length > 0
    ) return
    for (let index = 0; index < value.length; index += 1) {
      if (names[index] !== String(index)) return
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return
      collect(descriptor.value, inputs, dependencies, seen)
    }
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  if (Object.getOwnPropertySymbols(value).length > 0) return
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return
    collect(descriptor.value, inputs, dependencies, seen)
  }
}

/**
 * The BUILD.ts call site a declaration was written at.
 *
 * `path` alone identifies the declaring package. `line` and `column` are
 * reported back to the author when a declaration is rejected, and are absent
 * when the host does not expose them.
 */
interface SourceSite {
  readonly path: string
  readonly line: number | undefined
  readonly column: number | undefined
}

const sourceSite = (): SourceSite | undefined => {
  let sites: ReturnType<typeof getCallSites>
  try {
    sites = getCallSites(100, { sourceMap: true })
  } catch {
    return undefined
  }
  for (const site of sites) {
    let file = site.scriptName
    try {
      if (file.startsWith("file:")) file = fileURLToPath(file)
    } catch {
      continue
    }
    // BUILD.ts is the legacy authoring surface; PACKAGE.ts and WORKSPACE.ts
    // are the routed one. The site is diagnostic context only — package-mode
    // labels come exclusively from the package index, never from this stack.
    const basename = NodePath.basename(file)
    if (basename !== "BUILD.ts" && basename !== "PACKAGE.ts" && basename !== "WORKSPACE.ts") continue
    const positive = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
    return { path: NodePath.resolve(file), line: positive(site.lineNumber), column: positive(site.columnNumber) }
  }
  return undefined
}

/**
 * Maximum UTF-16 code units of formatted schema detail admitted into one
 * declaration-rejected message.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumRejectionDetailCodeUnits = 8 * 1024

const formatIssue = SchemaIssue.makeFormatterDefault()

/**
 * Renders why one declaration was rejected, without running author code.
 *
 * A rejected `Schema.make` carries the structured issue on `cause`. Reporting
 * only the constructor's own `"Schema validation failed"` loses the path and
 * the expectation, which is the whole content of the failure: an author is
 * told a BUILD file is invalid without being told which attr is wrong. The
 * issue is formatted when it is one, and otherwise the message is taken from
 * an own data property so an author-supplied accessor or Proxy cannot run.
 */
const rejectionDetail = (cause: unknown): string | undefined => {
  const bound = (text: string): string | undefined => {
    const wellFormed = text.isWellFormed() ? text : text.toWellFormed()
    if (wellFormed === "") return undefined
    return wellFormed.length <= maximumRejectionDetailCodeUnits
      ? wellFormed
      : `${wellFormed.slice(0, maximumRejectionDetailCodeUnits - 3)}...`
  }
  if (typeof cause !== "object" || cause === null || NodeUtil.isProxy(cause)) return undefined
  const issue = Object.getOwnPropertyDescriptor(cause, "cause")
  if (issue !== undefined && "value" in issue && SchemaIssue.isIssue(issue.value)) {
    try {
      return bound(formatIssue(issue.value))
    } catch {
      // Fall through to the plain message below.
    }
  }
  const message = Object.getOwnPropertyDescriptor(cause, "message")
  return message !== undefined && "value" in message && typeof message.value === "string"
    ? bound(message.value)
    : undefined
}

/**
 * Rejects one declaration with the target, the authoring site, and the reason.
 *
 * @category errors
 * @since 0.1.0
 */
export const declarationRejected = (id: string, site: SourceSite | undefined, cause: unknown): Error => {
  const where = site === undefined
    ? ""
    : ` at ${site.path}${
      site.line === undefined ? "" : `:${site.line}${site.column === undefined ? "" : `:${site.column}`}`
    }`
  const detail = rejectionDetail(cause)
  return new Error(
    `${id} declaration${where} is invalid${detail === undefined ? "" : `: ${detail}`}`,
    { cause }
  )
}

/**
 * Every target constructor validates attrs with excess properties as errors.
 *
 * `Schema.Struct.make` strips unknown keys by default, so a misspelled attr
 * (`gate` for `gates`, `approvals` for `approval`) would construct a green
 * target with the edge or safety attr silently absent. Declaration input is
 * author-written and there is no other guard in the pipeline (PACKAGE.ts is
 * loaded without typechecking), so an unknown key is a rejected declaration,
 * never a dropped one. The option applies recursively, so a nested struct
 * such as `readiness` rejects unknown keys too.
 */
const strictMake = { parseOptions: { onExcessProperty: "error" } } as const

/**
 * Creates a target whose attrs are the Flow payload schema and whose
 * implementation is the Flow's required pure plan-time body.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <
  const Id extends string,
  Attrs extends Flow.AnyStructSchema,
  Success extends Schema.Top = typeof Schema.Void,
  Error extends Schema.Top = typeof Schema.Never,
  Requires = never
>(
  id: Id,
  options: MakeOptions<Attrs, Success, Error, Requires>
): Definition<Id, Attrs, Success, Error, Requires> => {
  const successSchema = options.success ?? (Schema.Void as unknown as Success)
  const errorSchema = options.error ?? (Schema.Never as unknown as Error)
  const decodeSuccess = Schema.decodeUnknownSync(Schema.toType(successSchema))
  const schemaIdentity = {
    attrs: Schema.toJsonSchemaDocument(options.attrs),
    success: Schema.toJsonSchemaDocument(successSchema),
    error: Schema.toJsonSchemaDocument(errorSchema)
  }
  const functionIdentity = (operation: unknown): Node.FunctionIdentity | null =>
    operation === undefined ? null : Node.functionIdentity(operation)
  const implementationDigest = createHash("sha256").update(JSON.stringify({
    implementation: functionIdentity(options.implementation),
    attrsForKind: functionIdentity(options.attrsForKind),
    cache: typeof options.cache === "function"
      ? ["function", Node.functionIdentity(options.cache)]
      : ["constant", options.cache ?? false],
    inputs: functionIdentity(options.inputs),
    outputs: functionIdentity(options.outputs),
    verbGate: typeof options.verbGate === "function"
      ? Node.functionIdentity(options.verbGate)
      : options.verbGate ?? null,
    schemas: schemaIdentity
  })).digest("hex")
  const definition = (attrsInput: Attrs["~type.make.in"]) => {
    // Resolved before the attrs are constructed so a rejection can name the
    // BUILD.ts line the author has to edit.
    const site = sourceSite()
    let attrs: Attrs["Type"]
    try {
      attrs = options.attrs.make(attrsInput, strictMake)
    } catch (cause) {
      throw declarationRejected(id, site, cause)
    }
    const declarationSourceFile = site?.path
    const context: ImplementationContext = {
      sourceFile: declarationSourceFile,
      packageDirectory: declarationSourceFile === undefined ? undefined : NodePath.dirname(declarationSourceFile)
    }
    const inputs: Array<Input.Declared> = []
    const dependencies: Array<AnyTarget> = []
    collect(attrs, inputs, dependencies, new Set())
    if (options.inputs !== undefined) inputs.push(...options.inputs(attrs))
    const cacheableFor = (value: Attrs["Type"]): boolean =>
      typeof options.cache === "function" ? options.cache(value) : options.cache ?? false
    const resolvedVerbGate = typeof options.verbGate === "function" ? options.verbGate(attrs) : options.verbGate
    const verbGate = resolvedVerbGate === undefined ? undefined : [...new Set(resolvedVerbGate)]
    const outputsFor = (value: Attrs["Type"]): DeclaredOutputs | undefined =>
      options.outputs === undefined ? undefined : declaredOutputs(id, options.outputs(value))
    const baseView: KindView = {
      attrs,
      dependencies: [...new Set(dependencies)],
      inputs: [...new Set(inputs)],
      cacheable: cacheableFor(attrs),
      outputs: outputsFor(attrs)
    }
    const kindViews = new Map<Kind, KindView>()
    const forKind = (kind: Kind): KindView => {
      if (options.attrsForKind === undefined) return baseView
      const cached = kindViews.get(kind)
      if (cached !== undefined) return cached
      const candidate = options.attrsForKind(kind, attrs)
      if (candidate === attrs) {
        kindViews.set(kind, baseView)
        return baseView
      }
      let mapped: Attrs["Type"]
      try {
        mapped = options.attrs.make(candidate, strictMake)
      } catch (cause) {
        throw declarationRejected(`${id} (${kind})`, site, cause)
      }
      const mappedInputs: Array<Input.Declared> = []
      const mappedDependencies: Array<AnyTarget> = []
      collect(mapped, mappedInputs, mappedDependencies, new Set())
      if (options.inputs !== undefined) mappedInputs.push(...options.inputs(mapped))
      const dependenciesForKind = [...new Set(mappedDependencies)]
      const view: KindView = {
        attrs: mapped,
        dependencies: dependenciesForKind,
        inputs: [...new Set(mappedInputs)],
        cacheable: cacheableFor(mapped),
        outputs: outputsFor(mapped)
      }
      kindViews.set(kind, view)
      return view
    }
    const flow = Flow.make<Id, Attrs, Success, Error, Requires>(id, {
      payload: options.attrs,
      success: successSchema,
      error: errorSchema,
      body: (value) => options.implementation(value, context)
    })
    const value: Metadata = {
      target: id,
      implementationDigest,
      schemaIdentity,
      kinds: [...new Set(options.kinds)],
      attrs,
      attrsSchema: options.attrs,
      decodeSuccess,
      dependencies: baseView.dependencies,
      inputs: baseView.inputs,
      cacheable: baseView.cacheable,
      outputs: baseView.outputs,
      verbGate,
      sourceFile: declarationSourceFile,
      forKind
    }
    Object.defineProperty(flow, TargetTypeId, {
      configurable: false,
      enumerable: false,
      value,
      writable: false
    })
    return flow as unknown as Target<Id, Attrs, Success, Error, Requires>
  }
  return Object.assign(definition, {
    id,
    attrs: options.attrs,
    kinds: [...new Set(options.kinds)]
  })
}
