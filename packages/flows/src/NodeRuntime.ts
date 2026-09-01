/**
 * Node-only production composition for the durable flows runtime.
 *
 * This module is deliberately a subpath export. Importing it opens a
 * `node:sqlite` database through `@smthrs/database/node/NodeDatabase`, so
 * the browser-safe `@smthrs/flows` root must not re-export it.
 *
 * Construction is ordered by layer dependencies: the SQLite parent directory
 * is created before the database opens, migrations finish before any store is
 * built, the durable engine is built over those stores, and `registerFlows`
 * finishes before the resulting services are exposed. The engine's own
 * registration hook then re-arms durable clocks and deferred wakes, so a
 * persisted run cannot resume through this composition before its flow has
 * been registered.
 *
 * @since 0.1.0
 */
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { DurableEngineState, EngineStore, OwnerIdentity, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import * as Migrations from "@smthrs/engine-store/Migrations"
import { SqlJournal } from "@smthrs/journal"
import type * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as HostLiveness from "@smthrs/platform-node/HostLiveness"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import type * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { constants } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * Configuration for the supported Node SQLite runtime.
 *
 * `isAlive` is intentionally required, and a stub is not an answer: a check
 * that returns `false` without asking says "that owner is gone" about an owner
 * it never looked at, and the engine steals runs out of live processes on the
 * strength of it. A single-machine host passes `Ownership.sameHostPidProbe`,
 * which asks this machine's process table; a multi-process deployment answers
 * from its supervisor or lease system instead.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Options {
  /** SQLite database filename. Its parent directory is created recursively. */
  readonly filename: string
  /**
   * Workspace whose files actions may read or mutate. When omitted, the
   * database directory is used as a fail-closed compatibility default.
   */
  readonly workspaceRoot?: string | undefined
  /** Stable identity of this engine host. */
  readonly owner: {
    readonly hostId: string
  }
  /**
   * Whether a previously recorded owner is still alive.
   *
   * Takes the claim context as well as the owner, so a probe can tell whether
   * the recorded pid names a process on the machine it is running on. A
   * one-argument check that ignores the context still satisfies this.
   */
  readonly isAlive: Ownership.LivenessCheck
}

const Configuration = Schema.Struct({
  filename: Schema.NonEmptyString,
  workspaceRoot: Schema.optional(Schema.NonEmptyString),
  owner: Schema.Struct({ hostId: Schema.NonEmptyString })
})

const validate = (options: Options): Options => {
  Schema.decodeUnknownSync(Configuration)(options)
  return options
}

/**
 * The registry a host that discovers nothing composes: no services, no
 * requirements, no failures. Written as a function so each call site gets the
 * empty layer at its own type rather than sharing one assertion.
 */
const emptyRegistry = <Out, Error, Requirements>(): Layer.Layer<Out, Error, Requirements> =>
  Layer.empty as unknown as Layer.Layer<Out, Error, Requirements>

const databaseLayer = (filename: string) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      yield* fileSystem.makeDirectory(dirname(filename), { recursive: true })
      return Layer.provideMerge(
        DurableWriter.layer(),
        NodeDatabase.layer({ filename })
      )
    })
  )

