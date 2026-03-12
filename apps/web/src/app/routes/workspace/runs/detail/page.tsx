import { type ReactNode, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { CheckCircle2, Clock3, LoaderCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useRun } from "@/features/runs/hooks/use-run"
import { useRunEvents } from "@/features/runs/hooks/use-run-events"
import { buildNodeRunTimeline } from "@/features/runs/lib/run-timeline"
import {
  parseInlineCodeSegments,
  parseStructuredOutputCards,
  parseStructuredOutputJsonObjects,
} from "@/features/runs/lib/structured-output"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

function formatTimestamp(value?: string | null) {
  if (!value) {
    return "—"
  }

  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    return value
  }

  if (date.getTime() === 0) {
    return "—"
  }

  return date.toLocaleString()
}

function formatNodeStatus(status: "running" | "completed" | "failed") {
  if (status === "completed") {
    return "Completed"
  }

  if (status === "failed") {
    return "Failed"
  }

  return "Running"
}

function formatRunStatus(status: string) {
  return status
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ")
}

function renderInlineCodeText(value: string): ReactNode[] {
  return parseInlineCodeSegments(value).map((segment, index) =>
    segment.kind === "code" ? (
      <code
        key={`inline-code-${index}`}
        className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground"
      >
        {segment.text}
      </code>
    ) : (
      <span key={`inline-text-${index}`}>{segment.text}</span>
    )
  )
}

