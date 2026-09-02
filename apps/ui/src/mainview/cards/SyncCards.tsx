/*
 * The lane-sync cards (ADR 0005): the connector-setup card (one kind serves
 * both handoffs — the Linear wizard authorize → team → repository → confirm,
 * the same card turned connected state, and the GitHub App install/reconcile)
 * and the sync-ops card (Linear syncs and GitHub mirror syncs; the ops feed
 * is plue#468, so the degraded note renders and no op is ever faked). Every
 * act binds a registered flow through onRunCommand with data-flow set; the
 * rate-limit line follows the ADR (`… · 0 of 5 000 · resets 12:40 · Retry
 * after`, Retry disabled until the reset).
 */
import { Badge, Button } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Check, Circle, ExternalLink, Plug, RefreshCw, Unplug, X } from "lucide-react"
import { useCallback, useState, useSyncExternalStore } from "react"
import { useController } from "../ControllerContext"
import { ageLabel, timeLabel, untilLabel } from "../Timestamps"
import type { Card } from "../state/AppState"

export interface SyncCardActions {
  readonly onRunCommand: (name: string, args?: string) => void
}

type ConnectorSetupCard = Extract<Card, { kind: "connector-setup" }>
type SyncOpsCard = Extract<Card, { kind: "sync-ops" }>
type RateLimit = { readonly limit: number; readonly remaining: number; readonly resetAt: string | null }

/*
 * The clock a rate-limit line reads against. A reset still ahead re-renders
 * the subscriber at each minute boundary and once more at the reset itself,
 * so `resets in 12 min` counts down and a held Retry re-enables on time. An
 * external clock subscription (useSyncExternalStore), never a lifecycle
 * effect; the snapshot is the whole minutes left, so a tick always changes it.
 */
const useClockUntil = (iso: string | null): void => {
  const at = iso === null ? Number.NaN : Date.parse(iso)
  const subscribe = useCallback((onTick: () => void) => {
    const remaining = at - Date.now()
    if (Number.isNaN(remaining) || remaining <= 0) return () => {}
    const timer = setTimeout(onTick, remaining % 60_000 || 60_000)
    return () => clearTimeout(timer)
  }, [at])
  const snapshot = (): number => (Number.isNaN(at) ? -1 : Math.max(0, Math.ceil((at - Date.now()) / 60_000)))
  useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * The instant a refused call's Retry waits on (ADR 0005 "Rate limits": the
 * Retry action is disabled until the reset): an exhausted budget with its
 * reset still ahead. Null when Retry may run now — a low-but-positive budget
 * shows the line and holds nothing.
 */
export const rateLimitHeldUntil = (rateLimit: RateLimit, now: number = Date.now()): number | null => {
  if (rateLimit.remaining > 0 || rateLimit.resetAt === null) return null
  const at = Date.parse(rateLimit.resetAt)
  return Number.isNaN(at) || at <= now ? null : at
}

/** The clock time a card's Retry is held until, or null when it may run; re-renders when the hold lifts. */
export const useRetryHold = (rateLimit: RateLimit | undefined): string | null => {
  useClockUntil(rateLimit?.resetAt ?? null)
  if (rateLimit === undefined) return null
  const until = rateLimitHeldUntil(rateLimit)
  return until === null ? null : timeLabel(until)
}

/** The ADR's rate-limit line; a reset ahead reads `resets in 12 min` / `resets at 12:40`, one behind `reset 4 min ago`. */
export const RateLimitLine = ({ rateLimit }: { readonly rateLimit: RateLimit }) => {
  useClockUntil(rateLimit.resetAt)
  const now = Date.now()
  const reset = rateLimit.resetAt === null
    ? ""
    : Date.parse(rateLimit.resetAt) > now
    ? ` · resets ${untilLabel(rateLimit.resetAt, now)}`
    : ` · reset ${ageLabel(rateLimit.resetAt, now)}`
  return (
    <p className="world-card-path">
      {`GitHub rate limit reached · ${rateLimit.remaining.toLocaleString()} of ${rateLimit.limit.toLocaleString()}`}
      {reset} · Retry after
    </p>
  )
}

const stepIcon = (state: "pending" | "active" | "done" | "error") => {
  switch (state) {
    case "done":
      return <Check size={14} aria-hidden="true" />
    case "error":
      return <X size={14} aria-hidden="true" />
    case "active":
      return <Circle size={14} aria-hidden="true" fill="currentColor" />
    default:
      return <Circle size={14} aria-hidden="true" />
  }
}

