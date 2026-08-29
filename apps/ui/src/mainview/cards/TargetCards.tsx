/*
 * Lane L3's cards (docs/LOCAL-APP.md "Cards"): the opened repository, its
 * loaded targets, the panel the model (or the built-in template) authored,
 * and one streamed target run. The html card's frame is sandboxed to
 * scripts alone; its `run` / `open` messages reach the controller's window
 * listener, which finds the card through the frame's own attribute.
 */
import { Badge } from "@smthrs/ui"
import { groupTargets } from "smithers-shared/TargetsPanel"
import type { Card } from "../state/AppState"
import { HTML_CARD_FRAME_ATTRIBUTE } from "../state/controller/targets"

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
    </div>
  )
}

export const TargetsCardBody = ({ card }: { readonly card: Extract<Card, { kind: "targets" }> }) => {
  const { status, targets, warnings, highlighted } = card.payload
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
      {groupTargets(targets).map((group) => (
        <section key={group.package} className="targets-card-package" data-package={group.package}>
          <h3 className="targets-card-package-name">{group.package}</h3>
          <ul className="targets-card-list">
            {group.targets.map((target) => (
              <li
                key={target.label}
                className="targets-card-row"
                data-target-row={target.label}
                data-highlighted={highlighted === target.label}
              >
                <span className="targets-card-label">{target.label}</span>
                <span className="targets-card-type">{target.target}</span>
                <span className="targets-card-kinds">
                  {target.kinds.map((kind) => <Badge key={kind} variant="outline">{kind}</Badge>)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export const HtmlCardBody = ({ card }: { readonly card: Extract<Card, { kind: "html" }> }) => (
  <div className="html-card">
    <iframe
      className="html-card-frame"
      title={card.payload.title}
      sandbox="allow-scripts"
      srcDoc={card.payload.html}
      data-testid={`html-card-frame-${card.id}`}
      data-source={card.payload.source}
      {...{ [HTML_CARD_FRAME_ATTRIBUTE]: card.id }}
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