export function WorkspaceRunDetailPage() {
  const { runId } = useParams()
  const { workspaceId } = useActiveWorkspace()
  const { data: run, isLoading, error } = useRun(workspaceId, runId)
  const isTimelineStreaming = run
    ? run.status === "running" || run.status === "waiting-approval"
    : true
  const runEventsQuery = useRunEvents(workspaceId, runId, {
    enableStream: isTimelineStreaming,
    refetchIntervalMs: isTimelineStreaming ? 5000 : false,
  })
  const events = runEventsQuery.data
  const nodeTimeline = useMemo(() => buildNodeRunTimeline(events ?? []), [events])
  const displayRunStartedAt = useMemo(() => {
    const runStartedDate = run?.startedAt ? new Date(run.startedAt) : null
    const hasValidRunStartedAt =
      runStartedDate !== null &&
      !Number.isNaN(runStartedDate.valueOf()) &&
      runStartedDate.getTime() > 0

    if (hasValidRunStartedAt) {
      return run!.startedAt
    }

    return events?.[0]?.timestamp ?? null
  }, [events, run?.startedAt])
  const [selectedNodeRunId, setSelectedNodeRunId] = useState<string | null>(null)
  const [outputMode, setOutputMode] = useState<"parsed" | "raw">("parsed")
  const selectedNodeRun = useMemo(
    () => {
      if (nodeTimeline.length === 0) {
        return undefined
      }

      if (selectedNodeRunId === null) {
        return nodeTimeline[nodeTimeline.length - 1]
      }

      return nodeTimeline.find((entry) => entry.id === selectedNodeRunId) ?? nodeTimeline[nodeTimeline.length - 1]
    },
    [nodeTimeline, selectedNodeRunId]
  )
  const structuredOutputCards = useMemo(
    () => parseStructuredOutputCards(selectedNodeRun?.outputText ?? ""),
    [selectedNodeRun?.outputText]
  )
  const rawJsonOutput = useMemo(() => {
    const parsedObjects = parseStructuredOutputJsonObjects(selectedNodeRun?.outputText ?? "")
    if (parsedObjects.length === 0) {
      return null
    }

    if (parsedObjects.length === 1) {
      return JSON.stringify(parsedObjects[0], null, 2)
    }

    return JSON.stringify(parsedObjects, null, 2)
  }, [selectedNodeRun?.outputText])

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-x-hidden">
      <div className="grid min-h-0 flex-1 gap-4 p-4">
        <div className="grid min-h-0 flex-1 gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">Event timeline</h2>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading run…</p>
            ) : error ? (
              <p className="text-sm text-destructive">{error.message}</p>
            ) : run ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
                  {formatRunStatus(run.status)}
                </Badge>
                <span>|</span>
                <span>{formatTimestamp(displayRunStartedAt)}</span>
                <span>|</span>
                <span className="inline-flex items-center gap-1">
                  <Clock3 className="size-3.5" />
                  {run.summary.pending}
                </span>
                <span className="inline-flex items-center gap-1">
                  <LoaderCircle className="size-3.5" />
                  {run.summary.inProgress}
                </span>
                <span className="inline-flex items-center gap-1">
                  <CheckCircle2 className="size-3.5" />
                  {run.summary.finished}
                </span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Run not found.</p>
            )}
          </div>
          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3">
            {runEventsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading events…</p>
            ) : nodeTimeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events received yet.</p>
            ) : (
              <>
                <div className="flex min-h-0 flex-col gap-2 overflow-auto lg:col-span-1">
                  {nodeTimeline.map((nodeRun) => {
                    const isSelected = selectedNodeRun?.id === nodeRun.id

                    return (
                      <button
                        key={nodeRun.id}
                        type="button"
                        className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                          isSelected ? "border-primary bg-accent" : ""
                        }`}
                        onClick={() => setSelectedNodeRunId(nodeRun.id)}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-medium">{nodeRun.nodeId}</p>
                          <span className="text-xs text-muted-foreground">
                            {formatNodeStatus(nodeRun.status)}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {formatTimestamp(nodeRun.startedAt ?? nodeRun.finishedAt)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          iteration {nodeRun.iteration} • attempt {nodeRun.attempt}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          seq {nodeRun.firstSeq}
                          {nodeRun.lastSeq !== nodeRun.firstSeq ? `-${nodeRun.lastSeq}` : ""}
                        </p>
                      </button>
                    )
                  })}
                </div>

                <div className="flex min-h-0 flex-col rounded-lg border lg:col-span-2">
                  <div className="border-b px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">
                        {selectedNodeRun ? selectedNodeRun.nodeId : "Parsed text output"}
                      </p>
                      <div className="flex items-center gap-1">
                        <Button
                          size="xs"
                          variant={outputMode === "parsed" ? "secondary" : "outline"}
                          onClick={() => setOutputMode("parsed")}
                        >
                          Parsed
                        </Button>
                        <Button
                          size="xs"
                          variant={outputMode === "raw" ? "secondary" : "outline"}
                          onClick={() => setOutputMode("raw")}
                        >
                          Raw
                        </Button>
                      </div>
                    </div>
                    {selectedNodeRun ? (
                      <p className="text-xs text-muted-foreground">
                        iteration {selectedNodeRun.iteration} • attempt {selectedNodeRun.attempt}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select a node to inspect output.</p>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto p-3">
                    {!selectedNodeRun ? (
                      <p className="text-xs text-muted-foreground">Select a node to inspect parsed output.</p>
                    ) : outputMode === "raw" ? (
                      rawJsonOutput ? (
                        <pre className="whitespace-pre-wrap break-words text-xs">{rawJsonOutput}</pre>
                      ) : (
                        <pre className="whitespace-pre-wrap break-words text-xs">
                          {selectedNodeRun.outputText || "No NodeOutput text captured for this node."}
                        </pre>
                      )
                    ) : structuredOutputCards.length > 0 ? (
                      <div className="space-y-3">
                        {structuredOutputCards.map((card) => (
                          <div key={card.id} className="rounded-md border bg-muted/20">
                            <div className="border-b px-3 py-2">
                              <p className="text-sm font-medium">{card.title}</p>
                            </div>
                            <div className="space-y-3 p-3">
                              {card.sections.map((section, sectionIndex) => {
                                if (section.kind === "paragraph") {
                                  return (
                                    <div key={`${card.id}-${section.title}-${sectionIndex}`} className="space-y-1">
                                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {section.title}
                                      </p>
                                      <p className="whitespace-pre-wrap break-words text-sm">
                                        {renderInlineCodeText(section.text)}
                                      </p>
                                    </div>
                                  )
                                }

                                if (section.kind === "bullets") {
                                  return (
                                    <div key={`${card.id}-${section.title}-${sectionIndex}`} className="space-y-1">
                                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        {section.title}
                                      </p>
                                      <ul className="list-disc space-y-1 pl-4 text-sm">
                                        {section.items.map((item, itemIndex) => (
                                          <li key={`${card.id}-${section.title}-${itemIndex}`} className="break-words">
                                            {renderInlineCodeText(item)}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )
                                }

                                return (
                                  <div key={`${card.id}-${section.title}-${sectionIndex}`} className="space-y-1">
                                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      {section.title}
                                    </p>
                                    <Collapsible>
                                      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border px-2 py-1 text-left text-sm hover:bg-accent">
                                        <span>Show files</span>
                                        <span className="text-xs text-muted-foreground">
                                          {section.files.length} entries
                                        </span>
                                      </CollapsibleTrigger>
                                      <CollapsibleContent className="pt-2">
                                        <Table className="text-xs">
                                          <TableHeader>
                                            <TableRow>
                                              <TableHead>Path</TableHead>
                                              <TableHead>Extension</TableHead>
                                            </TableRow>
                                          </TableHeader>
                                          <TableBody>
                                            {section.files.map((file, fileIndex) => (
                                              <TableRow key={`${card.id}-${section.title}-file-${fileIndex}`}>
                                                <TableCell className="whitespace-normal break-all">
                                                  {file.path}
                                                </TableCell>
                                                <TableCell>{file.extension}</TableCell>
                                              </TableRow>
                                            ))}
                                          </TableBody>
                                        </Table>
                                      </CollapsibleContent>
                                    </Collapsible>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <pre className="whitespace-pre-wrap break-words text-xs">
                        {selectedNodeRun.outputText || "No NodeOutput text captured for this node."}
                      </pre>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
