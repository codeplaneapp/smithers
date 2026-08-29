import { Badge, Button } from "@smthrs/ui"
import { groupTargetsByWorkspace } from "smithers-shared/TargetPresentation"
import type { Card } from "../state/AppState"

export const RepoCardBody = ({ card }: { readonly card: Extract<Card, { kind: "repo" }> }) => {
  const { repo } = card.payload
  return (
    <div className="repo-card">
      <p className="repo-card-path">{repo.path}</p>
      {repo.git !== null ?
        (
          <p className="repo-card-git">
            {repo.git.branch ?? "detached"}
            {repo.git.remote !== null ? ` · ${repo.git.remote}` : ""}
          </p>
        ) :
        null}
      <p className="repo-card-detection" data-detected={repo.smithers.detected}>
        {repo.smithers.reason}
      </p>
      {repo.warnings.length > 0 ?
        (
          <ul className="targets-card-warnings" role="alert">
            {repo.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
          </ul>
        ) :
        null}
    </div>
  )
}

export const TargetsCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "targets" }>
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const { repoId, repoName, status, targets, warnings, highlighted } = card.payload
  const workspaces = groupTargetsByWorkspace(targets)
  const showWorkspaceNames = workspaces.length > 1
  return (
    <div className="targets-card">
      {status === "pending" ? <p className="smithers-card-note">Loading targets…</p> : null}
      {warnings.length > 0 ?
        (
          <ul className="targets-card-warnings" role="alert">
            {warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
          </ul>
        ) :
        null}
      {workspaces.map((workspace) => (
        <section
          key={workspace.workspace}
          className="targets-card-workspace"
          data-workspace={workspace.workspace}
        >
          {showWorkspaceNames ?
            (
              <h3 className="targets-card-workspace-name">
                {workspace.workspace === "." ? repoName : workspace.workspace}
              </h3>
            ) :
            null}
          {workspace.packages.map((group) => (
            <section key={group.package} className="targets-card-package" data-package={group.package}>
              <h4 className="targets-card-package-name">{group.package}</h4>
              <ul className="targets-card-list">
                {group.targets.map((target) => (
                  <li
                    key={`${target.workspace}:${target.label}`}
                    className="targets-card-row"
                    data-target-row={target.label}
                    data-highlighted={highlighted === target.label}
                  >
                    <span className="targets-card-label">{target.label}</span>
                    <span className="targets-card-type">{target.target}</span>
                    <span className="targets-card-kinds">
                      {target.kinds.map((kind) => <Badge key={kind} variant="outline">{kind}</Badge>)}
                    </span>
                    {target.id === undefined ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        data-flow="target.run"
                        data-testid={`targets-run-${target.label}`}
                        aria-label={`Run ${target.label}`}
                        onClick={() =>
                          onRunCommand("target.run", `${repoId} ${target.workspace} ${target.label}`)}
                      >
                        Run
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </section>
      ))}
    </div>
  )
}

const HTML_CARD_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'"

/** Legacy HTML cards are inert documents: no script, network, forms, or parent bridge. */
export const inertHtmlDocument = (html: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_CARD_CSP}"></head><body>${html}</body></html>`

export const HtmlCardBody = ({ card }: { readonly card: Extract<Card, { kind: "html" }> }) => (
  <div className="html-card">
    <iframe
      className="html-card-frame"
      title={card.payload.title}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={inertHtmlDocument(card.payload.html)}
      data-testid={`html-card-frame-${card.id}`}
      data-source={card.payload.source}
    />
  </div>
)

export const TargetRunCardBody = ({ card }: { readonly card: Extract<Card, { kind: "target-run" }> }) => {
  const { label, status, exitCode, output } = card.payload
  return (
    <div className="target-run-card" data-run-status={status}>
      <p className="target-run-meta">
        <span className="targets-card-label">{label}</span>
        <Badge variant={status === "done" ? "success" : status === "failed" ? "destructive" : "outline"}>
          {status}{exitCode !== null ? ` · exit ${exitCode}` : ""}
        </Badge>
      </p>
      <pre className="target-run-output" data-testid={`target-run-output-${card.id}`}>{output}</pre>
    </div>
  )
}
