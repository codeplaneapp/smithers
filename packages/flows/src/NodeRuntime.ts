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
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import type * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as HostServices from "@smthrs/kernel/HostServices"
import * as KernelJj from "@smthrs/kernel/Jj"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as HostLiveness from "@smthrs/platform-node/HostLiveness"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import type * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import type * as Crypto from "effect/Crypto"
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
  /** Workspace whose file actions may read or mutate. */
  readonly workspaceRoot: string
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

/**
 * Stable failure raised synchronously for invalid runtime construction input.
 *
 * @since 1.0.0
 * @category errors
 */
export class RuntimeConfigurationError extends Schema.TaggedError<RuntimeConfigurationError>()(
  "@smthrs/flows/RuntimeConfigurationError",
  {
    code: Schema.Literal("invalid_runtime_configuration"),
    field: Schema.String,
    message: Schema.String
  }
) {}

const invalidConfiguration = (field: string, message: string): RuntimeConfigurationError =>
  new RuntimeConfigurationError({ code: "invalid_runtime_configuration", field, message })

/**
 * Decodes one named option and reports the option that was wrong.
 *
 * A single struct decode would answer "options" for every refusal, and the
 * whole point of {@link RuntimeConfigurationError.field} is that an embedder
 * can tell an empty `filename` from an empty `owner.hostId` without reading
 * prose. Decoding field by field makes the name come from the call site rather
 * than from walking a schema issue tree.
 */
const decodeField = <A>(field: string, schema: Schema.Codec<A>, value: unknown, expectation: string): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    throw invalidConfiguration(field, `NodeRuntime ${field} ${expectation}`)
  }
}

const nonEmpty = "must be a non-empty string"

interface ValidatedOptions {
  readonly filename: string
  readonly workspaceRoot: string
  readonly owner: Readonly<{ readonly hostId: string }>
  readonly isAlive: Ownership.LivenessCheck
}

/** Captures one absolute, immutable runtime configuration at API entry. */
const validate = (options: Options): ValidatedOptions => {
  const filename = decodeField("filename", Schema.NonEmptyString, options.filename, nonEmpty)
  const workspaceRoot = decodeField("workspaceRoot", Schema.NonEmptyString, options.workspaceRoot, nonEmpty)
  // A JavaScript caller can omit `owner` entirely, so the field is read off a
  // possibly-absent record rather than dereferenced.
  const owner = options.owner as { readonly hostId?: unknown } | undefined
  const hostId = decodeField("owner.hostId", Schema.NonEmptyString, owner?.hostId, nonEmpty)
  const isAlive = options.isAlive
  if (typeof isAlive !== "function") {
    throw invalidConfiguration("isAlive", "NodeRuntime isAlive must be a function")
  }
  const absoluteFilename = resolve(filename)
  return Object.freeze({
    filename: absoluteFilename,
    workspaceRoot: resolve(workspaceRoot),
    owner: Object.freeze({ hostId }),
    isAlive
  })
}

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
  const validatedFilename = resolve(decodeField("filename", Schema.NonEmptyString, filename, nonEmpty))
  const databaseRoot = dirname(validatedFilename)
  const resolvedWorkspaceRoot = workspaceRoot === undefined
    ? databaseRoot
    : resolve(decodeField("workspaceRoot", Schema.NonEmptyString, workspaceRoot, nonEmpty))
  const database = Layer.provideMerge(Migrations.layer, databaseLayer(validatedFilename))
  return Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer,
    OwnerIdentity.layer,
    Workspace.layer(resolvedWorkspaceRoot),
    ArtifactStore.layerFileSystem({ directory: join(databaseRoot, "objects") })
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
    Layer.provideMerge(storage(validated.filename, validated.workspaceRoot)),
    // Credential redaction covers the operator's terminal as well as the
    // journal (the release policy). It sits UNDER the engine so the
    // context the engine captures for an action body carries it: a line an
    // action, the harness, or an agent session writes leaves through the same
    // rules `@smthrs/journal` applies on the write path.
    Layer.provideMerge(RedactedLogger.layer())
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
 * The registry-taking construction every public arity delegates to.
 *
 * {@link make}, {@link layer} and {@link layerHost} are OVERLOADED on this
 * rather than defaulting the registry argument, because a default value cannot
 * honor a caller-chosen registry type. With one signature and a default,
 * `layer<..., MyRegistry, never, never>(options, boundary, sandbox, register)`
 * compiles and returns a layer that CLAIMS to provide `MyRegistry` while
 * providing nothing, and the disagreement surfaces as a service-not-found
 * defect when the layer builds instead of as a type error where it was
 * written. Splitting the arities keeps the registry type parameters on the
 * signature that also takes the argument, so the mismatch cannot be spelled,
 * and the empty registry the shorter arity passes is `Layer.empty` at its own
 * `Layer<never, never, never>` type rather than an assertion.
 */
