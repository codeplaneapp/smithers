import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Action } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { Cause, Effect, Exit, Layer } from "effect"
import { EarlyFeedback, ObservePlan, feedbackLayers } from "../coding/feedback.ts"
import { Implement, RunCheck, policyLayers } from "../coding/workflow.ts"
import { checkInputDigest, type Implementation, type Plan, type Revision, type Receipt } from "../coding/schema.ts"

const revision = (name: string, parent?: string): Revision => ({ changeId: `jj-${name}`, commitId: `commit-${name}`, treeId: `tree-${name}`, operationId: `op-${name}`, parentCommitIds: parent ? [`commit-${parent}`] : [] })
const plan: Plan = { prompt: "Observe actionable feedback", memoryRevision: "fixture", base: revision("base"), changes: ["prefix", "owner", "tip"].map(id => ({
  id, title: id, intent: id, implementation: "implementation", implementationDigest: "0".repeat(64),
  atoms: [{ changeId: null, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [`${id}.txt`] }],
  checks: ["fast", "slow"].map(tier => ({ id: tier, target: tier, flow: tier, flowDigest: "0".repeat(64), tier: tier as "fast" | "slow", required: true }))
})) }
const implementation = (index: number, parent: Revision): Implementation => {
  const change = plan.changes[index]!, head = revision(change.id, index === 0 ? "base" : plan.changes[index - 1]!.id)
  return { change: change.id, parent, atoms: [head], head, reads: [], writes: [`${change.id}.txt`] }
}

for (const mode of ["early-before-tip", "early-after-tip", "later-check-pending", "all-pass", "invalid-owner", "invalid-source", "fast-failure", "late-fast-failure"] as const) {
  test(`native feedback: ${mode}`, { timeout: 180_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), "coding-feedback-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
    await writeFile(join(root, ".gitignore"), ".flows/\n")
    const events: string[] = []
    let released = 0
    let findingReady!: () => void
    const finding = new Promise<void>(resolve => { findingReady = resolve })
    let pendingReady!: () => void
    const pending = new Promise<void>(resolve => { pendingReady = resolve })
    const early = mode.startsWith("early") || mode === "later-check-pending"
    const HostRuntime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
    const runtime = HostRuntime.layerHost({ filename: join(root, ".flows", "engine.db"), workspaceRoot: root, owner: { hostId: "feedback-test" }, signals: [] },
      Layer.mergeAll(policyLayers, feedbackLayers,
        Implement.toLayer(({ change, parent }) => Effect.gen(function*() {
          if ((mode === "early-before-tip" || mode === "late-fast-failure") && change.id === "tip") yield* Effect.promise(() => finding)
          events.push(`implement:${change.id}`)
          return implementation(plan.changes.findIndex(value => value.id === change.id), parent)
        })),
        RunCheck.toLayer(({ implementation, check }) => Effect.gen(function*() {
          const receipt: Receipt = { change: implementation.change, checkId: check.id, target: check.target, tier: check.tier,
            commitId: implementation.head.commitId, treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "scripted check", findings: [] }
          if (early && check.tier === "slow" && implementation.change === (mode === "later-check-pending" ? "tip" : "prefix")) {
            events.push(`${implementation.change}:waiting`)
            pendingReady()
            return yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => { released++ })))
          }
          if ((mode === "fast-failure" || (mode === "late-fast-failure" && implementation.change === "tip")) && check.tier === "fast") return { ...receipt, status: "failed" as const }
          if (mode !== "all-pass" && mode !== "fast-failure" && check.tier === "slow" && implementation.change === "owner") {
            if (mode === "early-after-tip") yield* Effect.sleep("250 millis")
            if (mode === "later-check-pending") yield* Effect.promise(() => pending)
            events.push("owner:finding")
            findingReady()
            return { ...receipt, status: "failed" as const, findings: [{ owner: mode === "invalid-owner" ? "tip" : "owner",
              sourceCommitId: mode === "invalid-source" ? "stale" : implementation.head.commitId, message: "Fix owner" }] }
          }
          return receipt
        }))) .pipe(Layer.provideMerge(Action.layerImplementations)))
      .pipe(Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000)))
    const result = await Effect.runPromise(ObservePlan.execute({ plan }, { executionId: `feedback-${mode}` }).pipe(Effect.exit, Effect.scoped, Effect.provide(runtime)))
    if (mode === "all-pass") { assert.equal(Exit.isSuccess(result), true); return }
    assert.ok(Exit.isFailure(result))
    const reason = result.cause.reasons.find(Cause.isFailReason)
    if (early) {
      assert.ok(reason?.error instanceof EarlyFeedback, Cause.pretty(result.cause))
      assert.equal(reason.error.result.changes.length, 3)
      assert.equal(reason.error.result.status, "changes-requested")
      assert.equal(reason.error.result.changes[mode === "later-check-pending" ? 2 : 0]!.receipts.length, 1, "pending slow receipt is not fabricated")
      assert.equal(released, 1, "unrelated slow action is interrupted and its scope closes")
      const recordedEvents = [...events]
      const replay = await Effect.runPromise(ObservePlan.execute({ plan }, { executionId: `feedback-${mode}` }).pipe(Effect.exit, Effect.scoped, Effect.provide(runtime)))
      assert.ok(Exit.isFailure(replay))
      const repeated = replay.cause.reasons.find(Cause.isFailReason)
      assert.ok(repeated?.error instanceof EarlyFeedback)
      assert.deepEqual(repeated.error.result, reason.error.result)
      assert.deepEqual(events, recordedEvents, "cold host replay retains the first feedback decision without executing checks or implementation")
      const order = events.indexOf("owner:finding") - events.indexOf("implement:tip")
      assert.ok(mode === "early-before-tip" ? order < 0 : order > 0)
    } else {
      assert.ok(!(reason?.error instanceof EarlyFeedback))
      assert.match(Cause.pretty(result.cause), (mode === "fast-failure" || mode === "late-fast-failure") ? /did not pass/ : /invalid owner or source revision/)
      if (mode === "fast-failure") assert.deepEqual(events, ["implement:prefix"])
      if (mode === "late-fast-failure") assert.ok(events.includes("owner:finding"), "a recorded first finding cannot leave the failed implementation branch waiting for all IDs")
    }
  })
}
