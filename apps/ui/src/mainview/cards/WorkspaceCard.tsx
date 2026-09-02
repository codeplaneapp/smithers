/*
 * The workspace card (lane citc, ADR 0002): one persistent cloud computer,
 * reviewed in the transcript. The header names the repository, the target
 * bookmark, and the BOOKMARK's head (labeled as such — the DTO carries no
 * workspace head, plue#446, and none is faked). The body is four facets:
 * the terminal and its sessions, snapshots with their acts, and Files and
 * Services, which have no routes yet (plue#449) and say so — an empty state
 * is a valid state. Every act binds a registered command through
 * onRunCommand and carries data-flow (parity.test.ts gates this).
 */
import { useState } from "react"
import { Badge, Button, StatusPill } from "@smthrs/ui"
import { Camera, Copy, Monitor, Play, Square, TerminalSquare, Trash2 } from "lucide-react"
import type { Card } from "../state/AppState"

export interface WorkspaceCardActions {
  readonly onRunCommand: (name: string, args?: string) => void
}

type WorkspaceCard = Extract<Card, { kind: "workspace" }>

const FACETS = ["terminal", "files", "services", "snapshots"] as const

/** The empty facet states, in the ADR's own words: no invention, an absent API named. */
const NO_FILES_ROUTE = "The workspace file API doesn't exist yet (plue#449) — a workspace's files aren't listed here."
const NO_SERVICES_ROUTE = "The workspace services API doesn't exist yet (plue#449) — a workspace's services aren't listed here."

