import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useApprovalDecision } from "@/features/approvals/hooks/use-approval-decision"
import { useApprovals } from "@/features/approvals/hooks/use-approvals"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

export function WorkspaceApprovalsPage() {
  const { workspaceId } = useActiveWorkspace()
  const { data: approvals = [], isLoading } = useApprovals(workspaceId)
  const approvalDecision = useApprovalDecision(workspaceId)
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({})
  const [deciders, setDeciders] = useState<Record<string, string>>({})

  return (
    <div className="flex flex-col">
      <div className="grid gap-4 p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading approvals…</p>
        ) : approvals.length === 0 ? (
          <Card>
            <CardContent className="pt-4 text-sm text-muted-foreground">
              No approvals waiting for this workspace.
            </CardContent>
          </Card>
        ) : (
          approvals.map((approval) => (
            <Card key={approval.id}>
              <CardHeader>
                <CardTitle>{approval.label}</CardTitle>
                <CardDescription>{approval.note}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">Waiting {approval.waitMinutes} minutes</p>
                <div className="grid gap-2 md:grid-cols-2">
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
                <div className="flex items-center justify-end gap-2">
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
              </CardContent>
            </Card>
          ))
        )}
        {approvalDecision.error ? (
          <p className="text-sm text-destructive">{approvalDecision.error.message}</p>
        ) : null}
      </div>
    </div>
  )
}