const makeWithRegistry = <
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
) => Layer.build(composition(options, stepBoundary, workspaceSandbox, registerFlows, registry))

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
export const make: {
  <
    BoundaryError,
    BoundaryRequirements,
    SandboxError,
    SandboxRequirements,
    Registered,
    RegistrationError,
    RegistrationRequirements
  >(
    options: Options,
    stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
    workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
  ): ReturnType<
    typeof makeWithRegistry<
      BoundaryError,
      BoundaryRequirements,
      SandboxError,
      SandboxRequirements,
      Registered,
      RegistrationError,
      RegistrationRequirements,
      never,
      never,
      never
    >
  >
  <
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
  ): ReturnType<
    typeof makeWithRegistry<
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
    >
  >
} = (
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, any, any>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, any, any>,
  registerFlows: Layer.Layer<any, any, any>,
  registry?: Layer.Layer<any, any, any>
) => makeWithRegistry(options, stepBoundary, workspaceSandbox, registerFlows, registry ?? Layer.empty)

/** The registry-taking layer both {@link layer} arities delegate to. */
const layerWithRegistry = <
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
) =>
  Layer.effectContext(
    makeWithRegistry(options, stepBoundary, workspaceSandbox, registerFlows, registry)
  )

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
export const layer: {
  <
    BoundaryError,
    BoundaryRequirements,
    SandboxError,
    SandboxRequirements,
    Registered,
    RegistrationError,
    RegistrationRequirements
  >(
    options: Options,
    stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
    workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
  ): ReturnType<
    typeof layerWithRegistry<
      BoundaryError,
      BoundaryRequirements,
      SandboxError,
      SandboxRequirements,
      Registered,
      RegistrationError,
      RegistrationRequirements,
      never,
      never,
      never
    >
  >
  <
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
  ): ReturnType<
    typeof layerWithRegistry<
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
    >
  >
} = (
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, any, any>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, any, any>,
  registerFlows: Layer.Layer<any, any, any>,
  registry?: Layer.Layer<any, any, any>
) => layerWithRegistry(options, stepBoundary, workspaceSandbox, registerFlows, registry ?? Layer.empty)

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
   */
  readonly workspaceRoot: string
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
const defaultSignals: ReadonlyArray<NodeJS.Signals> = Object.freeze(["SIGINT", "SIGTERM"])

/**
 * How long a graceful shutdown may take before the host leaves anyway.
 *
 * @since 0.1.0
 * @category models
 */
export const defaultShutdownTimeoutMs = 30_000

/**
 * Largest delay Node accepts without truncating it to a one-millisecond timer.
 *
 * @since 1.0.0
 * @category models
 */
export const maximumShutdownTimeoutMs = 2_147_483_647

const catchableSignals = new Set<NodeJS.Signals>(
  Object.keys(constants.signals)
    .filter((signal) => signal !== "SIGKILL" && signal !== "SIGSTOP") as Array<NodeJS.Signals>
)

/** Validates, de-duplicates, and snapshots signal configuration. */
const snapshotSignals = (
  signals: ReadonlyArray<NodeJS.Signals> | undefined
): ReadonlyArray<NodeJS.Signals> => {
  const configured = signals ?? defaultSignals
  if (!Array.isArray(configured)) {
    throw invalidConfiguration("signals", "NodeRuntime signals must be an array")
  }
  const snapshot: Array<NodeJS.Signals> = []
  const seen = new Set<NodeJS.Signals>()
  for (const candidate of configured as ReadonlyArray<unknown>) {
    if (typeof candidate !== "string" || !catchableSignals.has(candidate as NodeJS.Signals)) {
      throw invalidConfiguration("signals", `NodeRuntime cannot install signal ${String(candidate)}`)
    }
    const signal = candidate as NodeJS.Signals
    if (!seen.has(signal)) {
      seen.add(signal)
      snapshot.push(signal)
    }
  }
  return Object.freeze(snapshot)
}

/** Validates and snapshots the one timer used by graceful shutdown. */
const snapshotShutdownTimeout = (timeoutMs: number | undefined): number => {
  const timeout = timeoutMs ?? defaultShutdownTimeoutMs
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > maximumShutdownTimeoutMs) {
    throw invalidConfiguration(
      "shutdownTimeoutMs",
      `NodeRuntime shutdownTimeoutMs must be an integer from 0 through ${maximumShutdownTimeoutMs}`
    )
  }
  return timeout
}

