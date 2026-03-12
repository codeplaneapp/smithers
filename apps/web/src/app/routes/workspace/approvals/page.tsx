import type { Approval, ApprovalStatus } from "@burns/shared"

import { useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useApprovalDecision } from "@/features/approvals/hooks/use-approval-decision"
import { useApprovals } from "@/features/approvals/hooks/use-approvals"
import { formatRelativeMinutes, formatTimestamp } from "@/features/workspace/lib/format"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

type ApprovalFilter = "all" | ApprovalStatus
type ApprovalSort = "wait-desc" | "wait-asc" | "updated-desc" | "updated-asc"

const filterOptions: Array<{ value: ApprovalFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
]

const sortOptions: Array<{ value: ApprovalSort; label: string }> = [
  { value: "wait-desc", label: "Wait high-low" },
  { value: "wait-asc", label: "Wait low-high" },
  { value: "updated-desc", label: "Updated newest" },
  { value: "updated-asc", label: "Updated oldest" },
]

function getSlaBadgeVariant(waitMinutes: number) {
  if (waitMinutes >= 30) {
    return "destructive"
  }

  if (waitMinutes >= 10) {
    return "outline"
  }

  return "secondary"
}

function toUpdatedTimestamp(approval: Approval) {
  if (!approval.decidedAt) {
    return 0
  }

  const parsed = Date.parse(approval.decidedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function sortApprovals(approvals: Approval[], sort: ApprovalSort) {
  const sorted = [...approvals]

  sorted.sort((left, right) => {
    if (sort === "wait-desc") {
      return right.waitMinutes - left.waitMinutes
    }

    if (sort === "wait-asc") {
      return left.waitMinutes - right.waitMinutes
    }

    if (sort === "updated-asc") {
      return toUpdatedTimestamp(left) - toUpdatedTimestamp(right)
    }

    return toUpdatedTimestamp(right) - toUpdatedTimestamp(left)
  })

  return sorted
}

export function WorkspaceApprovalsPage() {
  const { workspaceId } = useActiveWorkspace()
  const { data: approvals = [], isLoading } = useApprovals(workspaceId)
  const approvalDecision = useApprovalDecision(workspaceId)

  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({})
  const [deciders, setDeciders] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<ApprovalFilter>("all")
  const [sort, setSort] = useState<ApprovalSort>("wait-desc")

  const filteredApprovals = useMemo(() => {
    if (filter === "all") {
      return approvals
    }

    return approvals.filter((approval) => approval.status === filter)
  }, [approvals, filter])

  const pendingApprovals = useMemo(() => {
    return sortApprovals(
      filteredApprovals.filter((approval) => approval.status === "pending"),
      sort
    )
  }, [filteredApprovals, sort])

  const recentDecisions = useMemo(() => {
    return sortApprovals(
      filteredApprovals.filter((approval) => approval.status === "approved" || approval.status === "denied"),
      sort
    )
  }, [filteredApprovals, sort])

  return (
    <div className="flex flex-col">
      <div className="grid gap-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Approvals controls</CardTitle>
            <CardDescription>Filter queue status and sort by wait or update timestamp.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {filterOptions.map((option) => (
                <Button
                  key={option.value}
                  size="sm"
                  variant={filter === option.value ? "default" : "outline"}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {sortOptions.map((option) => (
                <Button
                  key={option.value}
                  size="sm"
                  variant={sort === option.value ? "default" : "outline"}
                  onClick={() => setSort(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pending inbox</CardTitle>
            <CardDescription>Approval gates awaiting operator action.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading approvals...</p>
            ) : pendingApprovals.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending approvals for current filter.</p>
            ) : (
              pendingApprovals.map((approval) => (
                <div key={approval.id} className="rounded-xl border p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{approval.label}</p>
                      <p className="text-xs text-muted-foreground">
                        run {approval.runId} - node {approval.nodeId}
                      </p>
                    </div>
                    <Badge variant={getSlaBadgeVariant(approval.waitMinutes)}>
                      waiting {formatRelativeMinutes(approval.waitMinutes)}
                    </Badge>
                  </div>

                  {approval.note ? <p className="mt-2 text-sm">{approval.note}</p> : null}

                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    <Input
                      placeholder="Decided by"
                      value={deciders[approval.id] ?? ""}
                      onChange={(event) =>
                        setDeciders((previous) => ({
                          ...previous,
                          [approval.id]: event.target.value,
                        }))
                      }
                    />
                    <Input
                      placeholder="Decision note (optional)"
                      value={decisionNotes[approval.id] ?? ""}
                      onChange={(event) =>
                        setDecisionNotes((previous) => ({
                          ...previous,
                          [approval.id]: event.target.value,
                        }))
                      }
                    />
                  </div>

                  <div className="mt-3 flex items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      disabled={approvalDecision.isPending || !(deciders[approval.id] ?? "").trim()}
                      onClick={() =>
                        approvalDecision.mutate({
                          runId: approval.runId,
                          nodeId: approval.nodeId,
                          decision: "denied",
                          input: {
                            decidedBy: (deciders[approval.id] ?? "").trim(),
                            note: (decisionNotes[approval.id] ?? "").trim() || undefined,
                          },
                        })
                      }
                    >
                      Deny
                    </Button>
                    <Button
                      disabled={approvalDecision.isPending || !(deciders[approval.id] ?? "").trim()}
                      onClick={() =>
                        approvalDecision.mutate({
                          runId: approval.runId,
                          nodeId: approval.nodeId,
                          decision: "approved",
                          input: {
                            decidedBy: (deciders[approval.id] ?? "").trim(),
                            note: (decisionNotes[approval.id] ?? "").trim() || undefined,
                          },
                        })
                      }
                    >
                      Approve
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent decisions</CardTitle>
            <CardDescription>Approved and denied nodes with decision metadata.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading decision history...</p>
            ) : recentDecisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent decisions for current filter.</p>
            ) : (
              recentDecisions.map((approval) => (
                <div key={approval.id} className="rounded-xl border p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{approval.label}</p>
                      <p className="text-xs text-muted-foreground">
                        run {approval.runId} - node {approval.nodeId}
                      </p>
                    </div>
                    <Badge variant={approval.status === "approved" ? "secondary" : "destructive"}>
                      {approval.status}
                    </Badge>
                  </div>

                  <div className="mt-2 grid gap-1 text-sm text-muted-foreground md:grid-cols-2">
                    <p>Decided by: {approval.decidedBy ?? "-"}</p>
                    <p>Updated: {formatTimestamp(approval.decidedAt)}</p>
                  </div>

                  <p className="mt-2 text-sm">{approval.note ?? "No decision note."}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {approvalDecision.error ? (
          <p className="text-sm text-destructive">{approvalDecision.error.message}</p>
        ) : null}
      </div>
    </div>
  )
}
