/*
 * The history card (Factory design session 2026-09-07 §3, mock 13): the
 * mythical history embedded in the chat. First-parent rows are epics with
 * their atomic commits under them and each commit's note beside it; the badge
 * is the invariant tree(mythical) == tree(main), or the honest reason it
 * cannot be checked. Until the bookmark exists the card is one sentence and
 * one door (history.bootstrap). Every button is the button door of a
 * registered flow, dispatched through onRunCommand with its repo carried.
 */
import type { HistoryNote } from "@smthrs/rpc/Cards"
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { emptyHistorySentence, treeEqualLabel } from "../state/seams/HistorySeam"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

type HistoryCard = Extract<Card, { kind: "history" }>

export interface HistoryCardActions {
  readonly onRunCommand: (name: string, args?: string) => void
}

const NoteSections = ({ note, sha }: { readonly note: HistoryNote; readonly sha: string }) => {
  const sections: ReadonlyArray<readonly [string, string | null]> = [
    ["Tried", note.tried],
    ["Evidence", note.evidence],
    ["Folded", note.folded],
    ["Superseded", note.superseded]
  ]
  const present = sections.filter((entry): entry is readonly [string, string] => entry[1] !== null && entry[1] !== "")
  if (present.length === 0) return null
  return (
    <dl className="history-note" data-testid={`history-note-${sha}`}>
      {present.map(([label, text]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{text}</dd>
        </div>
      ))}
    </dl>
  )
}

export const HistoryCardBody = ({ card, onRunCommand }: { readonly card: HistoryCard } & HistoryCardActions) => {
  const { payload } = card
  const { mythical, repo } = payload
  if (mythical.state === "absent") {
    return (
      <div className="world-card-list">
        <p className="world-card-empty" data-testid="history-empty">
          {emptyHistorySentence(payload.defaultBookmark, payload.mainCommits)}
        </p>
        <Button
          variant="ghost"
          size="sm"
          data-flow="history.bootstrap"
          data-testid="history-bootstrap"
          onClick={() => onRunCommand("history.bootstrap", repo)}
        >
          Bootstrap the mythical history
        </Button>
      </div>
    )
  }
  if (mythical.state === "unsupported") {
    return (
      <div className="world-card-list">
        <p className="world-card-empty" data-testid="history-unsupported">{mythical.reason}</p>
      </div>
    )
  }
  return (
    <div className="world-card-list">
      <p className="world-card-path" data-testid="history-badge">
        {treeEqualLabel(mythical, payload.defaultBookmark)} · {mythical.epics.length} epic{mythical.epics.length === 1 ? "" : "s"} ·{" "}
        {mythical.commitCount} commit{mythical.commitCount === 1 ? "" : "s"}
      </p>
      <ol className="world-card-list history-epics" data-testid="history-epics">
        {mythical.epics.map((epic) => (
          <li key={epic.sha} className="world-card-row" data-testid={`history-epic-${epic.sha}`}>
            <span className="world-card-title">{epic.title}</span>
            <span className="world-card-path">{epic.sha.slice(0, 7)}</span>
            {epic.note === null ? null : <NoteSections note={epic.note} sha={epic.sha} />}
            {epic.commits.length === 0 ? null : (
              <ol className="world-card-list history-commits">
                {epic.commits.map((commit) => (
                  <li key={commit.sha} className="world-card-row" data-testid={`history-commit-${commit.sha}`}>
                    <span className="world-card-title">{commit.title}</span>
                    <span className="world-card-path">{commit.sha.slice(0, 7)}</span>
                    {commit.note === null ? null : <NoteSections note={commit.note} sha={commit.sha} />}
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
      <div className="history-doors">
        <Button
          variant="ghost"
          size="sm"
          data-flow="history.fold"
          data-testid="history-fold"
          onClick={() => onRunCommand("history.fold", repo)}
        >
          Fold {payload.defaultBookmark ?? "the default bookmark"} into mythical
        </Button>
        <span className="world-card-path" data-testid="history-notes-state">
          {mythical.notes === "read" ? "refs/notes/mythical" : "refs/notes/mythical: not in the mirror's ref list"}
        </span>
      </div>
    </div>
  )
}

export const historyCardFamily: CardFamily<"history"> = {
  history: { render: (card, actions) => <HistoryCardBody card={card} onRunCommand={actions.onRunCommand} />, pill: settledPill }
}
