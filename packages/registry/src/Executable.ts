/**
 * Turning a discovered descriptor into something the durable engine runs.
 *
 * Discovery answers *what flows exist*: a {@link module:Descriptor.FlowDescriptor}
 * is metadata read without evaluating anything, with the body left behind a
 * {@link module:Descriptor.BodyRef}. Nothing in that answer is executable, so
 * `smithers up <flow>` could print a plan card and stop. This module is the
 * missing half: it loads the body a descriptor points at, resolves the
 * `@smthrs/flow` flow the descriptor delegates to, and returns a durable flow
 * plus the `Interpreter` layer that registers it with the runtime.
 *
 * The bridge deliberately does not compile a `@smthrs/core` graph into a plan.
 * A discovered flow declares WHAT it delegates to — a markdown `flows:`
 * frontmatter list, a module `Flow.make({ flows })` — and the host declares
 * HOW that work runs, by registering `@smthrs/flow` flows under those names.
 * One delegating node is therefore the whole lowering, and every runtime
 * decision the descriptor carries rides it:
 *
 * - the declared cache policy becomes key material captured on the delegating
 *   node, so a changed policy is a changed step key, and the flow's
 *   `@smthrs/flow` `CacheEnvironment.CachePolicyAnnotation`, which is where
 *   `@smthrs/patterns`' `withCache` puts one too. Read {@link Lowered.cache}
 *   for what rc.0 does and does not do with it: the annotation is declaration
 *   identity here, not a dispatch instruction;
 * - `Node.priority` becomes the delegating node's priority, which is what
 *   reaches `NodeDraft.priority` and `@smthrs/engine-store`'s `PlanScheduler`.
 *   The rc.0 `up` path settles a flow through `@smthrs/flow` `Interpreter`,
 *   which admits every ready node at once, so the priority orders scheduled
 *   plans and nothing else;
 * - the placement directive becomes both the flow's opaque
 *   `@smthrs/flow` placement annotation and a field of the
 *   {@link Invocation} the delegate reads, which is what a host selects a
 *   spawn target with.
 *
 * A delegate the host never registered is refused HERE, with an
 * {@link ExecutableError} naming it, rather than at dispatch: an unresolved
 * call inside the engine dies with an empty `AnyOf` issue that names nothing
 * (`docs/migration` Phase 5 finding 1), and a missing flow is a wiring mistake
 * an operator can fix only if the message says which flow is missing.
 *
 * @since 0.1.0
 */
import * as Annotations from "@smthrs/core/Annotations"
import * as CoreFlow from "@smthrs/core/Flow"
import * as CoreMarkdown from "@smthrs/core/Markdown"
import * as CorePlacement from "@smthrs/core/Placement"
import type { Implementations } from "@smthrs/flow/Action"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import * as RuntimeFlow from "@smthrs/flow/Flow"
import type { FlowRuntime } from "@smthrs/flow/FlowRuntime"
import * as Interpreter from "@smthrs/flow/Interpreter"
import * as PlanNode from "@smthrs/plan/Node"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type * as Descriptor from "./Descriptor.ts"
import * as Discovery from "./Discovery.ts"
import * as MarkdownFlow from "./MarkdownFlow.ts"
import * as Registry from "./Registry.ts"
import { type DiscoveryError, discoveryError, type RegistryError } from "./RegistryError.ts"

/**
 * The delegate a descriptor runs on when it names no single flow of its own.
 *
 * A markdown skill and a bodiless `Flow.make({ model })` both say "a model
 * does this"; neither names the code that drives one. `agent` is the name a
 * host registers that driver under, and {@link Options.agent} renames it for a
 * host that calls it something else.
 *
 * @category constructors
 * @since 0.1.0
 */
export const defaultAgent = "agent"

/**
 * The payload a bridged flow is executed with.
 *
 * One JSON field, because the caller is `smithers up <flow> --data <json>` or
 * a control-plane launch, and neither knows the descriptor's schema at the
 * call site. A markdown flow receives its `{ args }` here.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Payload = Schema.Struct({
  input: Schema.optionalKey(Schema.Json)
})

/**
 * The payload a bridged flow is executed with.
 *
 * @category models
 * @since 0.1.0
 */
