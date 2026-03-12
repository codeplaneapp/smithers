import type { Workspace } from "@burns/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useDaemonHealth } from "@/features/workspace/hooks/use-daemon-health"
import {
  useWorkspaceServerActions,
  useWorkspaceServerStatus,
} from "@/features/workspace/hooks/use-workspace-server"
import { formatTimestamp } from "@/features/workspace/lib/format"

function getHealthBadgeVariant(status: Workspace["healthStatus"]) {
  if (status === "healthy") {
    return "secondary"
  }

  if (status === "degraded") {
    return "outline"
  }

  if (status === "disconnected") {
    return "destructive"
  }

  return "outline"
}

type ServerHealthCardProps = {
  workspace: Workspace | null
  workspaceId?: string
  title?: string
  description?: string
  showControls?: boolean
}

export function ServerHealthCard({
  workspace,
  workspaceId,
  title = "Server health",
  description = "Workspace runtime and daemon health status.",
  showControls = false,
}: ServerHealthCardProps) {
  const resolvedWorkspaceId = workspaceId ?? workspace?.id
  const daemonHealth = useDaemonHealth()
  const workspaceServerStatus = useWorkspaceServerStatus(resolvedWorkspaceId)
  const workspaceServerActions = useWorkspaceServerActions(resolvedWorkspaceId)
  const daemonOnline = Boolean(daemonHealth.data?.ok) && !daemonHealth.isError
  const serverStatus = workspaceServerStatus.data
  const runtimeMode = serverStatus?.runtimeMode ?? workspace?.runtimeMode ?? "burns-managed"
  const isSelfManaged = runtimeMode === "self-managed"
  const actionDisabled =
    !resolvedWorkspaceId ||
    isSelfManaged ||
    workspaceServerActions.start.isPending ||
    workspaceServerActions.restart.isPending ||
    workspaceServerActions.stop.isPending

  const serverActionError =
    workspaceServerActions.start.error ??
    workspaceServerActions.restart.error ??
    workspaceServerActions.stop.error

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm md:grid-cols-2">
        <div className="rounded-lg border px-3 py-2">
          <p className="text-muted-foreground">Workspace health</p>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant={getHealthBadgeVariant(workspace?.healthStatus ?? "unknown")}>
              {workspace?.healthStatus ?? "unknown"}
            </Badge>
            <span className="text-xs text-muted-foreground">updated {formatTimestamp(workspace?.updatedAt)}</span>
          </div>
        </div>

        <div className="rounded-lg border px-3 py-2">
          <p className="text-muted-foreground">Daemon status</p>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant={daemonOnline ? "secondary" : "destructive"}>
              {daemonOnline ? "online" : "unreachable"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {daemonHealth.data?.service ?? "burns daemon"}
            </span>
          </div>
        </div>

        <div className="rounded-lg border px-3 py-2">
          <p className="text-muted-foreground">Runtime mode</p>
          <p className="font-medium">{runtimeMode}</p>
        </div>

        <div className="rounded-lg border px-3 py-2">
          <p className="text-muted-foreground">Smithers process state</p>
          <p className="font-medium">{serverStatus?.processState ?? "unknown"}</p>
        </div>

        <div className="rounded-lg border px-3 py-2">
          <p className="text-muted-foreground">Last heartbeat</p>
          <p className="font-medium">{formatTimestamp(serverStatus?.lastHeartbeatAt)}</p>
        </div>

        <div className="rounded-lg border px-3 py-2">
          <p className="text-muted-foreground">Restart / crash count</p>
          <p className="font-medium">
            {(serverStatus?.restartCount ?? 0).toString()} / {(serverStatus?.crashCount ?? 0).toString()}
          </p>
        </div>

        <div className="rounded-lg border px-3 py-2">
          <p className="text-muted-foreground">Smithers endpoint</p>
          <p className="truncate font-medium">
            {serverStatus?.baseUrl ?? workspace?.smithersBaseUrl ?? "workspace-managed"}
          </p>
        </div>

        {showControls ? (
          <div className="rounded-lg border px-3 py-2 md:col-span-2">
            <p className="text-muted-foreground">Server controls</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={actionDisabled}
                onClick={() => workspaceServerActions.start.mutate()}
              >
                Start
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={actionDisabled}
                onClick={() => workspaceServerActions.restart.mutate()}
              >
                Restart
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={actionDisabled}
                onClick={() => workspaceServerActions.stop.mutate()}
              >
                Stop
              </Button>
            </div>
            {isSelfManaged ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Controls are disabled for self-managed workspaces.
              </p>
            ) : null}
            {serverActionError ? (
              <p className="mt-2 text-sm text-destructive">{serverActionError.message}</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
