/**
 * The `install` flow: measure, fetch, link.
 *
 * `docs/specs/Concepts/Unified Flow Authoring.md` gives two nouns. The atoms
 * here are Actions, because each carries an implementation that is
 * attached separately as a `Layer` and none of them is made of steps. The
 * composite is a Flow, because it has a pure plan-time body and no opaque
 * code of its own.
 *
 * The shape follows Bazel's fetch/build split and rules_js's `npm_translate_lock`
 * split, restated in this vocabulary:
 *
 * | step    | tier   | boundary | admitted to the cross-run cache |
 * | ------- | ------ | -------- | ------------------------------- |
 * | measure | sealed | expected | no                              |
 * | fetch/* | sealed | expected | no                              |
 * | link    | sealed | expected | no                              |
 *
 * Every tier is `sealed` because `Plan.compile` refuses to key anything else:
 * `StepKey.fromKeyMaterial` fails with `non_content_material` for
 * `compensable` and `irreversible` declarations, so an `Action` declared at
 * either tier makes the flow unplannable. The `expected` boundary mode is what
 * keeps measure and link out of the cross-run cache, because
 * `ActionPersistence` admits a result only when the tier is `sealed` AND the
 * boundary mode is `hard`. No install action currently uses that mode.
 *
 * A `node_modules` tree is a graph of links into a local store, so
 * restoring one from another machine would produce a tree whose entries point
 * at nothing. Link is therefore never admitted, and measure is not admitted
 * either.
 *
 * ## What measure is, and what it is not
 *
 * Measure reports **content**: the lockfile digest and the credential-free
 * `.npmrc` digest. That is all. It used to report an `Environment` struct that
 * also carried the manager name, the manager version, and the host platform,
 * and the flow ran in two trampoline rounds so a later round could select a
 * manager-specific fetch from a measured manager name.
 *
 * Those three fields were never content. They are the identity of two host
 * services, and they now come from those services:
 *
 * - Which manager, and which version it must be, is
 *   {@link PackageManager.Service}. The workspace declares the version and
 *   `PackageManager.Service.verify` holds the host to it.
 * - The platform is {@link Runtime.Service}. It describes the machine, so it
 *   belongs to the runtime rather than to a struct passed between steps.
 *
 * Two consequences follow. The flow no longer trampolines: the manager arrives
 * in the payload as a plan-time declaration from BUILD.ts, so one round records
 * measure, exactly one fetch, and link. And the cross-round recheck is gone
 * with the second round, replaced by `verify`, which compares the host against
 * what the workspace declared rather than against an earlier measurement of the
 * same host.
 *
 * Measure still exists, and still runs in its own step, because the two digests
 * are step-key material: an install whose lockfile changed must not be answered
 * by the previous install's recorded result.
 *
 * @since 0.1.0
 */
import { Action, Flow } from "@smthrs/flow"
import { FileInput } from "@smthrs/flow/FileInput"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as PackageManager from "./PackageManager.ts"
import * as Runtime from "./Runtime.ts"

/**
 * Schema for the content an install is keyed on.
 *
 * Both fields are digests. Nothing here names a host, a manager, or a path into
 * a store, because this value exists to make one install distinguishable from
 * another install of different dependencies.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Content = Schema.Struct({
  /** The lockfile path and its measured digest. */
  lockfile: FileInput,
  /** The credential-free `.npmrc` and its digest, or `null` when absent. */
  npmrc: Schema.NullOr(FileInput)
})

/**
 * The content an install is keyed on.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Content = typeof Content.Type

/**
 * Schema for what a completed link reports.
 *
 * The digest describes the tree; the tree itself is never a value, never an
 * artifact, and never leaves the host.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const LinkManifest = Schema.Struct({
  /** The store manifest digest this tree was linked from. */
  store: PackageManager.Digest,
  /** Digest of the store, root package manifest, and manager tree evidence. */
  manifest: PackageManager.Digest,
  /** Whether the manager ran, or the tree was already fresh. */
  linked: Schema.Boolean
})

/**
 * What a completed link reports.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type LinkManifest = typeof LinkManifest.Type

/** The lockfiles and configuration the measure action may read. */
const measureInputPatterns: ReadonlyArray<string> = [
  ".npmrc",
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock"
]