export type Payload = typeof Payload.Type

/**
 * Everything a delegate is told about the descriptor it is running.
 *
 * It is a fixed, serializable envelope rather than the descriptor's own input
 * schema, because a host registers ONE delegate for many descriptors: the
 * agent driver runs every markdown skill in the project. The envelope is what
 * lets it, and it carries the two decisions a driver cannot re-derive —
 * `placement`, which selects the host a cell is spawned on, and `model`, which
 * selects the seat.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Invocation = Schema.Struct({
  /** The discovered flow's registry name. */
  flow: Schema.String,
  /** The caller's input, as JSON. `null` when the caller supplied none. */
  input: Schema.Json,
  /** The rendered markdown body, or the empty string for a module flow. */
  prompt: Schema.String,
  /** The seat the descriptor declared, or `null`. */
  model: Schema.NullOr(Schema.String),
  /** The placement directive the descriptor declared, or `null`. */
  placement: Schema.NullOr(Schema.Literals(["client", "local", "sandbox", "remote"])),
  /** The capabilities the descriptor declared. */
  capabilities: Schema.Array(Schema.String),
  /** The collaborator flows the descriptor declared. */
  flows: Schema.Array(Schema.String)
})

/**
 * Everything a delegate is told about the descriptor it is running.
 *
 * @category models
 * @since 0.1.0
 */
export type Invocation = typeof Invocation.Type

/**
 * A registered `@smthrs/flow` flow a descriptor may delegate to.
 *
 * Structural on purpose: a `Flow.make(...)` value satisfies it, and so does a
 * test double that records what it was called with. The bridge needs the tag
 * to resolve a name and `call` to place the delegation in the caller's plan;
 * it never executes a delegate itself.
 *
 * @category models
 * @since 0.1.0
 */
export interface Delegate {
  readonly _tag: string
  readonly call: (payload: any) => PlanNode.Node<any, any, any>
}

/**
 * Stable reasons a descriptor cannot be made runnable.
 *
 * @category models
 * @since 0.1.0
 */
export const ExecutableErrorCode = Schema.Literals([
  "missing_delegate",
  "ambiguous_delegate",
  "body_unavailable",
  "invalid_module"
])

/**
 * Stable reasons a descriptor cannot be made runnable.
 *
 * @category models
 * @since 0.1.0
 */
export type ExecutableErrorCode = typeof ExecutableErrorCode.Type

/**
 * A descriptor the bridge will not turn into a runnable flow.
 *
 * `delegate` is present whenever the refusal is about one named flow, which is
 * the whole point of the type: the engine's own unresolved-call defect names
 * nothing, so an operator reading it cannot tell which registration is
 * missing.
 *
 * @category errors
 * @since 0.1.0
 */
