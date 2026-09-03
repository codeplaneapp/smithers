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
import * as SchemaIssue from "effect/SchemaIssue"
import * as Os from "node:os"
import * as NodeUtil from "node:util/types"
import { entryLimit } from "./Cache.ts"
import * as Diagnostic from "./Diagnostic.ts"
import { byCodeUnit } from "./internal/Text.ts"
import type * as Planner from "./Planner.ts"

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

/** Effect's own rendering of a schema issue tree, built once. */
const formatSchemaIssue = SchemaIssue.makeFormatterDefault()

/**
 * Renders a failure value compactly for a status line.
 *
 * @category diagnostics
 * @since 0.1.0
 */
export const describeFailure = (value: unknown): string => {
  if (typeof value === "object" && value !== null && !NodeUtil.isProxy(value)) {
    // A schema refusal reaches here as the bare issue tree as often as it
    // reaches here wrapped in a SchemaError, and the tree carries no `message`
    // of any kind. Effect's own formatter is what turns it back into the
    // sentence naming the path and the expectation.
    try {
      if (SchemaIssue.isIssue(value)) return Diagnostic.message(formatSchemaIssue(value), "target failed")
    } catch {
      // Fall through to the generic renderings.
    }
  }
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
  // Every Error reaches this line: the clone above refuses any prototype that
  // is not a plain object. `Diagnostic.describe` is what makes the reason
  // survive that refusal, including for the Effect errors whose message is a
  // prototype accessor.
  return Diagnostic.describe(value, "target failed")
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
