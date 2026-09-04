/**
 * Case 21 — the pointers a snapshot hands back address the tree it captured.
 *
 * A change id is the only thing an engine keeps when it snapshots a workspace,
 * so it has to be enough to get the tree back. This case takes real snapshots
 * of a real Jujutsu repository through `NodeJj`, edits the working copy in
 * between, and restores by id: the file contents that come back are the fact
 * being checked, not the fact that a call returned.
 *
 * The repository is a throwaway created with `jj git init`. `jj` is a first
 * class dependency of the RC, so this case fails rather than skips on CI: a
 * silent skip is how a real regression against the real binary merges.
 */
import { Jj } from "@smthrs/jj/Jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

// A missing binary is a hard failure on CI and a quiet skip locally. It is a
// module-level throw rather than a guard suite so that a runner WITH jj emits
// no skipped test: a skip and a pass read the same in a suite summary, and a
// case that has silently skipped for months is indistinguishable from one that
// never ran.
if (!jjInstalled && Boolean(process.env.CI)) {
  throw new Error(
    "jj is not installed on this runner, so this case would silently skip. Install jj in the e2e-faults CI job."
  )
}

describe.skipIf(!jjInstalled)("case21 jj pointer integrity", () => {
  let repository: string
  let previousCwd: string

  beforeAll(() => {
    previousCwd = process.cwd()
    repository = mkdtempSync(join(tmpdir(), "smithers-e2e-case21-"))
    execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
    process.env.JJ_EDITOR = "true"
    process.chdir(repository)
  })

  afterAll(() => {
    process.chdir(previousCwd)
    rmSync(repository, { recursive: true, force: true })
  })

  const run = <A, E>(effect: Effect.Effect<A, E, Jj>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, NodeJj.layer) as Effect.Effect<A, E>)

  it("restores the tree a change id addresses, not the one on disk", async () => {
    const file = join(repository, "ledger.txt")
    writeFileSync(file, "one\n")
    const first = await run(Effect.flatMap(Jj, (jj) => jj.snapshot("smithers e2e first")))
    expect(first.changeId).toMatch(/^[a-z]+$/)

    writeFileSync(file, "two\n")
    const second = await run(Effect.flatMap(Jj, (jj) => jj.snapshot("smithers e2e second")))
    expect(second.changeId).not.toBe(first.changeId)

    // The two pointers really do address different trees.
    const diff = await run(Effect.flatMap(Jj, (jj) => jj.diff(first.changeId, second.changeId)))
    expect(diff).toContain("ledger.txt")

    // Restoring by the first id brings that tree back, over a working copy that
    // currently holds the second.
    expect(readFileSync(file, "utf8")).toBe("two\n")
    await run(Effect.flatMap(Jj, (jj) => jj.restore(first.changeId)))
    expect(readFileSync(file, "utf8")).toBe("one\n")

    // And the second pointer still addresses its own tree afterwards: a restore
    // is not a rewrite of history.
    await run(Effect.flatMap(Jj, (jj) => jj.restore(second.changeId)))
    expect(readFileSync(file, "utf8")).toBe("two\n")
  }, 120_000)

  it("refuses a change id no snapshot ever minted", async () => {
    const outcome = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          Effect.flatMap(Jj, (jj) => jj.restore("qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" as never)),
          NodeJj.layer
        )
      )
    )
    // `zzzzzzzz` is the root change every jj repository has, so the id here is
    // one that cannot resolve rather than one that merely looks unusual.
    expect(outcome._tag).toBe("Failure")
  }, 120_000)
})
