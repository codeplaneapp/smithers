/*
 * The change and diff cards (lane change, ADR 0003 — the change is the
 * unit). The change card's body is the five facets (diff, findings, checks,
 * review, history); each facet that has no route yet renders the ADR's
 * degraded wording in place of invention (plue#450–#457). The diff card
 * renders one from → to pair pinned at the change's commit, conflicted
 * files leading; an oversized hunk rides by reference and names the re-read
 * command. Every act binds a registered command through onRunCommand and
 * carries data-flow (parity.test.ts gates this).
 */
import { Button, StatusPill } from "@smthrs/ui"
import { AlertTriangle, FileDiff, GitMerge, GitPullRequest, History, Split } from "lucide-react"
import type { ChangeFacet } from "smithers-shared/Changes"
import type { Card } from "../state/AppState"

export interface ChangeCardActions {
  readonly onRunCommand: (name: string, args?: string) => void
}

type ChangeCard = Extract<Card, { kind: "change" }>
type DiffCard = Extract<Card, { kind: "diff" }>

/** Ids render short: jj change ids are already short words; commit hashes take the first 8. */
const shortId = (id: string): string => (id.length > 12 ? id.slice(0, 8) : id)

/* The degraded facet wording, in the ADR's own words: an absent API named, never invented. */
const NO_REVISION_HISTORY =
  "A change's revision history isn't recorded yet (plue#450) — this card tracks the current revision only."
const NO_FINDINGS =
  "Findings per revision don't exist yet (plue#454) — review findings aren't recorded here."
const NO_STALE_TOKEN =
  "Whether this thread still points at the current revision isn't computed yet (plue#453) — no stale marker is shown."

const FACET_LABELS: ReadonlyArray<readonly [ChangeFacet, string]> = [
  ["diff", "Diff"],
  ["findings", "Findings"],
  ["checks", "Checks"],
  ["review", "Review"],
  ["history", "History"]
]

/* The diff facet: the file rows of the parent → current diff, each opening the one-file diff card. */
const ChangeDiffFacet = ({ card, onRunCommand }: { readonly card: ChangeCard } & ChangeCardActions) => {
  const { payload } = card
  if (payload.diff === null) {
    return <p className="world-card-empty">The diff of {payload.changeId} couldn't be read.</p>
  }
  if (payload.diff.files.length === 0) {
    return <p className="world-card-empty">{payload.changeId} changes no files.</p>
  }
  return (
    <ul className="world-card-list">
      {payload.diff.files.map((file) => (
        <li key={file.path} className="world-card-row">
          <FileDiff size={14} aria-hidden="true" />
          <Button
            variant="ghost"
            size="sm"
            data-flow="change.diff"
            aria-label={`Open the diff of ${file.path}`}
            onClick={() => onRunCommand("change.diff", `${payload.changeId} parent current ${file.path}`)}
          >
            <span className="world-card-title">{file.path}</span>
          </Button>
          <span className="world-card-path">
            {file.changeType} · +{file.additions} −{file.deletions}
          </span>
        </li>
      ))}
    </ul>
  )
}

/* The checks facet: one row per context, newest answer per context. */
const ChangeChecksFacet = ({ card }: { readonly card: ChangeCard }) => {
  const { payload } = card
  if (payload.checks === null || payload.checks.length === 0) {
    return <p className="world-card-empty">No checks recorded at this revision.</p>
  }
  return (
    <ul className="world-card-list">
      {payload.checks.map((check) => (
        <li key={check.context} className="world-card-row">
          <span className="world-card-title">{check.context}</span>
          <StatusPill
            status={check.state === "success" ? "done" : check.state === "failure" || check.state === "error" ? "failed" : "pending"}
          />
          <span className="world-card-path">{check.state}</span>
        </li>
      ))}
    </ul>
  )
}