const WorkspaceFacetBody = ({
  card,
  facet,
  onRunCommand
}: {
  readonly card: WorkspaceCard
  readonly facet: (typeof FACETS)[number]
  readonly onRunCommand: WorkspaceCardActions["onRunCommand"]
}) => {
  const { payload } = card
  if (facet === "files") return <p className="world-card-empty">{NO_FILES_ROUTE}</p>
  if (facet === "services") return <p className="world-card-empty">{NO_SERVICES_ROUTE}</p>
  if (facet === "snapshots") {
    return (
      <ul className="world-card-list">
        {payload.snapshots.length === 0 ?
          <li className="world-card-empty">No snapshots of {payload.name} yet.</li> :
          payload.snapshots.map((snapshot) => (
            <li key={snapshot.id} className="world-card-row">
              <Camera size={14} aria-hidden="true" />
              <span className="world-card-title">{snapshot.name}</span>
              {snapshot.createdAt !== null ?
                <span className="world-card-path">{snapshot.createdAt.slice(0, 10)}</span> :
                null}
              <Button
                size="sm"
                variant="outline"
                data-flow="workspace.snapshot.fork"
                aria-label={`Fork a workspace from ${snapshot.name}`}
                onClick={() => onRunCommand("workspace.snapshot.fork", `${snapshot.id} ${payload.workspaceId}`)}
              >
                Fork from
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-flow="workspace.template"
                aria-label={`Create a template from ${snapshot.name}`}
                onClick={() =>
                  onRunCommand("workspace.template", `${snapshot.id} ${snapshot.name} ${payload.workspaceId}`)}
              >
                Make template
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-flow="workspace.snapshot.delete"
                aria-label={`Delete snapshot ${snapshot.name}`}
                onClick={() => onRunCommand("workspace.snapshot.delete", `${snapshot.id} ${payload.workspaceId}`)}
              >
                <Trash2 size={12} aria-hidden="true" /> Delete
              </Button>
            </li>
          ))}
      </ul>
    )
  }
  /* The terminal facet: the attachment, then every session the workspace holds. */
  return (
    <div className="world-card-list">
      {payload.terminalSessionId !== undefined ?
        (
          <p className="world-card-row">
            <TerminalSquare size={14} aria-hidden="true" />
            <span className="world-card-title">Attached to session {payload.terminalSessionId}</span>
          </p>
        ) :
        <p className="world-card-empty">No terminal attached.</p>}
      <Button
        size="sm"
        data-flow="workspace.terminal"
        onClick={() => onRunCommand("workspace.terminal", payload.workspaceId)}
      >
        Open terminal
      </Button>
      {payload.sessions.length === 0 ?
        null :
        (
          <ul className="world-card-list">
            {payload.sessions.map((session) => (
              <li key={session.id} className="world-card-row">
                <Monitor size={14} aria-hidden="true" />
                <span className="world-card-title">{session.id}</span>
                <StatusPill status={session.status} />
                <Button
                  size="sm"
                  variant="outline"
                  data-flow="workspace.session.destroy"
                  aria-label={`Destroy session ${session.id}`}
                  onClick={() => onRunCommand("workspace.session.destroy", `${session.id} ${payload.workspaceId}`)}
                >
                  Destroy
                </Button>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

export const WorkspaceCardBody = ({
  card,
  onRunCommand
}: { readonly card: WorkspaceCard } & WorkspaceCardActions) => {
  const { payload } = card
  const facet = payload.facet ?? "terminal"
  /* The delete act's typed confirm: the draft is transient chrome state, never a store fact. */
  const [deleteDraft, setDeleteDraft] = useState<string | null>(null)
  return (
    <div className="world-card-list">
      <p className="world-card-row">
        <span className="world-card-path">
          {payload.repo}
          {payload.targetBookmark !== null ? ` · ${payload.targetBookmark}` : ""}
          {payload.bookmarkHead?.changeId != null ?
            ` · bookmark ${payload.targetBookmark ?? ""} head @ ${payload.bookmarkHead.changeId.slice(0, 8)}` :
            ""}
        </span>
        <StatusPill status={payload.status} />
      </p>
      {payload.provisioningStage !== null && (payload.status === "pending" || payload.status === "starting") ?
        <p className="world-card-path">Provisioning: {payload.provisioningStage}</p> :
        null}
      {payload.suspendedAt != null && payload.status === "suspended" ?
        <p className="world-card-path">Suspended {payload.suspendedAt.slice(0, 10)}</p> :
        null}
      {payload.error !== undefined ? <p className="world-card-empty">{payload.error}</p> : null}
      {payload.status === "failed" ?
        (
          <p className="world-card-row">
            {payload.provisioningStage !== null ?
              <span className="world-card-path">Failed at {payload.provisioningStage}.</span> :
              null}
            <Button
              size="sm"
              data-flow="workspace.open"
              onClick={() =>
                onRunCommand(
                  "workspace.open",
                  payload.targetBookmark === null
                    ? payload.repo
                    : `${payload.targetBookmark} ${payload.repo}`
                )}
            >
              Retry
            </Button>
          </p>
        ) :
        null}
      <div className="world-card-row" role="tablist" aria-label="Workspace facets">
        {FACETS.map((name) => (
          <Button
            key={name}
            size="sm"
            variant={name === facet ? "default" : "outline"}
            role="tab"
            aria-selected={name === facet}
            data-flow="workspace.facet"
            onClick={() => onRunCommand("workspace.facet", `${payload.workspaceId} ${name}`)}
          >
            {name[0]!.toUpperCase()}{name.slice(1)}
          </Button>
        ))}
      </div>
      <WorkspaceFacetBody card={card} facet={facet} onRunCommand={onRunCommand} />
      <div className="world-card-row">
        {payload.status === "running" ?
          (
            <Button
              size="sm"
              variant="outline"
              data-flow="workspace.suspend"
              onClick={() => onRunCommand("workspace.suspend", payload.workspaceId)}
            >
              <Square size={12} aria-hidden="true" /> Suspend
            </Button>
          ) :
          null}
        {payload.status === "suspended" || payload.status === "stopped" ?
          (
            <Button
              size="sm"
              variant="outline"
              data-flow="workspace.resume"
              onClick={() => onRunCommand("workspace.resume", payload.workspaceId)}
            >
              <Play size={12} aria-hidden="true" /> Resume
            </Button>
          ) :
          null}
        <Button
          size="sm"
          variant="outline"
          data-flow="workspace.fork"
          onClick={() => onRunCommand("workspace.fork", `${payload.workspaceId} ${payload.name}-fork`)}
        >
          <Copy size={12} aria-hidden="true" /> Fork
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-flow="workspace.snapshot"
          onClick={() => onRunCommand("workspace.snapshot", payload.workspaceId)}
        >
          <Camera size={12} aria-hidden="true" /> Snapshot
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-flow="workspace.delete"
          onClick={() => setDeleteDraft((draft) => (draft === null ? "" : null))}
        >
          <Trash2 size={12} aria-hidden="true" /> Delete
        </Button>
      </div>
      {deleteDraft !== null ?
        (
          <p className="world-card-row">
            <span className="world-card-path">
              Type {payload.name} to delete {payload.workspaceId} permanently:
            </span>
            <input
              aria-label={`Type ${payload.name} to confirm the delete`}
              value={deleteDraft}
              onInput={(event) => setDeleteDraft(event.currentTarget.value)}
            />
            <Button
              size="sm"
              variant="outline"
              data-flow="workspace.delete"
              disabled={deleteDraft !== payload.name}
              onClick={() => onRunCommand("workspace.delete", payload.workspaceId)}
            >
              Delete permanently
            </Button>
          </p>
        ) :
        null}
      <p className="world-card-path">
        <Badge variant="outline">{payload.workspaceId}</Badge>
      </p>
    </div>
  )
}
