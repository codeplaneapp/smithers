import { describe, expect, test } from "bun:test"
import { CardSchema } from "./Cards"
import { RevisionPinSchema } from "./Changes"

/*
 * Lane change (ADR 0003 — the change is the unit): the change and diff card
 * payloads, and the revision pin on the file card. Degraded forms (no
 * revisions, no findings, no commit ids on verdicts) must parse — they are
 * what the seam builds today.
 */

const base = { id: "change-1", title: "qupxosqw", status: "active", createdAt: 0, ordinal: 0 } as const

const changePayload = {
  repo: "smithersai/smithers",
  changeId: "qupxosqw",
  description: "Serve repository files through one bounded, confined route",
  commitId: "a03f5f1e",
  currentSeq: null,
  revisionCount: null,
  revisions: [],
  authorName: "will",
  timestamp: "2026-09-02T10:00:00Z",
  repos: [{ repo: "smithersai/smithers", additions: 312, deletions: 41 }],
  diff: null,
  checks: [{ context: "typecheck", state: "success" }],
  findings: null,
  reviews: [{ author: null, type: "approve", body: "", commitId: null }],
  threads: [{ path: "src/server.ts", line: 12, body: "why bounded?", author: null, createdAt: null, state: null }],
  conflicts: [],
  stack: {
    landingNumber: 12,
    state: "open",
    position: 2,
    size: 3,
    targetBookmark: "main",
    conflictStatus: "none"
  },
  changeset: null
}

describe("the change card", () => {
  test("the degraded payload (no revisions, no findings, verdicts without commit ids) parses", () => {
    const card = CardSchema.parse({ ...base, kind: "change", payload: changePayload })
    if (card.kind !== "change") throw new Error("wrong kind")
    expect(card.payload.currentSeq).toBeNull()
    expect(card.payload.revisions).toEqual([])
    expect(card.payload.findings).toBeNull()
    expect(card.payload.reviews?.[0]?.commitId).toBeNull()
  })

  test("a payload with revisions and a changeset parses (the post-#450 shape)", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "change",
      payload: {
        ...changePayload,
        currentSeq: 5,
        revisionCount: 5,
        revisions: [{ seq: 5, commitId: "a03f5f1e", source: "agent", agentSessionId: "a03f5f" }],
        findings: [{ analyzer: "lint", severity: "warn", path: "src/a.ts", line: 3, summary: "unused", raisedAtSeq: 3 }],
        changeset: {
          id: 7,
          organization: "canary-changesets-e2e",
          changeId: "qupxosqw",
          state: "failed",
          failureReason: "member cs-web conflicted",
          targetBookmark: "main",
          members: [
            {
              repository: "cs-api",
              path: "api",
              changeId: "qupxosqw",
              commitId: "a03f5f1e",
              targetBookmark: "main",
              previousCommitId: null,
              landedCommitId: null
            }
          ]
        }
      }
    })
    if (card.kind !== "change") throw new Error("wrong kind")
    expect(card.payload.currentSeq).toBe(5)
    expect(card.payload.changeset?.state).toBe("failed")
  })

  test("a missing landing state (stack: null) parses — a change with no landing request", () => {
    const card = CardSchema.parse({ ...base, kind: "change", payload: { ...changePayload, stack: null, reviews: null, threads: null } })
    if (card.kind !== "change") throw new Error("wrong kind")
    expect(card.payload.stack).toBeNull()
  })
})

describe("the diff card", () => {
  test("carries the two picker tokens, the pin, and the files", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "diff",
      payload: {
        repo: "smithersai/smithers",
        changeId: "qupxosqw",
        from: "parent",
        to: "current",
        pin: { changeId: "qupxosqw", seq: null, commitId: "a03f5f1e" },
        files: [
          { path: "src/a.ts", changeType: "modified", isBinary: false, additions: 3, deletions: 1, patch: "@@ -1 +1 @@", conflicted: true },
          { path: "src/big.ts", changeType: "modified", isBinary: false, additions: 500, deletions: 0, patchLines: 812 }
        ]
      }
    })
    if (card.kind !== "diff") throw new Error("wrong kind")
    expect(card.payload.pin.seq).toBeNull()
    expect(card.payload.files[1]?.patch).toBeUndefined()
    expect(card.payload.files[1]?.patchLines).toBe(812)
  })

  test("the pin requires the change id — a card that cannot name its change is rejected", () => {
    const parsed = CardSchema.safeParse({
      ...base,
      kind: "diff",
      payload: { repo: "o/r", changeId: "qupxosqw", from: "parent", to: "current", pin: { seq: null, commitId: "a03f5f1e" }, files: [] }
    })
    expect(parsed.success).toBe(false)
  })
})

describe("the revision pin", () => {
  test("the file card's readAt accepts the pin's seq — optional, null until plue#450", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "file",
      payload: {
        repo: "smithersai/smithers",
        path: "README.md",
        content: "# hi",
        truncated: false,
        readAt: { changeId: "qupxosqw", commitId: "a03f5f1e", seq: null, source: "head" }
      }
    })
    if (card.kind !== "file") throw new Error("wrong kind")
    expect(card.payload.readAt?.seq).toBeNull()
  })

  test("a bare commit pin (a local working copy) is valid — never a server seq", () => {
    const pin = RevisionPinSchema.parse({ changeId: "qupxosqw", seq: null, commitId: "a03f5f1e" })
    expect(pin.seq).toBeNull()
  })
})
