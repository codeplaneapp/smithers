import { DEFAULT_AGENT } from "@/config/app-config"
import { DEFAULT_WORKSPACES_ROOT } from "@/config/paths"
import {
  getSmithersBaseUrlSettingValue,
  isWorkspaceSmithersManaged,
} from "@/services/smithers-instance-service"

export function handleSettingsRoutes(request: Request, pathname: string) {
  if (pathname === "/api/settings" && request.method === "GET") {
    return Response.json({
      workspaceRoot: DEFAULT_WORKSPACES_ROOT,
      defaultAgent: DEFAULT_AGENT,
      smithersBaseUrl: getSmithersBaseUrlSettingValue(),
      allowNetwork: false,
      smithersManagedPerWorkspace: isWorkspaceSmithersManaged(),
    })
  }

  return null
}
