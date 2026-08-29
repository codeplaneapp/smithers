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
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { DurableEngineState, EngineStore, OwnerIdentity } from "@smthrs/engine-store"
import * as Migrations from "@smthrs/engine-store/Migrations"
import type * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import type * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { SqlJournal } from "@smthrs/journal"
import { Workspace } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { dirname, join } from "node:path"

/**
 * Configuration for the supported Node SQLite runtime.
 *
 * `isAlive` is intentionally required. A local single-process host may return
 * `false`; a multi-process deployment must answer from its supervisor or
 * lease system so the engine never steals work from a live owner.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Options {
  /** SQLite database filename. Its parent directory is created recursively. */
  readonly filename: string
  /** Stable identity of this engine host. */
  readonly owner: {
    readonly hostId: string
  }
  /** Whether a previously recorded owner is still alive. */
  readonly isAlive: (owner: Ownership.OwnerId) => Effect.Effect<boolean>
}

const Configuration = Schema.Struct({
  filename: Schema.NonEmptyString,
  owner: Schema.Struct({ hostId: Schema.NonEmptyString })
})

const validate = (options: Options): Options => {
  Schema.decodeUnknownSync(Configuration)(options)
  return options
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
export const storage = (filename: string) => {
  const validatedFilename = Schema.decodeUnknownSync(Schema.NonEmptyString)(filename)
  const root = dirname(validatedFilename)
  const database = Layer.provideMerge(Migrations.layer, databaseLayer(validatedFilename))
  return Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer,
    OwnerIdentity.layer,
    Workspace.layer(root),
    ArtifactStore.layerFileSystem({ directory: join(root, ".flows/objects") })
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
    Layer.provideMerge(storage(validated.filename))
  )
  const engine = EngineStore.layer({
    owner: validated.owner,
    journalSource: `${validated.owner.hostId}-engine`,
    isAlive: validated.isAlive
  }).pipe(Layer.provideMerge(execution))
  return registerFlows.pipe(Layer.provideMerge(engine))
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
  RegistrationRequirements
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
) => Layer.build(composition(options, stepBoundary, workspaceSandbox, registerFlows))

/**
 * Provides the supported scoped Node SQLite runtime.
 *
 * `registerFlows` is the final startup phase, not a layer callers merge beside
 * the engine. This serializes the durability-sensitive order and ensures the
 * runtime is usable only after every supplied flow registration has completed.
 * Shutdown is scope closure; this module installs no process or signal
 * handlers.
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
