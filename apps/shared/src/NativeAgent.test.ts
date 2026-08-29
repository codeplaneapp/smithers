import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AgentTurnFrameSchema, isAgentTurnFrame } from "./NativeAgent"
import type { AgentTurnFrame } from "./NativeAgent"

const parses = (value: unknown): boolean => AgentTurnFrameSchema.safeParse(value).success

describe("AgentTurnFrame — proxy family", () => {
  test("delta and done frames parse as before", () => {
    expect(parses({ runId: "r1", type: "delta", kind: "text", text: "hi" })).toBe(true)
    expect(parses({ runId: "r1", type: "done", reason: "stop" })).toBe(true)
  })

  test("a frame without runId is rejected", () => {
    expect(parses({ type: "delta", kind: "text", text: "hi" })).toBe(false)
  })
})

describe("AgentTurnFrame — chain family (DESIGN.md §14)", () => {
  const frames: ReadonlyArray<AgentTurnFrame> = [
    { runId: "lineage-1", type: "link.authored", link: 0, scriptDigest: "d0", script: "```flow\nreturn done({})\n```" },
    { runId: "lineage-1", type: "call.started", link: 0, ordinal: 0, name: "grep" },
    { runId: "lineage-1", type: "call.settled", link: 0, ordinal: 0, name: "grep", verdict: "run" },
    {
      runId: "lineage-1",
      type: "call.settled",
      link: 1,
      ordinal: 0,
      name: "grep",
      verdict: "replay",
      resultDigest: "abc"
    },
    { runId: "lineage-1", type: "gate.rejected", link: 1, kind: "catalog", message: "unknown entry: frobnicate" },
    { runId: "lineage-1", type: "link.ended", link: 1, outcome: "to" },
    { runId: "lineage-1", type: "steering.drained", link: 2, count: 1 },
    { runId: "lineage-1", type: "park", code: "approval" }
  ]

  test("every chain frame round-trips through the schema", () => {
    for (const frame of frames) {
      const parsed = AgentTurnFrameSchema.safeParse(frame)
      expect(parsed.success).toBe(true)
      expect(parsed.success && parsed.data).toEqual(frame)
    }
  })

  test("isAgentTurnFrame guards the chain family too", () => {
    for (const frame of frames) expect(isAgentTurnFrame(frame)).toBe(true)
  })

  test("verdict, gate kind, outcome, and park code are closed vocabularies", () => {
    expect(parses({ runId: "r", type: "call.settled", link: 0, ordinal: 0, name: "x", verdict: "cached" })).toBe(false)
    expect(parses({ runId: "r", type: "gate.rejected", link: 0, kind: "vibes" })).toBe(false)
    expect(parses({ runId: "r", type: "link.ended", link: 0, outcome: "crashed" })).toBe(false)
    expect(parses({ runId: "r", type: "park", code: "nap" })).toBe(false)
  })

  test("link and ordinal are non-negative integers; drained count is positive", () => {
    expect(parses({ runId: "r", type: "link.ended", link: -1, outcome: "done" })).toBe(false)
    expect(parses({ runId: "r", type: "call.started", link: 0, ordinal: 1.5, name: "x" })).toBe(false)
    expect(parses({ runId: "r", type: "steering.drained", link: 0, count: 0 })).toBe(false)
  })

  test("an unknown frame type is rejected", () => {
    expect(parses({ runId: "r", type: "link.rebased", link: 0 })).toBe(false)
  })
})

/*
 * The dependency law of DESIGN.md §14: src/shared mirrors chain vocabulary and
 * never imports it. This keeps the Worker and both bridges effect-free.
 */
describe("src/shared stays runtime-free", () => {
  test("no shared module imports @smthrs/* or effect", () => {
    const dir = join(import.meta.dir)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
      const source = readFileSync(join(dir, file), "utf8")
      // Covers bare, subpath, single-quoted, and dynamic import specifiers.
      expect(source).not.toMatch(/(from\s+|import\()\s*["']@smthrs\//)
      expect(source).not.toMatch(/(from\s+|import\()\s*["']effect(["']|\/)/)
    }
  })
})
