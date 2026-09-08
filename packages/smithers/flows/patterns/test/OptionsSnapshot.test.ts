import { describe, it } from "@effect/vitest"
import { Effects, Flow, Graph, Node } from "@smthrs/core"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { expect } from "vitest"
import * as Bounded from "../src/Bounded.ts"
import * as CheckSuite from "../src/CheckSuite.ts"
import * as Debate from "../src/Debate.ts"
import * as DelegationChain from "../src/DelegationChain.ts"
import * as DriftDetector from "../src/DriftDetector.ts"
import * as Escalation from "../src/Escalation.ts"
import * as Intervene from "../src/Intervene.ts"
import * as Loop from "../src/Loop.ts"
import * as MapReduce from "../src/MapReduce.ts"
import * as Optimizer from "../src/Optimizer.ts"
import * as Panel from "../src/Panel.ts"
import * as Quarantine from "../src/Quarantine.ts"
import * as Recursion from "../src/Recursion.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"
import * as Runbook from "../src/Runbook.ts"
import * as ScanFixVerify from "../src/ScanFixVerify.ts"
import * as Sidecar from "../src/Sidecar.ts"
import * as Trellis from "../src/Trellis.ts"
import * as TryCatchFinally from "../src/TryCatchFinally.ts"
import * as WithApproval from "../src/WithApproval.ts"
import * as WithCache from "../src/WithCache.ts"
import * as WithRetry from "../src/WithRetry.ts"

// Two flows a plan can tell apart: a flow's name and capabilities enter the
// key material of every call to it, so a swapped collaborator is a changed
// graph whenever the swap reaches the declaration.
const flowNamed = (name: string): Flow.Any =>
  Flow.make({
    name,
    capabilities: [name],
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: (input) => Node.succeed(input)
  })

const step = flowNamed("step")
const other = flowNamed("other")

const approving = (name: string): Flow.Any =>
  Flow.make({
    name,
    input: Schema.Unknown,
    output: WithApproval.Approved,
    body: () => Node.dynamic({ output: WithApproval.Approved })
  })

const sealed = (name: string): Flow.Any =>
  Flow.make({
    name,
    input: Schema.Unknown,
    output: Schema.Unknown,
    effects: Effects.make({ reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }),
    body: () => Node.dynamic({ output: Schema.Unknown })
  })

// Every node's kind and key material except a body's `implementation`: core
// still digests a body per instance (see WithRetry.test.ts), so a wrapper a
// pattern builds inside `make`, such as a gated Runbook step, can never match
// that one field across two calls.
const shape = (flow: Flow.Any, input: unknown): unknown =>
  JSON.parse(
    JSON.stringify(
      Graph.nodes(Graph.build(flow, input)).map((node) => [node.kind, node.keyMaterial.body]),
      (key, value: unknown) => key === "implementation" ? undefined : value
    )
  )

const annotationsOf = (flow: Flow.Any): Context.Context<never> =>
  (flow as unknown as { readonly annotations: Context.Context<never> }).annotations

interface Declaration {
  readonly name: string
  readonly input: unknown
  /** Builds the declaration from fresh options and hands back the edit to make afterwards. */
  readonly declare: () => { readonly flow: Flow.Any; readonly mutate: () => void }
  /** The declaration built from fresh options. */
  readonly fresh: () => Flow.Any
  /** The declaration built from options that already carry the edit. */
  readonly edited: () => Flow.Any
}

const declared = <O>(
  name: string,
  input: unknown,
  options: () => O,
  make: (options: O) => Flow.Any,
  mutate: (options: O) => void
): Declaration => ({
  name,
  input,
  declare: () => {
    const live = options()
    return { flow: make(live), mutate: () => mutate(live) }
  },
  fresh: () => make(options()),
  edited: () => {
    const live = options()
    mutate(live)
    return make(live)
  }
})

const tree = { input: "root", children: [{ input: "left" }, { input: "right" }] }

