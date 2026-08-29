import { describe, expect, test } from "bun:test"
import { CardSchema } from "./Cards"

/*
 * The repo-plugin card (apps/ui/docs/LOCAL-APP.md "Cards"): the repository's
 * parsed `.smithers/UI.json` manifest embedded in the transcript, one Run
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
