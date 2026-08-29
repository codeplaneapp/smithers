import {
  Badge,
  Button,
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  FileTree,
  Markdown,
  Plan,
  PlanContent,
  PlanStep,
  Progress,
  StatusPill
} from "@smthrs/ui"
import type { ApprovalState } from "@smthrs/ui"
import { MarkdownEditor } from "@smthrs/ui/adapters/markdown-editor"
import { Check, ExternalLink, GitPullRequest, HardDrive, Maximize2, Minimize2, PanelTop, Server } from "lucide-react"
import { useState } from "react"
import type { KeyboardEvent } from "react"
import { BranchesCardBody } from "./cards/BranchesCard"
import { AffectedCardBody } from "./cards/AffectedCard"
import { CiMatrixCardBody } from "./cards/CiMatrixCard"
import { EnvCardBody } from "./cards/EnvCard"
import { FileCardBody, FileListCardBody } from "./cards/FileCards"
import { GraphCardBody } from "./cards/GraphCard"
import { IssueCardBody, IssueListCardBody } from "./cards/IssueCards"
import { KeysCardBody } from "./cards/KeysCard"
import { LandingCardBody, LandingListCardBody } from "./cards/LandingCards"
import { NotificationsCardBody } from "./cards/NotificationsCard"
import { RepoImportCardBody } from "./cards/RepoImportCard"
import { RunHistoryCardBody } from "./cards/RunHistoryCard"
import { RunTimelineCardBody } from "./cards/RunTimelineCard"
import { HtmlCardBody, RepoCardBody, TargetRunCardBody, TargetsCardBody } from "./cards/TargetCards"
import { ThemePickerCardBody } from "./cards/ThemePickerCard"
import type { Card, WorldDocument } from "./state/AppState"
import { WORLD_DISPLAY_NAME } from "./state/AppState"
import { timeLabel as clockLabel } from "./Timestamps"

const pillStatus = (card: Card): string => {
  if (card.status === "error") return "failed"
  if (card.kind === "approval") {
    if (card.status === "acted") return card.payload.decision ?? "approved"
    return "waiting-approval"
  }
  if (card.kind === "plan") {
    if (card.status === "acted") return "done"
    if (card.payload.items.length > 0 && card.payload.items.every((item) => item.status === "done")) {
      return "done"
    }
    if (card.payload.items.some((item) => item.status === "active")) return "running"
    return "pending"
  }
  if (card.kind === "balance") {
    if (card.payload.state === "empty") return "failed"
    if (card.payload.state === "low") return "pending"
    return "done"
  }
  if (card.kind === "grant-confirm") {
    if (card.payload.phase === "granted") return "done"
    if (card.payload.phase === "sending") return "running"
    return "waiting-approval"
  }
  /*
   * These cards only exist once their read has settled — the seam upserts
   * them after the answer arrives. Badging them PENDING made "still loading"
   * and "finished, nothing more coming" the same badge, so a read that
   * genuinely hung looked exactly like one that had rendered everything
   * (§28.3).
   */
  if (
    card.kind === "request-queue" ||
    card.kind === "admin-health" ||
    card.kind === "theme-picker"
  ) {
    return "done"
  }
  if (card.kind === "repo-chooser") {
    if (card.payload.phase === "saving") return "running"
    return "waiting-approval"
  }
  if (card.kind === "connect" || card.kind === "world" || card.kind === "browser") {
    return "done"
  }
  if (card.kind === "flow-run") {
    if (card.payload.phase === "completed") return "done"
    if (card.payload.phase === "failed" || card.payload.phase === "cancelled" || card.payload.phase === "no-capacity") {
      return "failed"
    }
    if (card.payload.phase === "waiting-approval") return "waiting-approval"
    /*
     * Wave 12 §3: a card whose body says the run has gone quiet, or that
     * nobody is watching it any more, may not wear a Running pill. The pill
     * is the most glanceable claim on the card, and "Running" is precisely
     * the thing neither of these states can vouch for — they read Quiet and
     * Stopped, muted, through the shared status vocabulary.
     */
    if (card.payload.phase === "quiet" || card.payload.phase === "stopped") return card.payload.phase
    return "running"
  }
  if (card.kind === "workflow-list") return "done"
  if (card.kind === "repo-import") {
    if (card.payload.phase === "done") return "done"
    if (card.payload.phase === "failed") return "failed"
    return "running"
  }
  if (
    card.kind === "issue-list" ||
    card.kind === "issue" ||
    card.kind === "pr-list" ||
    card.kind === "pr" ||
    card.kind === "keys" ||
    card.kind === "notifications" ||
    card.kind === "env" ||
    card.kind === "branches" ||
    card.kind === "file-list" ||
    card.kind === "file"
  ) {
    // card.status "error" already answered "failed" at the top.
    return "done"
  }
  /* Lane L3 (docs/LOCAL-APP.md "Cards"): the payload's own status leads. */
  if (card.kind === "targets") return card.payload.status
  if (card.kind === "target-run") return card.payload.status
  /* The target-graph cards' payloads carry their own read status the same way. */
  if (card.kind === "graph" || card.kind === "run-history" || card.kind === "affected" || card.kind === "ci-matrix") {
    return card.payload.status
  }
  if (card.kind === "run-timeline") return card.payload.status
  if (card.kind === "html" || card.kind === "repo") return "done"
  if (card.status === "acted") return "done"
  if (card.kind !== "status") return "pending"
  const progress = card.payload.progress
  return progress !== undefined && progress >= 1 ? "done" : "running"
}

