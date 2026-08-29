/**
 * Bounded-parallel execution of planned targets.
 *
 * Targets execute in dependency order with keep-going semantics: a failure
 * fails the run but skips only its dependent cone, every other target still
 * runs, and every result is collected. Each target's Flow runs through the
 * same in-memory flows runtime the install command uses, with the shared exec
 * action implemented by `ExecLive`, the generated-file actions implemented by
 * `WriteFileLive` and `CheckFileLive`, the documentation-parity action
 * implemented by `CheckDocsLive`, the file-group expansion implemented by
 * `ExpandFilegroupLive`, and cacheable green results stored in the
 * workspace cache.
 *
 * @since 0.1.0
 */
import { FlowEngine } from "@smthrs/engine"
import { Action, type Flow, Interpreter } from "@smthrs/flow"
import { ExecIrreversibleLive } from "@smthrs/targets/Changesets"
import { CheckDocsLive } from "@smthrs/targets/DocsParity"
import { ExecLive } from "@smthrs/targets/Exec"
import { ExpandFilegroupLive, isFilegroup } from "@smthrs/targets/Filegroup"
import { CheckFileLive, WriteFileLive } from "@smthrs/targets/GeneratedFile"
import { LlmReviewLive } from "@smthrs/targets/LlmLint"
import { ScaffoldPackageLive } from "@smthrs/targets/NewPackage"
import { SyncPackageJsonLive } from "@smthrs/targets/PackageJson"
import * as Target from "@smthrs/targets/Target"
import { CaptureOutputsLive, verifyOutputs } from "@smthrs/targets/ToolBuild"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"
import * as Os from "node:os"
import { performance } from "node:perf_hooks"
import * as NodeUtil from "node:util/types"
import { entryLimit, openCache } from "./Cache.ts"
import * as Diagnostic from "./Diagnostic.ts"
import { declaredToolchain, layerInstall, layerNonInteractiveNodeServices, layerPackageManager } from "./engine.ts"
import type * as Planner from "./Planner.ts"
import * as Reporter from "./Reporter.ts"
import type { ExpandedInput, Workspace } from "./Workspace.ts"

/**
 * One target's reported execution outcome.
 *
 * `hit` answered from the cache, `ran` executed green, `failed` executed and
 * failed, and `skipped` never ran because a dependency did not succeed.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface TargetReport {
  readonly label: string
  readonly target: string
  readonly status: "hit" | "ran" | "failed" | "skipped"
  readonly durationMs: number
  readonly key: string
  readonly error?: string | undefined
}

/**
 * Per-status result counts for one execution.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface StatusCounts {
  readonly hit: number
  readonly ran: number
  readonly failed: number
  readonly skipped: number
}

/**
 * What one execution reports: every target's outcome in plan order plus the
 * verdict `ok`, false when any target failed.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Summary {
  readonly verb: string
  readonly pattern: string
  readonly jobs: number
  readonly durationMs: number
  readonly counts: StatusCounts
  readonly ok: boolean
  readonly results: ReadonlyArray<TargetReport>
}

/**
 * Options accepted by {@link execute}.
 *
 * `jobs` bounds concurrent targets, must be a positive integer, and defaults
 * to the host parallelism.
 * `readCache` false bypasses cache reads while green results are still
 * written. `remoteCache` is resolved host state and never key material. `signal`
 * interrupts every running target. `reporter` receives every execution event;
 * without one, `log` receives one plain status line per settled target and
 * the end summary, and defaults to standard error.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ExecuteOptions {
  readonly workspace: Workspace
  readonly verb: string
  readonly pattern: string
  readonly targets: ReadonlyArray<Planner.PlannedTarget>
  readonly jobs?: number | undefined
  readonly readCache?: boolean | undefined
  readonly remoteCache?: {
    readonly endpoint: string
    readonly tokenEnv: string
    readonly token?: string | undefined
  } | undefined
  readonly signal?: AbortSignal | undefined
  readonly packageName?: string | undefined
  readonly log?: ((line: string) => void) | undefined
  readonly reporter?: Reporter.Reporter | undefined
}

/**
 * Several verb plans over one pattern merged into a single execution set.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface MergedPlan {
  readonly roots: ReadonlyArray<string>
  readonly targets: ReadonlyArray<Planner.PlannedTarget>
  readonly edges: ReadonlyArray<Planner.Edge>
  readonly warnings: ReadonlyArray<string>
}

/**
 * Merges verb plans into the closure of the selected per-label views.
 *
 * Equal-key duplicate views collapse. When lint and a writing verb disagree,
 * lint wins so CI checks drift without mutating it. Two different non-lint
 * views are ambiguous and fail instead of silently dropping one action. The
 * dependency closure and edges are rebuilt from the winning views; otherwise
 * a dependency that belonged only to a discarded build view would still run.
 *
 * @category planning
 * @since 0.1.0
 * @slop
 */
