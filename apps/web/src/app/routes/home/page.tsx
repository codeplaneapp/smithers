import { Navigate, useLocation } from "react-router-dom"

import { useOnboardingStatus } from "@/features/settings/hooks/use-onboarding-status"
import { shouldShowOnboarding } from "@/features/settings/lib/form"
import { useWorkspaces } from "@/features/workspaces/hooks/use-workspaces"

function resolveLegacyDeepLink(search: string) {
  const searchParams = new URLSearchParams(search)
  const tab = searchParams.get("tab")

  if (tab === "approvals") {
    return "/approvals"
  }

  if (tab !== "runs") {
    return null
  }

  const runId = searchParams.get("runId")
  const nodeId = searchParams.get("nodeId")

  if (!runId) {
    return "/runs"
  }

  if (nodeId) {
    return `/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`
  }

  return `/runs/${encodeURIComponent(runId)}`
}

export function HomePage() {
  const location = useLocation()
  const { data: workspaces = [], isLoading: isLoadingWorkspaces } = useWorkspaces()
  const { data: onboardingStatus, isLoading: isLoadingOnboarding } = useOnboardingStatus()
  const legacyDeepLink = resolveLegacyDeepLink(location.search)

  if (isLoadingWorkspaces || isLoadingOnboarding) {
    return <div className="p-6 text-sm text-muted-foreground">Loading workspaces…</div>
  }

  if (legacyDeepLink) {
    return <Navigate to={legacyDeepLink} replace />
  }

  if (workspaces[0]) {
    return <Navigate to={`/w/${workspaces[0].id}/overview`} replace />
  }

  if (shouldShowOnboarding({ workspacesCount: workspaces.length, onboardingCompleted: Boolean(onboardingStatus?.completed) })) {
    return <Navigate to="/onboarding" replace />
  }

  return <Navigate to="/workspaces/new" replace />
}