const PlanCardBody = ({ card }: { readonly card: Extract<Card, { kind: "plan" }> }) => (
  <>
    {card.body !== undefined ? <Markdown className="smithers-card-markdown" content={card.body} /> : null}
    <Plan defaultOpen>
      <PlanContent>
        <ol className="sui-plan-steps">
          {card.payload.items.map((item) => <PlanStep key={item.id} label={item.title} status={item.status} />)}
        </ol>
      </PlanContent>
    </Plan>
  </>
)

const ApprovalCardBody = ({
  card,
  onDecideApproval
}: {
  readonly card: Extract<Card, { kind: "approval" }>
  readonly onDecideApproval: (id: string, decision: "approved" | "denied") => void
}) => {
  const payload = card.payload
  const pending = payload.pending === true
  const state: ApprovalState = card.status === "error"
    ? "failed-submission"
    : card.status === "acted"
    ? (payload.decision ?? "approved")
    : "requested"
  const summary = card.body ?? payload.detail
  const stamp = payload.decidedAt !== undefined
    ? `${payload.decision === "denied" ? "Denied" : "Approved"} — ${clockLabel(payload.decidedAt)}`
    : undefined
  return (
    <Confirmation state={state}>
      <ConfirmationRequest>
        {summary !== undefined ? <div className="sui-approval-summary">{summary}</div> : null}
        <ul className="sui-approval-actions-list">
          <li>{payload.capability}</li>
        </ul>
      </ConfirmationRequest>
      {pending ? <p className="sui-approval-pending">Sending your decision…</p> : (
        <ConfirmationActions>
          <ConfirmationAction
            decision="approve"
            onDecide={() => onDecideApproval(card.id, "approved")}
          />
          <ConfirmationAction
            decision="deny"
            onDecide={() => onDecideApproval(card.id, "denied")}
          />
        </ConfirmationActions>
      )}
      {card.status === "error" && payload.error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {payload.error}
          </p>
        ) :
        null}
      <ConfirmationAccepted>{stamp}</ConfirmationAccepted>
      <ConfirmationRejected>{stamp}</ConfirmationRejected>
    </Confirmation>
  )
}

const BalanceCardBody = ({ card }: { readonly card: Extract<Card, { kind: "balance" }> }) => (
  <>
    {card.payload.introUsd !== null ?
      <p className="smithers-balance-intro">You have ${card.payload.introUsd} of usage on us.</p> :
      null}
    <p className="smithers-balance-total">
      {card.payload.allowedToStartWork
        ? `$${card.payload.totalUsd} left.`
        : "Balance is at $0 — new work is paused; everything already here stays readable."}
    </p>
    {card.payload.chargeCount > 0 ?
      (
        <p className="smithers-card-note">
          ${card.payload.lifetimeChargedUsd} spent across {card.payload.chargeCount} turn
          {card.payload.chargeCount === 1 ? "" : "s"} so far.
        </p>
      ) :
      null}
  </>
)