/**
 * Measures the content every later step keys on.
 *
 * Declared with an `expected` boundary so that no cross-run cache ever answers
 * it. Re-measuring costs two file digests, and a restored measurement would
 * describe another machine's checkout.
 *
 * @category actions
 * @since 0.1.0
 * @slop
 */
export const Measure = Action.make("smithers-build/install/measure", {
  payload: {},
  success: Content,
  error: PackageManager.PackageManagerError,
  tier: "sealed"
})
  .annotate(Flow.EffectsDeclaration, {
    reads: measureInputPatterns,
    writes: [],
    boundaryMode: "expected"
  })

/**
 * Populates the package-manager store, and writes no `node_modules`.
 *
 * Its key material is the measured content: the lockfile digest and the
 * credential-free `.npmrc` digest, reaching the key as a settled upstream
 * reference. Its value is a store-manifest digest, never the store's bytes and
 * never a `node_modules` archive. The store files are declared outputs, but
 * the shipped implementation pins its child process to an absolute project
 * root. It cannot freeze the lockfile and `.npmrc` between verification and
 * the child's own opens, so this action uses an `expected` boundary and is
 * not admitted to a cross-run cache.
 *
 * Every manager uses a workspace-local directory beneath `.flows/store`.
 * This static path keeps the write declaration exact and makes a future
 * sandbox-root-aware implementation possible without changing the Flow API.
 *
 * @category actions
 * @since 0.1.0
 */
const makeFetch = <Tag extends string>(
  name: Tag,
  lockfile: string,
  manager: PackageManager.Name
) =>
  Action.make(name, {
    payload: {
      content: Content
    },
    success: PackageManager.StoreManifest,
    error: PackageManager.PackageManagerError,
    tier: "sealed"
  })
    .annotate(Flow.EffectsDeclaration, {
      reads: [lockfile, ".npmrc"],
      writes: [{ _tag: "TreeArtifact", path: `${PackageManager.storeRoot}/${manager}` }],
      boundaryMode: "expected"
    })

/**
 * Fetches pnpm packages from `pnpm-lock.yaml`.
 *
 * @category actions
 * @since 0.1.0
 * @slop
 */
export const FetchPnpm = makeFetch("smithers-build/install/fetch/pnpm", "pnpm-lock.yaml", "pnpm")

/**
 * Fetches Bun packages from `bun.lock`.
 *
 * @category actions
 * @since 0.1.0
 * @slop
 */
export const FetchBun = makeFetch("smithers-build/install/fetch/bun", "bun.lock", "bun")

/**
 * Materializes `node_modules` from the already-populated store.
 *
 * Its `expected` boundary is what keeps it out of the cross-run cache;
 * `compensable` would say the same thing about retry semantics but would make
 * the flow unplannable, so the tier stays `sealed`. See the module doc. Its
 * step key still supports local freshness checks: an unchanged key lets the
 * same run, or the next run on this machine, skip the work.
 * Its write set is empty on purpose. The current boundary contract turns
 * declared writes into materialized artifacts, so naming `node_modules` would
 * violate the target that this tree is never cached. An isolated sandbox may
 * observe the write as an expected-set deviation without failing the action.
 *
 * @category actions
 * @since 0.1.0
 * @slop
 */
export const Link = Action.make("smithers-build/install/link", {
  payload: {
    content: Content,
    store: PackageManager.StoreManifest
  },
  success: LinkManifest,
  error: PackageManager.PackageManagerError,
  tier: "sealed"
})
  .annotate(Flow.EffectsDeclaration, {
    reads: ["package.json"],
    // A declared output is also materialized evidence in the current engine.
    // Naming node_modules here would cache the tree as file artifacts. The
    // expected boundary instead records sandbox-observed writes as a deviation.
    writes: [],
    boundaryMode: "expected"
  })