/* The review facet: the verdicts, then the threads; stale/moved tokens never render until plue#453. */
const ChangeReviewFacet = ({ card }: { readonly card: ChangeCard }) => {
  const { payload } = card
  const reviews = payload.reviews ?? []
  const threads = payload.threads ?? []
  if (payload.reviews === null && payload.threads === null) {
    return <p className="world-card-empty">No review is recorded for {payload.changeId}.</p>
  }
  return (
    <div className="world-card-list">
      {reviews.length === 0 ? null : (
        <ul className="world-card-list">
          {reviews.map((review, index) => (
            <li key={index} className="world-card-row">
              <span className="world-card-title">{review.type}</span>
              {review.body !== "" ? <span className="world-card-path">{review.body}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {threads.length === 0 ? null : (
        <ul className="world-card-list">
          {threads.map((thread, index) => (
            <li key={index} className="world-card-row">
              <span className="world-card-path">
                {thread.path ?? "file"}{thread.line !== null ? `:${thread.line}` : ""}
              </span>
              <span className="world-card-title">{thread.body}</span>
            </li>
          ))}
        </ul>
      )}
      {threads.length > 0 ? <p className="world-card-empty">{NO_STALE_TOKEN}</p> : null}
      {reviews.length === 0 && threads.length === 0 ?
        <p className="world-card-empty">No review is recorded for {payload.changeId}.</p> :
        null}
    </div>
  )
}

/* The history facet: the revisions list post-plue#450; the degraded wording until then. */
const ChangeHistoryFacet = ({ card }: { readonly card: ChangeCard }) => {
  const { payload } = card
  if (payload.revisions.length === 0) {
    return <p className="world-card-empty">{NO_REVISION_HISTORY}</p>
  }
  return (
    <ul className="world-card-list">
      {payload.revisions.map((revision) => (
        <li key={revision.seq} className="world-card-row">
          <History size={14} aria-hidden="true" />
          <span className="world-card-title">rev {revision.seq}</span>
          <span className="world-card-path">{shortId(revision.commitId)}</span>
        </li>
      ))}
    </ul>
  )
}

const ChangeFacetBody = ({
  card,
  facet,
  onRunCommand
}: {
  readonly card: ChangeCard
  readonly facet: ChangeFacet
} & ChangeCardActions) => {
  const { payload } = card
  if (facet === "diff") return <ChangeDiffFacet card={card} onRunCommand={onRunCommand} />
  if (facet === "findings") {
    if (payload.findings === null || payload.findings.length === 0) {
      return <p className="world-card-empty">{NO_FINDINGS}</p>
    }
    return (
      <ul className="world-card-list">
        {payload.findings.map((finding, index) => (
          <li key={index} className="world-card-row">
            <span className="world-card-title">{finding.severity}</span>
            <span className="world-card-path">{finding.path ?? "change"}{finding.line !== null ? `:${finding.line}` : ""}</span>
            <span className="world-card-title">{finding.summary}</span>
          </li>
        ))}
      </ul>
    )
  }
  if (facet === "checks") return <ChangeChecksFacet card={card} />
  if (facet === "review") return <ChangeReviewFacet card={card} />
  return <ChangeHistoryFacet card={card} />
}

export const ChangeCardBody = ({
  card,
  onRunCommand
}: { readonly card: ChangeCard } & ChangeCardActions) => {
  const { payload } = card
  const facet: ChangeFacet = payload.facet ?? "diff"
  const landed = payload.changeset?.state === "landed" || payload.stack?.state === "merged"
  return (
    <div className="world-card-list">
      <p className="world-card-row">
        <span className="world-card-path">
          {payload.repo} · {payload.changeId}
          {payload.commitId !== null ? ` · ${shortId(payload.commitId)}` : ""}
          {payload.authorName !== null ? ` · ${payload.authorName}` : ""}
        </span>
        {payload.stack !== null ? <StatusPill status={payload.stack.state === "merged" ? "done" : "pending"} /> : null}
      </p>
      {payload.timestamp !== null ? <p className="world-card-path">{payload.timestamp.replace("T", " ").slice(0, 16)}</p> : null}
      {payload.description !== "" ? <p className="world-card-title">{payload.description.split("\n")[0]}</p> : null}
      {payload.repos.length > 0 ?
        (
          <p className="world-card-path">
            {payload.repos.map((stat) => `${stat.repo} +${stat.additions} −${stat.deletions}`).join(" · ")}
          </p>
        ) :
        null}
      {payload.conflicts.length > 0 ?
        (
          <p className="world-card-row">
            <AlertTriangle size={14} aria-hidden="true" />
            <span className="world-card-path">
              Conflicted: {payload.conflicts.map((conflict) => conflict.path).join(", ")}
            </span>
          </p>
        ) :
        null}
      {payload.changeset !== null ?
        (
          <div className="world-card-list">
            <p className="world-card-row">
              <span className="world-card-path">
                Changeset {payload.changeset.id} → {payload.changeset.targetBookmark} · {payload.changeset.members.length} member
                {payload.changeset.members.length === 1 ? "" : "s"}
              </span>
              <StatusPill
                status={payload.changeset.state === "landed" ? "done" : payload.changeset.state === "failed" ? "failed" : "pending"}
              />
            </p>
            {payload.changeset.state === "failed" && payload.changeset.failureReason !== null ?
              <p className="sui-approval-error" role="alert">{payload.changeset.failureReason}</p> :
              null}
          </div>
        ) :
        null}
      {payload.stack !== null ?
        (
          <p className="world-card-path">
            Landing #{payload.stack.landingNumber} · position {payload.stack.position} of {payload.stack.size} ·{" "}
            {payload.stack.state} → {payload.stack.targetBookmark}
          </p>
        ) :
        null}
      {payload.error !== undefined ?
        <p className="sui-approval-error" role="alert">{payload.error}</p> :
        null}
      <div className="world-card-row" role="tablist" aria-label="Change facets">
        {FACET_LABELS.map(([name, label]) => (
          <Button
            key={name}
            size="sm"
            variant={name === facet ? "default" : "outline"}
            role="tab"
            aria-selected={name === facet}
            data-flow="change.facet"
            onClick={() => onRunCommand("change.facet", `${payload.changeId} ${name}`)}
          >
            {label}
          </Button>
        ))}
      </div>
      <ChangeFacetBody card={card} facet={facet} onRunCommand={onRunCommand} />
      <div className="world-card-row">
        <Button
          size="sm"
          data-flow="change.land"
          aria-label={payload.changeset !== null ? "Land the changeset" : "Land the change"}
          onClick={() => onRunCommand("change.land", payload.changeId)}
        >
          <GitMerge size={12} aria-hidden="true" />{" "}
          {payload.changeset !== null && payload.changeset.state === "failed" ? "Retry land" : "Land"}
        </Button>
        {payload.changeset !== null ?
          (
            <Button
              size="sm"
              variant="outline"
              data-flow="change.split-ready"
              aria-label="Split the ready members into a new change"
              onClick={() => onRunCommand("change.split-ready", payload.changeId)}
            >
              <Split size={12} aria-hidden="true" /> Split ready
            </Button>
          ) :
          null}
        {payload.conflicts.length > 0 ?
          (
            <Button
              size="sm"
              variant="outline"
              data-flow="change.resolve"
              aria-label={`Dispatch an agent to resolve the conflict in ${payload.conflicts[0]?.path}`}
              onClick={() => onRunCommand("change.resolve", `${payload.changeId} ${payload.conflicts[0]?.path ?? ""}`)}
            >
              Resolve
            </Button>
          ) :
          null}
        {landed ?
          (
            <Button
              size="sm"
              variant="outline"
              data-flow="change.revert"
              aria-label="Revert the landed change"
              onClick={() => onRunCommand("change.revert", payload.changeId)}
            >
              Revert
            </Button>
          ) :
          null}
        <Button
          size="sm"
          variant="outline"
          data-flow="change.diff"
          aria-label="Open the full diff card"
          onClick={() => onRunCommand("change.diff", payload.changeId)}
        >
          <GitPullRequest size={12} aria-hidden="true" /> Full diff
        </Button>
      </div>
    </div>
  )
}

export const DiffCardBody = ({
  card,
  onRunCommand
}: { readonly card: DiffCard } & ChangeCardActions) => {
  const { payload } = card
  return (
    <div className="world-card-list">
      <p className="world-card-path">
        {payload.repo} · {payload.changeId} · {payload.from} → {payload.to}
        {payload.pin.commitId !== null ? ` · pinned at ${shortId(payload.pin.commitId)}` : ""}
      </p>
      {payload.error !== undefined ?
        <p className="sui-approval-error" role="alert">{payload.error}</p> :
        null}
      {payload.files.length === 0 ?
        <p className="world-card-empty">No files in this diff.</p> :
        (
          <ul className="world-card-list">
            {payload.files.map((file) => (
              <li key={file.path} className="world-card-row">
                <FileDiff size={14} aria-hidden="true" />
                <span className="world-card-title">{file.path}</span>
                <span className="world-card-path">
                  {file.changeType} · +{file.additions} −{file.deletions}
                  {file.conflicted === true ? " · conflicted" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      {payload.files.map((file) => {
        if (file.isBinary) {
          return (
            <p key={`binary-${file.path}`} className="world-card-empty">
              {file.path} is binary, so its diff is not shown here.
            </p>
          )
        }
        if (file.patch !== undefined) {
          return <pre key={`patch-${file.path}`} className="world-card-path">{file.patch}</pre>
        }
        if (file.patchLines !== undefined) {
          return (
            <p key={`ref-${file.path}`} className="world-card-empty">
              {file.path}'s hunk is {file.patchLines} lines — it rides by reference.{" "}
              <Button
                variant="ghost"
                size="sm"
                data-flow="change.diff"
                onClick={() => onRunCommand("change.diff", `${payload.changeId} ${payload.from} ${payload.to} ${file.path}`)}
              >
                Read it
              </Button>
            </p>
          )
        }
        return null
      })}
    </div>
  )
}