const snapshotRule = (rule: Permission.Rule): Permission.Rule =>
  new Permission.Rule({
    effect: rule.effect,
    pattern: new Capability.CapabilityPattern({
      action: rule.pattern.action,
      resource: rule.pattern.resource
    })
  })

/** Detaches policy arrays and rule objects from mutable caller-owned input. */
const snapshotRules = (
  rules: GrantStore.MakeOptions["rules"]
): GrantStore.MakeOptions["rules"] => {
  if (rules === undefined) return undefined
  if (!Array.isArray(rules)) {
    throw invalidConfiguration("rules", "NodeRuntime rules must be an array")
  }
  if (rules.length > 0 && Array.isArray(rules[0])) {
    return Object.freeze(
      (rules as ReadonlyArray<ReadonlyArray<Permission.Rule>>).map((ruleset) => {
        if (!Array.isArray(ruleset)) {
          throw invalidConfiguration("rules", "NodeRuntime rulesets must be arrays")
        }
        return Object.freeze(ruleset.map(snapshotRule))
      })
    )
  }
  return Object.freeze((rules as ReadonlyArray<Permission.Rule>).map(snapshotRule))
}

/** Detaches containment callbacks and scalars from a caller-owned options object. */
const snapshotContainment = (
  options: (ContainedSpawner.Options & ProcessReaper.Options) | undefined
): (ContainedSpawner.Options & ProcessReaper.Options) | undefined => {
  if (options === undefined) return undefined
  const graceMs = options.graceMs
  const platform = options.platform
  const ownerPid = options.ownerPid
  const system = options.system
  const systemSnapshot = system === undefined
    ? undefined
    : Object.freeze({
      isAlive: system.isAlive,
      startedAtMs: system.startedAtMs,
      ownGroup: system.ownGroup,
      bootedAtMs: system.bootedAtMs,
      refuseTarget: system.refuseTarget,
      killTree: system.killTree
    })
  return Object.freeze({
    ...(graceMs === undefined ? {} : { graceMs }),
    ...(platform === undefined ? {} : { platform }),
    ...(ownerPid === undefined ? {} : { ownerPid }),
    ...(systemSnapshot === undefined ? {} : { system: systemSnapshot })
  })
}

interface ValidatedHostOptions extends ValidatedOptions {
  readonly rules: GrantStore.MakeOptions["rules"]
  readonly signals: ReadonlyArray<NodeJS.Signals>
  readonly shutdownTimeoutMs: number
  readonly containment: (ContainedSpawner.Options & ProcessReaper.Options) | undefined
}

/** Captures every host option before construction returns to the caller. */
const validateHost = (options: HostOptions): ValidatedHostOptions => {
  const filename = options.filename
  const owner = options.owner
  const configuredLiveness = options.isAlive
  const rules = options.rules
  const signals = options.signals
  const shutdownTimeoutMs = options.shutdownTimeoutMs
  const containment = options.containment
  const validated = validate({
    filename,
    workspaceRoot: options.workspaceRoot,
    owner,
    isAlive: configuredLiveness ?? HostLiveness.isAlive({ hostId: owner.hostId })
  })
  return Object.freeze({
    ...validated,
    rules: snapshotRules(rules),
    signals: snapshotSignals(signals),
    shutdownTimeoutMs: snapshotShutdownTimeout(shutdownTimeoutMs),
    containment: snapshotContainment(containment)
  })
}

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
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (deadline !== undefined) clearTimeout(deadline)
      })
    )
    for (const { handler, signal } of handlers) {
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on(signal, handler)),
        () => Effect.sync(() => process.removeListener(signal, handler))
      )
    }
  })

/** The registry-taking host both {@link layerHost} arities delegate to. */
const layerHostWithRegistry = <
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut,
  RegistryError,
  RegistryRequirements
