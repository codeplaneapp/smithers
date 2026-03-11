import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useApprovals } from "@/features/approvals/hooks/use-approvals"
import { useRuns } from "@/features/runs/hooks/use-runs"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"
import { useWorkflows } from "@/features/workflows/hooks/use-workflows"

export function WorkspaceOverviewPage() {
  const { workspace, workspaceId } = useActiveWorkspace()
  const { data: workflows = [] } = useWorkflows(workspaceId)
  const { data: runs = [] } = useRuns(workspaceId)
  const { data: approvals = [] } = useApprovals(workspaceId)

  return (
    <div className="flex flex-col">
      <div className="grid gap-4 p-6 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Current branch</CardTitle>
            <CardDescription>{workspace?.branch ?? "unknown"}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">clean working tree</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Workflows</CardTitle>
            <CardDescription>{workflows.length}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {workflows.map((workflow) => workflow.name).join(" · ") || "No workflows indexed"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active runs</CardTitle>
            <CardDescription>{runs.filter((run) => run.status === "running").length}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">implementation loop running</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Pending approvals</CardTitle>
            <CardDescription>{approvals.length}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">deploy gate nearing SLA</CardContent>
        </Card>
      </div>
    </div>
  )
}