/**
 * Provides the migrated database, durable stores, owner minter, workspace,
 * and local artifact store without constructing an engine.
 *
 * This is the lower-level seam for integrations that construct another
 * engine-backed service over the same storage context, such as the time-travel
 * example. Application entry points should normally use {@link layer}.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const storage = (filename: string, workspaceRoot?: string) => {
  const validatedFilename = Schema.decodeUnknownSync(Schema.NonEmptyString)(filename)
  const databaseRoot = dirname(validatedFilename)
  const resolvedWorkspaceRoot = resolve(
    Schema.decodeUnknownSync(Schema.NonEmptyString)(workspaceRoot ?? databaseRoot)
  )
  const database = Layer.provideMerge(Migrations.layer, databaseLayer(validatedFilename))
  return Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer,
    OwnerIdentity.layer,
    Workspace.layer(resolvedWorkspaceRoot),
    ArtifactStore.layerFileSystem({ directory: join(databaseRoot, ".flows/objects") })
  ).pipe(Layer.provideMerge(database))
}

const composition = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut,
  RegistryError,
  RegistryRequirements
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements>
) => {
  const validated = validate(options)
  const execution = Layer.merge(stepBoundary, workspaceSandbox).pipe(
    Layer.provideMerge(storage(validated.filename, validated.workspaceRoot))
  )
  const engine = EngineStore.layer({
    owner: validated.owner,
    journalSource: `${validated.owner.hostId}-engine`,
    isAlive: validated.isAlive
  }).pipe(Layer.provideMerge(execution))
  // The registry is built BETWEEN the engine and the registration phase, so a
  // registration that reads a catalog off it — `@smthrs/registry`'s
  // `Executable.layer`, which turns every discovered descriptor into a
  // registered durable flow — has both the registry and the engine's own
  // context in hand, and the engine is still live before the first flow is
  // registered.
  return registerFlows.pipe(Layer.provideMerge(registry), Layer.provideMerge(engine))
}

/**
 * Builds the production service context in the current scope.
 *
 * The caller selects the filesystem boundary and workspace sandbox layers,
 * and supplies a registration layer such as a merge of action implementation
 * layers and `Interpreter.layer(flow)`. `Jj`, Effect `FileSystem`, and Effect
 * `Crypto` remain requirements of the returned effect and are supplied by the
 * host. Closing the surrounding scope closes the database, journal writer,
 * sweeper, and active engine fibers through their existing finalizers.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut = never,
  RegistryError = never,
  RegistryRequirements = never
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements> = emptyRegistry()
) => Layer.build(composition(options, stepBoundary, workspaceSandbox, registerFlows, registry))

/**
 * Provides the supported scoped Node SQLite runtime.
 *
 * `registerFlows` is the final startup phase, not a layer callers merge beside
 * the engine. This serializes the durability-sensitive order and ensures the
 * runtime is usable only after every supplied flow registration has completed.
 * Shutdown is scope closure; this module installs no process or signal
 * handlers.
 *
 * `registry` is the optional catalog the registration phase reads from. A host
 * that discovers its flows rather than listing them passes
 * `@smthrs/registry`'s `Executable.layerProject({ root })` — `Discovery` over
 * `<root>/flows/**` plus any installed packs — and a `registerFlows` built from
 * `Executable.layer(...)`; the registry is provided beneath registration, so
 * every discovered flow is registered before the runtime accepts a launch.
 * Omitting it is exactly the previous behavior.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layer = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut = never,
  RegistryError = never,
  RegistryRequirements = never
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements> = emptyRegistry()
) => Layer.effectContext(make(options, stepBoundary, workspaceSandbox, registerFlows, registry))

/**
 * Configuration for the batteries-included Node host composition.
 *
 * Everything but the two required fields has a default that a single-process
 * Node program can live with, which is the point: {@link layerHost} exists so
 * a program does not restate the same eight layers to get a durable engine.
 *
 * @since 0.1.0
 * @category models
 */
export interface HostOptions {
  /** SQLite database filename. Its parent directory is created recursively. */
  readonly filename: string
  /**
   * Absolute or relative project workspace. It is resolved once while the
   * host is constructed and all Jj operations stay bound to that root.
   * Defaults to the database directory for backwards compatibility.
   */
  readonly workspaceRoot?: string | undefined
  /** Stable identity of this engine host. */
  readonly owner: {
    readonly hostId: string
  }
  /**
   * Whether a previously recorded owner is still alive. Defaults to
   * `HostLiveness.isAlive`, which answers from this machine's process table
   * and never declares another host's owner dead. A deployment with a
   * supervisor or a lease system should answer from that instead.
   */
  readonly isAlive?: Ownership.LivenessCheck | undefined
  /**
   * The capability rules this host grants without asking. The grant store is
   * unattended — there is no operator to prompt — so a capability no rule
   * allows is denied rather than escalated.
   */
  readonly rules?: GrantStore.MakeOptions["rules"]
  /**
   * The signals that shut the runtime down. Default `SIGINT` and `SIGTERM`;
   * an empty list installs no handler at all, for a program that owns its own
   * signal wiring.
   */
  readonly signals?: ReadonlyArray<NodeJS.Signals> | undefined
  /**
   * How long a graceful shutdown may take before the host stops waiting for it
   * and leaves with the signal's own exit code. Default
   * {@link defaultShutdownTimeoutMs}.
   *
   * Installing a handler removes Node's default disposition, so without a
   * deadline a finalizer that never returns turns `Ctrl-C` into a program that
   * cannot be stopped at all. A second signal escapes immediately, whatever
   * this is set to.
   */
  readonly shutdownTimeoutMs?: number | undefined
  /** Process containment and reaping options for the host spawner. */
  readonly containment?: (ContainedSpawner.Options & ProcessReaper.Options) | undefined
}

/** The signals a host shuts down on when its program names none. */
const defaultSignals: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM"]

/**
 * How long a graceful shutdown may take before the host leaves anyway.
 *
 * @since 0.1.0
 * @category models
 */
export const defaultShutdownTimeoutMs = 30_000

