import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { ChangeCardBody, DiffCardBody } from "./ChangeCards"

/*
 * The change and diff cards (lane change, ADR 0003): the five facets render
 * their facts or the ADR's degraded wording (plue#450–#457); the conflicted
 * change offers Resolve, the landed one Revert, the changeset's failure
 * renders verbatim with Retry land; an oversized hunk rides by reference and
 * names the re-read command. Every act rides onRunCommand with a complete
 * invocation.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

type ChangePayload = Extract<Card, { kind: "change" }>["payload"]
type DiffPayload = Extract<Card, { kind: "diff" }>["payload"]

const changeCard = (overrides: Partial<ChangePayload> = {}): Extract<Card, { kind: "change" }> => ({
  id: "change-will/smithers-qupxosqw",
  kind: "change",
  title: "qupxosqw · Add the split flow",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: "will/smithers",
    changeId: "qupxosqw",
    description: "Add the split flow\n\nLong body.",
    commitId: "a03f5f1111111111",
    currentSeq: null,
    revisionCount: null,
    revisions: [],
    authorName: "will",
    timestamp: "2026-09-01T10:00:00Z",
    repos: [{ repo: "will/smithers", additions: 2, deletions: 1 }],
    diff: {
      from: "parent",
      to: "current",
      files: [
        { path: "src/app.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
        { path: "docs/guide.md", changeType: "added", isBinary: false, additions: 1, deletions: 0 }
      ]
    },
    checks: [{ context: "build", state: "success" }],
    findings: null,
    reviews: [{ author: null, type: "approve", body: "ship it", commitId: null }],
    threads: [],
    conflicts: [],
    stack: { landingNumber: 42, state: "open", position: 2, size: 2, targetBookmark: "main", conflictStatus: "none" },
    changeset: null,
    ...overrides
  }
})

const diffCard = (overrides: Partial<DiffPayload> = {}): Extract<Card, { kind: "diff" }> => ({
  id: "diff-will/smithers-qupxosqw",
  kind: "diff",
  title: "qupxosqw · parent → current",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: "will/smithers",
    changeId: "qupxosqw",
    from: "parent",
    to: "current",
    pin: { changeId: "qupxosqw", seq: null, commitId: "a03f5f1111111111" },
    files: [
      { path: "src/app.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }
    ],
    ...overrides
  }
})

const renderChange = (card: Extract<Card, { kind: "change" }>) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(
      <ChangeCardBody card={card} onRunCommand={(name, args) => commands.push({ name, args })} />
    )
  })
  return { host, commands }
}

const renderDiff = (card: Extract<Card, { kind: "diff" }>) => {
  const commands: Array<{ name: string; args?: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(
      <DiffCardBody card={card} onRunCommand={(name, args) => commands.push({ name, args })} />
    )
  })
  return { host, commands }
}

const click = (host: HTMLElement, testIdOrText: string): void => {
  const button = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(testIdOrText) || candidate.getAttribute("aria-label") === testIdOrText)
  if (button === undefined) throw new Error(`no button named ${testIdOrText}`)
  flushSync(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

describe("the change card", () => {
  test("the header names the repo, the change, the short commit, and the author — never a revision count", () => {
    const { host } = renderChange(changeCard())
    const text = host.textContent ?? ""
    expect(text).toContain("will/smithers · qupxosqw · a03f5f11 · will")
    expect(text).not.toContain("rev ")
    host.remove()
  })

  test("the diff facet lists the files, each opening its one-file diff", () => {
    const { host, commands } = renderChange(changeCard())
    const text = host.textContent ?? ""
    expect(text).toContain("src/app.ts")
    expect(text).toContain("+1 −1")
    click(host, "Open the diff of src/app.ts")
    expect(commands).toEqual([{ name: "change.diff", args: "qupxosqw parent current src/app.ts" }])
    host.remove()
  })

  test("the history facet says the revision history isn't recorded yet (plue#450)", () => {
    const { host, commands } = renderChange(changeCard())
    click(host, "History")
    expect(commands).toEqual([{ name: "change.facet", args: "qupxosqw history" }])
    host.remove()

    const shown = renderChange(changeCard({ facet: "history" }))
    expect(shown.host.textContent ?? "").toContain("revision history isn't recorded yet (plue#450)")
    shown.host.remove()
  })

  test("the history facet renders revisions when the backend carries them (post-#450)", () => {
    const { host } = renderChange(
      changeCard({ facet: "history", revisions: [{ seq: 2, commitId: "a03f5f1111111111" }] })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("rev 2")
    expect(text).toContain("a03f5f11")
    host.remove()
  })

  test("the findings facet says findings per revision don't exist yet (plue#454)", () => {
    const { host } = renderChange(changeCard({ facet: "findings" }))
    expect(host.textContent ?? "").toContain("Findings per revision don't exist yet (plue#454)")
    host.remove()
  })

  test("the checks facet renders one row per context", () => {
    const { host } = renderChange(changeCard({ facet: "checks" }))
    const text = host.textContent ?? ""
    expect(text).toContain("build")
    expect(text).toContain("success")
    host.remove()
  })

  test("the review facet renders verdicts and never a stale token claim (plue#453)", () => {
    const { host } = renderChange(
      changeCard({
        facet: "review",
        threads: [{ path: "src/app.ts", line: 12, body: "why this?", author: null, createdAt: "2026-09-01T10:02:00Z", state: null }]
      })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("approve")
    expect(text).toContain("why this?")
    expect(text).toContain("isn't computed yet (plue#453)")
    expect(text).not.toContain("stale —")
    expect(text).not.toContain("moved —")
    host.remove()
  })

  test("a conflicted change names the files and offers Resolve", () => {
    const { host, commands } = renderChange(
      changeCard({ conflicts: [{ path: "src/app.ts", state: "unresolved" }] })
    )
    expect(host.textContent ?? "").toContain("Conflicted: src/app.ts")
    click(host, "Dispatch an agent to resolve the conflict in src/app.ts")
    expect(commands).toEqual([{ name: "change.resolve", args: "qupxosqw src/app.ts" }])
    host.remove()
  })

  test("an unlanded change never offers Revert; a landed one does", () => {
    const open = renderChange(changeCard())
    expect(open.host.textContent ?? "").not.toContain("Revert")
    open.host.remove()

    const landed = renderChange(changeCard({ stack: { landingNumber: 42, state: "merged", position: 2, size: 2, targetBookmark: "main", conflictStatus: "none" } }))
    click(landed.host, "Revert the landed change")
    expect(landed.commands).toEqual([{ name: "change.revert", args: "qupxosqw" }])
    landed.host.remove()
  })

  test("a failed changeset renders its failure reason verbatim with Retry land", () => {
    const { host, commands } = renderChange(
      changeCard({
        changeset: {
          id: 7,
          organization: "will",
          changeId: "qupxosqw",
          state: "failed",
          failureReason: "bookmark moved under the land",
          targetBookmark: "main",
          members: []
        }
      })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("bookmark moved under the land")
    expect(text).toContain("Changeset 7 → main")
    click(host, "Land the changeset")
    expect(commands[0]).toEqual({ name: "change.land", args: "qupxosqw" })
    host.remove()
  })

  test("a changeset's change offers Split ready; a plain one doesn't", () => {
    const plain = renderChange(changeCard())
    expect(plain.host.textContent ?? "").not.toContain("Split ready")
    plain.host.remove()

    const { host, commands } = renderChange(
      changeCard({
        changeset: { id: 7, organization: "will", changeId: "qupxosqw", state: "pending", failureReason: null, targetBookmark: "main", members: [] }
      })
    )
    click(host, "Split the ready members into a new change")
    expect(commands).toEqual([{ name: "change.split-ready", args: "qupxosqw" }])
    host.remove()
  })

  test("the Land and Full diff acts carry complete invocations", () => {
    const { host, commands } = renderChange(changeCard())
    click(host, "Land the change")
    click(host, "Open the full diff card")
    expect(commands).toEqual([
      { name: "change.land", args: "qupxosqw" },
      { name: "change.diff", args: "qupxosqw" }
    ])
    host.remove()
  })

  test("an error the seam recorded renders on the card", () => {
    const { host } = renderChange(changeCard({ error: "the land failed: bookmark moved" }))
    expect(host.textContent ?? "").toContain("the land failed: bookmark moved")
    host.remove()
  })
})

describe("the diff card", () => {
  test("the header names the from → to pair and the pin's commit", () => {
    const { host } = renderDiff(diffCard())
    const text = host.textContent ?? ""
    expect(text).toContain("will/smithers · qupxosqw · parent → current")
    expect(text).toContain("pinned at a03f5f11")
    host.remove()
  })

  test("an inline hunk renders; a binary file says so", () => {
    const { host } = renderDiff(
      diffCard({
        files: [
          { path: "src/app.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
          { path: "logo.png", changeType: "modified", isBinary: true, additions: 0, deletions: 0 }
        ]
      })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("@@ -1 +1 @@")
    expect(text).toContain("logo.png is binary")
    host.remove()
  })

  test("an oversized hunk rides by reference and names the re-read command", () => {
    const { host, commands } = renderDiff(
      diffCard({
        files: [{ path: "src/big.ts", changeType: "modified", isBinary: false, additions: 500, deletions: 0, patchLines: 500 }]
      })
    )
    expect(host.textContent ?? "").toContain("src/big.ts's hunk is 500 lines — it rides by reference")
    click(host, "Read it")
    expect(commands).toEqual([{ name: "change.diff", args: "qupxosqw parent current src/big.ts" }])
    host.remove()
  })

  test("a conflicted file is marked", () => {
    const { host } = renderDiff(
      diffCard({
        files: [{ path: "src/app.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1, patch: "x", conflicted: true }]
      })
    )
    expect(host.textContent ?? "").toContain("conflicted")
    host.remove()
  })
})
