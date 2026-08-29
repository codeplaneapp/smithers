/**
 * Cloudflare Durable Object composition for the durable flows runtime.
 *
 * This module is the Workers counterpart of `src/NodeRuntime.ts`, and a
 * subpath export for the same reason: importing it opens a SQL client over
 * `@smthrs/database/cloudflare/DurableObjectDatabase`, so the
 * platform-neutral `@smthrs/flows` root must not re-export it.
 *
 * Construction is ordered by layer dependencies exactly as the Node
 * composition is: migrations finish before any store is built, the durable
 * engine is built over those stores, and `registerFlows` finishes before the
 * resulting services are exposed. The engine's own registration hook then
 * re-arms durable clocks and deferred wakes, so a run persisted in the
 * object's storage cannot resume through this composition before its flow has
 * been registered.
 *
 * **What the Node composition provides and this one does not.** A Durable
 * Object has no filesystem, so `Workspace` and the local `ArtifactStore` — the
 * two filesystem-shaped layers `NodeRuntime.storage` merges in — are the
 * caller's to supply, along with the `Jj` and `Crypto` seams both compositions
 * leave to the host. Nothing in `EngineStore.layer` requires the filesystem
 * pair; a Workers deployment that needs artifacts binds R2 or a second Durable
 * Object and provides `ArtifactStore` itself.
 *
 * **One object, one database, one writer.** Durable Object SQLite is scoped to
 * a single object id and runs on a single thread, so this composition is
 * built once per object — in the object's constructor — and lives for the
 * object's lifetime. There is no second process to fence against, which is why
 * `isAlive` is normally `false` here: the object *is* the lease.
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database"
import * as DurableObjectDatabase from "@smthrs/database/cloudflare/DurableObjectDatabase"
import type { DurableObjectStorageLike } from "@smthrs/database/cloudflare/SqlStorageLike"
import { DurableEngineState, EngineStore, OwnerIdentity } from "@smthrs/engine-store"
import * as Migrations from "@smthrs/engine-store/Migrations"
import type * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import type * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { SqlJournal } from "@smthrs/journal"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/**
 * Configuration for the Durable Object runtime.
 *
 * `isAlive` is intentionally required, as it is in `NodeRuntime`. A single
 * object answering for its own storage returns `false`; a deployment that
 * hands one object's runs to another must answer from whatever it uses to
 * decide that the previous holder is gone.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Options {
  /** The Durable Object's storage handle, `ctx.storage`. */
  readonly storage: DurableObjectStorageLike
  /** Stable identity of this engine host, normally the object's id. */
  readonly owner: {
    readonly hostId: string
  }
  /** Whether a previously recorded owner is still alive. */
  readonly isAlive: (owner: Ownership.OwnerId) => Effect.Effect<boolean>
}

const Configuration = Schema.Struct({
  owner: Schema.Struct({ hostId: Schema.NonEmptyString })
})

const validate = (options: Options): Options => {
  Schema.decodeUnknownSync(Configuration)(options)
  return options
}

/**
 * Provides the migrated database, durable stores, and owner minter without
 * constructing an engine.
 *
 * This is the lower-level seam for integrations that construct another
 * engine-backed service over the same object's storage. Application entry
 * points should normally use {@link layer}.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const storage = (storage: DurableObjectStorageLike) => {
  const database = Layer.provideMerge(
    Migrations.layer,
    Layer.provideMerge(DurableWriter.layer(), DurableObjectDatabase.layer({ storage }))
  )
  return Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer,
    OwnerIdentity.layer
  ).pipe(Layer.provideMerge(database))
}

const composition = <
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
) => {
  const validated = validate(options)
  const execution = Layer.merge(stepBoundary, workspaceSandbox).pipe(
    Layer.provideMerge(storage(validated.storage))
  )
  const engine = EngineStore.layer({
    owner: validated.owner,
    journalSource: `${validated.owner.hostId}-engine`,
    isAlive: validated.isAlive
  }).pipe(Layer.provideMerge(execution))
  return registerFlows.pipe(Layer.provideMerge(engine))
}

/**
 * Builds the Durable Object service context in the current scope.
 *
 * The caller selects the filesystem boundary and workspace sandbox layers and
 * supplies a registration layer, exactly as in `NodeRuntime.make`. `Jj` and
 * Effect `Crypto` remain requirements of the returned effect. Closing the
 * surrounding scope closes the journal writer, sweeper, and active engine
 * fibers through their existing finalizers; the object's storage outlives the
 * scope, because the platform owns it.
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
  RegistrationRequirements
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
) => Layer.build(composition(options, stepBoundary, workspaceSandbox, registerFlows))

/**
 * Provides the scoped Durable Object runtime.
 *
 * `registerFlows` is the final startup phase, not a layer callers merge beside
 * the engine, for the same durability-ordering reason `NodeRuntime.layer`
 * gives. Shutdown is scope closure; this module installs no handlers.
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
  RegistrationRequirements
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
) => Layer.effectContext(make(options, stepBoundary, workspaceSandbox, registerFlows))