>(
  options: HostOptions,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements>
) => {
  const validated = validateHost(options)
  const workspaceRoot = validated.workspaceRoot
  // The layering is the design decision this function makes, and it has two
  // sides. The engine's MACHINERY — the SQLite storage, the step boundary, the
  // workspace sandbox — runs on the raw host: a database directory the engine
  // must create to exist at all cannot be something the engine asks permission
  // for, and a whole-tree sandbox copy is engine bookkeeping, not an agent
  // reaching for a file. Everything the engine then hands a FLOW BODY is the
  // guarded surface, because a body is exactly what the capability check
  // exists for. That is why the engine is built over the kernel here and not
  // beside it: an action resolves its host services from the engine's context.
  const raw = Layer.mergeAll(NodeHost.layerAt(workspaceRoot), NodeHost.NodeCrypto.layer).pipe(
    Layer.provideMerge(RedactedLogger.layer())
  )
  const privilegedJj = Layer.effect(KernelJj.Jj, KernelJj.Jj).pipe(Layer.provide(raw))
  const store = storage(validated.filename, workspaceRoot).pipe(Layer.provideMerge(raw))
  const execution = Layer.merge(StepBoundary.layer, WorkspaceSandbox.layerFileSystem()).pipe(
    Layer.provideMerge(store)
  )
  const guarded = HostServices.layer.pipe(
    Layer.provide(Layer.orDie(GrantStore.layer({ attended: false, rules: validated.rules }))),
    Layer.provideMerge(NodeHost.layerContainedAt(workspaceRoot, validated.containment)),
    Layer.provideMerge(ProcessLedger.layer({ hostId: validated.owner.hostId, ownerPid: process.pid })),
    Layer.provideMerge(execution)
  )
  const engine = EngineStore.layerWithPrivilegedJj(
    {
      owner: validated.owner,
      journalSource: `${validated.owner.hostId}-engine`,
      isAlive: validated.isAlive
    },
    privilegedJj
  ).pipe(Layer.provideMerge(guarded))
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
      validated.signals,
      runtime,
      validated.shutdownTimeoutMs
    )
    return context
  }))
}

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
 *   it. A capability no rule in {@link HostOptions.rules} allows is denied.
 *   Engine snapshot bookkeeping uses a distinct private Jj service, so it
 *   grants no repository authority to the action context.
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
export const layerHost: {
  <Registered, RegistrationError, RegistrationRequirements>(
    options: HostOptions,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
  ): ReturnType<
    typeof layerHostWithRegistry<
      Registered,
      RegistrationError,
      RegistrationRequirements,
      never,
      never,
      never
    >
  >
  <
    Registered,
    RegistrationError,
    RegistrationRequirements,
    RegistryOut,
    RegistryError,
    RegistryRequirements
  >(
    options: HostOptions,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
    registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements>
  ): ReturnType<
    typeof layerHostWithRegistry<
      Registered,
      RegistrationError,
      RegistrationRequirements,
      RegistryOut,
      RegistryError,
      RegistryRequirements
    >
  >
} = (
  options: HostOptions,
  registerFlows: Layer.Layer<any, any, any>,
  registry?: Layer.Layer<any, any, any>
) => layerHostWithRegistry(options, registerFlows, registry ?? Layer.empty)

/** Refuses a composition root that still owes a service. */
type Complete<L> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>] ? [R] extends [never] ? true : false
  : false

/** Refuses a layer composition whose allowed requirement channel is not exact. */
type LayerRequirementsAre<L, Expected> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>]
  ? [R] extends [Expected] ? [Expected] extends [R] ? true : false : false
  : false

/** Refuses an effect composition whose requirement channel is not exact. */
type EffectRequirementsAre<F, Expected> = [F] extends [Effect.Effect<infer _A, infer _E, infer R>]
  ? [R] extends [Expected] ? [Expected] extends [R] ? true : false : false
  : false

/** Fails to compile unless its argument is `true`. */
type Expect<T extends true> = T

/**
 * Pins every full runtime composition to its documented host boundary.
 *
 * `make` builds in the caller's scope, while `layer` leaves the raw host's
 * crypto, filesystem, and Jj services to its caller. `layerHost` supplies
 * those services and manages its own child scope. Its registration and
 * registry arguments may still declare requirements, so the closed generic
 * instantiation below proves only that the host itself owes nothing.
 *
 * @category models
 * @since 1.0.0
 */
export type CompositionRootsAreComplete = [
  Expect<
    EffectRequirementsAre<
      ReturnType<typeof make<never, never, never, never, never, never, never>>,
      Crypto.Crypto | FileSystem.FileSystem | KernelJj.Jj | Scope.Scope
    >
  >,
  Expect<
    LayerRequirementsAre<
      ReturnType<typeof layer<never, never, never, never, never, never, never>>,
      Crypto.Crypto | FileSystem.FileSystem | KernelJj.Jj
    >
  >,
  Expect<Complete<ReturnType<typeof layerHost<never, never, never>>>>
]
