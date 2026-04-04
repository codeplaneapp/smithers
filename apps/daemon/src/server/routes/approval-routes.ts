import { approvalDecisionInputSchema } from "@burns/shared"

import { decideApproval, listApprovals, listPendingApprovalInbox } from "@/services/approval-service"
import { toErrorResponse } from "@/utils/http-error"

export async function handleApprovalRoutes(request: Request, pathname: string) {
  try {
    if (
      request.method === "GET" &&
      (pathname === "/api/approvals" || pathname === "/api/approval/list")
    ) {
      return Response.json({
        approvals: await listPendingApprovalInbox(),
      })
    }

    const approvalsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/approvals$/)
    if (approvalsMatch && request.method === "GET") {
      return Response.json(listApprovals(approvalsMatch[1]))
    }

    const approveMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/nodes\/([^/]+)\/approve$/
    )
    if (approveMatch && request.method === "POST") {
      const input = approvalDecisionInputSchema.parse(await request.json().catch(() => null))
      return Response.json(
        await decideApproval({
          workspaceId: approveMatch[1],
          runId: approveMatch[2],
          nodeId: approveMatch[3],
          decision: "approved",
          input,
        })
      )
    }

    const denyMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/nodes\/([^/]+)\/deny$/)
    if (denyMatch && request.method === "POST") {
      const input = approvalDecisionInputSchema.parse(await request.json().catch(() => null))
      return Response.json(
        await decideApproval({
          workspaceId: denyMatch[1],
          runId: denyMatch[2],
          nodeId: denyMatch[3],
          decision: "denied",
          input,
        })
      )
    }

    return null
  } catch (error) {
    return toErrorResponse(error)
  }
}