// Every edit a caller can make after `make` returned: swapped collaborator
// flows, re-pointed nested records, widened or narrowed bounds, and changed
// policies. Each case's edit is one the declaration reacts to, which the test
// proves by building the edited options fresh.
const declarations: ReadonlyArray<Declaration> = [
  declared(
    "Debate.make",
    "topic",
    () => ({ proponent: step, opponent: step, judge: step, rounds: 1 }),
    (options) => Debate.make(options),
    (options) => {
      options.proponent = other
      options.opponent = other
      options.judge = other
      options.rounds = 2
    }
  ),
  declared(
    "Panel.make",
    "question",
    () => ({
      panelists: { a: step, b: step } as Record<string, Flow.Any>,
      moderator: step,
      roles: { a: "critic" } as Record<string, string>,
      concurrency: 1
    }),
    (options) => Panel.make(options),
    (options) => {
      options.panelists.a = other
      options.panelists.c = other
      options.moderator = other
      options.roles.a = "fan"
      options.roles.b = "judge"
      options.concurrency = 2
    }
  ),
  declared(
    "Escalation.make",
    "request",
    () => ({
      rungs: [{ flow: step, escalateIf: step }, step] as Array<{ flow: Flow.Any; escalateIf: Flow.Any } | Flow.Any>,
      accept: step,
      fallback: step
    }),
    (options) => Escalation.make(options),
    (options) => {
      const first = options.rungs[0] as { flow: Flow.Any; escalateIf: Flow.Any }
      first.flow = other
      first.escalateIf = other
      options.rungs.push(other)
      options.accept = other
      options.fallback = other
    }
  ),
  declared(
    "ReviewLoop.make",
    "draft",
    () => ({ produce: step, review: step, revise: step, maxRounds: 1 }),
    (options) => ReviewLoop.make(options),
    (options) => {
      options.produce = other
      options.review = other
      options.revise = other
      options.maxRounds = 2
    }
  ),
  declared(
    "MapReduce.make",
    { shards: ["a", "b"] },
    () => ({ map: step, reduce: step, concurrency: 1, onEmpty: "reduce" as MapReduce.OnEmpty }),
    (options) => MapReduce.make(options),
    (options) => {
      options.map = other
      options.reduce = other
      options.concurrency = 2
      options.onEmpty = "succeed"
    }
  ),
  declared(
    "Recursion.recurse",
    tree,
    () => ({ child: step, fuel: 4, depth: 2, fanout: 2 }),
    (options) => Recursion.recurse(options),
    (options) => {
      options.child = other
      options.fuel = 8
      options.depth = 3
      options.fanout = 3
    }
  ),
  declared(
    "TryCatchFinally.make",
    "job",
    () => ({ try: step, catch: step, finally: step }),
    (options) => TryCatchFinally.make(options),
    (options) => {
      options.try = other
      options.catch = other
      options.finally = other
    }
  ),
  declared(
    "Loop.make",
    "seed",
    () => ({
      body: step,
      until: step,
      maxIterations: 1,
      onMaxReached: "return-last" as Loop.OnMaxReached,
      captures: { threshold: 1 } as Record<string, unknown>
    }),
    (options) => Loop.make(options),
    (options) => {
      options.body = other
      options.until = other
      options.maxIterations = 2
      options.onMaxReached = "fail"
      options.captures.threshold = 2
    }
  ),
  declared(
    "Optimizer.make",
    "seed",
    () => ({
      generate: step,
      evaluate: step,
      targetScore: 1,
      maxIterations: 1,
      onMaxReached: "return-last" as Optimizer.OnMaxReached
    }),
    (options) => Optimizer.make(options),
    (options) => {
      options.generate = other
      options.evaluate = other
      options.targetScore = 2
      options.maxIterations = 2
    }
  ),
  declared(
    "ScanFixVerify.make",
    "tree",
    () => ({ scan: step, fix: step, verify: step, maxRetries: 1, maxIssues: 1, concurrency: 1 }),
    (options) => ScanFixVerify.make(options),
    (options) => {
      options.scan = other
      options.fix = other
      options.verify = other
      options.maxRetries = 2
      options.maxIssues = 2
      options.concurrency = 2
    }
  ),
  declared(
    "DriftDetector.make",
    { target: "config" },
    () => ({ capture: step, compare: step, alert: step, baseline: { checksum: "a" } as unknown }),
    (options) => DriftDetector.make(options),
    (options) => {
      options.capture = other
      options.compare = other
      options.alert = other
      options.baseline = { checksum: "b" }
    }
  ),
  declared(
    "Sidecar.make",
    "question",
    () => ({ primary: step, shadow: step, score: step }),
    (options) => Sidecar.make(options),
    (options) => {
      options.primary = other
      options.shadow = other
      options.score = other
    }
  ),
  declared(
    "Intervene.make",
    "target",
    () => ({
      read: step,
      propose: step,
      apply: step,
      report: step,
      dryRun: false,
      approval: approving("gate"),
      reason: "apply the fix"
    }),
    (options) => Intervene.make(options),
    (options) => {
      options.read = other
      options.propose = other
      options.apply = other
      options.report = other
      options.dryRun = true
      options.approval = approving("other-gate")
      options.reason = "apply something else"
    }
  ),
  declared(
    "CheckSuite.make",
    "tree",
    () => ({
      checks: { lint: step } as Record<string, Flow.Any>,
      strategy: "all-pass" as CheckSuite.Strategy,
      concurrency: 1,
      continueOnFail: false
    }),
    (options) => CheckSuite.make(options),
    (options) => {
      options.checks.lint = other
      options.checks.test = other
      options.strategy = "any-pass"
      options.concurrency = 2
      options.continueOnFail = true
    }
  ),
  declared(
    "Runbook.make",
    "target",
    () => ({
      steps: [
        { id: "backup", flow: step, risk: "safe" as Runbook.Risk },
        { id: "deploy", flow: step, risk: "risky" as Runbook.Risk }
      ],
      approval: approving("gate"),
      onDeny: "fail" as Runbook.OnDeny,
      reason: "run the step"
    }),
    (options) => Runbook.make(options),
    (options) => {
      options.steps[0]!.id = "renamed"
      options.steps[0]!.risk = "critical"
      options.steps[0]!.flow = other
      options.steps.push({ id: "late", flow: other, risk: "safe" })
      options.approval = approving("other-gate")
      options.reason = "run something else"
    }
  ),
  declared(
    "Trellis.make",
    "prompt",
    () => ({ author: step, leaf: step, envelope: { fuel: 2, depth: 2, fanout: 2 } }),
    (options) => Trellis.make(options),
    (options) => {
      options.author = other
      options.leaf = other
      options.envelope.fuel = 3
    }
  ),
  declared(
    "DelegationChain.make",
    "prompt",
    () => ({
      refine: step,
      plan: step,
      derisk: step,
      execute: { weak: step, strong: step } as Record<string, Flow.Any>,
      review: step,
      settle: step,
      tierOrder: ["weak", "strong"],
      maxDepth: 1,
      maxDeriskRounds: 1,
      maxAttempts: 1,
      budget: { maxUsd: 5 } as { maxUsd?: number | undefined }
    }),
    (options) => DelegationChain.make(options),
    (options) => {
      options.refine = other
      options.plan = other
      options.derisk = other
      options.execute.weak = other
      options.review = other
      options.settle = other
      options.tierOrder.reverse()
      options.maxDepth = 2
      options.maxDeriskRounds = 2
      options.maxAttempts = 2
      options.budget.maxUsd = 9
    }
  )
]

