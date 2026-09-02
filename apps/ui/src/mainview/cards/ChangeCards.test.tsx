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
    stack: stackOf(),
    changeset: null,
    ...overrides
  }
})

/** The default landing request: qupxosqw is its top, 2 of 2 by request order. */
function stackOf(): NonNullable<ChangePayload["stack"]> {
  return {
    landingNumber: 42,
    state: "open",
    position: 2,
    size: 2,
    changeIds: ["mzxvbnmk", "qupxosqw"],
    targetBookmark: "main",
    conflictStatus: "none"
  }
}

type Changeset = NonNullable<ChangePayload["changeset"]>

const member = (repository: string, path: string): Changeset["members"][number] => ({
  repository,
  path,
  changeId: "qupxosqw",
  commitId: "a03f5f",
  targetBookmark: "main",
  previousCommitId: null,
  landedCommitId: null
})

const changesetOf = (overrides: Partial<Changeset> = {}): Changeset => ({
  id: 7,
  organization: "will",
  superproject: "will/smithers",
  changeId: "qupxosqw",
  state: "pending",
  failureReason: null,
  targetBookmark: "main",
  members: [],
  ...overrides
})

const landButton = (host: HTMLElement): HTMLButtonElement =>
  host.querySelector('button[data-flow="change.land"]') as HTMLButtonElement

