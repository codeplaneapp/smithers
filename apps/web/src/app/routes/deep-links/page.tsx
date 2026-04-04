import { useEffect, useMemo, useState } from "react"
import { Navigate, useParams } from "react-router-dom"

import { useWorkspaces } from "@/features/workspaces/hooks/use-workspaces"
import { setActiveWorkspaceId, useStoredActiveWorkspaceId } from "@/features/workspaces/lib/active-workspace-store"
import { burnsClient } from "@/lib/api/client"

function resolvePreferredWorkspaceId(
  workspaces: Array<{ id: string }>,
  preferredWorkspaceId?: string | null
) {
  if (
    preferredWorkspaceId &&
    workspaces.some((workspace) => workspace.id === preferredWorkspaceId)
  ) {
    return preferredWorkspaceId
  }

  return workspaces[0]?.id ?? null
}

async function findWorkspaceIdForRun(
  runId: string,
  workspaceIds: string[]
) {
  for (const workspaceId of workspaceIds) {
    try {
      const runs = await burnsClient.listRuns(workspaceId)
      if (runs.some((run) => run.id === runId)) {
        return workspaceId
      }
    } catch {
      // Best-effort lookup; we fall back to current/first workspace below.
    }
  }

  return null
}

export function RunsDeepLinkPage() {
  const { data: workspaces = [], isLoading } = useWorkspaces()
  const storedWorkspaceId = useStoredActiveWorkspaceId()

  const fallbackWorkspaceId = useMemo(
    () => resolvePreferredWorkspaceId(workspaces, storedWorkspaceId),
    [storedWorkspaceId, workspaces]
  )

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading runs…</div>
  }

  if (!fallbackWorkspaceId) {
    return <Navigate to="/" replace />
  }

  return <Navigate to={`/w/${encodeURIComponent(fallbackWorkspaceId)}/runs`} replace />
}

type RunLinkResolverState = {
  targetPath: string | null
  resolving: boolean
}

function RunLinkResolverPage(props: { nodeId?: string }) {
  const { runId } = useParams()
  const { data: workspaces = [], isLoading } = useWorkspaces()
  const storedWorkspaceId = useStoredActiveWorkspaceId()
  const [state, setState] = useState<RunLinkResolverState>({
    targetPath: null,
    resolving: true,
  })

  const fallbackWorkspaceId = useMemo(
    () => resolvePreferredWorkspaceId(workspaces, storedWorkspaceId),
    [storedWorkspaceId, workspaces]
  )

  useEffect(() => {
    if (!runId) {
      setState({
        targetPath: "/",
        resolving: false,
      })
      return
    }

    if (isLoading) {
      setState((currentState) => ({
        ...currentState,
        resolving: true,
      }))
      return
    }

    if (!fallbackWorkspaceId) {
      setState({
        targetPath: "/",
        resolving: false,
      })
      return
    }

    let cancelled = false
    setState({
      targetPath: null,
      resolving: true,
    })

    const workspaceIds = workspaces.map((workspace) => workspace.id)

    void findWorkspaceIdForRun(runId, workspaceIds).then((resolvedWorkspaceId) => {
      if (cancelled) {
        return
      }

      const workspaceId = resolvedWorkspaceId ?? fallbackWorkspaceId
      setActiveWorkspaceId(workspaceId)

      const search = props.nodeId
        ? `?nodeId=${encodeURIComponent(props.nodeId)}`
        : ""
      setState({
        targetPath: `/w/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}${search}`,
        resolving: false,
      })
    })

    return () => {
      cancelled = true
    }
  }, [
    fallbackWorkspaceId,
    isLoading,
    props.nodeId,
    runId,
    workspaces,
  ])

  if (state.targetPath) {
    return <Navigate to={state.targetPath} replace />
  }

  if (state.resolving) {
    return <div className="p-6 text-sm text-muted-foreground">Resolving run link…</div>
  }

  return <Navigate to="/" replace />
}

export function RunDeepLinkPage() {
  return <RunLinkResolverPage />
}

export function NodeDeepLinkPage() {
  const { nodeId } = useParams()
  return <RunLinkResolverPage nodeId={nodeId} />
}
