import { Outlet, useLocation } from "react-router-dom"

import mrBurnsAvatar from "@/assets/mr-burns.png"
import { SidebarNav } from "@/components/app-shell/sidebar-nav"
import { WorkspaceSelector } from "@/components/app-shell/workspace-selector"
import { Badge } from "@/components/ui/badge"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

const globalItems = [
  { label: "Workflows", to: "/workflows" },
  { label: "Add workspace", to: "/workspaces/new" },
  { label: "Settings", to: "/settings" },
]

function toTitleCase(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function buildBreadcrumbs(pathname: string, workspaceName?: string) {
  const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment))

  if (segments.length === 0) {
    return ["Home"]
  }

  if (segments[0] === "workflows") {
    const workflowCrumbs = ["Workflow"]

    if (segments[1] === "new") {
      workflowCrumbs.push("New")
      return workflowCrumbs
    }

    if (segments[1]) {
      workflowCrumbs.push(segments[1])
    }

    if (segments[2]) {
      workflowCrumbs.push(toTitleCase(segments[2]))
    }

    return workflowCrumbs
  }

  if (segments[0] === "workspaces" && segments[1] === "new") {
    return ["Workspace", "New"]
  }

  if (segments[0] === "settings") {
    return ["Settings"]
  }

  if (segments[0] === "w") {
    const workspaceCrumbs = [workspaceName ?? "Workspace"]

    if (segments[2]) {
      workspaceCrumbs.push(toTitleCase(segments[2]))
    }

    return workspaceCrumbs
  }

  return segments.map((segment) => toTitleCase(segment))
}

export function AppShell() {
  const location = useLocation()
  const { workspace } = useActiveWorkspace()
  const breadcrumbs = buildBreadcrumbs(location.pathname, workspace?.name)

  return (
    <div className="grid min-h-screen grid-cols-[18rem_1fr] bg-background text-foreground">
      <aside className="border-r bg-sidebar">
        <div className="flex h-full flex-col gap-6 p-4">
          <div className="flex items-center gap-3 px-2 py-1">
            <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border bg-background">
              <img src={mrBurnsAvatar} alt="Mr. Burns" className="h-full w-full object-cover object-top" />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-semibold">Mr. Burns</span>
              <span className="text-xs text-muted-foreground">Smither&apos;s Manager</span>
            </div>
          </div>

          <SidebarNav title="Global" items={globalItems} />
          <WorkspaceSelector />
        </div>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              {breadcrumbs.map((crumb, index) => (
                <div key={`${crumb}-${index}`} className="flex items-center gap-2">
                  {index > 0 ? <span className="text-muted-foreground">{">"}</span> : null}
                  <span>{crumb}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">Inbox 3</Badge>
          </div>
        </header>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