export const mergePlans = (plans: ReadonlyArray<Planner.Plan>): MergedPlan => {
  const roots: Array<string> = []
  const warnings: Array<string> = []
  const seenRoots = new Set<string>()
  const selectedTargets = new Map<
    string,
    { readonly target: Planner.PlannedTarget; readonly verb: Planner.Plan["verb"] }
  >()
  const seenWarnings = new Set<string>()
  for (const plan of plans) {
    for (const root of plan.roots) {
      if (seenRoots.has(root)) continue
      seenRoots.add(root)
      roots.push(root)
    }
    for (const target of plan.targets) {
      const selected = selectedTargets.get(target.label)
      if (selected === undefined) {
        selectedTargets.set(target.label, { target, verb: plan.verb })
        continue
      }
      if (selected.target.keyPreview === target.keyPreview) continue
      if (plan.verb === "lint" && selected.verb !== "lint") {
        selectedTargets.set(target.label, { target, verb: plan.verb })
        continue
      }
      if (selected.verb === "lint" && plan.verb !== "lint") continue
      throw new Error(
        `cannot merge ${selected.verb} and ${plan.verb} plans: ${target.label} has incompatible execution views`
      )
    }
    for (const warning of plan.warnings) {
      if (seenWarnings.has(warning)) continue
      seenWarnings.add(warning)
      warnings.push(warning)
    }
  }
  const targets: Array<Planner.PlannedTarget> = []
  const edges: Array<Planner.Edge> = []
  const complete = new Set<string>()
  const visiting = new Set<string>()
  const visit = (label: string): void => {
    if (complete.has(label)) return
    if (visiting.has(label)) throw new Error(`merged dependency cycle reaches ${label}`)
    const selected = selectedTargets.get(label)
    if (selected === undefined) throw new Error(`merged plan depends on missing target ${label}`)
    visiting.add(label)
    for (const dependency of selected.target.dependencies) {
      visit(dependency)
      edges.push({ from: dependency, to: label })
    }
    visiting.delete(label)
    complete.add(label)
    targets.push(selected.target)
  }
  for (const root of roots) visit(root)
  return { roots, targets, edges, warnings }
}

/**
 * The type-level stance the executor takes on a target Flow.
 *
 * A target's real payload schema is its attrs schema and the planner metadata
 * carries the already-decoded attrs, so the executor erases the payload to an
 * empty struct and both result channels to unknown. The runtime path still
 * validates through the target's own schemas; the erasure only keeps the
 * erased schema service channels out of the composed effect's requirements.
 */
type Executable = Flow.Flow<
  string,
  Schema.Struct<{}>,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  never
>

/**
 * Runs one target Flow to settlement in its own in-memory runtime.
 *
 * Each target gets a fresh runtime because two targets of the same target share
 * a Flow tag: registering both with one engine would alias their bodies.
 * `attrs` are the planned verb-effective attrs, so a generator target runs
 * its write form under `build` and its drift-check form under `lint`.
 */
const runTarget = (
  workspaceRoot: string,
  cacheDirectory: string,
  target: Target.AnyTarget,
  attrs: unknown,
  executionId: string,
  sensitiveEnv: ReadonlyArray<string>,
  packageName?: string | undefined,
  signal?: AbortSignal | undefined
): Promise<Exit.Exit<unknown, unknown>> => {
  const flow = target as unknown as Executable
  const runtime = Layer.mergeAll(
    layerInstall,
    ExecLive({ workspaceRoot, cacheDirectory, sensitiveEnv }),
    ExecIrreversibleLive({ workspaceRoot }),
    CaptureOutputsLive({ workspaceRoot, cacheDirectory }),
    ExpandFilegroupLive({ workspaceRoot, cacheDirectory }),
    WriteFileLive({ workspaceRoot }),
    CheckFileLive({ workspaceRoot }),
    CheckDocsLive({ workspaceRoot }),
    LlmReviewLive({ workspaceRoot, sensitiveEnv }),
    SyncPackageJsonLive({ workspaceRoot, cacheDirectory }),
    ScaffoldPackageLive({ workspaceRoot, packageName }),
    Target.layerNotImplemented,
    Interpreter.layer(flow)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    // The toolchain comes from this target's own attrs, so two targets in one
    // graph can run under different managers and the layer matches whichever
    // BUILD.ts declared.
    Layer.provideMerge(layerPackageManager(workspaceRoot, declaredToolchain(attrs), sensitiveEnv)),
    Layer.provideMerge(layerNonInteractiveNodeServices)
  )
  return Effect.runPromiseExit(
    flow.execute(attrs as {}, { executionId }).pipe(
      Effect.provide(runtime)
    ),
    { signal }
  )
}

