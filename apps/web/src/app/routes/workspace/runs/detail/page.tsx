import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useRun } from "@/features/runs/hooks/use-run"
import { useRunEvents } from "@/features/runs/hooks/use-run-events"
import { useCancelRun } from "@/features/runs/hooks/use-cancel-run"
import { useResumeRun } from "@/features/runs/hooks/use-resume-run"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

function formatTimestamp(value?: string | null) {
  if (!value) {
    return "—"
  }

  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    return value
  }

  return date.toLocaleString()
}

function formatRawPayload(value: unknown) {
  if (value === undefined) {
    return "No raw payload available for this event."
  }

  try {
    const serialized = JSON.stringify(value, null, 2)
    return serialized ?? "null"
  } catch {
    return String(value)
  }
}

export function WorkspaceRunDetailPage() {
  const navigate = useNavigate()
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
  const [selectedEventSeq, setSelectedEventSeq] = useState<number | null>(null)
  const selectedEvent = useMemo(
    () => {
      if (!events || events.length === 0) {
        return undefined
      }

      if (selectedEventSeq === null) {
        return events[events.length - 1]
      }

      return events.find((event) => event.seq === selectedEventSeq) ?? events[events.length - 1]
    },
    [events, selectedEventSeq]
  )

  const resumeRun = useResumeRun(workspaceId, runId)
  const cancelRun = useCancelRun(workspaceId, runId)

  return (
    <div className="flex flex-col">
      <div className="grid gap-4 p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold">{runId ?? "Run"}</h1>
            <p className="text-sm text-muted-foreground">
              {isTimelineStreaming
                ? "Live event stream from Smithers with polling fallback."
                : "Static event history for this completed run."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => navigate(`/w/${workspaceId}/runs`)}>
              Back to runs
            </Button>
            <Button
              variant="outline"
              disabled={!runId || resumeRun.isPending}
              onClick={() => resumeRun.mutate({})}
            >
              {resumeRun.isPending ? "Resuming…" : "Resume"}
            </Button>
            <Button
              variant="destructive"
              disabled={!runId || cancelRun.isPending}
              onClick={() => cancelRun.mutate({})}
            >
              {cancelRun.isPending ? "Cancelling…" : "Cancel"}
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Run summary</CardTitle>
            {run ? (
              <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
                {run.status}
              </Badge>
            ) : null}
          </CardHeader>
          <CardContent className="grid gap-3 text-sm md:grid-cols-3">
            {isLoading ? (
              <p className="text-muted-foreground">Loading run…</p>
            ) : error ? (
              <p className="text-destructive">{error.message}</p>
            ) : run ? (
              <>
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-muted-foreground">Workflow</p>
                  <p className="font-medium">{run.workflowName}</p>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-muted-foreground">Started</p>
                  <p className="font-medium">{formatTimestamp(run.startedAt)}</p>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-muted-foreground">Finished</p>
                  <p className="font-medium">{formatTimestamp(run.finishedAt)}</p>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-muted-foreground">Finished tasks</p>
                  <p className="font-medium">{run.summary.finished}</p>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-muted-foreground">In progress</p>
                  <p className="font-medium">{run.summary.inProgress}</p>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-muted-foreground">Pending</p>
                  <p className="font-medium">{run.summary.pending}</p>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">Run not found.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Event timeline</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            {runEventsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading events…</p>
            ) : (events?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No events received yet.</p>
            ) : (
              <>
                <div className="flex max-h-[32rem] flex-col gap-2 overflow-auto">
                  {events!.map((event) => {
                    const isSelected = selectedEvent?.seq === event.seq

                    return (
                      <button
                        key={`${event.seq}-${event.type}`}
                        type="button"
                        className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                          isSelected ? "border-primary bg-accent" : ""
                        }`}
                        onClick={() => setSelectedEventSeq(event.seq)}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-medium">{event.type}</p>
                          <span className="text-xs text-muted-foreground">seq {event.seq}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {formatTimestamp(event.timestamp)}
                        </p>
                        {event.nodeId ? (
                          <p className="text-xs text-muted-foreground">node: {event.nodeId}</p>
                        ) : null}
                        {event.message ? <p className="mt-1">{event.message}</p> : null}
                      </button>
                    )
                  })}
                </div>

                <div className="flex max-h-[32rem] flex-col rounded-lg border">
                  <div className="border-b px-3 py-2">
                    <p className="font-medium">Raw event output</p>
                    {selectedEvent ? (
                      <p className="text-xs text-muted-foreground">
                        {selectedEvent.type} • seq {selectedEvent.seq}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">Select an event to inspect.</p>
                    )}
                  </div>
                  <pre className="overflow-auto p-3 text-xs">
                    {selectedEvent
                      ? formatRawPayload(selectedEvent.rawPayload ?? selectedEvent)
                      : "Select an event to inspect raw output."}
                  </pre>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
