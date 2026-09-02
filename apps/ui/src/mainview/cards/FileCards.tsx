/*
 * The repo file cards: a directory listing ("file-list") whose rows open
 * /files.list or /files.read, and a file view ("file") rendered as a fenced
 * code block, honest about truncation. Every row is a command binding through
 * onRunCommand — the one delegated dispatch CardView threads from App.tsx —
 * and carries data-flow with its registered command name.
 */
import { Button } from "@smthrs/ui"
import { FileText, Folder } from "lucide-react"
import { lazy, Suspense, useContext } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import type { Card } from "../state/AppState"
import type { AppController } from "../state/AppController"
import { ControllerContext } from "../ControllerContext"

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

/** Ids render short: jj change ids are already short words; commit hashes take the first 8. */
const shortId = (id: string): string => (id.length > 12 ? id.slice(0, 8) : id)

/*
 * The card's address header (lane piper step 5, ADR 0001): the global path
 * `/org/repo/path` the payload carries, plus the position the read was taken
 * at, plus — when the inventory says the repository's head has moved since —
 * a "head moved to <id> · refresh" line. Nothing auto-refreshes: the card
 * states where it stands; the human (or the model) re-reads explicitly.
 * The controller is read from context directly so component tests without a
 * provider still render the plain address.
 */
const FileCardHeader = (props: {
  readonly repo: string
  readonly path: string
  readonly address?: string | undefined
  readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null } | undefined
  readonly refreshCommand: "files.read" | "files.list"
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const controller = useContext(ControllerContext)
  if (controller === null) return <FileCardAddressLine {...props} head={null} />
  return <FileCardHeaderLive {...props} controller={controller} />
}

const FileCardAddressLine = ({
  repo,
  path,
  address,
  readAt,
  head,
  refreshCommand,
  onRunCommand
}: {
  readonly repo: string
  readonly path: string
  readonly address?: string | undefined
  readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null } | undefined
  readonly head: { readonly changeId: string | null; readonly commitId: string | null } | null
  readonly refreshCommand: "files.read" | "files.list"
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const moved = head !== null && readAt?.commitId != null && head.commitId != null && head.commitId !== readAt.commitId
  const refreshArgs = `${path === "" ? "/" : path} ${repo}`
  return (
    <div>
      <p className="world-card-path">
        {address ?? `${repo} · ${path || "/"}`}
        {readAt?.changeId != null ? ` · ${shortId(readAt.changeId)}` : null}
      </p>
      {moved ?
        (
          <p className="world-card-empty">
            head moved to {shortId(head.changeId ?? head.commitId ?? "")}
            {" · "}
            <Button
              variant="ghost"
              size="sm"
              data-flow={refreshCommand}
              onClick={() => onRunCommand(refreshCommand, refreshArgs)}
            >
              refresh
            </Button>
          </p>
        ) :
        null}
    </div>
  )
}

const FileCardHeaderLive = ({
  controller,
  ...props
}: {
  readonly controller: AppController
  readonly repo: string
  readonly path: string
  readonly address?: string | undefined
  readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null } | undefined
  readonly refreshCommand: "files.read" | "files.list"
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const { data: repositoryRows } = useLiveQuery((q) =>
    q.from({ repository: controller.store.collections.repositories }).select(({ repository }) => ({
      id: repository.id,
      head: repository.head
    })))
  const head = repositoryRows.find((row) => row.id === props.repo)?.head ?? null
  return <FileCardAddressLine {...props} head={head} />
}

export const FileListCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "file-list" }> } & FileCardActions) => {
  const { repo, path, entries } = card.payload
  return (
    <div className="world-card-list">
      <FileCardHeader
        repo={repo}
        path={path}
        address={card.payload.address}
        readAt={card.payload.readAt}
        refreshCommand="files.list"
        onRunCommand={onRunCommand}
      />
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
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "file" }> } & FileCardActions) => (
  <div className="world-card-list">
    <FileCardHeader
      repo={card.payload.repo}
      path={card.payload.path}
      address={card.payload.address}
      readAt={card.payload.readAt}
      refreshCommand="files.read"
      onRunCommand={onRunCommand}
    />
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