const recorder = () => {
  const trace: Array<string> = []
  const record = (label: string) => () =>
    Effect.sync(() => {
      trace.push(label)
      return label
    })
  return { trace, record }
}

describe("options are snapshotted at the call", () => {
  for (const entry of declarations) {
    it(`${entry.name} declares from the snapshot it took of its options`, () => {
      const { flow, mutate } = entry.declare()
      const before = shape(flow, entry.input)
      mutate()

      expect(shape(flow, entry.input)).toEqual(before)
      expect(before).toEqual(shape(entry.fresh(), entry.input))
      // The edit is one the declaration reacts to, so the equality above is
      // not vacuous.
      expect(shape(entry.edited(), entry.input)).not.toEqual(before)
    })
  }

  it("WithRetry.make snapshots its options before the decorator is applied", () => {
    const options = { attempts: 2, backoff: { initialMs: 10, factor: 2, maxMs: 100 }, nonRetryable: ["Boom"] }
    const decorator = WithRetry.make(options)
    options.attempts = 5
    options.backoff.maxMs = 1000
    options.nonRetryable.push("Other")

    const inner = sealed("search")
    const decorated = decorator(inner)
    const reference = WithRetry.make({
      attempts: 2,
      backoff: { initialMs: 10, factor: 2, maxMs: 100 },
      nonRetryable: ["Boom"]
    })(inner)
    expect((decorated as { readonly name?: string }).name).toBe(
      "withRetry(search, attempts=2, backoff=10x2<=100, nonRetryable=Boom)"
    )
    expect(shape(decorated, "query")).toEqual(shape(reference, "query"))
    // The edit is one the decorator reacts to, so the label above is not
    // vacuous.
    expect((WithRetry.make(options)(inner) as { readonly name?: string }).name).toBe(
      "withRetry(search, attempts=5, backoff=10x2<=1000, nonRetryable=Boom|Other)"
    )
  })

  it("WithRetry.retryEffect waits the backoff it was called with", () =>
    Effect.gen(function*() {
      let attempts = 0
      const backoff = { initialMs: 100, factor: 2, maxMs: 250 }
      const retried = WithRetry.retryEffect(
        Effect.suspend(() => {
          attempts = attempts + 1
          return Effect.fail("retry")
        }),
        { attempts: 3, backoff }
      )
      // Cap the ladder below its first rung after the call. A ladder that
      // read the cap live would wait one millisecond instead of a hundred.
      backoff.maxMs = 1
      backoff.initialMs = 1
      const fiber = yield* retried.pipe(Effect.forkChild({ startImmediately: true }))

      expect(attempts).toBe(1)
      yield* TestClock.adjust("99 millis")
      expect(attempts).toBe(1)
      yield* TestClock.adjust("1 millis")
      expect(attempts).toBe(2)
      yield* TestClock.adjust("199 millis")
      expect(attempts).toBe(2)
      yield* TestClock.adjust("1 millis")
      expect(attempts).toBe(3)

      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise))

  it("WithCache.make snapshots its policy before the decorator is applied", () => {
    const options = { ttlMs: 1000, scope: "run" as WithCache.Scope, version: "v1" }
    const decorator = WithCache.make(options)
    options.ttlMs = 5
    options.scope = "flow"
    options.version = "v2"

    const decorated = decorator(sealed("read"))
    expect((decorated as { readonly name?: string }).name).toBe("withCache(read, ttlMs=1000, scope=run, version=v1)")
    expect(WithCache.policyOf(annotationsOf(decorated))).toEqual({ ttlMs: 1000, scope: "run" })
  })

  it("WithApproval.make snapshots its options before the decorator is applied", () => {
    const options = { reason: "publish", approval: approving("gate") }
    const decorator = WithApproval.make(options)
    options.reason = "something else"
    options.approval = approving("other-gate")

    const inner = flowNamed("publish")
    const decorated = decorator(inner)
    const reference = WithApproval.make({ reason: "publish", approval: approving("gate") })(inner)
    expect(shape(decorated, "release")).toEqual(shape(reference, "release"))
    expect(shape(decorated, "release")).not.toEqual(shape(WithApproval.make(options)(inner), "release"))
  })

  it.effect("Bounded.run runs the members and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const members: Record<string, Effect.Effect<string>> = { a: record("a")() }
      const options = { concurrency: 1, priority: 1, priorities: { a: 2 } as Record<string, number> }
      const running = Bounded.run(members, options)

      members.a = record("swapped")()
      members.late = record("late")()
      options.concurrency = 0
      options.priorities.late = 5

      expect(yield* running).toEqual({ a: "a" })
      expect(trace).toEqual(["a"])
    }))

  it.effect("Quarantine.run runs the members and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const members: Record<string, Effect.Effect<string>> = { a: record("a")() }
      const options = { policy: "quarantine" as const, concurrency: 1 }
      const running = Quarantine.run(members, options)

      members.a = record("swapped")()
      members.late = record("late")()
      ;(options as { policy: Quarantine.Policy }).policy = "halt"
      options.concurrency = 0

      expect(yield* running).toEqual({ a: { _tag: "Succeeded", member: "a", value: "a" } })
      expect(trace).toEqual(["a"])
    }))

  it.effect("Panel.run runs the panelists and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const panelists: Record<string, (input: string) => Effect.Effect<string>> = { a: record("a") }
      const options = {
        panelists,
        moderator: (args: { readonly input: string; readonly opinions: Readonly<Record<string, string>> }) =>
          Effect.sync(() => {
            trace.push("moderate")
            return args.opinions
          }),
        concurrency: 1
      }
      const running = Panel.run("question", options)

      panelists.a = record("swapped")
      panelists.late = record("late")
      options.moderator = () =>
        Effect.sync(() => {
          trace.push("swapped moderator")
          return {}
        })
      options.concurrency = 0

      expect(yield* running).toEqual({ a: "a" })
      expect(trace).toEqual(["a", "moderate"])
    }))

  it.effect("Debate.run runs the participants and rounds it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        rounds: 1,
        proponent: record("proponent"),
        opponent: record("opponent"),
        judge: record("judge")
      }
      const running = Debate.run("topic", options)

      options.rounds = 3
      options.proponent = record("swapped proponent")
      options.opponent = record("swapped opponent")
      options.judge = record("swapped judge")

      expect(yield* running).toBe("judge")
      expect(trace).toEqual(["proponent", "opponent", "judge"])
    }))

  it.effect("Escalation.run runs the rungs and deciders it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const rung = { run: record("rung"), escalateIf: () => Effect.succeed(false) }
      const options = {
        rungs: [rung] as Array<typeof rung>,
        accept: () => Effect.succeed(true),
        fallback: record("fallback")
      }
      const running = Escalation.run("job", options)

      rung.run = record("swapped rung")
      rung.escalateIf = () => Effect.succeed(true)
      options.rungs.push({ run: record("late"), escalateIf: () => Effect.succeed(false) })
      options.accept = () => Effect.succeed(false)
      options.fallback = record("swapped fallback")

      expect(yield* running).toEqual({ level: 0, result: "rung" })
      expect(trace).toEqual(["rung"])
    }))

  it.effect("ReviewLoop.run runs the callbacks and bound it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        produce: record("produce"),
        review: () => Effect.succeed(true),
        revise: record("revise"),
        maxRounds: 1
      }
      const running = ReviewLoop.run("draft", options)

      options.produce = record("swapped produce")
      options.review = () => Effect.succeed(false)
      options.revise = record("swapped revise")
      options.maxRounds = 3

      expect(yield* running).toBe("produce")
      expect(trace).toEqual(["produce"])
    }))

  it.effect("MapReduce.run runs the shards and callbacks it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const input = { shards: ["a"] as Array<string> }
      const options = {
        map: ({ shard }: { readonly shard: string }) =>
          Effect.sync(() => {
            trace.push(`map ${shard}`)
            return shard
          }),
        reduce: ({ mapped }: { readonly mapped: ReadonlyArray<string> }) =>
          Effect.sync(() => {
            trace.push("reduce")
            return mapped
          }),
        concurrency: 1,
        onEmpty: "reduce" as MapReduce.OnEmpty
      }
      const running = MapReduce.run(input, options)

      input.shards.push("b")
      options.map = record("swapped map")
      options.reduce = () => Effect.sync(() => (trace.push("swapped reduce"), []))
      options.concurrency = 0
      options.onEmpty = "fail"

      expect(yield* running).toEqual(["a"])
      expect(trace).toEqual(["map a", "reduce"])
    }))

  it.effect("TryCatchFinally.run runs the arms it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        try: record("try"),
        catch: record("catch"),
        catchErrors: () => true,
        finally: record("finally")
      }
      const running = TryCatchFinally.run("job", options)

      options.try = record("swapped try")
      options.catch = record("swapped catch")
      options.catchErrors = () => false
      options.finally = record("swapped finally")

      expect(yield* running).toBe("try")
      expect(trace).toEqual(["try", "finally"])
    }))

  it.effect("Loop.run runs the body, predicate, and bound it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        body: record("body"),
        until: () => Effect.succeed(true),
        maxIterations: 1,
        onMaxReached: "return-last" as Loop.OnMaxReached
      }
      const running = Loop.run("seed", options)

      options.body = record("swapped body")
      options.until = () => Effect.succeed(false)
      options.maxIterations = 3
      options.onMaxReached = "fail"

      expect(yield* running).toEqual({ value: "body", iterations: 1, exhausted: false })
      expect(trace).toEqual(["body"])
    }))

  it.effect("Optimizer.run runs the callbacks and bounds it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        generate: record("generate"),
        evaluate: () => Effect.succeed({ score: 1 }),
        targetScore: 1,
        maxIterations: 1,
        onMaxReached: "return-last" as Optimizer.OnMaxReached
      }
      const running = Optimizer.run("seed", options)

      options.generate = record("swapped generate")
      options.evaluate = () => Effect.succeed({ score: 0 })
      options.targetScore = 5
      options.maxIterations = 3
      options.onMaxReached = "fail"

      expect(yield* running).toEqual({
        best: { candidate: "generate", score: 1, feedback: undefined, iteration: 1 },
        iterations: 1,
        converged: true
      })
      expect(trace).toEqual(["generate"])
    }))

  it.effect("ScanFixVerify.run runs the callbacks and bounds it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        scan: ({ iteration }: { readonly iteration: number }) =>
          Effect.sync(() => {
            trace.push(`scan ${iteration}`)
            return iteration === 1 ? ["issue"] : []
          }),
        fix: record("fix"),
        verify: record("verify"),
        maxRetries: 2,
        concurrency: 1
      }
      const running = ScanFixVerify.run("tree", options)

      options.scan = () => Effect.sync(() => (trace.push("swapped scan"), ["x", "y"]))
      options.fix = record("swapped fix")
      options.verify = record("swapped verify")
      options.maxRetries = 5
      options.concurrency = 0

      expect(yield* running).toEqual({ iterations: 2, remaining: [], resolved: true, verifications: ["verify"] })
      expect(trace).toEqual(["scan 1", "fix", "verify", "scan 2"])
    }))

  it.effect("DriftDetector.run runs the callbacks and baseline it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        baseline: "a",
        capture: record("capture"),
        compare: () => Effect.succeed(true),
        alertIf: undefined as ((comparison: boolean) => boolean) | undefined,
        alert: record("alert")
      }
      const running = DriftDetector.run("config", options)

      options.baseline = "b"
      options.capture = record("swapped capture")
      options.compare = () => Effect.succeed(false)
      options.alertIf = () => false
      options.alert = record("swapped alert")

      expect(yield* running).toEqual({ snapshot: "capture", comparison: true, drifted: true, alert: "alert" })
      expect(trace).toEqual(["capture", "alert"])
    }))

  it.effect("Sidecar.run runs the primary, shadow, and scorer it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        primary: record("primary"),
        shadow: record("shadow"),
        score: () => Effect.succeed({ primary: 1, shadow: 1 })
      }
      const running = Sidecar.run("question", options)

      options.primary = record("swapped primary")
      options.shadow = record("swapped shadow")
      options.score = () => Effect.succeed({ primary: 0, shadow: 5 })

      expect(yield* running).toEqual({
        primary: "primary",
        shadow: { quarantined: false, value: "shadow" },
        delta: { primary: 1, shadow: 1, difference: 0, cheaperWins: true }
      })
      expect([...trace].sort()).toEqual(["primary", "shadow"])
    }))

  it.effect("CheckSuite.run runs the checks and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const checks: Record<string, (input: string) => Effect.Effect<string>> = { lint: record("lint") }
      const options = { checks, strategy: "all-pass" as CheckSuite.Strategy, concurrency: 1, continueOnFail: false }
      const running = CheckSuite.run("tree", options)

      checks.lint = record("swapped lint")
      checks.late = record("late")
      options.strategy = "any-pass"
      options.concurrency = 0
      options.continueOnFail = true

      expect(yield* running).toEqual({ passed: ["lint"], failed: [], errors: {}, strategy: "all-pass", verdict: true })
      expect(trace).toEqual(["lint"])
    }))

  it.effect("Intervene.run runs the callbacks and mode it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        read: record("read"),
        propose: record("propose"),
        apply: record("apply"),
        report: ({ applied, dryRun }: { readonly applied: string | undefined; readonly dryRun: boolean }) =>
          Effect.sync(() => {
            trace.push("report")
            return { applied, dryRun }
          }),
        dryRun: false,
        approval: () => Effect.succeed("approved")
      }
      const running = Intervene.run("target", options)

      options.read = record("swapped read")
      options.propose = record("swapped propose")
      options.apply = record("swapped apply")
      options.report = () => Effect.sync(() => (trace.push("swapped report"), { applied: undefined, dryRun: true }))
      options.dryRun = true
      options.approval = () => Effect.succeed("denied")

      expect(yield* running).toEqual({ applied: "apply", dryRun: false })
      expect(trace).toEqual(["read", "propose", "apply", "report"])
    }))

  it.effect("Runbook.run runs the steps and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const steps: Array<{ id: string; risk: Runbook.Risk; run: () => Effect.Effect<string> }> = [
        { id: "a", risk: "safe", run: record("a") }
      ]
      const options = { steps, approve: () => Effect.succeed("approved"), onDeny: "fail" as Runbook.OnDeny }
      const running = Runbook.run("target", options)

      steps[0]!.id = "renamed"
      steps[0]!.risk = "critical"
      steps[0]!.run = record("swapped")
      steps.push({ id: "late", risk: "safe", run: record("late") })
      options.approve = () => Effect.succeed("denied")
      options.onDeny = "skip"

      expect(yield* running).toEqual({ outputs: { a: "a" }, ran: ["a"], skipped: [] })
      expect(trace).toEqual(["a"])
    }))

  it.effect("Trellis.run runs the callbacks and envelope it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const options = {
        author: () =>
          Effect.sync(() => {
            trace.push("author")
            return { agent: { goal: "goal" } }
          }),
        leaf: record("leaf"),
        envelope: { fuel: 1, depth: 1, fanout: 1 },
        concurrency: 1,
        continue: undefined as (() => Effect.Effect<unknown>) | undefined
      }
      const running = Trellis.run("prompt", options)

      options.author = () => Effect.sync(() => (trace.push("swapped author"), { agent: { goal: "swapped" } }))
      options.leaf = record("swapped leaf")
      options.envelope.fuel = 0
      options.concurrency = 0
      options.continue = () => Effect.succeed({ agent: { goal: "again" } })

      expect(yield* running).toEqual({ rounds: [{ plan: { agent: { goal: "goal" } }, result: "leaf" }], remaining: 0 })
      expect(trace).toEqual(["author", "leaf"])
    }))

  it.effect("Trellis.execute runs the plan and options it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const plan: { sequence: [Trellis.Plan, ...Array<Trellis.Plan>] } = { sequence: [{ agent: { goal: "a" } }] }
      const options = { leaf: record("leaf"), concurrency: 1 }
      const running = Trellis.execute(plan, options)

      plan.sequence.push({ agent: { goal: "late" } })
      options.leaf = record("swapped leaf")
      options.concurrency = 0

      expect(yield* running).toEqual(["leaf"])
      expect(trace).toEqual(["leaf"])
    }))

  it.effect("DelegationChain.run runs the callbacks and bounds it was called with", () =>
    Effect.gen(function*() {
      const { trace, record } = recorder()
      const execute: Record<string, (work: DelegationChain.Work) => Effect.Effect<string>> = {
        weak: (work) =>
          Effect.sync(() => {
            trace.push(`weak ${work.budget?.maxUsd}`)
            return "weak"
          })
      }
      const options = {
        refine: record("refine"),
        plan: () =>
          Effect.sync(() => {
            trace.push("plan")
            return { agent: { goal: "goal" } }
          }),
        derisk: () =>
          Effect.sync(() => {
            trace.push("derisk")
            return true
          }),
        execute,
        review: ({ stage }: { readonly stage: string }) =>
          Effect.sync(() => {
            trace.push(`review ${stage}`)
            return true
          }),
        settle: (settlement: DelegationChain.Settlement) =>
          Effect.sync(() => {
            trace.push("settle")
            return settlement.leaves
          }),
        tierOrder: ["weak"],
        maxDepth: 1,
        maxDeriskRounds: 1,
        maxAttempts: 1,
        budget: { maxUsd: 1 } as { maxUsd?: number | undefined },
        concurrency: 1
      }
      const running = DelegationChain.run("prompt", options)

      options.refine = record("swapped refine")
      options.plan = () => Effect.sync(() => (trace.push("swapped plan"), { agent: { goal: "swapped" } }))
      options.derisk = () => Effect.sync(() => (trace.push("swapped derisk"), false))
      execute.weak = record("swapped weak")
      options.review = () => Effect.sync(() => (trace.push("swapped review"), false))
      options.settle = () => Effect.sync(() => (trace.push("swapped settle"), []))
      options.tierOrder[0] = "missing"
      options.maxDepth = 0
      options.maxDeriskRounds = 0
      options.maxAttempts = 0
      options.budget.maxUsd = 9
      options.concurrency = 0

      expect(yield* running).toEqual(["weak"])
      expect(trace).toEqual(["refine", "plan", "derisk", "weak 1", "review leaf", "review chain", "settle"])
    }))
})
