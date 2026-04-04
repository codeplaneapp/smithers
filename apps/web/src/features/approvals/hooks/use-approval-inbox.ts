import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useApprovalInbox() {
  return useQuery({
    queryKey: ["approval-inbox"],
    queryFn: () => burnsClient.listPendingApprovals(),
    refetchInterval: 2_000,
  })
}
