import {
  Button,
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  Markdown,
  Plan,
  PlanContent,
  PlanStep,
  Progress,
  StatusPill
} from "@smthrs/ui"
import type { ApprovalState } from "@smthrs/ui"
import { agentRole } from "smithers-shared/AgentRoles"
import { ArrowLeft, ArrowRight, GitFork, Maximize2, Minimize2, PanelTop } from "lucide-react"
import { lazy, Suspense, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import { BranchesCardBody } from "./cards/BranchesCard"
import { AffectedCardBody } from "./cards/AffectedCard"
import { CiMatrixCardBody } from "./cards/CiMatrixCard"
import {
  BrowserCardBody,
  ConnectCardBody,
  WorldCardBody
} from "./cards/ConversationCards"
import { EnvCardBody } from "./cards/EnvCard"
import { FileCardBody, FileListCardBody } from "./cards/FileCards"
import { IssueCardBody, IssueListCardBody } from "./cards/IssueCards"
import { KeysCardBody } from "./cards/KeysCard"
import { LandingCardBody, LandingListCardBody } from "./cards/LandingCards"
import { NotificationsCardBody } from "./cards/NotificationsCard"
import { RepoImportCardBody } from "./cards/RepoImportCard"
import { RunHistoryCardBody } from "./cards/RunHistoryCard"
import { RunTimelineCardBody } from "./cards/RunTimelineCard"
import { RepoPluginCardBody } from "./cards/RepoPluginCard"
import { ApprovalsInboxCardBody, RunListCardBody } from "./cards/RunsCards"
import { HtmlCardBody, RepoCardBody, TargetRunCardBody, TargetsCardBody } from "./cards/TargetCards"
import { ThemePickerCardBody } from "./cards/ThemePickerCard"
import type { Card, WorldDocument } from "./state/AppState"
import { timeLabel as clockLabel } from "./Timestamps"

const GraphCardBody = lazy(() =>
  import("./cards/GraphCard").then((module) => ({ default: module.GraphCardBody }))
)

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
  /* Lane runs: the inboxes are listings — they settle the moment they render. */
  if (card.kind === "run-list" || card.kind === "approvals-inbox") return "done"
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
  if (card.kind === "html" || card.kind === "repo" || card.kind === "repo-plugin") return "done"
  /* A subagent's pill is its process: running, done on a clean exit, failed otherwise. */
  if (card.kind === "agent") {
    if (card.payload.phase === "running") return "running"
    return card.payload.exitCode === 0 || card.payload.exitCode === null ? "done" : "failed"
  }
  if (card.kind === "explain") {
    if (card.payload.phase === "asking") return "running"
    return card.payload.phase === "answered" ? "done" : "failed"
  }
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
  readonly onMaximize: (id: string) => void
  readonly onMinimize: () => void
  readonly onFrameBack?: () => void
  readonly onFrameForward?: () => void
  readonly onForkFrame?: () => void
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
  /*
   * Lane runs — the session's verbose flag, so the run card's Events tab (the
   * raw journal, a debug surface) exists only where verbose does.
   */
  readonly debugVerbose?: boolean
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

export const WorkflowRunCardBody = ({
  card,
  onStopRun,
  onRetryRun,
  onRunCommand,
  debugVerbose = false
}: {
  readonly card: Extract<Card, { kind: "flow-run" }>
  readonly onStopRun: (cardId: string) => void
  readonly onRetryRun: (cardId: string) => void
  readonly onRunCommand: (name: string, args?: string) => void
  readonly debugVerbose?: boolean
}) => {
  const { phase, steps, result, error, runId } = card.payload
  const facet = card.payload.facet ?? "steps"
  return (
    <div className="flow-run-card">
      {result !== null ? <Markdown className="smithers-card-markdown" content={result} /> : null}
      <p className="smithers-card-note">{WORKFLOW_RUN_PHASE_WORDS[phase] ?? phase}</p>
      {/* Lane runs: why a live run is not moving, in the control plane's word. */}
      {card.payload.waiting !== undefined ?
        (
          <p className="smithers-card-note" data-testid={`flow-run-waiting-${runId}`}>
            {card.payload.waiting === "executor"
              ? "Accepted — nothing is driving it yet. /runs.resume starts it."
              : `Waiting on ${card.payload.waiting}.`}
          </p>
        ) :
        null}
      {card.payload.steeringPending === true ?
        <p className="smithers-card-note">steering pending · delivered at the next turn</p> :
        null}
      {/*
       * The facets the card grows (lane runs): the steps tail by default, the
       * transcript on demand (runs.logs), the raw journal only where verbose
       * is on (runs.events). Each tab is a registered flow, never local state.
       */}
      <div className="flow-run-actions" role="tablist" aria-label="Run views">
        <Button
          size="sm"
          variant={facet === "steps" ? "default" : "outline"}
          data-flow="runs.steps"
          data-testid={`flow-run-facet-steps-${runId}`}
          onClick={() => onRunCommand("runs.steps", runId)}
        >
          Steps
        </Button>
        <Button
          size="sm"
          variant={facet === "transcript" ? "default" : "outline"}
          data-flow="runs.logs"
          data-testid={`flow-run-facet-transcript-${runId}`}
          onClick={() => onRunCommand("runs.logs", runId)}
        >
          Transcript
        </Button>
        {debugVerbose ?
          (
            <Button
              size="sm"
              variant={facet === "events" ? "default" : "outline"}
              data-flow="runs.events"
              data-testid={`flow-run-facet-events-${runId}`}
              onClick={() => onRunCommand("runs.events", runId)}
            >
              Events
            </Button>
          ) :
          null}
      </div>
      {facet === "transcript" ?
        card.payload.transcriptRows === undefined || card.payload.transcriptRows.length === 0 ?
          <p className="smithers-card-note">The transcript is empty so far.</p> :
          (
            <ul className="flow-run-steps" data-testid={`flow-run-transcript-${runId}`}>
              {card.payload.transcriptRows.map((row) => (
                <li key={row.sequence}>
                  {row.turn !== undefined ? `turn ${row.turn} · ` : ""}{row.at !== undefined ? `${clockLabel(row.at)} · ` : ""}{row.kind !== undefined ? `${row.kind} · ` : ""}{row.text}
                </li>
              ))}
            </ul>
          ) :
        null}
      {facet === "events" && debugVerbose ?
        card.payload.events === undefined || card.payload.events.length === 0 ?
          <p className="smithers-card-note">No events recorded yet.</p> :
          (
            <ul className="flow-run-steps" data-testid={`flow-run-events-${runId}`}>
              {card.payload.events.map((event, index) => (
                <li key={index}>{JSON.stringify(event)}</li>
              ))}
            </ul>
          ) :
        null}
      {facet === "steps" && steps.length > 0 ?
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
      {/*
       * Lane runs — the lifecycle acts. Stop is available on every
       * non-terminal phase (the flow confirms); Resume answers a wait the
       * control plane named (anything but an approval, which the approval
       * card below answers); Run again relaunches a settled run with the
       * same input and refuses honestly when this client never recorded one.
       */}
      {LIVE_RUN_PHASES.has(phase) ?
        (
          <div className="flow-run-actions">
            {card.payload.waiting !== undefined && card.payload.waiting !== "approval" ?
              (
                <Button
                  size="sm"
                  variant="outline"
                  data-flow="runs.resume"
                  data-testid={`flow-run-resume-${runId}`}
                  onClick={() => onRunCommand("runs.resume", runId)}
                >
                  Resume
                </Button>
              ) :
              null}
            <Button
              size="sm"
              variant="outline"
              data-flow="flow.run.stop"
              data-testid={`flow-run-stop-${runId}`}
              onClick={() => onStopRun(card.id)}
            >
              Stop
            </Button>
          </div>
        ) :
        null}
      {TERMINAL_RUN_PHASES.has(phase) ?
        (
          <div className="flow-run-actions">
            <Button
              size="sm"
              variant="outline"
              data-flow="runs.rerun"
              data-testid={`flow-run-rerun-${runId}`}
              onClick={() => onRunCommand("runs.rerun", runId)}
            >
              Run again
            </Button>
          </div>
        ) :
        null}
      {LIVE_RUN_PHASES.has(phase) ? <RunSteerRow runId={runId} onRunCommand={onRunCommand} /> : null}
    </div>
  )
}

/** The phases a run can still be steered, resumed, or stopped in. */
const LIVE_RUN_PHASES: ReadonlySet<string> = new Set(["launching", "running", "waiting-approval", "reconnecting"])
/** The phases a Run again answers. */
// "stopped" is the phase a REFUSED cancel leaves (workflow-pump stopWatchingRun): the run may still be live, so it is not terminal.
const TERMINAL_RUN_PHASES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "no-capacity"])