/**
 * Resolves every planned label back to its executable target Flow.
 *
 * The traversal re-walks the same closure the planner walked: the pattern's
 * selected targets plus transitive direct-import dependencies. The workspace
 * caches BUILD.ts modules, so the objects resolved here are the ones the plan
 * was derived from.
 */
const resolveFlows = async (
  workspace: Workspace,
  targets: ReadonlyArray<Planner.PlannedTarget>
): Promise<ReadonlyMap<string, Target.AnyTarget>> => {
  const found = new Map<string, Target.AnyTarget>()
  for (const planned of targets) {
    const resolved = await workspace.targets(planned.label)
    const target = resolved[0]
    if (resolved.length !== 1 || target === undefined) {
      throw new Error(`planned target ${planned.label} did not resolve to an executable Flow`)
    }
    found.set(planned.label, target)
  }
  return found
}

/**
 * Resolves the concurrency bound one execution runs under.
 *
 * The CLI validates its own flag, so this guards the programmatic call. A
 * non-integer bound is rejected instead of clamped: `NaN` silently scheduled
 * zero targets and reported a green summary for a run that never happened.
 *
 * @category execution
 * @since 0.1.0
 * @slop
 */
export const resolveJobs = (jobs?: number | undefined): number => {
  if (jobs === undefined) return Math.max(1, Os.availableParallelism())
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new TypeError(
      `jobs must be a positive integer, received ${typeof jobs === "number" ? String(jobs) : typeof jobs}`
    )
  }
  return jobs
}

/**
 * Validates a work list before anything is dispatched.
 *
 * Every one of these was previously either accepted silently or discovered
 * only by the scheduler running out of ready work. A duplicate label makes two
 * targets share one completion slot, so one of them is dropped and the other's
 * dependents are released early. An unknown dependency used to be filtered out,
 * which released a dependent whose dependency was never in the graph. A
 * self-dependency and a cycle are both unsatisfiable and used to be reported
 * only after every acyclic target had already executed. Reporting them here
 * means an unschedulable graph never runs half of itself first.
 *
 * Diagnostics are deterministic: offenders are listed in code-unit order.
 */
const validateWorkList = (targets: ReadonlyArray<Planner.PlannedTarget>): string | undefined => {
  const byCodeUnit = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
  const labels = new Set<string>()
  const duplicates = new Set<string>()
  for (const target of targets) {
    if (labels.has(target.label)) duplicates.add(target.label)
    labels.add(target.label)
  }
  if (duplicates.size > 0) {
    return `the work list names ${[...duplicates].sort(byCodeUnit).join(", ")} more than once`
  }
  for (const target of targets) {
    const seen = new Set<string>()
    for (const dependency of target.dependencies) {
      if (dependency === target.label) return `${target.label} depends on itself`
      if (seen.has(dependency)) return `${target.label} lists the dependency ${dependency} more than once`
      seen.add(dependency)
      if (!labels.has(dependency)) {
        return `${target.label} depends on ${dependency}, which is not in the work list`
      }
    }
  }
  // Kahn's algorithm over the validated graph. Whatever it cannot reach lies on
  // or below a cycle.
  const remaining = new Map(targets.map((target) => [target.label, target.dependencies.length]))
  const dependents = new Map<string, Array<string>>()
  for (const target of targets) {
    for (const dependency of target.dependencies) {
      const entry = dependents.get(dependency)
      if (entry === undefined) dependents.set(dependency, [target.label])
      else entry.push(target.label)
    }
  }
  const queue = targets.filter((target) => target.dependencies.length === 0).map((target) => target.label)
  let settled = 0
  for (let index = 0; index < queue.length; index += 1) {
    settled += 1
    for (const dependent of dependents.get(queue[index]!) ?? []) {
      const left = remaining.get(dependent)! - 1
      remaining.set(dependent, left)
      if (left === 0) queue.push(dependent)
    }
  }
  if (settled !== targets.length) {
    const stalled = targets
      .filter((target) => (remaining.get(target.label) ?? 0) > 0)
      .map((target) => target.label)
      .sort(byCodeUnit)
    return `${targets.length - settled} of ${targets.length} targets never became ready ` +
      `(dependency graph is not satisfiable): ${stalled.join(", ")}`
  }
  return undefined
}

