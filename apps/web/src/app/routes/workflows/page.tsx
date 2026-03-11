import { useEffect } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { WorkflowEditorPane } from "@/components/code-editor/workflow-editor-pane"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useDeleteWorkflow } from "@/features/workflows/hooks/use-delete-workflow"
import { useWorkflow } from "@/features/workflows/hooks/use-workflow"
import { useWorkflows } from "@/features/workflows/hooks/use-workflows"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

export function WorkflowsPage() {
  const navigate = useNavigate()
  const { workflowId: selectedWorkflowId } = useParams()
  const { workspace } = useActiveWorkspace()
  const { data: workflows = [], isLoading } = useWorkflows(workspace?.id)
  const { data: workflowDocument } = useWorkflow(workspace?.id, selectedWorkflowId)
  const deleteWorkflow = useDeleteWorkflow(workspace?.id)

  useEffect(() => {
    if (!selectedWorkflowId || isLoading) {
      return
    }

    if (workflows.every((workflow) => workflow.id !== selectedWorkflowId)) {
      navigate("/workflows", { replace: true })
    }
  }, [isLoading, navigate, selectedWorkflowId, workflows])

  return (
    <div className="flex flex-col">
      <div className="grid gap-4 p-6 xl:grid-cols-[20rem_1fr]">
        <Card className="h-full">
          <CardHeader>
            <CardTitle>Workspace workflows</CardTitle>
            <CardDescription>Source files under .mr-burns/workflows.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading workflows…</p>
            ) : workflows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No workflows found for this workspace.</p>
            ) : (
              workflows.map((workflow) => (
                <button
                  key={workflow.id}
                  type="button"
                  onClick={() => navigate(`/workflows/${workflow.id}`)}
                  className="flex items-center justify-between rounded-xl border px-3 py-3 text-left transition-colors hover:bg-muted"
                >
                  <div className="flex flex-col gap-1">
                    <p className="font-medium">{workflow.name}</p>
                    <p className="text-xs text-muted-foreground">{workflow.relativePath}</p>
                  </div>
                  <Badge variant={selectedWorkflowId === workflow.id ? "secondary" : "outline"}>
                    {workflow.status}
                  </Badge>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <WorkflowEditorPane
            workflow={workflowDocument ?? null}
            isDeleting={deleteWorkflow.isPending}
            onCreateNew={() => navigate("/workflows/new")}
            onEditWithAi={() => {
              if (!selectedWorkflowId) {
                return
              }

              navigate(`/workflows/${selectedWorkflowId}/edit`)
            }}
            onDelete={() => {
              if (!selectedWorkflowId) {
                return
              }

              const confirmed = window.confirm(
                `Delete workflow "${selectedWorkflowId}"? This removes its workflow folder from disk.`
              )
              if (!confirmed) {
                return
              }

              deleteWorkflow.mutate(selectedWorkflowId, {
                onSuccess: () => {
                  const remainingWorkflows = workflows.filter(
                    (workflow) => workflow.id !== selectedWorkflowId
                  )
                  const nextSelectedId = remainingWorkflows[0]?.id

                  navigate(nextSelectedId ? `/workflows/${nextSelectedId}` : "/workflows")
                },
              })
            }}
          />
          {deleteWorkflow.error ? (
            <p className="text-sm text-destructive">{deleteWorkflow.error.message}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
