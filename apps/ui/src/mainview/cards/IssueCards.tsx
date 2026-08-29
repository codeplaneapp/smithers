/*
 * The issues cards: the list ("issue-list") and the detail ("issue"). Every
 * act binds a command through onRunCommand — the one delegated dispatch
 * CardView threads from App.tsx (parity.test.ts allowlists it). List rows open
 * the detail (issues.view); the detail carries the one state toggle
 * (issues.close / issues.reopen). Every interactive element carries
 * data-flow with its registered command name.
 */
import { Badge, Button, Markdown } from "@smthrs/ui"
import { MessageSquare } from "lucide-react"
import type { Card } from "../state/AppState"

export interface IssueCardActions {
  readonly onRunCommand: (name: string, args?: string) => void
}

const stateBadge = (state: "open" | "closed") => <Badge variant={state === "open" ? "success" : "muted"}>{state}</Badge>

/** "2026-08-11T09:00:00Z" → "2026-08-11 09:00"; a non-ISO string passes through. */
const dateLabel = (iso: string): string => iso.replace("T", " ").slice(0, 16)

export const IssueListCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "issue-list" }> } & IssueCardActions) => (
  <ul className="world-card-list">
    {card.payload.issues.length === 0 ?
      (
        <li className="world-card-empty">
          {card.payload.filter === "all"
            ? `No issues in ${card.payload.repo}.`
            : `No ${card.payload.filter} issues in ${card.payload.repo}.`}
        </li>
      ) :
      (
        card.payload.issues.map((issue) => (
          <li key={issue.number} className="world-card-row">
            <Button
              variant="ghost"
              size="sm"
              data-flow="issues.view"
              onClick={() => onRunCommand("issues.view", `${issue.number} ${card.payload.repo}`)}
            >
              <span className="world-card-title">
                #{issue.number} {issue.title}
              </span>
            </Button>
            {stateBadge(issue.state)}
            <span className="world-card-path">
              <MessageSquare size={12} aria-hidden="true" /> {issue.comments}
            </span>
            {issue.updatedAt !== null ? <span className="world-card-path">{dateLabel(issue.updatedAt)}</span> : null}
          </li>
        ))
      )}
  </ul>
)

export const IssueCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "issue" }> } & IssueCardActions) => {
  const { repo, number, title, state, author, issueBody, labels, comments } = card.payload
  const toggleCommand = state === "open" ? "issues.close" : "issues.reopen"
  return (
    <div className="world-card-list">
      <div className="world-card-row">
        <span className="world-card-title">
          #{number} {title}
        </span>
        {stateBadge(state)}
      </div>
      <p className="world-card-path">
        {repo}
        {author !== null ? ` · opened by ${author}` : ""}
      </p>
      {labels.length > 0 ?
        (
          <div className="world-card-row">
            {labels.map((label) => (
              <Badge key={label} variant="outline">
                {label}
              </Badge>
            ))}
          </div>
        ) :
        null}
      {issueBody === "" ?
        <p className="world-card-empty">No description.</p> :
        <Markdown className="smithers-card-markdown" content={issueBody} />}
      {comments.length > 0 ?
        (
          <ul className="world-card-list">
            {comments.map((comment, index) => (
              <li key={`comment-${index}`}>
                <p className="world-card-path">
                  <MessageSquare size={12} aria-hidden="true" /> {comment.author ?? "unknown"}
                  {comment.createdAt !== null ? ` · ${dateLabel(comment.createdAt)}` : ""}
                </p>
                <Markdown className="smithers-card-markdown" content={comment.commentBody} />
              </li>
            ))}
          </ul>
        ) :
        null}
      <div className="world-card-row">
        <Button
          variant="outline"
          size="sm"
          data-flow={toggleCommand}
          onClick={() => onRunCommand(toggleCommand, `${number} ${repo}`)}
        >
          {state === "open" ? "Close issue" : "Reopen issue"}
        </Button>
      </div>
    </div>
  )
}
