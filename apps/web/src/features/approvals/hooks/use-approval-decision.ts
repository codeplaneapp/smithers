import type { ApprovalDecisionInput } from "@burns/shared"

import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useApprovalDecision(workspaceId?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: {
      workspaceId?: string
      runId: string
      nodeId: string
      decision: "approved" | "denied"
      input: ApprovalDecisionInput
    }) => {
      const effectiveWorkspaceId = params.workspaceId ?? workspaceId
      if (!effectiveWorkspaceId) {
        throw new Error("workspaceId is required to resolve approval decisions")
      }

      if (params.decision === "approved") {
        return await burnsClient.approveNode(
          effectiveWorkspaceId,
          params.runId,
          params.nodeId,
          params.input
        )
      }

      return await burnsClient.denyNode(
        effectiveWorkspaceId,
        params.runId,
        params.nodeId,
        params.input
      )
    },
    onMutate: async (params) => {
      await queryClient.cancelQueries({ queryKey: ["approval-inbox"] })
      const previousInbox = queryClient.getQueryData<Array<{ runId: string; nodeId: string }>>([
        "approval-inbox",
      ])

      queryClient.setQueryData<Array<{ runId: string; nodeId: string }>>(
        ["approval-inbox"],
        (current) =>
          current?.filter(
            (approval) =>
              !(approval.runId === params.runId && approval.nodeId === params.nodeId)
          ) ?? []
      )

      return { previousInbox }
    },
    onError: (_error, _params, context) => {
      if (context?.previousInbox) {
        queryClient.setQueryData(["approval-inbox"], context.previousInbox)
      }
    },
    onSuccess: async (approval) => {
      const resolvedWorkspaceId = workspaceId ?? approval.workspaceId
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["approval-inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["approvals", resolvedWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["runs", resolvedWorkspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["run", resolvedWorkspaceId, approval.runId] }),
        queryClient.invalidateQueries({ queryKey: ["run-events", resolvedWorkspaceId, approval.runId] }),
      ])
    },
  })
}