/**
 * The status a process that was ended by `signal` exits with.
 *
 * A host that installs a handler owes its supervisor the answer the default
 * disposition would have given, which is `128 + signal number`: `130` for
 * `SIGINT`, `143` for `SIGTERM`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const signalExitCode = (signal: NodeJS.Signals): number =>
  128 + ((constants.signals as Record<string, number>)[signal] ?? constants.signals.SIGTERM)

/**
 * The capability rules the ENGINE's own bookkeeping runs under.
 *
 * A compensable action is snapshotted and restored by `EngineStore` itself,
 * through the same guarded `Jj` the flow body sees, because an action resolves
 * its host services from the engine's context. Without these rules a host built
 * by {@link layerHost} could not run a compensable action at all: the engine's
 * own pre-image would be refused before the body ever started, which is a
 * refusal aimed at the engine rather than at anything a flow asked for.
 *
 * They are merged UNDER a program's own {@link HostOptions.rules}, so a policy
 * that denies `jj:snapshot` still denies it. The snapshot pattern is the
 * message the engine writes and nothing else; `jj:restore` names a change id,
 * which is opaque, so it cannot be narrowed further.
 *
 * @since 0.1.0
 * @category models
 */
export const engineRules: ReadonlyArray<Permission.Rule> = [
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "jj:snapshot", resource: "smithers action *" })
  }),
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "jj:restore", resource: "*" })
  }),
  new Permission.Rule({
    effect: "allow",
    pattern: new Capability.CapabilityPattern({ action: "jj:diff", resource: "*" })
  })
]

/** Puts {@link engineRules} beneath a program's configured ruleset. */
const withEngineRules = (
  rules: GrantStore.MakeOptions["rules"]
): ReadonlyArray<ReadonlyArray<Permission.Rule>> => {
  if (rules === undefined || rules.length === 0) return [engineRules]
  const nested: ReadonlyArray<ReadonlyArray<Permission.Rule>> = Array.isArray(rules[0])
    ? rules as ReadonlyArray<ReadonlyArray<Permission.Rule>>
    : [rules as ReadonlyArray<Permission.Rule>]
  // Configured policy is the FIRST ruleset and the last match in it wins, so
  // prepending leaves a program free to deny what it does not want granted.
  /* v8 ignore next -- the empty-`rules` case already returned, so `nested` always has a first ruleset; the fallback only discharges the optional an index read carries */
  return [[...engineRules, ...(nested[0] ?? [])], ...nested.slice(1)]
}

/**
 * Installs the shutdown handlers and removes them when the scope closes.
 *
 * The handler closes the runtime's own scope rather than interrupting a fiber.
 * That is the difference between a shutdown and a kill: closing the scope runs
 * the engine's finalizers, the drive fibers are interrupted from inside the
 * engine, and each owned run parks itself `released`, reclaimable by the next
 * host that starts rather than left `running` with a dead owner for the
 * stale-run sweep to notice much later. A fiber cannot be the handle here
 * anyway: a layer builds in its own fiber, not the program's, so the fiber
 * this code can reach is not the one the program runs on.
 *
 * Installing the handler also REMOVES Node's default disposition, and that has
 * to be paid for. A finalizer that never returns would otherwise turn `Ctrl-C`
 * into a program nothing short of `SIGKILL` can stop, so the handler keeps two
 * escapes: a second signal leaves immediately, and a graceful shutdown that
 * outlasts {@link HostOptions.shutdownTimeoutMs} leaves anyway. Both exit with
 * the status the default disposition would have produced.
 */
const onSignal = (
  signals: ReadonlyArray<NodeJS.Signals>,
  runtime: Scope.Closeable,
  timeoutMs: number
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function*() {
    let closing = false
    let deadline: NodeJS.Timeout | undefined
    const leave = (signal: NodeJS.Signals) => {
      process.exit(signalExitCode(signal))
    }
    const handlers = signals.map((signal) => {
      const handler = () => {
        if (closing) {
          // The operator asked twice. Whatever the shutdown is waiting for, it
          // has stopped being this program's decision.
          leave(signal)
          return
        }
        closing = true
        Effect.runFork(Scope.close(runtime, Exit.void))
        deadline = setTimeout(() => leave(signal), timeoutMs)
        // A shutdown that finishes on time must not be held open by its own
        // deadline timer.
        deadline.unref()
      }
      return { signal, handler }
    })
    for (const { handler, signal } of handlers) process.on(signal, handler)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (deadline !== undefined) clearTimeout(deadline)
        for (const { handler, signal } of handlers) process.removeListener(signal, handler)
      })
    )
  })

