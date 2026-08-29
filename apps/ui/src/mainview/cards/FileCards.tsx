/*
 * The repo file cards: a directory listing ("file-list") whose rows open
 * /files.list or /files.read, and a file view ("file") rendered as a fenced
 * code block, honest about truncation. Every row is a command binding through
 * onRunCommand — the one delegated dispatch CardView threads from App.tsx —
 * and carries data-flow with its registered command name.
 */
import { Button } from "@smthrs/ui"
import { FileText, Folder } from "lucide-react"
import type { Card } from "../state/AppState"

export interface FileCardActions {
  readonly onRunCommand: (name: string, args?: string) => void
}

/** The entry's full path under the card's path — the argument the row's command takes. */
const childPath = (parent: string, name: string): string => parent === "" ? name : `${parent}/${name}`

export const FileListCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "file-list" }> } & FileCardActions) => {
  const { repo, path, entries } = card.payload
  return (
    <div className="world-card-list">
      <p className="world-card-path">
        {repo} · {path || "/"}
      </p>
      <ul className="world-card-list">
        {entries.length === 0 ?
          (
            <li className="world-card-empty">
              Nothing under {path || "/"} in {repo}.
            </li>
          ) :
          (
            entries.map((entry) => (
              <li key={entry.name} className="world-card-row">
                {entry.kind === "dir" ?
                  (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-flow="files.list"
                      onClick={() => onRunCommand("files.list", `${childPath(path, entry.name)} ${repo}`)}
                    >
                      <Folder size={12} aria-hidden="true" />
                      <span className="world-card-title">{entry.name}</span>
                    </Button>
                  ) :
                  (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-flow="files.read"
                      onClick={() => onRunCommand("files.read", `${childPath(path, entry.name)} ${repo}`)}
                    >
                      <FileText size={12} aria-hidden="true" />
                      <span className="world-card-title">{entry.name}</span>
                    </Button>
                  )}
              </li>
            ))
          )}
      </ul>
    </div>
  )
}

export const FileCardBody = ({
  card
}: { readonly card: Extract<Card, { kind: "file" }> } & FileCardActions) => (
  <div className="world-card-list">
    <p className="world-card-path">
      {card.payload.repo} · {card.payload.path}
    </p>
    {card.payload.binary === true ?
      (
        <p className="world-card-empty">
          This file is binary, so its bytes are not shown here — open it in the repository.
        </p>
      ) :
      <pre className="world-card-path">{card.payload.content}</pre>}
    {card.payload.truncated ?
      <p className="world-card-empty">Truncated — the full file stays in the repository.</p> :
      null}
  </div>
)