/** The blocking reason a disabled Land wears: the span right after the button. */
const landReason = (host: HTMLElement): string | null => landButton(host).nextElementSibling?.textContent ?? null

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

    const landed = renderChange(changeCard({ stack: { ...stackOf(), state: "merged" } }))
    click(landed.host, "Revert the landed change")
    expect(landed.commands).toEqual([{ name: "change.revert", args: "qupxosqw" }])
    landed.host.remove()
  })

  test("a failed changeset renders its failure reason verbatim with Retry land", () => {
    const { host, commands } = renderChange(
      changeCard({ changeset: changesetOf({ state: "failed", failureReason: "bookmark moved under the land" }) })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("bookmark moved under the land")
    expect(text).toContain("Changeset 7 → main")
    expect(landButton(host).disabled).toBe(false)
    expect(landButton(host).textContent).toContain("Retry land")
    click(host, "Land the changeset")
    expect(commands[0]).toEqual({ name: "change.land", args: "qupxosqw" })
    host.remove()
  })

  test("Land is disabled with the reason while a changeset is landing or landed", () => {
    const landing = renderChange(changeCard({ changeset: changesetOf({ state: "landing" }) }))
    expect(landButton(landing.host).disabled).toBe(true)
    expect(landReason(landing.host)).toBe("landing…")
    landing.host.remove()

    const landed = renderChange(changeCard({ changeset: changesetOf({ state: "landed" }) }))
    expect(landButton(landed.host).disabled).toBe(true)
    expect(landReason(landed.host)).toBe("landed")
    landed.host.remove()
  })

  test("a changeset lists its members as repository · path before the Land confirm", () => {
    const { host } = renderChange(
      changeCard({ changeset: changesetOf({ members: [member("will/cs-api", "services/api"), member("will/cs-web", "apps/web")] }) })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("2 members")
    expect(text).toContain("will/cs-api · services/api")
    expect(text).toContain("will/cs-web · apps/web")
    host.remove()
  })

  test("a changeset's change offers Split ready; a plain one doesn't", () => {
    const plain = renderChange(changeCard())
    expect(plain.host.textContent ?? "").not.toContain("Split ready")
    plain.host.remove()

    const { host, commands } = renderChange(changeCard({ changeset: changesetOf() }))
    click(host, "Split the ready members into a new change")
    expect(commands).toEqual([{ name: "change.split-ready", args: "qupxosqw" }])
    host.remove()

    /* Landed: nothing is left to split. */
    const landed = renderChange(changeCard({ changeset: changesetOf({ state: "landed" }) }))
    expect(landed.host.textContent ?? "").not.toContain("Split ready")
    landed.host.remove()
  })

  test("the Land and Full diff acts carry complete invocations", () => {
    const { host, commands } = renderChange(changeCard())
    click(host, "Land 1 → 2")
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

  test("an unread checks list says so with its reason — never 'No checks recorded'", () => {
    const unread = renderChange(
      changeCard({ facet: "checks", checks: null, unread: { checks: "Reading statuses failed (500)" } })
    )
    expect(unread.host.textContent ?? "").toContain("checks not read (Reading statuses failed (500))")
    expect(unread.host.textContent ?? "").not.toContain("No checks recorded")
    unread.host.remove()

    const empty = renderChange(changeCard({ facet: "checks", checks: [] }))
    expect(empty.host.textContent ?? "").toContain("No checks recorded at this revision.")
    empty.host.remove()
  })

  test("unread reviews and threads say so with their reasons — never 'No review is recorded'", () => {
    const { host } = renderChange(
      changeCard({
        facet: "review",
        reviews: null,
        threads: null,
        unread: { reviews: "the landing list wasn't read: 502", threads: "the landing list wasn't read: 502" }
      })
    )
    const text = host.textContent ?? ""
    expect(text).toContain("reviews not read (the landing list wasn't read: 502)")
    expect(text).toContain("threads not read (the landing list wasn't read: 502)")
    expect(text).not.toContain("No review is recorded")
    host.remove()

    const empty = renderChange(changeCard({ facet: "review", reviews: [], threads: [] }))
    expect(empty.host.textContent ?? "").toContain("No review is recorded for qupxosqw.")
    empty.host.remove()
  })

  test("unread conflicts render as unread, never as a clean change", () => {
    const { host } = renderChange(changeCard({ conflicts: null, unread: { conflicts: "Reading conflicts failed (500)" } }))
    expect(host.textContent ?? "").toContain("conflicts not read (Reading conflicts failed (500))")
    expect(host.textContent ?? "").not.toContain("Conflicted:")
    host.remove()
  })

  test("every conflicted file carries its own Resolve", () => {
    const { host, commands } = renderChange(
      changeCard({
        conflicts: [{ path: "src/app.ts", state: "unresolved" }, { path: "docs/guide.md", state: "unresolved" }]
      })
    )
    click(host, "Dispatch an agent to resolve the conflict in docs/guide.md")
    click(host, "Dispatch an agent to resolve the conflict in src/app.ts")
    expect(commands).toEqual([
      { name: "change.resolve", args: "qupxosqw docs/guide.md" },
      { name: "change.resolve", args: "qupxosqw src/app.ts" }
    ])
    host.remove()
  })

  test("a landing request's Land names its scope, and only its top change may land", () => {
    const top = renderChange(changeCard())
    expect(landButton(top.host).disabled).toBe(false)
    expect(landButton(top.host).textContent).toContain("Land 1 → 2")
    expect(landButton(top.host).getAttribute("aria-label")).toBe("Land the change: lands 1 → 2 together")
    top.host.remove()

    const mid = renderChange(
      changeCard({ stack: { ...stackOf(), position: 1, changeIds: ["qupxosqw", "ronvznsk"] } })
    )
    expect(landButton(mid.host).disabled).toBe(true)
    expect(landReason(mid.host)).toBe(
      "landing request #42 lands 1 → 2 together from ronvznsk (2 of 2); landing a prefix alone isn't possible yet (plue#452)"
    )
    mid.host.remove()

    const alone = renderChange(changeCard({ stack: { ...stackOf(), position: 1, size: 1, changeIds: ["qupxosqw"] } }))
    expect(landButton(alone.host).disabled).toBe(false)
    expect(landButton(alone.host).textContent?.trim()).toBe("Land")
    expect(landButton(alone.host).getAttribute("aria-label")).toBe("Land the change: lands qupxosqw alone")
    alone.host.remove()
  })

  test("Land is disabled with the state while a landing request is queued, landing, merged, or closed; failed re-lands", () => {
    const blocked: ReadonlyArray<readonly [string, string]> = [
      ["queued", "queued…"],
      ["landing", "landing…"],
      ["merged", "landed"],
      ["closed", "closed — plue lands a request only while it is open or failed"]
    ]
    for (const [state, reason] of blocked) {
      const { host } = renderChange(changeCard({ stack: { ...stackOf(), state } }))
      expect(landButton(host).disabled).toBe(true)
      expect(landReason(host)).toBe(reason)
      host.remove()
    }
    const failed = renderChange(changeCard({ stack: { ...stackOf(), state: "failed" } }))
    expect(landButton(failed.host).disabled).toBe(false)
    expect(landButton(failed.host).textContent).toContain("Retry land 1 → 2")
    failed.host.remove()
  })

  test("the landing pill: merged is done, failed is failed, closed is neutral with plue's own word", () => {
    const pills: ReadonlyArray<readonly [string, string]> = [
      ["open", "pending"],
      ["merged", "done"],
      ["failed", "failed"],
      ["closed", "cancelled"]
    ]
    for (const [state, status] of pills) {
      const { host } = renderChange(changeCard({ stack: { ...stackOf(), state } }))
      const pill = host.querySelector("[data-status]")
      expect(pill?.getAttribute("data-status")).toBe(status)
      if (state === "closed") expect(pill?.textContent).toContain("Closed")
      host.remove()
    }
  })

  test("the stack line labels the position as inferred by request order", () => {
    const { host } = renderChange(changeCard())
    expect(host.textContent ?? "").toContain("Landing #42 · position 2 of 2 by request order · open → main")
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