/** The thinking levels a steer may name — the wire's own vocabulary (@smthrs/notifications). */
const THINKING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const

/*
 * Lane runs §5 — the steer row: an operator message into the next turn, and
 * the mono strip of the other three steer kinds. Every submit is the flow
 * (runs.steer / runs.seat / runs.thinking / runs.tools); the text under the
 * pointer is presentation state, cleared the moment its flow takes it.
 */
const RunSteerRow = ({
  runId,
  onRunCommand
}: {
  readonly runId: string
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const [message, setMessage] = useState("")
  const [seat, setSeat] = useState("")
  const [tools, setTools] = useState("")
  const sendMessage = (): void => {
    const body = message.trim()
    if (body === "") return
    onRunCommand("runs.steer", `${runId} ${body}`)
    setMessage("")
  }
  const sendSeat = (): void => {
    const value = seat.trim()
    if (value === "") return
    onRunCommand("runs.seat", `${runId} ${value}`)
    setSeat("")
  }
  const sendTools = (): void => {
    const value = tools.trim()
    if (value === "") return
    onRunCommand("runs.tools", `${runId} ${value}`)
    setTools("")
  }
  const onEnter = (submit: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      submit()
    }
  }
  return (
    <div className="flow-run-steer" data-testid={`flow-run-steer-${runId}`}>
      <div className="flow-run-actions">
        <input
          className="flow-run-steer-input"
          aria-label="Steer this run"
          placeholder="Steer this run — a message for the next turn"
          value={message}
          data-testid={`flow-run-steer-input-${runId}`}
          onInput={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={onEnter(sendMessage)}
        />
        <Button
          size="sm"
          variant="outline"
          data-flow="runs.steer"
          disabled={message.trim() === ""}
          onClick={() => {
            if (message.trim() === "") return
            onRunCommand("runs.steer", `${runId} ${message.trim()}`)
            setMessage("")
          }}
        >
          Steer
        </Button>
      </div>
      <div className="flow-run-actions flow-run-steer-strip">
        <input
          className="flow-run-steer-input flow-run-steer-small"
          aria-label="Move the run to a seat"
          placeholder="seat — provider:model"
          value={seat}
          onInput={(event) => setSeat(event.currentTarget.value)}
          onKeyDown={onEnter(sendSeat)}
        />
        <select
          className="flow-run-steer-select"
          aria-label="Change the thinking level"
          data-testid={`flow-run-thinking-${runId}`}
          value=""
          onChange={(event) => {
            const level = event.currentTarget.value
            if (level !== "") onRunCommand("runs.thinking", `${runId} ${level}`)
          }}
        >
          <option value="" disabled>
            thinking ▾
          </option>
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
        <input
          className="flow-run-steer-input flow-run-steer-small"
          aria-label="Add tools to the run"
          placeholder="tools — comma-separated"
          value={tools}
          onInput={(event) => setTools(event.currentTarget.value)}
          onKeyDown={onEnter(sendTools)}
        />
      </div>
    </div>
  )
}

/*
 * Wave 12 §2 — which loaded repository. Embedded, keyboard-complete (arrows
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
        aria-label="Your loaded repositories"
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

/*
 * A subagent launched from the `+` menu (docs/LOCAL-APP.md "Tabs"): which
 * harness, where it runs, whether it is still running, and the way back to
 * its tab — a registered flow (tab.select), so the card never owns the tab.
 */
const AgentCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "agent" }>
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const { displayName, cwd, phase, exitCode, tabId, roleId, task } = card.payload
  const role = roleId === undefined ? undefined : agentRole(roleId)
  const state = phase === "running"
    ? `${displayName} is running in ${cwd}.`
    : exitCode === null
    ? `${displayName} stopped.`
    : `${displayName} exited (${exitCode}).`
  return (
    <div className="agent-card" data-phase={phase} data-role={roleId}>
      {role !== undefined ? <p className="smithers-card-note agent-card-role">{role.purpose}</p> : null}
      {task !== undefined ? <p className="smithers-card-note agent-card-task">Task: {task}</p> : null}
      <p className="smithers-card-note">{state}</p>
      {phase === "running" ?
        (
          <div className="flow-run-actions">
            <Button
              size="sm"
              variant="outline"
              data-flow="tab.select"
              data-testid={`agent-open-tab-${tabId}`}
              onClick={() => onRunCommand("tab.select", tabId)}
            >
              Open tab
            </Button>
          </div>
        ) :
        null}
    </div>
  )
}

