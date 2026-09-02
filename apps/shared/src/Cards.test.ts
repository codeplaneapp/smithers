import { describe, expect, test } from "bun:test"
import { CardSchema } from "./Cards"

/*
 * The repo-plugin card (apps/ui/docs/LOCAL-APP.md "Cards"): the repository's
 * parsed `smithers-ui.json` manifest embedded in the transcript, one Run
 * affordance per entry riding the existing target.run flow.
 */

const base = { id: "repo-plugin-r1", title: "Aomi", status: "active", createdAt: 0, ordinal: 0 }

const manifest = {
  schemaVersion: 1,
  name: "aomi",
  title: "Aomi",
  summary: "Cross-repo workflows.",
  groups: [{ id: "checks", title: "Checks", kind: "check" }],
  entries: [
    {
      id: "check",
      group: "checks",
      workspace: ".",
      label: "//:check",
      title: "Check everything",
      summary: "One gate.",
      approval: false,
      agentic: false
    }
  ]
}

describe("the repo-plugin card", () => {
  test("carries the repo id and the parsed manifest", () => {
    const card = CardSchema.parse({ ...base, kind: "repo-plugin", payload: { repoId: "r1", manifest } })
    expect(card.kind).toBe("repo-plugin")
    if (card.kind !== "repo-plugin") return
    expect(card.payload.repoId).toBe("r1")
    expect(card.payload.manifest.entries[0]).toMatchObject({ approval: false, agentic: false })
  })

  test("a payload without the manifest is rejected", () => {
    expect(CardSchema.safeParse({ ...base, kind: "repo-plugin", payload: { repoId: "r1" } }).success).toBe(false)
  })
})

/*
 * Lane citc (ADR 0002): the workspace card carries the plue DTO trimmed to
 * what the card states — no kind, no uptime, no workspace head, no
 * ahead/behind (plue#446) — and the service-log contract lands with it.
 */
describe("the workspace card", () => {
  const payload = {
    workspaceId: "ws-1",
    repo: "will/smithers",
    name: "review",
    targetBookmark: "main",
    status: "running",
    provisioningStage: null,
    bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" },
    snapshots: [{ id: "snap-1", name: "before-upgrade", createdAt: "2026-09-01T10:00:00Z" }],
    sessions: [{ id: "sess-1", status: "running", createdAt: null }]
  }

  test("carries the DTO plus the bookmark head, and defaults nothing", () => {
    const card = CardSchema.parse({ ...base, kind: "workspace", payload })
    if (card.kind !== "workspace") return
    expect(card.payload.status).toBe("running")
    expect(card.payload.bookmarkHead).toEqual({ changeId: "qupxosqw", commitId: "c0ffee1" })
    // The forbidden fields are not in the schema at all (plue#446).
    expect(JSON.stringify(Object.keys(card.payload))).not.toMatch(/kind|uptime|ahead|behind/)
  })

  test("a status outside plue's six is rejected", () => {
    expect(CardSchema.safeParse({ ...base, kind: "workspace", payload: { ...payload, status: "melting" } }).success)
      .toBe(false)
  })

  test("the bookmark head may be absent (an unread head is not a fact)", () => {
    const card = CardSchema.parse({ ...base, kind: "workspace", payload: { ...payload, bookmarkHead: null } })
    if (card.kind !== "workspace") return
    expect(card.payload.bookmarkHead).toBeNull()
  })
})

describe("the service-log card", () => {
  test("carries the service, its lines, and the follow state", () => {
    const card = CardSchema.parse({
      ...base,
      kind: "service-log",
      payload: { workspaceId: "ws-1", repo: "will/smithers", service: "web", lines: ["listening"], follow: true }
    })
    if (card.kind !== "service-log") return
    expect(card.payload.follow).toBe(true)
    expect(card.payload.lines).toEqual(["listening"])
  })
})