export class ExecutableError extends Schema.TaggedError<ExecutableError>()(
  "flows/registry/ExecutableError",
  {
    code: ExecutableErrorCode,
    flow: Schema.String,
    delegate: Schema.optional(Schema.String),
    available: Schema.Array(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * The runtime decisions lowered off a descriptor and its loaded body.
 *
 * @category models
 * @since 0.1.0
 */
export interface Lowered {
  /**
   * The declared cache policy, or `undefined` when none was declared.
   *
   * In rc.0 this is declaration identity, not a dispatch instruction. It enters
   * the delegating node's captured key material, so a changed policy is a
   * changed step key, and it is annotated on the bridged flow under the
   * identifier `@smthrs/engine-store` reads a policy off a dispatched action.
   * Nothing carries a flow's annotation bag onto the actions its delegate
   * dispatches, so neither `ttlMs` nor `scope` narrows a cache row here.
   */
  readonly cache: CacheEnvironment.CachePolicy | undefined
  /**
   * The declared scheduling priority, or `undefined`.
   *
   * Honored by `@smthrs/engine-store`'s `PlanScheduler`, which admits ready
   * nodes highest-priority-first under a concurrency limit. The rc.0 `up` path
   * runs a flow through `@smthrs/flow` `Interpreter`, which settles every ready
   * node at once, so on that path the priority orders nothing.
   */
  readonly priority: number | undefined
  /** The declared placement directive, or `undefined`. */
  readonly placement: CorePlacement.Placement | undefined
}

/**
 * What a registration layer still needs from its host: the flow runtime it
 * registers with, and the action implementation table its body's delegate
 * resolves calls through.
 *
 * @category models
 * @since 0.1.0
 */
export type Registration = FlowRuntime | Implementations

/**
 * One discovered flow, made runnable.
 *
 * @category models
 * @since 0.1.0
 */
export interface Executable {
  /** The descriptor this was built from. */
  readonly descriptor: Descriptor.FlowDescriptor
  /** The registered flow this descriptor delegates to. */
  readonly delegate: string
  /** The runtime decisions lowered off the descriptor. */
  readonly lowered: Lowered
  /** The envelope the delegate receives for a given caller input. */
  readonly invocation: (input: Schema.Json) => Invocation
  /** The durable flow, tagged with the descriptor's registry name. */
  readonly flow: RuntimeFlow.Flow<string, typeof Payload, typeof Schema.Unknown, typeof Schema.Unknown, any>
  /** Registers {@link Executable.flow} with the runtime. */
  readonly layer: Layer.Layer<never, never, Registration>
}

/**
 * How a descriptor is loaded and what it may delegate to.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** The registered runtime flows a descriptor may delegate to. */
  readonly delegates: ReadonlyArray<Delegate>
  /** The delegate a model-backed descriptor runs on. Defaults to `agent`. */
  readonly agent?: string | undefined
  /**
   * Loads a module body. Defaults to a dynamic `import` of the file the
   * descriptor points at; a test or a bundled host supplies its own.
   */
  readonly load?: ((path: string) => Effect.Effect<unknown, unknown>) | undefined
}

const refuse = (options: {
  readonly code: ExecutableErrorCode
  readonly flow: string
  readonly delegate?: string | undefined
  readonly available?: ReadonlyArray<string> | undefined
  readonly message: string
  readonly cause?: unknown
}): ExecutableError =>
  new ExecutableError({
    code: options.code,
    flow: options.flow,
    delegate: options.delegate,
    available: options.available ?? [],
    message: options.message,
    cause: options.cause
  })

/**
 * The three characters a path may legally contain that a URL reads as
 * structure rather than as a name, in the order they must be escaped: `%`
 * first, or escaping the other two would corrupt a literal `%` beside them.
 */
const urlStructural: ReadonlyArray<readonly [string, string]> = [
  ["%", "%25"],
  ["#", "%23"],
  ["?", "%3F"]
]

/**
 * A `file:` specifier for an absolute filesystem path.
 *
 * Written by hand rather than with `node:url` because this package is
 * browser-safe: a host that bundles a registry must not pull a Node builtin in
 * behind it. Doing it by hand means doing what `pathToFileURL` does. A `#` or
 * a `?` in a directory name is both a legal filename character and URL syntax,
 * and concatenating one unescaped truncates the specifier at it, so
 * `file:///a#b.ts` addresses `/a`. The loader then imports the wrong module,
 * or none, with nothing in the failure to say why.
 *
 * Exported because {@link Options.load} receives a filesystem path, not a
 * specifier: a host that supplies its own loader has to make the same
 * conversion, and in a browser bundle it has no `pathToFileURL` to make it
 * with.
 *
 * @category conversions
 * @since 0.1.0
 */
export const fileSpecifier = (path: string): string => {
  if (path.startsWith("file:")) return path
  const posix = path.replaceAll("\\", "/")
  const escaped = urlStructural.reduce(
    (value, [character, escape]) => value.replaceAll(character, escape),
    posix
  )
  return posix.startsWith("/") ? `file://${escaped}` : `file:///${escaped}`
}

const importModule = (path: string): Effect.Effect<unknown, unknown> =>
  Effect.tryPromise({
    try: () => import(/* @vite-ignore */ fileSpecifier(path)) as Promise<unknown>,
    catch: (cause) => cause
  })

/**
 * The registry name of the flow a descriptor delegates to.
 *
 * A descriptor that names exactly one flow delegates to it. One that names
 * none delegates to the agent, and so does one that names several while
 * declaring a model — a skill listing its tools is naming what the model may
 * call, not what runs it. Several named flows and no model leaves nothing to
 * choose between them, and the bridge refuses rather than guesses.
 *
 * @category constructors
 * @since 0.1.0
 */
export const delegateOf = (
  descriptor: Descriptor.FlowDescriptor,
  options: { readonly agent?: string | undefined } = {}
): Effect.Effect<string, ExecutableError> => {
  const agent = options.agent ?? defaultAgent
  if (descriptor.flows.length === 1) return Effect.succeed(descriptor.flows[0]!)
  if (descriptor.flows.length === 0 || Option.isSome(descriptor.model)) return Effect.succeed(agent)
  return Effect.fail(
    refuse({
      code: "ambiguous_delegate",
      flow: descriptor.name,
      message:
        `flow "${descriptor.name}" names ${descriptor.flows.length} flows and no model, so the flow it delegates to is undecidable; declare a model or name one flow`
    })
  )
}

/**
 * The placement directive a descriptor's literal stands for.
 *
 * Discovery records placement as one of four literals because a descriptor is
 * serializable; `@smthrs/core` models it as a tagged value with host-selection
 * options. This is the one-way projection between them.
 */
const placementOf = (literal: Descriptor.Placement): CorePlacement.Placement => {
  switch (literal) {
    case "client":
      return CorePlacement.client()
    case "local":
      return CorePlacement.local()
    case "sandbox":
      return CorePlacement.sandbox()
    case "remote":
      return CorePlacement.remote()
  }
}

/**
 * Reads the runtime decisions a loaded body and its descriptor declare.
 *
 * The body's annotation bag wins over the descriptor's frontmatter, because a
 * body is the later and more specific statement: `Flow.within(...)` and
 * `@smthrs/patterns`' `withCache` both write there, and frontmatter cannot
 * express either.
 *
 * @category conversions
 * @since 0.1.0
 */
export const lower = (
  descriptor: Descriptor.FlowDescriptor,
  annotations: Context.Context<never>
): Lowered => ({
  cache: CacheEnvironment.cachePolicyOf(annotations),
  priority: Option.getOrUndefined(Annotations.getOption(annotations, Annotations.Priority)),
  placement: Option.getOrUndefined(Annotations.getOption(annotations, Annotations.Placement)) ??
    Option.getOrUndefined(Option.map(descriptor.placement, placementOf))
})

/** The captured declaration identity a policy contributes to the node's key. */
const captured = (lowered: Lowered): Readonly<Record<string, unknown>> => ({
  ...(lowered.cache?.ttlMs === undefined ? {} : { ttlMs: lowered.cache.ttlMs }),
  ...(lowered.cache?.scope === undefined ? {} : { scope: lowered.cache.scope })
})

/**
 * The annotation bag the bridged flow carries.
 *
 * Placement is stored under `@smthrs/flow`'s own placement key, which
 * `@smthrs/flow` `Graph` reads while building the plan. The cache policy is
 * stored under `CacheEnvironment.CachePolicyAnnotation`. That is the identifier
 * `@smthrs/engine-store` `ActionPersistence` reads a policy under, and the one
 * `@smthrs/patterns`' `withCache` writes on a flow. What `ActionPersistence`
 * reads it off, though, is a DISPATCHED ACTION.
 *
 * A flow's bag is not an action's bag, and rc.0 carries nothing between them:
 * `@smthrs/flow` `Interpreter` dispatches the actions a delegate's own body
 * names and never consults the enclosing flow's annotations. So the policy
 * lowered here bounds nothing at dispatch today. It is kept because it is
 * where a policy belongs and because the delegating node's captured key
 * material, which is the half that does change behavior, has to agree with it.
 * `packages/registry/test/ExecutableEngine.test.ts` pins the current behavior
 * with a `scope: "run"` descriptor that does NOT re-execute.
 */
const annotationsOf = (lowered: Lowered): Context.Context<never> => {
  let bag = Context.empty()
  if (lowered.cache !== undefined) bag = Context.add(bag, CacheEnvironment.CachePolicyAnnotation, lowered.cache)
  if (lowered.placement !== undefined) {
    bag = Context.add(bag, RuntimeFlow.Placement, lowered.placement as RuntimeFlow.PlacementDirective)
  }
  return bag
}

/**
 * The loaded body of one descriptor: the prompt it renders, and the annotation
 * bag its declaration carries.
 */
interface LoadedBody {
  readonly prompt: string
  readonly annotations: Context.Context<never>
}

const loadMarkdown = (
  descriptor: Descriptor.FlowDescriptor,
  path: string,
  baseDirectory: string
): Effect.Effect<LoadedBody, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const text = yield* fs.readFileString(pathService.normalize(path)).pipe(
      Effect.mapError((cause) =>
        refuse({
          code: "body_unavailable",
          flow: descriptor.name,
          message: `the body of flow "${descriptor.name}" is unavailable at "${path}"`,
          cause
        })
      )
    )
    // `loadBody` is typed over the whole body union but answers `Prompt` for
    // every markdown source, which is the only kind that reaches here; the
    // module arm is the branch above. Narrowing by assertion rather than by a
    // condition keeps an unreachable arm out of the module.
    const body = MarkdownFlow.loadBody(text, baseDirectory) as Descriptor.FlowBodyPrompt
    const prompt = MarkdownFlow.renderPrompt(body, { args: "" })
    const lowered = CoreMarkdown.lowerMarkdown(MarkdownFlow.toCoreFrontmatter(descriptor), prompt)
    return { prompt, annotations: lowered.annotations }
  })