/**
 * Drains a dependency-ordered work list with at most `jobs` in flight.
 *
 * The work list and the concurrency bound are validated before anything is
 * dispatched, and an invalid one rejects without running a target. See
 * {@link validateWorkList}: a duplicate label, a duplicate or unknown or
 * self-referential dependency edge, and any cycle are all refused up front.
 * `jobs` must be a positive integer, because a fractional or non-finite bound
 * made the dispatch loop's `active < jobs` comparison false forever and
 * resolved a summary for a run that never happened.
 *
 * `runOne` reports an ordinary target failure itself and still resolves, which
 * is what keeps the run going. A rejection, or a synchronous throw, is
 * therefore an internal fault: no further target is dispatched, the targets
 * already in flight are awaited so nothing keeps mutating the workspace or the
 * cache after the caller has resumed, and the first rejection is the one
 * reported.
 *
 * Once `signal` aborts, no new target is dispatched. Targets already in flight
 * are still drained before the abort is reported, so they cannot keep mutating
 * the workspace after the caller regains control.
 *
 * The scheduler therefore always settles: it resolves only after dispatching
 * every target, and rejects in every other case.
 *
 * @category execution
 * @since 0.1.0
 * @slop
 */
export const schedule = (
  targets: ReadonlyArray<Planner.PlannedTarget>,
  jobs: number,
  runOne: (label: string) => Promise<void>,
  signal?: AbortSignal | undefined
): Promise<void> => {
  if (!Number.isInteger(jobs) || jobs < 1) {
    return Promise.reject(
      new TypeError(
        `jobs must be a positive integer, received ${typeof jobs === "number" ? String(jobs) : typeof jobs}`
      )
    )
  }
  const invalid = validateWorkList(targets)
  if (invalid !== undefined) return Promise.reject(new Error(`scheduler refused the work list: ${invalid}`))
  const remaining = new Map<string, number>()
  const dependents = new Map<string, Array<string>>()
  const ready: Array<string> = []
  for (const target of targets) {
    remaining.set(target.label, target.dependencies.length)
    if (target.dependencies.length === 0) ready.push(target.label)
    for (const dependency of target.dependencies) {
      const entry = dependents.get(dependency)
      if (entry === undefined) dependents.set(dependency, [target.label])
      else entry.push(target.label)
    }
  }
  return new Promise((done, fail) => {
    let active = 0
    let dispatched = 0
    let settled = false
    let failure: Error | undefined
    const abortFailure = (): Error => {
      const reason: unknown = signal?.reason
      return Diagnostic.error(reason, "execution aborted")
    }
    // A synchronous throw from `runOne` must join the ordinary rejection path:
    // thrown out of a completion handler it would reject nothing anyone
    // observes and leave the scheduler waiting forever.
    const dispatch = (label: string): Promise<void> => {
      try {
        return Promise.resolve(runOne(label))
      } catch (cause) {
        return Promise.reject(cause)
      }
    }
    const pump = (): void => {
      while (failure === undefined && active < jobs && ready.length > 0) {
        const label = ready.shift()!
        active += 1
        dispatched += 1
        dispatch(label).then(() => {
          active -= 1
          for (const dependent of dependents.get(label) ?? []) {
            const left = (remaining.get(dependent) ?? 1) - 1
            remaining.set(dependent, left)
            if (left === 0) ready.push(dependent)
          }
          pump()
        }, (cause: unknown) => {
          active -= 1
          // Keep the first fault: a later one is usually a consequence of it.
          failure ??= Diagnostic.error(cause, "scheduled target rejected")
          pump()
        })
      }
      if (settled || active > 0) return
      if (failure !== undefined) {
        settled = true
        signal?.removeEventListener("abort", onAbort)
        fail(failure)
        return
      }
      if (ready.length === 0) {
        settled = true
        signal?.removeEventListener("abort", onAbort)
        // Validation already proved every target becomes ready, so this only
        // ever resolves. The alternative branch stays as a backstop: a
        // scheduler that quietly resolved over undispatched work would report
        // a green summary for a run that dropped targets.
        if (dispatched === targets.length) done()
        else fail(new Error(`scheduler stalled after dispatching ${dispatched} of ${targets.length} targets`))
      }
    }
    const onAbort = (): void => {
      failure ??= abortFailure()
      pump()
    }
    if (signal?.aborted) failure = abortFailure()
    else signal?.addEventListener("abort", onAbort, { once: true })
    pump()
  })
}

/** Renders a failure value compactly for a status line. */
const describeFailure = (value: unknown): string => {
  if (typeof value === "object" && value !== null) {
    try {
      const cloned = cloneCacheJson(
        value,
        new Set(),
        { bytes: entryLimit - Diagnostic.maximumMessageCodeUnits, members: 0 },
        "failure",
        0
      )
      const encoded = JSON.stringify(cloned)
      if (encoded !== undefined && encoded !== "{}") return Diagnostic.message(encoded, "target failed")
    } catch {
      // Fall through to the generic renderings.
    }
  }
  return Diagnostic.message(value, "target failed")
}

