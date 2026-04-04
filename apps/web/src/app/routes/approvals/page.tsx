import type { ApprovalInboxItem } from "@burns/shared"

import { useEffect, useMemo, useState } from "react"
import { NavLink } from "react-router-dom"
import { AlertTriangleIcon, ArrowUpRightIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useApprovalDecision } from "@/features/approvals/hooks/use-approval-decision"
import { useApprovalInbox } from "@/features/approvals/hooks/use-approval-inbox"
import { formatRelativeMinutes, formatTimestamp } from "@/features/workspace/lib/format"

const DEFAULT_DECIDED_BY = "Burns UI"

function getRunHref(approval: ApprovalInboxItem) {
  return `/w/${approval.workspaceId}/runs/${approval.runId}`
}

function getWaitingLabel(approval: ApprovalInboxItem) {
  return formatRelativeMinutes(approval.waitingMinutes)
}

function sortByLongestWait(approvals: ApprovalInboxItem[]) {
  return [...approvals].sort((left, right) => {
    if (right.waitingMs !== left.waitingMs) {
      return right.waitingMs - left.waitingMs
    }

    return left.id.localeCompare(right.id)
  })
}

export function ApprovalsPage() {
  const { data: approvals = [], isLoading, isError, error } = useApprovalInbox()
  const approvalDecision = useApprovalDecision()
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null)
  const [notesByApprovalId, setNotesByApprovalId] = useState<Record<string, string>>({})

  const sortedApprovals = useMemo(() => sortByLongestWait(approvals), [approvals])
  const selectedApproval = useMemo(
    () => sortedApprovals.find((approval) => approval.id === selectedApprovalId) ?? null,
    [selectedApprovalId, sortedApprovals]
  )

  useEffect(() => {
    if (sortedApprovals.length === 0) {
      if (selectedApprovalId !== null) {
        setSelectedApprovalId(null)
      }
      return
    }

    if (!selectedApprovalId || !sortedApprovals.some((approval) => approval.id === selectedApprovalId)) {
      setSelectedApprovalId(sortedApprovals[0]!.id)
    }
  }, [selectedApprovalId, sortedApprovals])

  const mutateApproval = (approval: ApprovalInboxItem, decision: "approved" | "denied") => {
    const note = notesByApprovalId[approval.id]?.trim()
    approvalDecision.mutate(
      {
        workspaceId: approval.workspaceId,
        runId: approval.runId,
        nodeId: approval.nodeId,
        decision,
        input: {
          decidedBy: DEFAULT_DECIDED_BY,
          note: note ? note : undefined,
        },
      },
      {
        onSuccess: () => {
          setNotesByApprovalId((current) => {
            if (!(approval.id in current)) {
              return current
            }

            const next = { ...current }
            delete next[approval.id]
            return next
          })
        },
      }
    )
  }

  const isDecisionPending = (approval: ApprovalInboxItem) => {
    if (!approvalDecision.isPending) {
      return false
    }

    return (
      approvalDecision.variables?.runId === approval.runId &&
      approvalDecision.variables?.nodeId === approval.nodeId
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden">
      <div className="grid w-full min-w-0 max-w-full gap-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Approvals</CardTitle>
            <CardDescription>Pending operator decisions across all workspaces.</CardDescription>
          </CardHeader>
        </Card>

        {isLoading ? (
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Loading pending approvals...</p>
            </CardContent>
          </Card>
        ) : isError ? (
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-destructive">{error.message}</p>
            </CardContent>
          </Card>
        ) : sortedApprovals.length === 0 ? (
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">No pending approvals.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <Card className="min-h-0">
              <CardHeader>
                <CardTitle>Queue</CardTitle>
                <CardDescription>{sortedApprovals.length} pending</CardDescription>
              </CardHeader>
              <CardContent className="flex max-h-[65vh] min-h-0 flex-col gap-3 overflow-auto pr-1">
                {sortedApprovals.map((approval) => {
                  const active = approval.id === selectedApproval?.id
                  const decisionPending = isDecisionPending(approval)
                  const noteValue = notesByApprovalId[approval.id] ?? ""

                  return (
                    <div
                      key={approval.id}
                      className={`rounded-xl border p-3 transition-colors ${
                        active ? "border-primary bg-muted/40" : "hover:bg-muted/50"
                      }`}
                    >
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() => setSelectedApprovalId(approval.id)}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="space-y-1">
                            <p className="text-sm font-medium">
                              {approval.runId} • {approval.workflowName}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {approval.workspaceName} • {approval.nodeId} • {approval.nodeLabel}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {approval.requestSummary ?? "Approval required to continue this node."}
                            </p>
                          </div>
                          <Badge variant={approval.waitingMinutes >= 30 ? "destructive" : "outline"}>
                            waiting {getWaitingLabel(approval)}
                          </Badge>
                        </div>
                      </button>

                      <div className="mt-3 grid gap-2">
                        <Input
                          value={noteValue}
                          placeholder="Optional note"
                          onChange={(event) => {
                            const next = event.target.value
                            setNotesByApprovalId((current) => ({
                              ...current,
                              [approval.id]: next,
                            }))
                          }}
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Button size="sm" variant="outline" render={<NavLink to={getRunHref(approval)} />}>
                            Open run
                            <ArrowUpRightIcon className="size-4" />
                          </Button>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={decisionPending}
                              onClick={() => mutateApproval(approval, "denied")}
                            >
                              Deny
                            </Button>
                            <Button
                              size="sm"
                              disabled={decisionPending}
                              onClick={() => mutateApproval(approval, "approved")}
                            >
                              Approve
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </CardContent>
            </Card>

            <Card className="min-h-0">
              <CardHeader>
                <CardTitle>Details</CardTitle>
                <CardDescription>
                  {selectedApproval
                    ? `Requested ${formatTimestamp(selectedApproval.requestedAt)}`
                    : "Select an approval from the queue."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!selectedApproval ? (
                  <p className="text-sm text-muted-foreground">No approval selected.</p>
                ) : (
                  <>
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{selectedApproval.requestTitle}</p>
                      <p className="text-sm text-muted-foreground">
                        {selectedApproval.requestSummary ?? "No summary was provided for this approval request."}
                      </p>
                    </div>

                    <div className="space-y-1 text-sm">
                      <p>
                        <span className="font-medium">Workspace:</span> {selectedApproval.workspaceName}
                      </p>
                      <p>
                        <span className="font-medium">Run:</span>{" "}
                        <NavLink className="underline underline-offset-4" to={getRunHref(selectedApproval)}>
                          {selectedApproval.runId}
                        </NavLink>
                      </p>
                      <p>
                        <span className="font-medium">Node:</span> {selectedApproval.nodeId} ({selectedApproval.nodeLabel})
                      </p>
                      <p>
                        <span className="font-medium">Waiting:</span> {getWaitingLabel(selectedApproval)}
                      </p>
                      {!selectedApproval.runFound ? (
                        <p className="flex items-center gap-1 text-amber-700">
                          <AlertTriangleIcon className="size-4" />
                          Run not found
                        </p>
                      ) : null}
                    </div>

                    <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                      <p>Approve resumes the workflow from this gate.</p>
                      <p>Deny records a rejected decision and the workflow handles the denied path.</p>
                    </div>

                    <div className="space-y-2">
                      <Textarea
                        value={notesByApprovalId[selectedApproval.id] ?? ""}
                        placeholder="Optional note to persist with this decision"
                        onChange={(event) => {
                          const next = event.target.value
                          setNotesByApprovalId((current) => ({
                            ...current,
                            [selectedApproval.id]: next,
                          }))
                        }}
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          disabled={isDecisionPending(selectedApproval)}
                          onClick={() => mutateApproval(selectedApproval, "denied")}
                        >
                          Deny
                        </Button>
                        <Button
                          disabled={isDecisionPending(selectedApproval)}
                          onClick={() => mutateApproval(selectedApproval, "approved")}
                        >
                          Approve
                        </Button>
                      </div>
                    </div>
                  </>
                )}

                {approvalDecision.error ? (
                  <p className="text-sm text-destructive">{approvalDecision.error.message}</p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