const loadModule = (
  descriptor: Descriptor.FlowDescriptor,
  path: string,
  options: Options
): Effect.Effect<LoadedBody, ExecutableError> =>
  Effect.gen(function*() {
    const loaded = yield* (options.load ?? importModule)(path).pipe(
      Effect.mapError((cause) =>
        refuse({
          code: "body_unavailable",
          flow: descriptor.name,
          message: `the body of flow "${descriptor.name}" could not be loaded from "${path}"`,
          cause
        })
      )
    )
    const exported = (loaded as { readonly default?: unknown } | null | undefined)?.default
    if (!CoreFlow.isFlow(exported)) {
      return yield* Effect.fail(
        refuse({
          code: "invalid_module",
          flow: descriptor.name,
          message: `"${path}" must default-export a Flow.make value; flow "${descriptor.name}" cannot be run`
        })
      )
    }
    // Every flow carries an annotation bag; `Flow.Any` simply does not say so.
    return { prompt: "", annotations: (exported as unknown as CoreFlow.Flow<never, never, never>).annotations }
  })

/**
 * Makes one discovered descriptor runnable.
 *
 * The body is loaded — a module through the loader, markdown through
 * {@link module:MarkdownFlow} — the delegate is resolved against the host's
 * registered flows, and the result is a durable flow whose body is one
 * delegating node plus the layer that registers it.
 *
 * Everything that can be refused is refused here, before the flow exists: a
 * missing delegate, an undecidable one, an unreadable body, a module that
 * exports something else. A flow this function returns is one the engine can
 * drive.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromDescriptor = (
  descriptor: Descriptor.FlowDescriptor,
  options: Options
): Effect.Effect<Executable, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    // The delegate is resolved BEFORE the body is loaded. Both refusals are
    // real, but only one of them is about this host: a flow whose delegate
    // nobody registered is not runnable here whatever its body says, and an
    // operator reading "could not load" would go looking in the wrong place.
    const name = yield* delegateOf(descriptor, options)
    const delegate = options.delegates.find((candidate) => candidate._tag === name)
    if (delegate === undefined) {
      return yield* Effect.fail(
        refuse({
          code: "missing_delegate",
          flow: descriptor.name,
          delegate: name,
          available: options.delegates.map((candidate) => candidate._tag).sort(),
          message: `flow "${descriptor.name}" delegates to "${name}", which no registered flow provides`
        })
      )
    }
    const body = descriptor.body._tag === "Markdown"
      ? yield* loadMarkdown(descriptor, descriptor.body.path, descriptor.body.baseDirectory)
      : yield* loadModule(descriptor, descriptor.body.path, options)
    const lowered = lower(descriptor, body.annotations)
    const invocation = (input: Schema.Json): Invocation => ({
      flow: descriptor.name,
      input,
      prompt: body.prompt,
      model: Option.getOrNull(descriptor.model),
      placement: Option.getOrNull(descriptor.placement),
      capabilities: descriptor.capabilities,
      flows: descriptor.flows
    })
    // The policy travels twice, exactly as `@smthrs/patterns`' `withCache`
    // sends it: as an annotation on the flow, and as captured identity on the
    // node, so two descriptors declaring different policies are two
    // declarations with two step keys. Only the second half reaches the rc.0
    // runtime; see `annotationsOf`.
    const identity = PlanNode.capture(captured(lowered), (value: unknown) => value)
    // The BODY's identity is captured too, and it has to be. A plan-time
    // function JavaScript cannot inspect gets process-local identity, so a
    // bridged flow built from one unchanged descriptor would key differently in
    // every process — no replayed step would ever match, and no recorded result
    // would ever be reused. Everything the body reads is inert descriptor data,
    // so declaring it makes the flow's identity a function of the descriptor
    // rather than of the process that loaded it.
    const build = PlanNode.capture(
      {
        flow: descriptor.name,
        delegate: name,
        prompt: body.prompt,
        model: Option.getOrNull(descriptor.model),
        placement: Option.getOrNull(descriptor.placement),
        capabilities: [...descriptor.capabilities],
        flows: [...descriptor.flows],
        priority: lowered.priority ?? null,
        ...captured(lowered)
      },
      (payload: Payload) => {
        const called = delegate.call(invocation(payload.input ?? null))
        const carried = lowered.cache === undefined ? called : PlanNode.map(called, identity)
        return lowered.priority === undefined ? carried : PlanNode.priority(carried, lowered.priority)
      }
    )
    const flow = RuntimeFlow.make(descriptor.name, {
      payload: Payload,
      success: Schema.Unknown,
      error: Schema.Unknown,
      annotations: annotationsOf(lowered),
      body: build
    })
    return {
      descriptor,
      delegate: name,
      lowered,
      invocation,
      flow,
      layer: Interpreter.layer(flow)
    }
  })

/**
 * Makes one discovered flow runnable by registry name.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromRegistry = (
  name: string,
  options: Options
): Effect.Effect<
  Executable,
  ExecutableError | RegistryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return yield* fromDescriptor(yield* registry.get(name), options)
  })

/**
 * Every discovered flow this host can run, and the ones it declined.
 *
 * @category models
 * @since 0.1.0
 */