/**
 * The install payload.
 *
 * `manager` is the manager the workspace declared in BUILD.ts. It is a
 * plan-time value, which is what lets one round select exactly one fetch
 * action; the previous design had to measure the manager first and hand off to
 * a second round to do the same job. The project root is the engine's working
 * directory, so it does not enter a content key.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const payloadFields = {
  manager: PackageManager.Name
}

/**
 * The implementations the body names.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Requires =
  | Action.Requirement<"smithers-build/install/measure">
  | Action.Requirement<"smithers-build/install/fetch/pnpm">
  | Action.Requirement<"smithers-build/install/fetch/bun">
  | Action.Requirement<"smithers-build/install/link">

/**
 * The declaration shape the flow is named under.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type InstallFlow = Flow.Flow<
  "smithers-build/install",
  Schema.Struct<typeof payloadFields>,
  typeof LinkManifest,
  typeof PackageManager.PackageManagerError,
  Requires
>

/**
 * Records measure, one fetch, and link.
 *
 * The fetch is a parameter rather than a value selected inside the body because
 * each fetch declaration carries its own requirement in its type. Selecting one
 * from a union collapses the recorded requirement to whichever branch the
 * compiler read first; passing one in keeps this helper generic over exactly one
 * requirement and lets the four call sites union at the body, which is what
 * {@link Requires} already spells.
 *
 * @private
 */
const measureFetchLink = <R>(
  fetch: (
    content: Planned.Planned<Content>
  ) => Node.Node<PackageManager.StoreManifest, PackageManager.PackageManagerError, R>
): Node.Node<
  LinkManifest,
  PackageManager.PackageManagerError,
  | R
  | Action.Requirement<"smithers-build/install/measure">
  | Action.Requirement<"smithers-build/install/link">
> =>
  Measure.call({}).pipe(
    Node.andThen((content) => fetch(content).pipe(Node.andThen((store) => Link.call({ content, store }))))
  )

/**
 * Installs a project's dependencies.
 *
 * The body is pure: it records nodes and executes nothing. It runs in one
 * round. The manager is a declaration in the payload, so the body selects one
 * manager-specific fetch statically, and measure feeds it as an ordinary
 * settled upstream reference rather than as a second round's payload.
 *
 * The capability ceiling is declared here rather than per action because
 * `Graph.build` reads it from the flow and copies it onto every node it
 * records; an `Action` declaration's own `Flow.Capabilities` annotation is
 * never read. DESIGN.md records that discrepancy against
 * `docs/specs/Concepts/Step Keys.md`, which describes capabilities as
 * per-step key material.
 *
 * @category flows
 * @since 0.1.0
 * @slop
 */
export const Install: InstallFlow = Flow.make("smithers-build/install", {
  payload: payloadFields,
  success: LinkManifest,
  error: PackageManager.PackageManagerError,
  maxRounds: 1,
  body: ({ manager }): Node.Node<
    Flow.BodySuccess<typeof LinkManifest.Type>,
    PackageManager.PackageManagerError,
    Requires
  > =>
    manager === "pnpm"
      ? measureFetchLink((content) => FetchPnpm.call({ content }))
      : measureFetchLink((content) => FetchBun.call({ content }))
}).annotate(Flow.Capabilities, ["fs:read", "fs:write", "net:get", "net:post", "proc:spawn"])

/** @private */
const environmentMismatch = (message: string): PackageManager.PackageManagerError =>
  new PackageManager.PackageManagerError({ code: "environment_mismatch", message })

const lockfileFor = (manager: PackageManager.Name): string => manager === "pnpm" ? "pnpm-lock.yaml" : "bun.lock"

const verifyManagerContract = (
  manager: PackageManager.Service
): Effect.Effect<void, PackageManager.PackageManagerError> => {
  if (!["pnpm", "bun"].includes(manager.name)) {
    return Effect.fail(environmentMismatch("the package-manager layer declares an unknown manager"))
  }
  const expectedLockfile = lockfileFor(manager.name)
  const expectedStore = `${PackageManager.storeRoot}/${manager.name}`
  return manager.lockfileName === expectedLockfile && manager.storeDirectory === expectedStore
    ? Effect.void
    : Effect.fail(
      environmentMismatch(
        `the ${manager.name} layer declares ${manager.lockfileName} and ${manager.storeDirectory}; ` +
          `the install Flow boundary requires ${expectedLockfile} and ${expectedStore}`
      )
    )
}

/**
 * Checks the layer against the declaration and the host against both.
 *
 * Three things have to agree before a manager writes anything: the manager the
 * workspace declared, the manager the composition provided, and the versions
 * the host actually has. The first mismatch is a wiring error and the last is
 * a machine that is not set up the way the workspace says it must be; both are
 * reported before any store or tree is touched.
 *
 * @private
 */
