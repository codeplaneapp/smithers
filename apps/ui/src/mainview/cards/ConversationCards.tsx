import { Badge, Button, FileTree } from "@smthrs/ui"
import { Check, ExternalLink, GitPullRequest, HardDrive, Server } from "lucide-react"
import { lazy, Suspense, useState } from "react"
import type { KeyboardEvent } from "react"
import type { Card, WorldDocument } from "../state/AppState"
import { WORLD_DISPLAY_NAME } from "../state/AppState"

const MarkdownEditorSurface = lazy(() =>
  import("../MarkdownEditorSurface").then((module) => ({ default: module.MarkdownEditorSurface }))
)

/*
 * The repo-chooser (Wave 10 onboarding): multi-select, fully keyboard-driven
 * — arrows move, Space toggles the highlighted row (when the filter is
 * empty), typing filters, Enter confirms. Select-all/none plus the one
 * confirm action; every act is a command binding.
 */
export const freshnessLabel = (pushedAt: string | null, now: number = Date.now()): string => {
  if (pushedAt === null) return "never pushed"
  const days = Math.max(0, Math.floor((now - Date.parse(pushedAt)) / 86_400_000))
  if (Number.isNaN(days)) return ""
  if (days === 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`
}

/*
 * The chooser's keyboard map, pure so the completeness contract is testable
 * without a DOM: arrows move, Space toggles the highlighted row (only while
 * the filter is empty — otherwise Space is text), Enter is the one confirm.
 */
export type ChooserKeyAction =
  | { readonly kind: "move"; readonly delta: 1 | -1 }
  | { readonly kind: "toggle" }
  | { readonly kind: "confirm" }
  | { readonly kind: "none" }

export const chooserKeyAction = (key: string, filter: string): ChooserKeyAction => {
  if (key === "ArrowDown") return { kind: "move", delta: 1 }
  if (key === "ArrowUp") return { kind: "move", delta: -1 }
  if (key === " " && filter === "") return { kind: "toggle" }
  if (key === "Enter") return { kind: "confirm" }
  return { kind: "none" }
}

/** The chooser's filter, pure: case-insensitive substring on the full name. */
export const chooserFilter = <C extends { fullName: string }>(
  candidates: ReadonlyArray<C>,
  filter: string
): Array<C> => {
  const needle = filter.trim().toLowerCase()
  return needle === ""
    ? [...candidates]
    : candidates.filter((candidate) => candidate.fullName.toLowerCase().includes(needle))
}

/** Keep a 200+ repository account responsive while preserving local search over the whole inventory. */
export const REPO_CHOOSER_PAGE_SIZE = 50

/**
 * The chooser's arrow-key windowing, pure so it is testable without a DOM.
 * Moving down past the rendered window grows the window by a page instead of
 * wrapping, so a keyboard-only user can reach repositories past the first
 * page (previously the highlight wrapped at row 50 and the only way further
 * was the scroll handler). At the true end the highlight wraps to the top.
 */
export const chooserMove = (args: {
  readonly delta: 1 | -1
  readonly highlightedIndex: number
  readonly visibleCount: number
  readonly visibleLimit: number
  readonly totalCount: number
  readonly pageSize?: number
}): { readonly highlighted: number; readonly visibleLimit: number } => {
  const pageSize = args.pageSize ?? REPO_CHOOSER_PAGE_SIZE
  if (args.visibleCount === 0) return { highlighted: 0, visibleLimit: args.visibleLimit }
  if (args.delta === 1) {
    if (args.highlightedIndex + 1 < args.visibleCount) {
      return { highlighted: args.highlightedIndex + 1, visibleLimit: args.visibleLimit }
    }
    if (args.visibleLimit < args.totalCount) {
      return {
        highlighted: args.highlightedIndex + 1,
        visibleLimit: Math.min(args.visibleLimit + pageSize, args.totalCount)
      }
    }
    return { highlighted: 0, visibleLimit: args.visibleLimit }
  }
  return {
    highlighted: (args.highlightedIndex + args.visibleCount - 1) % args.visibleCount,
    visibleLimit: args.visibleLimit
  }
}

export const RepoChooserCardBody = ({
  card,
  onRepoToggle,
  onReposSelectAll,
  onReposSelectNone,
  onReposConfirm
}: {
  readonly card: Extract<Card, { kind: "repo-chooser" }>
  readonly onRepoToggle: (fullName: string) => void
  readonly onReposSelectAll: () => void
  readonly onReposSelectNone: () => void
  readonly onReposConfirm: () => void
}) => {
  const { candidates, selected, phase, error } = card.payload
  const [filter, setFilter] = useState("")
  const [highlighted, setHighlighted] = useState(0)
  const [visibleLimit, setVisibleLimit] = useState(REPO_CHOOSER_PAGE_SIZE)
  const saving = phase === "saving"
  const filteredRows = chooserFilter(candidates, filter)
  const visibleRows = filteredRows.slice(0, visibleLimit)
  const highlightedIndex = Math.min(highlighted, Math.max(visibleRows.length - 1, 0))

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const action = chooserKeyAction(event.key, filter)
    if (action.kind === "none") return
    event.preventDefault()
    if (action.kind === "move") {
      const next = chooserMove({
        delta: action.delta,
        highlightedIndex,
        visibleCount: visibleRows.length,
        visibleLimit,
        totalCount: filteredRows.length
      })
      if (next.visibleLimit !== visibleLimit) setVisibleLimit(next.visibleLimit)
      setHighlighted(next.highlighted)
      return
    }
    if (saving) return
    if (action.kind === "toggle") {
      const row = visibleRows[highlightedIndex]
      if (row !== undefined) onRepoToggle(row.fullName)
      return
    }
    onReposConfirm()
  }

  const activeDescendant = visibleRows.length === 0 ? undefined : `repo-chooser-option-${highlightedIndex}`

  return (
    <div className="repo-chooser">
      <input
        className="repo-chooser-filter"
        type="text"
        value={filter}
        placeholder="Type to filter repositories…"
        aria-label="Filter repositories"
        role="combobox"
        aria-expanded={true}
        aria-controls="repo-chooser-list"
        aria-activedescendant={activeDescendant}
        disabled={saving}
        onChange={(event) => {
          setFilter(event.target.value)
          setHighlighted(0)
          setVisibleLimit(REPO_CHOOSER_PAGE_SIZE)
        }}
        onKeyDown={onFilterKeyDown}
      />
      <ul
        className="repo-chooser-list"
        id="repo-chooser-list"
        role="listbox"
        aria-multiselectable
        aria-label="Your repositories"
        onScroll={(event) => {
          const list = event.currentTarget
          if (list.scrollTop + list.clientHeight < list.scrollHeight - 8) return
          setVisibleLimit((current) => Math.min(current + REPO_CHOOSER_PAGE_SIZE, filteredRows.length))
        }}
      >
        {visibleRows.map((candidate, index) => {
          const checked = selected.includes(candidate.fullName)
          return (
            <li key={candidate.fullName}>
              <button
                type="button"
                role="option"
                id={`repo-chooser-option-${index}`}
                aria-selected={checked}
                data-highlighted={index === highlightedIndex}
                className="repo-chooser-row"
                disabled={saving}
                onClick={() => onRepoToggle(candidate.fullName)}
              >
                <span className="repo-chooser-check" aria-hidden="true">
                  {checked ? <Check size={13} /> : null}
                </span>
                <span className="repo-chooser-name">{candidate.fullName}</span>
                {
                  /* NO INVENTION: the brief names three columns — name, freshness,
								    open-issue count. `private` stays on the wire contract, unshown. */
                }
                <span className="repo-chooser-freshness">{freshnessLabel(candidate.pushedAt)}</span>
                <span className="repo-chooser-issues">
                  {candidate.openIssues} open issue{candidate.openIssues === 1 ? "" : "s"}
                </span>
              </button>
            </li>
          )
        })}
        {visibleRows.length === 0 ? <li className="repo-chooser-empty">No repositories match.</li> : null}
      </ul>
      <div className="repo-chooser-actions">
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => onReposSelectAll()}>
          All
        </Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => onReposSelectNone()}>
          None
        </Button>
        <Button
          size="sm"
          data-flow="repos.watch.confirm"
          disabled={saving}
          loading={saving}
          onClick={() => onReposConfirm()}
        >
          Watch {selected.length} {selected.length === 1 ? "repository" : "repositories"}
        </Button>
      </div>
      {phase === "failed" && error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
    </div>
  )
}

/*
 * The connect surface as an embedded card (§2c″ — the agent's connect form):
 * the same extension-store grammar as the pane, derived from the session the
 * card was rendered with. Sign-in and the GitHub connector are one act
 * (§2a′): a signed-in session reads Connected, never "connect again".
 */
export const ConnectCardBody = ({
  card,
  onConnectGitHub,
  onConnectLocal,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "connect" }>
  readonly onConnectGitHub: () => void
  readonly onConnectLocal: () => void
  readonly onRunCommand: (name: string, args?: string) => void
}) => (
  <ul className="connect-store-list">
    <li className="connect-store-row">
      <span className="connect-store-icon">
        <GitPullRequest size={16} aria-hidden="true" />
      </span>
      <span className="connect-store-text">
        <strong>GitHub</strong>
        <span>Issues, pull requests, and reviews from the repositories you choose.</span>
      </span>
      {card.payload.github.connected ?
        <Badge variant="success">Connected ✓ as {card.payload.github.login ?? "you"}</Badge> :
        (
          <Button size="sm" data-flow="auth.sign-in" onClick={() => onConnectGitHub()}>
            Connect
          </Button>
        )}
    </li>
    {card.payload.nativeAvailable ?
      (
        <li className="connect-store-row">
          <span className="connect-store-icon">
            <HardDrive size={16} aria-hidden="true" />
          </span>
          <span className="connect-store-text">
            <strong>Local repository</strong>
            <span>A repository on this machine, read directly.</span>
          </span>
          <Button size="sm" variant="outline" data-flow="connector.add" onClick={() => onConnectLocal()}>
            Connect
          </Button>
        </li>
      ) :
      null}
    <li className="connect-store-row">
      <span className="connect-store-icon">
        <Server size={16} aria-hidden="true" />
      </span>
      <span className="connect-store-text">
        <strong>Smithers Cloud repository</strong>
        <span>Import a GitHub repository into hosted workspace storage.</span>
      </span>
      <Button size="sm" variant="outline" data-flow="repos.import" onClick={() => onRunCommand("repos.import")}>
        Import
      </Button>
    </li>
  </ul>
)

/*
 * The world query's embedded answer card (§2c″) — the answer rides in the chat
 * text beside it. The card is a browsable slice of the world: the surfaced
 * documents as a file tree, the selected one open in the markdown editor.
 * Bodies come from the LIVE worldDocuments collection (the payload is a
 * path/title/confidence snapshot), so a note deleted since the query gets an
 * honest note instead of stale text.
 */
export const WorldCardBody = ({
  card,
  worldDocuments,
  onChangeWorldDocument
}: {
  readonly card: Extract<Card, { kind: "world" }>
  readonly worldDocuments: ReadonlyArray<WorldDocument>
  readonly onChangeWorldDocument: (id: string, body: string) => void
}) => {
  const [selectedPath, setSelectedPath] = useState(card.payload.documents[0]?.path)
  if (card.payload.documents.length === 0) {
    return (
      <ul className="world-card-list">
        <li className="world-card-empty">{WORLD_DISPLAY_NAME} is empty so far.</li>
      </ul>
    )
  }
  const selectedEntry = card.payload.documents.find((document) => document.path === selectedPath) ??
    card.payload.documents[0]
  const selectedDocument = worldDocuments.find(
    (document) => document.path === selectedEntry.path
  )
  return (
    <div className="world-card-workspace">
      <aside className="world-card-sidebar" aria-label={`${WORLD_DISPLAY_NAME} documents`}>
        <FileTree
          nodes={card.payload.documents.map((document) => ({
            path: document.path,
            label: document.title
          }))}
          selected={selectedEntry.path}
          onSelect={(path) => setSelectedPath(path)}
        />
      </aside>
      <div className="world-card-doc">
        {
          /*
           * No confidence badge. A bare "80%" is a score, and no score,
           * grade or number is user-facing (DESIGN.md, launch-checklist
           * row B-5). The confidence still rides the entry for ranking;
           * it is not shown.
           */
        }
        <div className="world-card-meta">
          <span className="world-card-path">{selectedEntry.path}</span>
        </div>
        {selectedDocument !== undefined ?
          (
            <Suspense fallback={<p className="smithers-card-note">Loading editor…</p>}>
              <MarkdownEditorSurface
                value={selectedDocument.body}
                resetKey={selectedDocument.id}
                label={`Edit ${selectedDocument.title}`}
                onChange={(body) => onChangeWorldDocument(selectedDocument.id, body)}
              />
            </Suspense>
          ) :
          (
            <p className="world-card-empty">
              This note has left {WORLD_DISPLAY_NAME} since the answer was written.
            </p>
          )}
      </div>
    </div>
  )
}

/*
 * The browser surface (§2d′): the page embedded in an iframe with its URL
 * visible; a site that refuses framing gets the honest state + the one next
 * step, never a silent blank.
 */
export const BrowserCardBody = ({ card }: { readonly card: Extract<Card, { kind: "browser" }> }) => {
  const { url, finalUrl, frameable, blockReason, error } = card.payload
  const shownUrl = finalUrl ?? url
  if (error !== undefined) {
    return (
      <p className="sui-approval-error" role="alert">
        {error}
      </p>
    )
  }
  return (
    <div className="browser-card">
      {/* NO INVENTION: §2d′ asks for the frame with the URL visible — nothing else. */}
      <p className="browser-card-url">
        <ExternalLink size={12} aria-hidden="true" /> {shownUrl}
      </p>
      {frameable ?
        (
          /*
           * §8.13: the app document is cross-origin isolated (COEP
           * require-corp) because OPFS needs it, and under that policy Chrome
           * blocks every cross-origin frame whose response carries no CORP
           * header — which is practically every site on the public web. The
           * frame went to chrome-error:// and the card rendered an empty white
           * box while its pill still read DONE. A credentialless frame is the
           * escape hatch the policy ships with: it loads third-party documents
           * without credentials and without demanding CORP of them, and the
           * document stays isolated.
           */
          <iframe
            className="browser-card-frame"
            src={shownUrl}
            title={shownUrl}
            // @ts-expect-error React has no typing for the credentialless attribute yet.
            credentialless=""
            sandbox="allow-scripts allow-same-origin"
          />
        ) :
        (
          <div className="browser-card-blocked">
            <p>{blockReason ?? "This site can't be embedded here."}</p>
            <a className="browser-card-open" href={shownUrl} target="_blank" rel="noreferrer">
              Open in a new tab
            </a>
          </div>
        )}
    </div>
  )
}

