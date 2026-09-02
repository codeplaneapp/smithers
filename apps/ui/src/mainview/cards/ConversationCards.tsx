import { Badge, Button, FileTree } from "@smthrs/ui"
import { ExternalLink, GitPullRequest, HardDrive, Server } from "lucide-react"
import { lazy, Suspense, useState } from "react"
import type { Card, WorldDocument } from "../state/AppState"
import { WORLD_DISPLAY_NAME } from "../state/AppState"

const MarkdownEditorSurface = lazy(() =>
  import("../MarkdownEditorSurface").then((module) => ({ default: module.MarkdownEditorSurface }))
)

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