/**
 * Provides the whole Node host, storage, kernel, and engine from one call.
 *
 * {@link layer} composes storage and the engine and leaves the host to the
 * caller: `Jj`, `FileSystem`, `Crypto`, the step boundary, and the workspace
 * sandbox are all arguments or requirements, and every embedder was wiring the
 * same eight layers in the same order to satisfy them. This composition is
 * that wiring, with the pieces a host actually has to decide left as options.
 *
 * What it adds over {@link layer}:
 *
 * - The complete Node host from `@smthrs/platform-node`, with process
 *   containment on: a spawned process gets its own process group, is signalled
 *   and then killed when its action's scope closes, and is recorded in the
 *   `ProcessLedger` so the next incarnation of this host reaps whatever a
 *   crash left running.
 * - The kernel's guarded Host surface over an unattended `GrantStore`, so an
 *   action reaches the host through the capability check rather than around
 *   it. A capability no rule in {@link HostOptions.rules} allows is denied,
 *   with one documented exception: {@link engineRules} let the ENGINE take the
 *   pre-image a compensable action needs, because that snapshot is the
 *   engine's own bookkeeping and not something the flow asked for.
 * - The default `StepBoundary` and filesystem `WorkspaceSandbox`, which is the
 *   pairing that makes a sealed action's result eligible for the step cache.
 * - Signal handling: `SIGINT` or `SIGTERM` closes the runtime scope, which
 *   releases every run this host owns for another host to reclaim. A second
 *   signal, or a shutdown that outlasts
 *   {@link HostOptions.shutdownTimeoutMs}, leaves with the signal's own exit
 *   code instead of waiting on a finalizer that is not coming back.
 *
 * A program that needs a different host, a different policy, or no signals at
 * all still composes {@link layer} itself; nothing here is reachable only
 * through this function.
 *
 * The optional `registry` argument is the same seam {@link layer} takes: pass
 * `@smthrs/registry`'s `Executable.layerProject({ root })` to feed the
 * registration phase from `<root>/flows/**` and the installed packs instead of
 * a hand-written list of flows.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerHost = <
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut = never,
  RegistryError = never,
  RegistryRequirements = never
>(
  options: HostOptions,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements> = emptyRegistry()
) => {
  const validated = validate({
    filename: options.filename,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    owner: options.owner,
    isAlive: options.isAlive ?? HostLiveness.isAlive({ hostId: options.owner.hostId })
  })
  const workspaceRoot = resolve(validated.workspaceRoot ?? dirname(validated.filename))
  // The layering is the design decision this function makes, and it has two
  // sides. The engine's MACHINERY — the SQLite storage, the step boundary, the
  // workspace sandbox — runs on the raw host: a database directory the engine
  // must create to exist at all cannot be something the engine asks permission
  // for, and a whole-tree sandbox copy is engine bookkeeping, not an agent
  // reaching for a file. Everything the engine then hands a FLOW BODY is the
  // guarded surface, because a body is exactly what the capability check
  // exists for. That is why the engine is built over the kernel here and not
  // beside it: an action resolves its host services from the engine's context.
  const raw = Layer.mergeAll(NodeHost.layerAt(workspaceRoot), NodeHost.NodeCrypto.layer)
  const store = storage(validated.filename, workspaceRoot).pipe(Layer.provideMerge(raw))
  const execution = Layer.merge(StepBoundary.layer, WorkspaceSandbox.layerFileSystem()).pipe(
    Layer.provideMerge(store)
  )
  const guarded = HostServices.layer.pipe(
    Layer.provide(Layer.orDie(GrantStore.layer({ attended: false, rules: withEngineRules(options.rules) }))),
    Layer.provideMerge(NodeHost.layerContainedAt(workspaceRoot, options.containment)),
    Layer.provideMerge(ProcessLedger.layer({ hostId: validated.owner.hostId, ownerPid: process.pid })),
    Layer.provideMerge(execution)
  )
  const engine = EngineStore.layer({
    owner: validated.owner,
    journalSource: `${validated.owner.hostId}-engine`,
    isAlive: validated.isAlive
  }).pipe(Layer.provideMerge(guarded))
  // Registration stays the final startup phase, exactly as in `layer`: no
  // persisted run can resume through this composition before its flow is
  // registered. The registry sits directly beneath it, so a registration built
  // from a discovered catalog reads the catalog on the guarded host this
  // composition already built.
  const composed = registerFlows.pipe(Layer.provideMerge(registry), Layer.provideMerge(engine))
  return Layer.effectContext(Effect.gen(function*() {
    const parent = yield* Scope.Scope
    // The composition is built into a scope this module can close, because a
    // signal has to be able to shut the runtime down without the program
    // having handed anything over. Forking from the caller's scope keeps the
    // ordinary path unchanged: closing the caller's scope closes this one.
    const runtime = yield* Scope.fork(parent)
    const context = yield* Effect.provideService(Layer.build(composed), Scope.Scope, runtime)
    yield* onSignal(
      options.signals ?? defaultSignals,
      runtime,
      options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs
    )
    return context
  }))
}