/**
 * Encodes a flow result as a value that survives the JSON cache unchanged, or
 * explains why it cannot.
 *
 * The previous implementation ran `JSON.parse(JSON.stringify(value))` in a
 * `try` and cached `null` when it threw, so a result holding a cycle or a
 * bigint was stored as the JSON value `null` and every later run answered that
 * action with it. Even without a throw the round trip is lossy: `NaN` and
 * `Infinity` become `null`, an undefined object member disappears, a `Date`
 * becomes a string, and a `Map` becomes `{}`.
 *
 * Only the supported JSON domain is stored: null, booleans, finite numbers,
 * strings, plain-prototype objects, and dense arrays of the same. Anything else
 * leaves the target green and skips publication with a diagnostic, because a
 * result that cannot be recorded faithfully is not a result worth replaying.
 *
 * A top-level `undefined` is the one accepted non-JSON value: it is what a target
 * whose success schema is `Void` returns. An explicit tagged envelope records
 * it without confusing it with `null`. A nested `undefined` is refused,
 * because there `null`, an absent member, and `undefined` are distinct values.
 *
 * @category execution
 * @since 0.1.0
 */
const cacheUndefinedTag = "smithers-build/cache-output/undefined-v1"
const cacheValueTag = "smithers-build/cache-output/value-v1"
const maximumCacheOutputDepth = 256
const maximumCacheOutputMembers = 500_000

interface OutputBudget {
  bytes: number
  members: number
}

const spendOutputBudget = (budget: OutputBudget, bytes: number, path: string): void => {
  budget.bytes += bytes
  budget.members += 1
  if (budget.bytes > entryLimit) throw new Error(`${path} exceeds the ${entryLimit}-byte cache output limit`)
  if (budget.members > maximumCacheOutputMembers) {
    throw new Error(`${path} exceeds the ${maximumCacheOutputMembers}-member cache output limit`)
  }
}