/* The explainer's answer (AgentRoles.ts): streams in place; says who was asked, never who answered. */
const ExplainCardBody = ({ card }: { readonly card: Extract<Card, { kind: "explain" }> }) => {
  const { question, answer, phase, answeredBy, error } = card.payload
  return (
    <div className="explain-card" data-phase={phase}>
      <p className="smithers-card-note explain-card-question">{question}</p>
      {answer !== "" ? <Markdown className="smithers-card-markdown" content={answer} /> : null}
      {phase === "asking" ? <p className="sui-approval-pending">Explaining…</p> : null}
      {phase === "failed" && error !== undefined ?
        (
          <p className="sui-approval-error" role="alert">
            {error}
          </p>
        ) :
        null}
      <p className="smithers-card-note explain-card-by">{answeredBy}</p>
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
  onMaximize,
  onMinimize,
  onFrameBack,
  onFrameForward,
  onForkFrame,
  onOpenInTab,
  onConnectGitHub,
  onConnectLocal,
  onRunWorkflow,
  onStopRun,
  onRetryRun,
  onChooseWorkflowRepo,
  worldDocuments,
  onChangeWorldDocument,
  onRunCommand,
  debugVerbose
}: CardViewProps) {
  /*
   * Maximize and minimize replace each other in the header, so the button
   * the pointer just pressed unmounts and focus falls to <body> — outside
   * the shell whose onKeyDown owns Escape. Each act hands focus to the
   * button that took its place, so Escape (and the Tab ring) keep working.
   */
  const maximizeRef = useRef<HTMLButtonElement>(null)
  const minimizeRef = useRef<HTMLButtonElement>(null)
  const maximizeThenFocus = (): void => {
    onMaximize(card.id)
    requestAnimationFrame(() => minimizeRef.current?.focus())
  }
  const minimizeThenFocus = (): void => {
    onMinimize()
    requestAnimationFrame(() => maximizeRef.current?.focus())
  }
  return (
    <>
      {maximized ?
        (
          <div
            className="card-maximize-backdrop"
            aria-hidden="true"
            onClick={minimizeThenFocus}
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
                <Button
                  variant="ghost"
                  size="icon"
                  data-flow="frame.back"
                  data-testid="frame-back"
                  aria-label="Previous frame"
                  title="Previous frame"
                  onClick={() => onFrameBack?.()}
                >
                  <ArrowLeft size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  data-flow="frame.forward"
                  data-testid="frame-forward"
                  aria-label="Next frame"
                  title="Next frame"
                  onClick={() => onFrameForward?.()}
                >
                  <ArrowRight size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  data-flow="frame.fork"
                  data-testid="frame-fork"
                  aria-label="Fork frame"
                  title="Fork frame"
                  onClick={() => onForkFrame?.()}
                >
                  <GitFork size={13} />
                </Button>
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
                  ref={minimizeRef}
                  variant="ghost"
                  size="icon"
                  className="card-minimize-btn"
                  data-flow="card.minimize"
                  data-testid={`card-minimize-${card.id}`}
                  aria-label="Minimize card"
                  title="Minimize card"
                  onClick={minimizeThenFocus}
                >
                  <Minimize2 size={13} />
                </Button>
              </>
            ) :
            (
              <Button
                ref={maximizeRef}
                variant="ghost"
                size="icon"
                className="card-maximize-btn"
                data-flow="card.maximize"
                data-testid={`card-maximize-${card.id}`}
                aria-label="Maximize card"
                title="Maximize card"
                onClick={maximizeThenFocus}
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
            (
              <WorkflowRunCardBody
                card={card}
                onStopRun={onStopRun}
                onRetryRun={onRetryRun}
                onRunCommand={onRunCommand}
                debugVerbose={debugVerbose}
              />
            ) :
            null}
          {card.kind === "run-list" ? <RunListCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "approvals-inbox" ?
            <ApprovalsInboxCardBody card={card} onDecideApproval={onDecideApproval} /> :
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
          {card.kind === "repo-plugin" ? <RepoPluginCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "targets" ? <TargetsCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "html" ? <HtmlCardBody card={card} /> : null}
          {card.kind === "target-run" ? <TargetRunCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "graph" ?
            (
              <Suspense fallback={<p className="smithers-card-note">Loading graph…</p>}>
                <GraphCardBody card={card} onRunCommand={onRunCommand} />
              </Suspense>
            ) :
            null}
          {card.kind === "run-timeline" ? <RunTimelineCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "run-history" ? <RunHistoryCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "affected" ? <AffectedCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "ci-matrix" ? <CiMatrixCardBody card={card} /> : null}
          {card.kind === "agent" ? <AgentCardBody card={card} onRunCommand={onRunCommand} /> : null}
          {card.kind === "explain" ? <ExplainCardBody card={card} /> : null}
        </div>
      </section>
    </>
  )
}