/** The wizard's repository pick: every loaded repository, one click each. */
const RepositoryPick = ({
  cardRepo,
  onRunCommand
}: {
  readonly cardRepo: string
} & SyncCardActions) => {
  const controller = useController()
  const { data: repositories } = useLiveQuery((q) =>
    q.from({ repository: controller.store.collections.repositories }).select(({ repository }) => ({
      id: repository.id
    })))
  if (repositories.length === 0) return null
  return (
    <>
      {repositories.map((repository) => (
        <div key={repository.id} className="world-card-row">
          <Button
            variant={repository.id === cardRepo ? "outline" : "ghost"}
            size="sm"
            data-flow="linear.connect.repo"
            onClick={() => onRunCommand("linear.connect.repo", `${cardRepo} ${repository.id}`)}
          >
            {repository.id}
          </Button>
        </div>
      ))}
    </>
  )
}

/** The Linear wizard and, on confirm, the connected state (the SAME card). */
const LinearSetupBody = ({ card, onRunCommand }: { readonly card: ConnectorSetupCard } & SyncCardActions) => {
  const { repo, steps, teams, teamId, setupKey, integration } = card.payload
  /*
   * Disconnect's card-level confirm (the workspace card's rule): the first
   * click arms a confirm row, the second sends the team key back as the
   * flow's own input, so one click never disconnects. Armed-or-not is
   * transient chrome state, never a store fact.
   */
  const [disconnectArmed, setDisconnectArmed] = useState(false)
  if (card.payload.phase === "connected" && integration !== undefined) {
    return (
      <div className="world-card-list">
        <div className="world-card-row">
          <span className="connect-store-icon">
            <Plug size={14} />
          </span>
          <span className="world-card-title">{`${integration.teamKey} · ${integration.teamName} → ${repo}`}</span>
          <Badge variant={integration.active ? "success" : "muted"}>{integration.active ? "active" : "inactive"}</Badge>
        </div>
        {integration.lastSyncAt !== null ?
          <p className="world-card-path">{`last sync ${ageLabel(integration.lastSyncAt)}`}</p> :
          null}
        <div className="world-card-row">
          <Button size="sm" variant="outline" data-flow="linear.sync" onClick={() => onRunCommand("linear.sync", String(integration.id))}>
            <RefreshCw size={14} /> Sync now
          </Button>
          <Button size="sm" variant="ghost" data-flow="linear.activity" onClick={() => onRunCommand("linear.activity", String(integration.id))}>
            Activity
          </Button>
          <Button size="sm" variant="ghost" data-flow="linear.disconnect" onClick={() => setDisconnectArmed((armed) => !armed)}>
            <Unplug size={14} /> Disconnect
          </Button>
        </div>
        {disconnectArmed ?
          (
            <div className="world-card-row">
              <span className="world-card-path">{`Disconnect Linear ${integration.teamKey} from ${repo}?`}</span>
              <Button
                size="sm"
                variant="destructive"
                data-flow="linear.disconnect"
                onClick={() => onRunCommand("linear.disconnect", `${integration.id} ${integration.teamKey}`)}
              >
                {`Disconnect ${integration.teamKey}`}
              </Button>
            </div>
          ) :
          null}
        {card.payload.rateLimit !== undefined ? <RateLimitLine rateLimit={card.payload.rateLimit} /> : null}
        {card.payload.error !== undefined ? <p className="world-card-path">{card.payload.error}</p> : null}
      </div>
    )
  }
  const stepOf = (id: string) => steps.find((step) => step.id === id)
  const team = stepOf("team")
  const repository = stepOf("repository")
  const confirmReady = setupKey !== undefined && teamId !== undefined
  return (
    <div className="world-card-list">
      {steps.map((step) => (
        <div key={step.id} className="world-card-row">
          <span className="connect-store-icon">{stepIcon(step.state)}</span>
          <span className="world-card-title">{step.label}</span>
          {step.detail !== null ? <span className="world-card-path">{step.detail}</span> : null}
          {step.id === "authorize" && (step.state === "active" || step.state === "error") ?
            (
              <Button size="sm" variant="outline" data-flow="linear.connect.open" onClick={() => onRunCommand("linear.connect.open", repo)}>
                <ExternalLink size={14} /> Open Linear
              </Button>
            ) :
            null}
        </div>
      ))}
      {steps.filter((step) => step.error !== undefined).map((step) => (
        <p key={`${step.id}-error`} className="world-card-path">{step.error}</p>
      ))}
      {team?.state === "active" && teams !== undefined ?
        teams.map((candidate) => (
          <div key={candidate.id} className="world-card-row">
            <Button
              variant="ghost"
              size="sm"
              data-flow="linear.connect.team"
              onClick={() => onRunCommand("linear.connect.team", `${candidate.id} ${repo}`)}
            >
              {`${candidate.key} · ${candidate.name}`}
            </Button>
          </div>
        )) :
        null}
      {repository?.state === "active" ? <RepositoryPick cardRepo={repo} onRunCommand={onRunCommand} /> : null}
      {confirmReady ?
        (
          <div className="world-card-row">
            <Button size="sm" data-flow="linear.connect.confirm" onClick={() => onRunCommand("linear.connect.confirm", repo)}>
              Connect
            </Button>
          </div>
        ) :
        null}
      {card.payload.error !== undefined ? <p className="world-card-path">{card.payload.error}</p> : null}
    </div>
  )
}