/** Clones exactly the JSON value the cache will serialize, without invoking user code. */
const cloneCacheJson = (
  member: unknown,
  seen: Set<object>,
  budget: OutputBudget,
  path: string,
  depth: number
): unknown => {
  if (depth > maximumCacheOutputDepth) {
    throw new Error(`${path} exceeds the maximum cache output depth of ${maximumCacheOutputDepth}`)
  }
  if (member === null) {
    spendOutputBudget(budget, 4, path)
    return null
  }
  switch (typeof member) {
    case "boolean":
      spendOutputBudget(budget, member ? 4 : 5, path)
      return member
    case "string":
      spendOutputBudget(budget, Buffer.byteLength(member, "utf8") + 2, path)
      return member
    case "number":
      if (!Number.isFinite(member)) throw new Error(`${path} is the non-finite number ${String(member)}`)
      if (Object.is(member, -0)) throw new Error(`${path} is negative zero, which JSON would change to zero`)
      spendOutputBudget(budget, String(member).length, path)
      return member
    case "undefined":
      throw new Error(`${path} is undefined, which JSON cannot distinguish from an absent member`)
    case "bigint":
      throw new Error(`${path} is a bigint`)
    case "symbol":
      throw new Error(`${path} is a symbol`)
    case "function":
      throw new Error(`${path} is a function`)
    case "object":
      break
    default:
      throw new Error(`${path} is an unsupported ${typeof member} value`)
  }
  const object = member
  if (NodeUtil.isProxy(object)) throw new Error(`${path} is a Proxy`)
  if (seen.has(object)) throw new Error(`${path} closes a reference cycle`)
  const prototype = Object.getPrototypeOf(object)
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      if (prototype !== Array.prototype) throw new Error(`${path} is an array subclass instance`)
      const names = Object.getOwnPropertyNames(object)
      if (
        names.length !== object.length + 1 ||
        names.at(-1) !== "length" ||
        Object.getOwnPropertySymbols(object).length > 0
      ) {
        throw new Error(`${path} is a sparse array or carries extra own properties`)
      }
      spendOutputBudget(budget, 2, path)
      const encoded: Array<unknown> = []
      for (let index = 0; index < object.length; index += 1) {
        const childPath = `${path}[${index}]`
        if (names[index] !== String(index)) {
          throw new Error(`${path} is a sparse array or carries extra own properties`)
        }
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index))
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw new Error(`${childPath} is an accessor or non-enumerable property`)
        }
        encoded.push(cloneCacheJson(descriptor.value, seen, budget, childPath, depth + 1))
      }
      return encoded
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} is an object whose prototype is not a plain object`)
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new Error(`${path} carries symbol-keyed own properties`)
    }
    spendOutputBudget(budget, 2, path)
    const encoded = Object.create(null) as Record<string, unknown>
    for (const key of Object.getOwnPropertyNames(object).sort()) {
      const childPath = path === "" ? key : `${path}.${key}`
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new Error(`${childPath} is an accessor or non-enumerable property`)
      }
      spendOutputBudget(budget, Buffer.byteLength(key, "utf8") + 3, childPath)
      encoded[key] = cloneCacheJson(descriptor.value, seen, budget, childPath, depth + 1)
    }
    return encoded
  } finally {
    seen.delete(object)
  }
}

/**
 * Encodes one schema-level wire value in an unambiguous cache envelope.
 *
 * @category caching
 * @since 0.1.0
 * @slop
 */
export const encodeCacheOutput = (
  value: unknown
): { readonly output: unknown } | { readonly reason: string } => {
  if (value === undefined) return { output: { _tag: cacheUndefinedTag } }
  try {
    return {
      output: {
        _tag: cacheValueTag,
        value: cloneCacheJson(value, new Set(), { bytes: 0, members: 0 }, "result", 0)
      }
    }
  } catch (cause) {
    return { reason: describeFailure(cause) }
  }
}

/**
 * Decodes and revalidates the cache envelope without trusting its object shape.
 *
 * @category caching
 * @since 0.1.0
 * @slop
 */
export const decodeCacheOutput = (
  output: unknown
): { readonly value: unknown } | { readonly reason: string } => {
  try {
    if (typeof output !== "object" || output === null || NodeUtil.isProxy(output)) {
      throw new Error("cached output is not a plain envelope")
    }
    if (Object.getPrototypeOf(output) !== Object.prototype || Object.getOwnPropertySymbols(output).length > 0) {
      throw new Error("cached output is not a plain envelope")
    }
    const names = Object.getOwnPropertyNames(output).sort()
    const tagDescriptor = Object.getOwnPropertyDescriptor(output, "_tag")
    if (
      tagDescriptor === undefined ||
      !("value" in tagDescriptor) ||
      tagDescriptor.enumerable !== true ||
      typeof tagDescriptor.value !== "string"
    ) {
      throw new Error("cached output has no data tag")
    }
    if (tagDescriptor.value === cacheUndefinedTag) {
      if (names.length !== 1 || names[0] !== "_tag") throw new Error("cached undefined output has extra fields")
      return { value: undefined }
    }
    if (tagDescriptor.value !== cacheValueTag || names.length !== 2 || names[0] !== "_tag" || names[1] !== "value") {
      throw new Error("cached output has an unknown or malformed envelope")
    }
    const valueDescriptor = Object.getOwnPropertyDescriptor(output, "value")
    if (valueDescriptor === undefined || !("value" in valueDescriptor) || valueDescriptor.enumerable !== true) {
      throw new Error("cached output value is not a data property")
    }
    return {
      value: cloneCacheJson(valueDescriptor.value, new Set(), { bytes: 0, members: 0 }, "cached result", 0)
    }
  } catch (cause) {
    return { reason: describeFailure(cause) }
  }
}

/** Encodes a successful Flow value through its declared schema before storage. */
const encodeSuccess = (
  flow: Target.AnyTarget,
  value: unknown
): { readonly output: unknown } | { readonly reason: string } => {
  try {
    const validated = Target.metadata(flow).decodeSuccess(value)
    return encodeCacheOutput(validated)
  } catch (cause) {
    return { reason: `the success schema could not encode it: ${describeFailure(cause)}` }
  }
}

/** Reconstructs a successful Flow value only through the target's own schema. */
const decodeSuccess = (
  flow: Target.AnyTarget,
  output: unknown
): { readonly value: unknown } | { readonly reason: string } => {
  const decoded = decodeCacheOutput(output)
  if (!("value" in decoded)) return decoded
  try {
    return { value: Target.metadata(flow).decodeSuccess(decoded.value) }
  } catch (cause) {
    return { reason: `the success schema rejected it: ${describeFailure(cause)}` }
  }
}

/**
 * Checks one target's declared output tree against a manifest, or returns the
 * reason it does not hold.
 *
 * The declaration comes from target metadata, never from the value being checked,
 * so an untrusted entry cannot choose a shorter list of paths to be measured
 * against, and a producer cannot decide after the fact that it made fewer
 * outputs than it promised. Every declared path is re-measured with the same
 * `measureOutput` capture itself runs, so a stored entry is admitted only when
 * the tree still holds exactly what capture would record for it now, and a
 * fresh success is reported only when the tool really produced what the target
 * declared.
 */
const checkDeclaredOutputs = async (
  workspaceRoot: string,
  cacheDirectory: string,
  target: Planner.PlannedTarget,
  value: unknown,
  signal?: AbortSignal | undefined
): Promise<string | undefined> =>
  target.declaredOutputs === undefined
    ? undefined
    : verifyOutputs(workspaceRoot, target.declaredOutputs, value, { cacheDirectory, signal })

/**
 * Re-expands every declared input and compares it to the planned snapshot.
 *
 * Returns undefined when the snapshot still holds, and a diagnostic otherwise.
 * Paths and per-file digests are compared, not just the number of matches: a
 * glob that lost one file and gained another has the same length and a
 * different meaning.
 *
 * ## Boundary
 *
 * A file can always change in the window between the last comparison and the
 * syscall that acts on it. That final race is unavoidable without a filesystem
 * that can hand out a token for a version of a tree, which no portable API
 * does. What this closes is the whole plan-to-execution window, which is
 * seconds or minutes wide in a real run: the plan measured the tree once, and
 * everything after it — admitting a cache hit, running the tool, publishing
 * the result under the planned key — used to trust that one measurement.
 */
const revalidateInputs = async (
  workspace: Workspace,
  target: Planner.PlannedTarget
): Promise<string | undefined> => {
  if (target.declaredInputs.length === 0) return undefined
  let expanded: ReadonlyArray<ExpandedInput>
  try {
    expanded = await workspace.reexpandInputs(target.declaredInputs)
  } catch (cause) {
    return `declared inputs could not be revalidated: ${describeFailure(cause)}`
  }
  if (expanded.length !== target.declaredInputs.length) {
    return `declared inputs changed: ${target.declaredInputs.length} expanded to ${expanded.length}`
  }
  for (const [index, planned] of target.declaredInputs.entries()) {
    const now = expanded[index]!
    if (now.digest !== planned.digest) {
      return `declared input ${JSON.stringify(planned.declaration)} changed since the plan was made`
    }
    if (now.files.length !== planned.files.length) {
      return `declared input ${JSON.stringify(planned.declaration)} matches a different set of files`
    }
    for (const [position, file] of planned.files.entries()) {
      const observed = now.files[position]!
      if (observed.path !== file.path || observed.digest !== file.digest) {
        return `declared input file ${file.path} changed since the plan was made`
      }
    }
  }
  return undefined
}

/**
 * Replaces a filegroup's declarations with the planner-expanded transitive
 * file set. Paths are workspace anchored, so execution returns the same set
 * regardless of the BUILD.ts package that declared each nested group.
 */
const filegroupAttrs = (target: Planner.PlannedTarget): unknown => ({
  srcs: [
    ...new Set(
      target.declaredInputs.flatMap((input) => input.files.map((file) => file.path))
    )
  ].sort().map((path) => ({ _tag: "File" as const, path: `//${path}` })),
  cwd: "."
})

