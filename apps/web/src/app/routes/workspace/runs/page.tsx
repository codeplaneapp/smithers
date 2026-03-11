import { useNavigate } from "react-router-dom"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useStartRun } from "@/features/runs/hooks/use-start-run"
import { useRuns } from "@/features/runs/hooks/use-runs"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"
import { useWorkflows } from "@/features/workflows/hooks/use-workflows"

export function WorkspaceRunsPage() {
  const navigate = useNavigate()
  const { workspaceId } = useActiveWorkspace()
  const { data: workflows = [] } = useWorkflows(workspaceId)
  const { data: runs = [], isLoading } = useRuns(workspaceId)
  const startRun = useStartRun(workspaceId)

  return (
    <div className="flex flex-col">
      <div className="grid gap-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Launch run</CardTitle>
            <CardDescription>Start a run from a workspace workflow.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {workflows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No workflows available for this workspace.</p>
            ) : (
              workflows.map((workflow) => (
                <div
                  key={workflow.id}
                  className="flex items-center justify-between rounded-xl border px-3 py-2"
                >
                  <div className="flex flex-col">
                    <p className="font-medium">{workflow.name}</p>
                    <p className="text-xs text-muted-foreground">{workflow.relativePath}</p>
                  </div>
                  <Button
                    disabled={startRun.isPending}
                    onClick={() =>
                      startRun.mutate(
                        { workflowId: workflow.id },
                        {
                          onSuccess: (run) => navigate(`/w/${workspaceId}/runs/${run.id}`),
                        }
                      )
                    }
                  >
                    Start run
                  </Button>
                </div>
              ))
            )}
            {startRun.error ? (
              <p className="text-sm text-destructive">{startRun.error.message}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
            <CardDescription>Live polling fallback + SSE enriched state.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading runs…</p>
            ) : runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs found for this workspace.</p>
            ) : (
              runs.map((run) => (
                <button
                  type="button"
                  key={run.id}
                  className="flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors hover:bg-muted"
                  onClick={() => navigate(`/w/${workspaceId}/runs/${run.id}`)}
                >
                  <div className="flex flex-col gap-1">
                    <p className="font-medium">{run.id} · {run.workflowName}</p>
                    <p className="text-sm text-muted-foreground">started {run.startedAt}</p>
                  </div>
                  <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
                    {run.status}
                  </Badge>
                </button>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
