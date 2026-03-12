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
  const { workspace, workspaceId } = useActiveWorkspace()
  const { data: workflows = [], isLoading } = useWorkflows(workspace?.id)
  const { data: workflowDocument } = useWorkflow(workspace?.id, selectedWorkflowId)
  const deleteWorkflow = useDeleteWorkflow(workspace?.id)
  const workflowsBasePath = workspaceId ? `/w/${workspaceId}/workflows` : "/"

  useEffect(() => {
    if (!selectedWorkflowId || isLoading) {
      return
    }

    if (workflows.every((workflow) => workflow.id !== selectedWorkflowId)) {
      navigate(workflowsBasePath, { replace: true })
    }
  }, [isLoading, navigate, selectedWorkflowId, workflows, workflowsBasePath])

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden xl:overflow-y-hidden">
      <div className="grid w-full min-w-0 max-w-full gap-4 p-6 xl:h-full xl:min-h-0 xl:grid-cols-[20rem_1fr] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
        <Card className="h-full min-w-0 xl:flex xl:min-h-0 xl:flex-col">
          <CardHeader>
            <CardTitle>Workspace workflows</CardTitle>
            <CardDescription>Source files under .mr-burns/workflows.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading workflows…</p>
            ) : workflows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No workflows found for this workspace.</p>
            ) : (
              workflows.map((workflow) => (
                <button
                  key={workflow.id}
                  type="button"
                  onClick={() => navigate(`${workflowsBasePath}/${workflow.id}`)}
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

        <div className="flex min-w-0 flex-col gap-4 xl:min-h-0 xl:overflow-hidden">
          <WorkflowEditorPane
            workflow={workflowDocument ?? null}
            isDeleting={deleteWorkflow.isPending}
            onCreateNew={() => navigate(`${workflowsBasePath}/new`)}
            onEditWithAi={() => {
              if (!selectedWorkflowId) {
                return
              }

              navigate(`${workflowsBasePath}/${selectedWorkflowId}/edit`)
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

                  navigate(nextSelectedId ? `${workflowsBasePath}/${nextSelectedId}` : workflowsBasePath)
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
