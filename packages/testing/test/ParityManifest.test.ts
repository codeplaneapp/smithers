import { existsSync, readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Conformance from "../src/Conformance.ts"
import {
  openCodeBehaviorInventory,
  requiredOpenCodeBehaviors,
  requiredOpenCodeSources,
  rows
} from "../src/ParityManifest.ts"

// Manifest rows keep their former superproject-relative `flows/` or `agent/`
// prefix, but the files they name now live in this repository, so they resolve
// against the repo root. That stays correct in the canonical checkout, in
// isolated worktrees, and on CI. The OpenCode corpus is a gitignored sibling
// of the checkout
// (`../reference` in the canonical layout, `reference/` in a repo-local
// clone); corpus-dependent suites skip when no clone is present, as in
// worktrees and CI.
const repositoryRoot = new URL("../../../", import.meta.url)
const corpusRoot = [
  new URL("../reference/", repositoryRoot),
  new URL("reference/", repositoryRoot)
].find((candidate) => existsSync(new URL("opencode/packages/core/test/", candidate)))
const testFile = /\.test\.ts$/

describe("ParityManifest", () => {
  it("maps every conformance pin entry to an executable suite case", () => {
    const names = new Set(Conformance.suite().map((conformanceCase) => conformanceCase.name))
    for (const row of rows) {
      if (testFile.test(row.flowsEquivalent) || row.flowsEquivalent === "—") continue
      expect(names.has(row.flowsEquivalent), `${row.source}: ${row.flowsEquivalent}`).toBe(true)
    }
  })

  it("maps every test-file entry to a file in the repository", () => {
    for (const row of rows) {
      if (!testFile.test(row.flowsEquivalent)) continue
      expect(
        existsSync(new URL(row.flowsEquivalent.replace(/^(?:agent|flows)\//, ""), repositoryRoot)),
        row.flowsEquivalent
      ).toBe(true)
    }
  })

  it("explains every incomplete parity claim", () => {
    for (const row of rows) {
      if (row.status === "pinned") continue
      expect(row.reason?.trim(), `${row.source}: ${row.behavior}`).toBeTruthy()
    }
  })

  it("does not duplicate external behavior claims", () => {
    const claims = rows.map((row) => `${row.source}\u0000${row.behavior}`)
    expect(new Set(claims).size).toBe(claims.length)
  })

  it("accounts for every ranked Smithers conformance row", () => {
    const ranks = new Set(
      rows.flatMap((row) => {
        const match = /^smithers #(\d+)\b/.exec(row.source)
        return match === null ? [] : [Number(match[1])]
      })
    )
    expect([...ranks].filter((rank) => rank >= 1 && rank <= 14).sort((left, right) => left - right)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14
    ])
  })

  it.skipIf(corpusRoot === undefined)("accounts for every targeted OpenCode session source", () => {
    if (corpusRoot === undefined) return
    const sourceDirectory = new URL("opencode/packages/core/test/", corpusRoot)
    const discovered = readdirSync(sourceDirectory)
      .filter((name) =>
        /^session-(?:runner.*|tool-progress|create|prompt|projector|compaction|todo|run-coordinator|history)\.test\.ts$/
          .test(
            name
          )
      )
      .map((name) => `packages/core/test/${name}`)
      .sort()
    expect([...requiredOpenCodeSources].sort()).toEqual(discovered)
  })

  it.skipIf(corpusRoot === undefined)("inventories every static behavior in each targeted OpenCode source", () => {
    if (corpusRoot === undefined) return
    for (const source of requiredOpenCodeSources) {
      const text = readFileSync(new URL(`opencode/${source}`, corpusRoot), "utf8")
      const discovered = [
        ...new Set(
          [...text.matchAll(/\b(?:test|it)(?:\.effect)?\(\s*(["'`])((?:(?!\1)[\s\S])*?)\1/g)].map(
            (match) => (match[2] ?? "").replace(/\s+/g, " ").trim()
          )
        )
      ].sort()
      expect(
        [...openCodeBehaviorInventory[source as keyof typeof openCodeBehaviorInventory]].sort(),
        source
      ).toEqual(discovered)
    }
  })

  it("maps every targeted OpenCode behavior", () => {
    for (const { source, behavior } of requiredOpenCodeBehaviors) {
      expect(
        rows.some((row) => row.source === source && row.behavior === behavior),
        `missing OpenCode parity row for ${source}: ${behavior}`
      ).toBe(true)
    }
  })

  it("classifies heartbeat fencing and exact harness descendants without overclaiming durability", () => {
    const heartbeat = rows.find((row) => row.source.startsWith("smithers #5 "))
    expect(heartbeat).toMatchObject({
      flowsEquivalent: "flows/packages/engine-store/test/Ownership.test.ts",
      status: "partial"
    })

    // The three overflow-recovery rows are `skipped` because that recovery was
    // a contract of the deleted provider-tool-call loop, not because coverage
    // regressed: the cell loop compacts on a declared token budget instead.
    const expected = [
      // The cell loop recovers from a failed call inside the cell; the durable
      // half of the settlement stays engine-owned, so the row is `partial`.
      ["durably settles local tool failures before continuing", "partial"],
      ["forces one compaction and retries after provider context overflow", "partial"],
      ["persists a second context overflow after one recovery", "skipped"],
      ["recovers once from a raw context overflow failure", "skipped"],
      ["does not recover context overflow after durable assistant output", "skipped"],
      ["forces a text response on an agent's configured final step", "pinned"],
      ["projects raw provider stream failures as terminal assistant step failures", "partial"],
      ["keeps interleaved assistant text blocks separate", "pinned"],
      ["broadcasts provider ${kind} deltas without storing projection rewrites", "partial"],
      ["durably closes partial ${kind} when the provider stream fails", "partial"],
      ["durably closes partial ${kind} when the provider stream is interrupted", "partial"]
    ] as const
    for (const [behavior, status] of expected) {
      expect(
        rows.find((row) =>
          row.source === "packages/core/test/session-runner.test.ts" &&
          row.behavior === behavior
        ),
        behavior
      ).toMatchObject({ status })
    }
  })
})