export interface Catalog {
  readonly executables: ReadonlyArray<Executable>
  readonly refused: ReadonlyArray<ExecutableError>
}

/**
 * Service tag for the catalog a host was built from.
 *
 * {@link layer} provides it, so a command that lists or diagnoses flows reads
 * the same refusals the registration phase acted on instead of rebuilding the
 * catalog and hoping the two agree.
 *
 * @category services
 * @since 0.1.0
 */
export const Catalog: Context.Service<Catalog, Catalog> = Context.Service("flows/registry/Catalog")

/**
 * Makes every discovered flow runnable, reporting the ones it could not.
 *
 * A project's `flows/` directory is a mixed set: some entries delegate to a
 * flow this host registered, others name a delegate only another host has, and
 * one may simply be broken. None of those is a reason to withhold the rest.
 * `flows/` is a directory a person edits, so at any moment one file in it is
 * mid-edit or wrong, and a catalog that failed on it would take down `ls`,
 * `ps`, and every unrelated `up` with it.
 *
 * So every refusal is reported in {@link Catalog.refused} carrying its
 * {@link ExecutableError} code, and the entries that resolve stay runnable. The
 * codes are what distinguish the two kinds: `missing_delegate` and
 * `ambiguous_delegate` are statements about this host, while
 * `body_unavailable` and `invalid_module` are defects in the entry.
 *
 * @category constructors
 * @since 0.1.0
 */
