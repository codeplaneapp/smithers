/*
 * The repo file cards: a directory listing ("file-list") whose rows open
 * /files.list or /files.read, and a file view ("file") rendered as a fenced
 * code block, honest about truncation. Every row is a command binding through
 * onRunCommand — the one delegated dispatch CardView threads from App.tsx —
 * and carries data-flow with its registered command name.
 */
import { Button } from "@smthrs/ui"
import { FileText, Folder } from "lucide-react"
import { lazy, Suspense } from "react"
import type { Card } from "../state/AppState"

/*
 * A markdown file renders through the shared WYSIWYG editor the World notes
 * use (will, 2026-09-01), read only: nothing writes a repository file back.
 * The adapter is heavy, so it loads only when a markdown card is on screen.
 */
const MarkdownEditorSurface = lazy(() =>
  import("../MarkdownEditorSurface").then((module) => ({ default: module.MarkdownEditorSurface }))
)

/** Markdown by extension: the editor renders these; everything else is a fenced block. */
export const isMarkdownPath = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path)

/*
 * The editor reseeds its document only when resetKey changes (the adapter's
 * contract), so the key follows the CONTENT: a re-read after a same-length
 * edit must not show the old text. djb2 over the string is cheap at the card
 * cap and distinct enough for a key.
 */
export const contentKey = (content: string): string => {
  let hash = 5381
  for (let index = 0; index < content.length; index += 1) hash = ((hash << 5) + hash + content.charCodeAt(index)) | 0
  return `${content.length}:${(hash >>> 0).toString(36)}`
}

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
      {card.payload.truncated === true ?
        <p className="world-card-empty">Truncated — the directory holds more entries than the listing shows.</p> :
        null}
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
      isMarkdownPath(card.payload.path) ?
      (
        <div className="world-card-doc" data-file-markdown="">
          <Suspense fallback={<p className="smithers-card-note">Loading editor…</p>}>
            <MarkdownEditorSurface
              value={card.payload.content}
              resetKey={`${card.id}:${contentKey(card.payload.content)}`}
              label={`${card.payload.path} in ${card.payload.repo}`}
              readOnly
            />
          </Suspense>
        </div>
      ) :
      <pre className="world-card-path">{card.payload.content}</pre>}
    {card.payload.truncated ?
      <p className="world-card-empty">Truncated — the full file stays in the repository.</p> :
      null}
  </div>
)