/**
 * Executes planned targets in dependency order with bounded parallelism.
 *
 * Before a cacheable target runs, its planner content key consults the
 * workspace cache; a stored green result reports `hit` and skips the run, and
 * a green run stores its result. A failed target reports `failed` and its
 * transitive dependents report `skipped`; everything else still executes. The
 * returned summary lists every target in plan order and `ok` is false when
 * any target failed.
 *
 * @category execution
 * @since 0.1.0
 * @slop
 */
export const execute = async (options: ExecuteOptions): Promise<Summary> => {
  const jobs = resolveJobs(options.jobs)
  const workspace = options.workspace
  const readCache = options.readCache ?? true
  const reporter = Reporter.of(options)
  const log = reporter.warn
  const startedAt = performance.now()
  const flows = await resolveFlows(workspace, options.targets)
  const store = await openCache({
    workspaceRoot: workspace.root,
    cacheDirectory: workspace.cacheDirectory,
    endpoint: options.remoteCache?.endpoint,
    token: options.remoteCache?.token,
    warn: log
  })
  const byLabel = new Map(options.targets.map((target) => [target.label, target]))
  const reports = new Map<string, TargetReport>()
  const notGreen = new Set<string>()

  const report = (entry: TargetReport): void => {
    reports.set(entry.label, entry)
    reporter.targetFinished(entry)
  }

  const runOne = async (label: string): Promise<void> => {
    const target = byLabel.get(label)!
    const started = performance.now()
    /** Fails one target: dependents are blocked and nothing is published. */
    const fail = (error: string): void => {
      notGreen.add(label)
      report({
        label,
        target: target.target,
        status: "failed",
        durationMs: performance.now() - started,
        key: target.keyPreview,
        error
      })
    }
    const blocked = target.dependencies.find((dependency) => notGreen.has(dependency))
    if (blocked !== undefined) {
      notGreen.add(label)
      report({
        label,
        target: target.target,
        status: "skipped",
        durationMs: 0,
        key: target.keyPreview,
        error: `dependency ${blocked} did not succeed`
      })
      return
    }
    reporter.targetStarted(label)
    const flow = flows.get(label)!
    if (readCache && target.cacheable) {
      const cached = await store.get(target.keyPreview).catch(() => null)
      // A decoded entry filed under the right key is not yet an answer for
      // this target: it must also name this target and this label. A store that
      // was hand edited, shared with another workspace, or answered by a
      // hostile remote can otherwise hand one action another action's result
      // under a key it forged.
      if (
        cached !== null &&
        cached.exitOk &&
        cached.target === target.target &&
        cached.label === label
      ) {
        const decoded = decodeSuccess(flow, cached.output)
        if ("value" in decoded) {
          const outputs = await checkDeclaredOutputs(
            workspace.root,
            workspace.cacheDirectory,
            target,
            decoded.value,
            options.signal
          )
          if (outputs === undefined) {
            // The tree was read to validate the outputs, which takes time, so
            // a change that landed during that read must not be reported as a
            // hit for the old key. One check does that. It compares against
            // the plan's own measurement rather than against an earlier
            // revalidation, so checking after the outputs were read proves
            // everything a check before them would have proved and proves it
            // of a later moment; and nothing ran here, so there is no
            // execution window for a second check to bracket.
            const admitted = await revalidateInputs(workspace, target)
            if (admitted !== undefined) return fail(admitted)
            report({
              label,
              target: target.target,
              status: "hit",
              durationMs: performance.now() - started,
              key: target.keyPreview
            })
            return
          }
        }
      }
    }
    // Nothing answered from cache, so this target is about to run. The plan
    // measured its inputs once, and everything downstream of that measurement
    // — the key this result is published under — is only sound while the
    // measurement still holds, so it is taken again here rather than assumed.
    const beforeRun = await revalidateInputs(workspace, target)
    if (beforeRun !== undefined) return fail(beforeRun)
    const exit = await runTarget(
      workspace.root,
      workspace.cacheDirectory,
      flow,
      isFilegroup(flow) ? filegroupAttrs(target) : target.attrs,
      `smithers-build-target-${target.keyPreview.slice(0, 24)}`,
      options.remoteCache === undefined ? [] : [options.remoteCache.tokenEnv],
      options.packageName,
      options.signal
    )
    if (!Exit.isSuccess(exit)) return fail(describeFailure(Cause.squash(exit.cause)))
    // A success is not a success until the target's declared outputs are on
    // disk and match what it reported. An implementation that returns without
    // its manifest fails here rather than caching green.
    const produced = await checkDeclaredOutputs(
      workspace.root,
      workspace.cacheDirectory,
      target,
      exit.value,
      options.signal
    )
    if (produced !== undefined) return fail(produced)
    // PackageJsonWrite deliberately reads and then replaces package.json so it
    // can preserve manager-owned dependency fields. Its pre-run snapshot still
    // closes the plan-to-execution race; requiring that input to remain equal
    // after the action would reject every successful write by definition.
    const afterRun = target.target === "PackageJsonWrite" ? undefined : await revalidateInputs(workspace, target)
    if (afterRun !== undefined) return fail(afterRun)
    report({
      label,
      target: target.target,
      status: "ran",
      durationMs: performance.now() - started,
      key: target.keyPreview
    })
    if (!target.cacheable) return
    const encoded = encodeSuccess(flow, exit.value)
    if (!("output" in encoded)) {
      log(`smthrs: skipped the cache store for ${label} because its result does not round trip: ${encoded.reason}`)
      return
    }
    await store.put(target.keyPreview, {
      key: target.keyPreview,
      target: target.target,
      label,
      exitOk: true,
      output: encoded.output,
      storedAt: new Date().toISOString()
    }).catch((cause: unknown) => {
      log(`smthrs: could not store ${label} in the cache: ${describeFailure(cause)}`)
    })
  }

  reporter.begin({
    verb: options.verb,
    pattern: options.pattern,
    jobs,
    targets: options.targets.map((target) => ({ label: target.label, target: target.target }))
  })
  try {
    await schedule(options.targets, jobs, runOne, options.signal)
  } finally {
    await store.close().catch(() => undefined)
  }

  const results = options.targets
    .map((target) => reports.get(target.label))
    .filter((entry): entry is TargetReport => entry !== undefined)
  const counts: StatusCounts = {
    hit: results.filter((entry) => entry.status === "hit").length,
    ran: results.filter((entry) => entry.status === "ran").length,
    failed: results.filter((entry) => entry.status === "failed").length,
    skipped: results.filter((entry) => entry.status === "skipped").length
  }
  const durationMs = performance.now() - startedAt
  const summary: Summary = {
    verb: options.verb,
    pattern: options.pattern,
    jobs,
    durationMs,
    counts,
    ok: counts.failed === 0,
    results
  }
  reporter.summary(summary)
  return summary
}
