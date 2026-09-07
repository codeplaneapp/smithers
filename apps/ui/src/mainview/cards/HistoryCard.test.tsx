import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "@smthrs/rpc/Cards"
import { HistoryCardBody } from "./HistoryCard"

/*
 * The history card renders exactly what its payload states: the empty state
 * is one sentence and one door, the badge is the tree invariant or the honest
 * reason it cannot be checked, and every button carries a registered flow with
 * the repository as its args.
 */

type HistoryCard = Extract<Card, { kind: "history" }>

const card = (payload: HistoryCard["payload"]): HistoryCard => ({
  id: "history-will/flows",
  kind: "history",
  title: "Mythical history · will/flows",
  status: "active",
  createdAt: 1,
  ordinal: 1,
  payload
})

const render = (payload: HistoryCard["payload"], onRunCommand: (name: string, args?: string) => void = () => {}): string =>
  renderToStaticMarkup(<HistoryCardBody card={card(payload)} onRunCommand={onRunCommand} />)

describe("HistoryCard", () => {
  test("the empty state is the one sentence and the bootstrap door carrying the repository", () => {
    const html = render({ repo: "will/flows", defaultBookmark: "main", mainCommits: 214, mythical: { state: "absent" } })
    expect(html).toContain("No mythical history yet. main has 214 commits.")
    expect(html).toContain('data-flow="history.bootstrap"')
    expect(html).not.toContain("history.fold")
    // One commit reads singular; an unknown count says so instead of a number.
    expect(render({ repo: "will/flows", defaultBookmark: "main", mainCommits: 1, mythical: { state: "absent" } })).toContain("main has 1 commit.")
    expect(render({ repo: "will/flows", defaultBookmark: "main", mainCommits: null, mythical: { state: "absent" } })).toContain(
      "No mythical history yet. The commit count of main is not available."
    )
  })

  test("the badge states tree equality against the default bookmark's head, or why it cannot be checked", () => {
    const present = (treeEqual: "equal" | "different" | "unsupported"): HistoryCard["payload"] => ({
      repo: "will/flows",
      defaultBookmark: "main",
      mainCommits: 2,
      mythical: {
        state: "present",
        head: "e200000000000000000000000000000000000002",
        mainHead: "3333333333333333333333333333333333333333",
        treeEqual,
        commitCount: 6,
        notes: "absent",
        epics: [{ sha: "e200000000000000000000000000000000000002", title: "02 · Targets", merge: true, note: null, commits: [] }]
      }
    })
    expect(render(present("equal"))).toContain("tree-equal to main @ 3333333 · 1 epic · 6 commits")
    expect(render(present("different"))).toContain("tree differs from main @ 3333333")
    expect(render(present("unsupported"))).toContain("tree-equal: not available (the mirror does not serve git commits yet)")
    expect(render(present("equal"))).toContain("refs/notes/mythical: not in the mirror&#x27;s ref list")
    expect(render(present("equal"))).toContain('data-flow="history.fold"')
  })

  test("epics list their atomic commits with the note sections the note holds", () => {
    const html = render({
      repo: "will/flows",
      defaultBookmark: "main",
      mainCommits: 2,
      mythical: {
        state: "present",
        head: "e2",
        mainHead: null,
        treeEqual: "unsupported",
        commitCount: 2,
        notes: "read",
        epics: [{
          sha: "e2e2e2e2",
          title: "02 · Targets",
          merge: true,
          note: null,
          commits: [{
            sha: "b2b2b2b2",
            title: "feat(targets): declare targets",
            note: { tried: "a single json file", evidence: null, folded: "9a0f2e1", superseded: null }
          }]
        }]
      }
    })
    expect(html).toContain('data-testid="history-epic-e2e2e2e2"')
    expect(html).toContain('data-testid="history-commit-b2b2b2b2"')
    expect(html).toContain("<dt>Tried</dt><dd>a single json file</dd>")
    expect(html).toContain("<dt>Folded</dt><dd>9a0f2e1</dd>")
    expect(html).not.toContain("<dt>Evidence</dt>")
    expect(html).not.toContain("<dt>Superseded</dt>")
    expect(html).toContain("Fold main into mythical")
  })
})