export const catalog = (
  options: Options
): Effect.Effect<
  Catalog,
  RegistryError | DiscoveryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    const descriptors = yield* registry.list()
    const executables: Array<Executable> = []
    const refused: Array<ExecutableError> = []
    for (const descriptor of descriptors) {
      const result = yield* Effect.result(fromDescriptor(descriptor, options))
      if (result._tag === "Success") {
        executables.push(result.success)
        continue
      }
      refused.push(result.failure)
    }
    return { executables, refused }
  })

/**
 * Registers every runnable discovered flow with the runtime.
 *
 * This is the layer a host passes as the durable runtime's registration phase:
 * once it has been built, `Control.run` on a discovered flow reaches a
 * registered durable flow instead of an empty catalog.
 *
 * A refusal is never silent. Each one is logged as a warning naming the flow,
 * the code, the delegate it wanted, and what is registered instead, and the
 * whole {@link Catalog} is provided as a service, so a host can print the
 * refusals rather than let an operator discover them from `up <flow>` failing
 * inside the runtime.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<
  Catalog,
  RegistryError | DiscoveryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path | Registration
> =>
  Layer.unwrap(
    Effect.map(
      Effect.tap(catalog(options), (built) =>
        Effect.forEach(built.refused, (failure) =>
          Effect.logWarning("discovered flow is not runnable on this host", {
            flow: failure.flow,
            code: failure.code,
            delegate: failure.delegate,
            available: failure.available,
            reason: failure.message
          }), { discard: true })),
      (built) =>
        Layer.mergeAll(
          Layer.succeed(Catalog)(built),
          ...built.executables.map((executable) =>
            executable.layer
          )
        )
    )
  )

/**
 * How a project's flow registry is assembled.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProjectOptions {
  /** The project root. `<root>/flows` is scanned for `flow.ts` and `flow.mdx`. */
  readonly root: string
  /**
   * Installed packs whose flows join the project's, project entries first.
   *
   * The runtime version rides inside {@link module:Registry.PackConfig} rather
   * than beside it, so a caller cannot ask for packs without saying what their
   * `requires.smithers` range is checked against.
   */
  readonly packs?: Registry.PackConfig | undefined
}