const StatusCardBody = ({ card }: { readonly card: Extract<Card, { kind: "status" }> }) => (
  <>
    {card.body !== undefined ? <Markdown className="smithers-card-markdown" content={card.body} /> : null}
    {card.payload.progress !== undefined ?
      <Progress className="smithers-card-progress" value={Math.round(card.payload.progress * 100)} /> :
      null}
    {card.payload.note !== undefined ? <p className="smithers-card-note">{card.payload.note}</p> : null}
  </>
)

const GrantConfirmCardBody = ({
  card,
  onGrantConfirm,
  onGrantCancel
}: {
  readonly card: Extract<Card, { kind: "grant-confirm" }>
  readonly onGrantConfirm: (id: string) => void
  readonly onGrantCancel: (id: string) => void
}) => {
  const { login, amountUsd, phase, grantId, error } = card.payload
  return (
    <div className="grant-card">
      <p className="grant-what">
        Grant <strong>${amountUsd}</strong> of promotional balance to <strong>{login}</strong>.
      </p>
      <p className="smithers-card-note">
        The grant is recorded with your login as the requester and a fresh timestamp; the billing service answers before
        anything is treated as done.
      </p>
      {phase === "confirm" || phase === "failed" ?
        (
          <div className="reco-actions">
            <Button size="sm" onClick={() => onGrantConfirm(card.id)}>
              {phase === "failed" ? "Try again" : "Post the grant"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onGrantCancel(card.id)}>
              Cancel
            </Button>
          </div>
        ) :
        null}
      {phase === "sending" ? <p className="sui-approval-pending">Posting the grant…</p> : null}
      {phase === "granted" ?
        (
          <p className="smithers-card-note">
            Granted{grantId !== undefined ? ` — ${grantId}` : ""}.
          </p>
        ) :
        null}
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

const RequestQueueCardBody = ({
  card,
  onQueueApprove
}: {
  readonly card: Extract<Card, { kind: "request-queue" }>
  readonly onQueueApprove: (login: string) => void
}) => {
  const { requests, approving, error } = card.payload
  if (requests.length === 0) {
    return <p className="smithers-card-note">The queue is empty — nobody is waiting.</p>
  }
  return (
    <div className="queue-card">
      <ul className="queue-list">
        {requests.map((entry) => (
          <li key={entry.login} className="queue-row">
            <span className="queue-login">{entry.login}</span>
            {entry.note !== null ? <span className="queue-note">{entry.note}</span> : null}
            <span className="queue-at">{entry.createdAt.slice(0, 10)}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={approving !== null}
              onClick={() => onQueueApprove(entry.login)}
            >
              {approving === entry.login ? "Approving…" : "Approve"}
            </Button>
          </li>
        ))}
      </ul>
      {error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
    </div>
  )
}

const AdminHealthCardBody = ({ card }: { readonly card: Extract<Card, { kind: "admin-health" }> }) => {
  const { services, queueDepth, charges, checkedAt } = card.payload
  return (
    <div className="admin-health">
      <ul className="admin-health-services">
        {services.map((service) => (
          <li key={service.name} data-status={service.status}>
            <StatusPill
              status={service.status === "ok" ? "done" : service.status === "failed" ? "failed" : "pending"}
            />{" "}
            <strong>{service.name}</strong> — {service.detail}
          </li>
        ))}
      </ul>
      <p className="smithers-card-note">
        {queueDepth === null
          ? "Request queue depth: unread."
          : `Request queue: ${queueDepth} waiting.`} {charges === null
          ? "Charges: unread."
          : `Charges: $${charges.lifetimeChargedUsd} across ${charges.chargeCount} turn${
            charges.chargeCount === 1 ? "" : "s"
          }.`} Read at {checkedAt.replace("T", " ").slice(0, 16)}.
      </p>
    </div>
  )
}

export interface CardViewProps {
  readonly card: Card
  readonly maximized: boolean
  readonly onDecideApproval: (id: string, decision: "approved" | "denied") => void
  readonly onGrantConfirm: (id: string) => void
  readonly onGrantCancel: (id: string) => void
  readonly onQueueApprove: (login: string) => void
  readonly onRepoToggle: (fullName: string) => void
  readonly onReposSelectAll: () => void
  readonly onReposSelectNone: () => void
  readonly onReposConfirm: () => void
  readonly onMaximize: (id: string) => void
  readonly onMinimize: () => void
  /* A maximized card's "Open in tab" (docs/LOCAL-APP.md "Cards"): user-triggered only. */
  readonly onOpenInTab: (id: string) => void
  readonly onConnectGitHub: () => void
  readonly onConnectLocal: () => void
  readonly onRunWorkflow: (name: string) => void
  /* Wave 12 — the run card's quiet-state acts and the which-repo answer. */
  readonly onStopRun: (cardId: string) => void
  readonly onRetryRun: (cardId: string) => void
  readonly onChooseWorkflowRepo: (fullName: string) => void
  /* The world card reads live documents so its editor never shows stale bodies. */
  readonly worldDocuments: ReadonlyArray<WorldDocument>
  readonly onChangeWorldDocument: (id: string, body: string) => void
  /*
   * The one delegated dispatch for the domain cards (issues, PRs, keys,
   * notifications, env, import): every in-card act names its command and
   * routes through the registry at the App.tsx binding site.
   */
  readonly onRunCommand: (name: string, args?: string) => void
}

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

const RepoChooserCardBody = ({
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
const ConnectCardBody = ({
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
const WorldCardBody = ({
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
            <MarkdownEditor
              value={selectedDocument.body}
              resetKey={selectedDocument.id}
              aria-label={`Edit ${selectedDocument.title}`}
              onChange={(body) => onChangeWorldDocument(selectedDocument.id, body)}
            />
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
const BrowserCardBody = ({ card }: { readonly card: Extract<Card, { kind: "browser" }> }) => {
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

/*
 * Wave 11 — the embedded run card: live status from the relay event stream,
 * node progress in words, the result leading once the run settles. Stream
 * loss is routine and stated honestly ("reconnecting"), never a silent stall.
 */
const WORKFLOW_RUN_PHASE_WORDS: Readonly<Record<string, string>> = {
  launching: "Starting the run…",
  running: "Running on your workspace.",
  "waiting-approval": "Waiting for your approval below.",
  reconnecting: "Reconnecting to the workspace — the run continues; this card catches up on its own.",
  /* Wave 12 §3 — the bounded stance: honest, not silent, and not still polling. */
  quiet: "This run has gone quiet — no progress from your workspace for a long time, so I stopped checking.",
  stopped: "I stopped watching this run. It may still be running on your workspace.",
  completed: "Finished.",
  failed: "Failed.",
  cancelled: "Cancelled.",
  "no-capacity": "No workspace capacity right now."
}

const WorkflowRunCardBody = ({
  card,
  onStopRun,
  onRetryRun
}: {
  readonly card: Extract<Card, { kind: "flow-run" }>
  readonly onStopRun: (cardId: string) => void
  readonly onRetryRun: (cardId: string) => void
}) => {
  const { phase, steps, result, error } = card.payload
  return (
    <div className="flow-run-card">
      {result !== null ? <Markdown className="smithers-card-markdown" content={result} /> : null}
      <p className="smithers-card-note">{WORKFLOW_RUN_PHASE_WORDS[phase] ?? phase}</p>
      {steps.length > 0 ?
        (
          <ul className="flow-run-steps">
            {steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
          </ul>
        ) :
        null}
      {/* §3: the two acts a quiet run offers — both registered commands. */}
      {phase === "quiet" ?
        (
          <div className="flow-run-actions">
            <Button size="sm" data-flow="flow.run.retry" onClick={() => onRetryRun(card.id)}>
              Check again
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-flow="flow.run.stop"
              onClick={() => onStopRun(card.id)}
            >
              Stop watching
            </Button>
          </div>
        ) :
        null}
      {(phase === "failed" || phase === "cancelled" || phase === "no-capacity") && error !== undefined ?
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
 * Wave 12 §2 — which watched repository. Embedded, keyboard-complete (arrows
 * move, Enter chooses), and one act: choosing IS the confirm, so the create
 * resumes immediately on the repo the human named.
 */
const WorkflowRepoCardBody = ({
  card,
  onChooseWorkflowRepo
}: {
  readonly card: Extract<Card, { kind: "workflow-repo" }>
  readonly onChooseWorkflowRepo: (fullName: string) => void
}) => {
  const { repos, chosen, description } = card.payload
  const [highlighted, setHighlighted] = useState(0)
  const index = Math.min(highlighted, Math.max(repos.length - 1, 0))
  if (chosen !== null) {
    return <p className="smithers-card-note">Creating it on {chosen}.</p>
  }
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (repos.length === 0) return
      setHighlighted(
        event.key === "ArrowDown" ? (index + 1) % repos.length : (index + repos.length - 1) % repos.length
      )
      return
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      const repo = repos[index]
      if (repo !== undefined) onChooseWorkflowRepo(repo)
    }
  }
  return (
    <div className="workflow-repo-chooser">
      <p className="smithers-card-note">{description}</p>
      <ul
        className="workflow-repo-list"
        role="listbox"
        aria-label="Your watched repositories"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {repos.map((repo, position) => (
          <li key={repo}>
            <button
              type="button"
              role="option"
              aria-selected={position === index}
              data-highlighted={position === index}
              className="workflow-repo-row"
              data-flow="flow.repo.choose"
              onMouseEnter={() => setHighlighted(position)}
              onClick={() => onChooseWorkflowRepo(repo)}
            >
              {repo}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* The workspace's workflows (flow.list) — each row's Run is a command binding. */
const WorkflowListCardBody = ({
  card,
  onRunWorkflow
}: {
  readonly card: Extract<Card, { kind: "workflow-list" }>
  readonly onRunWorkflow: (name: string) => void
}) => {
  const { workflows } = card.payload
  if (workflows.length === 0) {
    return <p className="smithers-card-note">No workflows on this workspace yet — ask for one and I'll create it.</p>
  }
  return (
    <ul className="workflow-list">
      {workflows.map((workflow) => (
        <li key={workflow.key} className="workflow-list-row">
          <span className="workflow-list-text">
            <strong>{workflow.key}</strong>
            {workflow.description !== null ? <span>{workflow.description}</span> : null}
          </span>
          <Button
            size="sm"
            variant="outline"
            data-flow="flow.run"
            onClick={() => onRunWorkflow(workflow.key)}
          >
            Run
          </Button>
        </li>
      ))}
    </ul>
  )
}

export function CardView({
  card,
  maximized,
  onDecideApproval,
  onGrantConfirm,
  onGrantCancel,
  onQueueApprove,
  onRepoToggle,
  onReposSelectAll,
  onReposSelectNone,
  onReposConfirm,
  onMaximize,
  onMinimize,
  onOpenInTab,
  onConnectGitHub,
  onConnectLocal,
  onRunWorkflow,
  onStopRun,
  onRetryRun,
  onChooseWorkflowRepo,
  worldDocuments,
  onChangeWorldDocument,
  onRunCommand
}: CardViewProps) {
  return (
    <>
      {maximized ?
        (
          <div
            className="card-maximize-backdrop"
            aria-hidden="true"
            onClick={() => onMinimize()}
          />
        ) :
        null}
      <section
        className="smithers-card"
        data-kind={card.kind}
        data-status={card.status}
        data-maximized={maximized}
        data-run-id={card.kind === "flow-run" ? card.payload.runId : undefined}
        data-testid={`card-${card.id}`}
        aria-label={card.title}
      >
        <header className="smithers-card-header">
          <span className="smithers-card-title">{card.title}</span>
          <StatusPill status={pillStatus(card)} />
          <span className="smithers-card-meta" data-testid={`card-kind-${card.kind}`}>
            {card.kind} · {clockLabel(card.createdAt)}
          </span>
          {maximized ?
            (
              <>
                {/* Open in tab exists only on the maximized card: a user's explicit act (THE EMBED LAW). */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="card-maximize-btn"
                  data-flow="tab.card"
                  data-testid={`card-open-in-tab-${card.id}`}
                  aria-label="Open in tab"
                  title="Open in tab"
                  onClick={() => onOpenInTab(card.id)}
                >
                  <PanelTop size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="card-minimize-btn"
                  data-flow="card.minimize"
                  aria-label="Minimize card"
                  title="Minimize card"
                  onClick={() => onMinimize()}
                >
                  <Minimize2 size={13} />
                </Button>
              </>
            ) :
            (
              <Button
                variant="ghost"
                size="icon"
                className="card-maximize-btn"
                data-flow="card.maximize"
                data-testid={`card-maximize-${card.id}`}
                aria-label="Maximize card"
                title="Maximize card"
                onClick={() => onMaximize(card.id)}
              >
                <Maximize2 size={13} />
              </Button>
            )}
        </header>
        <div className="smithers-card-body">
          {card.kind === "plan" ? <PlanCardBody card={card} /> : null}
          {card.kind === "approval" ? <ApprovalCardBody card={card} onDecideApproval={onDecideApproval} /> : null}
          {card.kind === "status" ? <StatusCardBody card={card} /> : null}
          {card.kind === "balance" ? <BalanceCardBody card={card} /> : null}
          {card.kind === "grant-confirm" ?
            <GrantConfirmCardBody card={card} onGrantConfirm={onGrantConfirm} onGrantCancel={onGrantCancel} /> :
            null}
          {card.kind === "request-queue" ? <RequestQueueCardBody card={card} onQueueApprove={onQueueApprove} /> : null}
          {card.kind === "admin-health" ? <AdminHealthCardBody card={card} /> : null}
          {card.kind === "repo-chooser" ?
            (
              <RepoChooserCardBody
                card={card}
                onRepoToggle={onRepoToggle}
                onReposSelectAll={onReposSelectAll}
                onReposSelectNone={onReposSelectNone}
                onReposConfirm={onReposConfirm}
              />
            ) :
            null}
          {card.kind === "connect" ?
            (
              <ConnectCardBody
                card={card}
                onConnectGitHub={onConnectGitHub}
                onConnectLocal={onConnectLocal}
                onRunCommand={onRunCommand}
              />
            ) :
            null}
          {card.kind === "world" ?
            (
              <WorldCardBody
                card={card}
                worldDocuments={worldDocuments}
                onChangeWorldDocument={onChangeWorldDocument}
              />
            ) :
            null}
          {card.kind === "browser" ? <BrowserCardBody card={card} /> : null}
          {card.kind === "flow-run" ?
            <WorkflowRunCardBody card={card} onStopRun={onStopRun} onRetryRun={onRetryRun} /> :
            null}
          {card.kind === "workflow-list" ? <WorkflowListCardBody card={card} onRunWorkflow={onRunWorkflow} /> : null}
          {card.kind === "workflow-repo" ?
            <WorkflowRepoCardBody card={card} onChooseWorkflowRepo={onChooseWorkflowRepo} /> :
            null}
          {card.kind === "issue-list" ? <IssueListCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "issue" ? <IssueCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "pr-list" ? <LandingListCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "pr" ? <LandingCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "keys" ? <KeysCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "notifications" ? <NotificationsCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "env" ? <EnvCardBody card={card} /> : null}
          {card.kind === "repo-import" ? <RepoImportCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "branches" ? <BranchesCardBody card={card} /> : null}
          {card.kind === "file-list" ? <FileListCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "file" ? <FileCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "theme-picker" ? <ThemePickerCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "repo" ? <RepoCardBody card={card} /> : null}
          {card.kind === "targets" ? <TargetsCardBody card={card} /> : null}
          {card.kind === "html" ? <HtmlCardBody card={card} /> : null}
          {card.kind === "target-run" ? <TargetRunCardBody card={card} /> : null}
          {card.kind === "graph" ? <GraphCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "run-timeline" ? <RunTimelineCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "run-history" ? <RunHistoryCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "affected" ? <AffectedCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "ci-matrix" ? <CiMatrixCardBody card={card} /> : null}
        </div>
      </section>
    </>
  )
}
