/*
 * The repo-import card: one upserted job card, phase starting → running →
 * done | failed. The frame's StatusPill wears the coarse state; the body
 * names the exact phase, the live stage detail, and — on a failure — one
 * retry act bound to /repos.import.
 */
import { Badge, Button } from "@smthrs/ui"
import { CloudDownload, RefreshCw } from "lucide-react"
import type { Card } from "../state/AppState"

const PHASE_VARIANT = {
  starting: "outline",
  running: "outline",
  done: "success",
  failed: "destructive"
} as const

export const RepoImportCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "repo-import" }>
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const { repo, jobId, phase, detail } = card.payload
  return (
    <div className="world-card-list">
      <div className="world-card-row">
        <span className="connect-store-icon">
          <CloudDownload size={14} />
        </span>
        <span className="world-card-title">{repo}</span>
        <Badge variant={PHASE_VARIANT[phase]}>{phase}</Badge>
      </div>
      {detail !== null ? <p className="world-card-path">{detail}</p> : null}
      {jobId !== null ? <p className="world-card-path">job {jobId}</p> : null}
      {phase === "failed" ?
        (
          <div className="world-card-row">
            <Button
              size="sm"
              variant="outline"
              data-flow="repos.import"
              onClick={() => onRunCommand("repos.import", repo)}
            >
              <RefreshCw size={14} /> Try again
            </Button>
          </div>
        ) :
        null}
    </div>
  )
}