/**
 * Provides the registry a Node host discovers a project's flows in.
 *
 * `<root>/flows/**` first, then every installed pack's own sources, all under
 * one first-found registry, so a project flow shadows a pack flow of the same
 * name and `refresh` rescans both. Packs are scanned through the registry's own
 * pack path, so each pack descriptor carries its `provenance.pack`, a name two
 * packs both define is reported as `shadowed` naming both of them with the
 * `local` pack winning, and every pack's `requires.smithers` is checked against
 * {@link module:Registry.PackConfig.runtimeVersion}.
 *
 * A project with no `flows/` directory is not a failure: it simply has no flows
 * yet, which is the state `smithers init` leaves behind. That is decided by
 * looking for the directory, so it stays a statement about the PROJECT: a pack
 * that declares a flows directory it does not ship fails the layer as an
 * `invalid_pack` naming the pack, instead of quietly emptying the registry the
 * project's own flows were in.
 *
 * This is the value a host passes as the durable runtime's registry: the seam
 * `@smthrs/flows` `NodeRuntime` opened so discovery, and not a hand-written
 * list, feeds the executor catalog.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerProject = (
  options: ProjectOptions
): Layer.Layer<Registry.Registry, RegistryError | DiscoveryError, FileSystem.FileSystem | Path.Path> =>
  Layer.unwrap(
    Effect.gen(function*() {
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const root = path.join(options.root, "flows")
      // ASKED UP FRONT, not caught afterwards. A project with no `flows/`
      // directory has no flows yet, which is the state `smithers init` leaves
      // behind; catching the scan's `root_missing` instead would make every
      // OTHER missing root — a pack that declares a directory it does not
      // ship — read as "this project has no flows" and empty the registry the
      // project's own flows were in.
      const present = yield* fs.exists(root).pipe(
        Effect.mapError((cause) =>
          discoveryError({
            code: "read_failed",
            module: "Executable",
            method: "layerProject",
            description: `could not access the project flows directory "${root}"`,
            cause
          })
        )
      )
      const sources: ReadonlyArray<Descriptor.Source> = present
        ? [{ source: "project", root, naming: "path" }]
        : []
      return Registry.layer({
        sources,
        ...(options.packs === undefined ? {} : { packs: options.packs })
      }).pipe(Layer.provide(Discovery.layer))
    })
  )