/** The GitHub App half: install state, the install/reconcile acts, the rate-limit line. */
const GitHubSetupBody = ({ card, onRunCommand }: { readonly card: ConnectorSetupCard } & SyncCardActions) => {
  const { repo, phase, installationId, configured, installUrl } = card.payload
  const connected = phase === "connected"
  /* A refused call holds Re-check and Reconcile until the reset, with the time on them (ADR "Rate limits"). */
  const heldUntil = useRetryHold(card.payload.rateLimit)
  return (
    <div className="world-card-list">
      <div className="world-card-row">
        <span className="connect-store-icon">
          <Plug size={14} />
        </span>
        <span className="world-card-title">
          {connected
            ? `GitHub App installed${installationId != null ? ` · installation ${installationId}` : ""}${configured === true ? " · configured" : ""}`
            : "The Smithers GitHub App is not installed"}
        </span>
        <Badge variant={connected ? "success" : "outline"}>{connected ? "installed" : "not installed"}</Badge>
      </div>
      <div className="world-card-row">
        {!connected && installUrl !== undefined ?
          (
            <Button size="sm" variant="outline" data-flow="github.app.open" onClick={() => onRunCommand("github.app.open", repo)}>
              <ExternalLink size={14} /> Open GitHub
            </Button>
          ) :
          null}
        <Button size="sm" variant="ghost" data-flow="github.app" disabled={heldUntil !== null} onClick={() => onRunCommand("github.app", repo)}>
          <RefreshCw size={14} /> {heldUntil === null ? "Re-check" : `Re-check after ${heldUntil}`}
        </Button>
        <Button size="sm" variant="ghost" data-flow="github.reconcile" disabled={heldUntil !== null} onClick={() => onRunCommand("github.reconcile", repo)}>
          {heldUntil === null ? "Reconcile" : `Reconcile after ${heldUntil}`}
        </Button>
      </div>
      {card.payload.rateLimit !== undefined ? <RateLimitLine rateLimit={card.payload.rateLimit} /> : null}
      {card.payload.error !== undefined ? <p className="world-card-path">{card.payload.error}</p> : null}
    </div>
  )
}

export const ConnectorSetupCardBody = ({
  card,
  onRunCommand
}: { readonly card: ConnectorSetupCard } & SyncCardActions) =>
  card.payload.connector === "linear"
    ? <LinearSetupBody card={card} onRunCommand={onRunCommand} />
    : <GitHubSetupBody card={card} onRunCommand={onRunCommand} />

const OP_LIMIT = 10

export const SyncOpsCardBody = ({ card, onRunCommand }: { readonly card: SyncOpsCard } & SyncCardActions) => {
  const { subject, runState, counts, trigger, ops, opsNote, hasOlder, expanded } = card.payload
  const shown = expanded === true ? ops : ops.slice(0, OP_LIMIT)
  return (
    <div className="world-card-list">
      <div className="world-card-row">
        <span className="world-card-title">{subject}</span>
        {runState !== null ?
          <Badge variant={runState === "done" ? "success" : runState === "failed" ? "destructive" : "outline"}>{runState}</Badge> :
          null}
      </div>
      {counts != null ?
        <p className="world-card-path">{`${counts.done} of ${counts.total} · ${counts.failed} failed`}</p> :
        null}
      {trigger != null ? <p className="world-card-path">{trigger}</p> : null}
      {shown.map((op) => (
        <div key={op.id} className="world-card-row">
          <span className="world-card-title">
            {`${op.source} → ${op.target} ${op.entity}${op.entityId !== null ? ` ${op.entityId}` : ""} ${op.action}`}
          </span>
          <Badge variant={op.status === "done" ? "success" : op.status === "failed" ? "destructive" : "outline"}>{op.status}</Badge>
          {op.status === "failed" && op.retryable ?
            (
              <Button size="sm" variant="ghost" data-flow="sync.retry" onClick={() => onRunCommand("sync.retry", op.id)}>
                <RefreshCw size={14} /> Retry
              </Button>
            ) :
            null}
          {op.error !== undefined ? <span className="world-card-path">{op.error}</span> : null}
        </div>
      ))}
      {ops.length > OP_LIMIT && expanded !== true ?
        (
          <div className="world-card-row">
            <Button size="sm" variant="ghost" data-flow="sync.ops.show-more" onClick={() => onRunCommand("sync.ops.show-more", card.id)}>
              Show more
            </Button>
          </div>
        ) :
        null}
      {hasOlder === true ? <p className="world-card-path">Older ops exist beyond this cut.</p> : null}
      {opsNote !== undefined ? <p className="world-card-path">{opsNote}</p> : null}
      {card.payload.rateLimit !== undefined ? <RateLimitLine rateLimit={card.payload.rateLimit} /> : null}
      {card.payload.error !== undefined ? <p className="world-card-path">{card.payload.error}</p> : null}
    </div>
  )
}