const verifyEnvironment = (
  manager: PackageManager.Service,
  runtime: Runtime.Service
): Effect.Effect<string, PackageManager.PackageManagerError> =>
  Effect.gen(function*() {
    yield* verifyManagerContract(manager)
    yield* runtime.verify.pipe(
      Effect.mapError((cause) => environmentMismatch(cause.message))
    )
    return yield* manager.verify
  })

/**
 * Refuses to link a store with a different manager implementation.
 *
 * @private
 */
const verifyStoreManager = (
  manager: PackageManager.Service,
  managerVersion: string,
  platform: PackageManager.Platform | null,
  store: PackageManager.StoreManifest
): Effect.Effect<void, PackageManager.PackageManagerError> => {
  const samePlatform = store.platform === null
    ? platform === null
    : platform !== null &&
      store.platform.os === platform.os &&
      store.platform.arch === platform.arch &&
      store.platform.libc === platform.libc
  return store.manager === manager.name &&
      store.managerVersion === managerVersion &&
      samePlatform
    ? Effect.void
    : Effect.fail(environmentMismatch("the fetched store does not match this host"))
}

/**
 * The implementation of {@link Measure}.
 *
 * It reads two files and digests them. It measures no manager version and no
 * platform, because neither is content and both now have a service that
 * answers for them.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const MeasureLive = Measure.toLayer(() =>
  Effect.gen(function*() {
    const manager = yield* PackageManager.PackageManager
    yield* verifyManagerContract(manager)
    const lockfile = yield* PackageManager.lockfileDigest(manager.projectRoot, manager.lockfileName)
    const npmrc = yield* PackageManager.npmrcDigest(manager.projectRoot)
    return {
      lockfile: { path: manager.lockfileName, digest: lockfile },
      npmrc: npmrc === null ? null : { path: ".npmrc", digest: npmrc }
    }
  })
)

/**
 * The implementation shared by the manager-specific fetch declarations.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const executeFetch = ({ content }: { readonly content: Content }) =>
  Effect.gen(function*() {
    const manager = yield* PackageManager.PackageManager
    const runtime = yield* Runtime.Runtime
    const managerVersion = yield* verifyEnvironment(manager, runtime)
    yield* manager.fetch
    return yield* PackageManager.storeManifest({
      manager: manager.name,
      managerVersion,
      platform: manager.platformSensitive ? runtime.platform : null,
      lockfileDigest: content.lockfile.digest,
      npmrcDigest: content.npmrc === null ? null : content.npmrc.digest
    })
  })

/**
 * Implements {@link FetchPnpm}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const FetchPnpmLive = FetchPnpm.toLayer(executeFetch)

/**
 * Implements {@link FetchBun}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const FetchBunLive = FetchBun.toLayer(executeFetch)

/**
 * The implementation of {@link Link}.
 *
 * Link always asks the selected package manager to reconcile `node_modules`.
 * Manager metadata such as npm's hidden lockfile or pnpm's modules manifest
 * describes the intended graph, but cannot prove that every package file is
 * still present and unmodified. Treating that metadata as a freshness proof
 * would silently accept a deleted or corrupted package. The expected boundary
 * keeps this work local and out of the shared action cache.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const executeLink = ({ store }: {
  readonly content: Content
  readonly store: PackageManager.StoreManifest
}) =>
  Effect.gen(function*() {
    const manager = yield* PackageManager.PackageManager
    const runtime = yield* Runtime.Runtime
    const managerVersion = yield* verifyEnvironment(manager, runtime)
    yield* verifyStoreManager(
      manager,
      managerVersion,
      manager.platformSensitive ? runtime.platform : null,
      store
    )
    const packageJsonDigest = yield* PackageManager.packageJsonDigest(manager.projectRoot)
    yield* manager.link
    const managerEvidence = yield* manager.linkManifest
    const manifest = yield* PackageManager.linkedTreeManifest({
      storeDigest: store.digest,
      packageJsonDigest,
      managerEvidence
    })
    return { store: store.digest, manifest, linked: true }
  })

/**
 * Live implementation of the package-manager link action.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const LinkLive = Link.toLayer(executeLink)

/**
 * Every implementation the {@link Install} flow needs.
 *
 * Compose it over a `PackageManager` layer, a `Runtime` layer, a
 * `FlowRuntime`, and the host services those need. Selecting the manager and
 * the runtime is the only choice a consumer makes.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = Layer.mergeAll(
  MeasureLive,
  FetchPnpmLive,
  FetchBunLive,
  LinkLive
)
