import { expect, test } from "bun:test"
import { GatewayWorkspaceIdSchema, isGatewayWorkspaceId } from "@smthrs/rpc/GatewayWorkspace"
import { CardSchema } from "@smthrs/rpc/Cards"

test("all persisted gateway cards accept exactly the Worker's canonical non-nil identity", () => {
  for (const value of ["ffffffff-ffff-ffff-ffff-ffffffffffff", "83e75ae5-0920-4000-8000-000000000001", "00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "../other"]) {
    expect(GatewayWorkspaceIdSchema.safeParse(value).success).toBe(isGatewayWorkspaceId(value))
    const card = { id: "inbox", title: "Approvals", createdAt: 1, ordinal: 1, status: "active", kind: "approvals-inbox", payload: { repo: "o/r", workspaceId: value, approvals: [] } }
    expect(CardSchema.safeParse(card).success).toBe(isGatewayWorkspaceId(value))
  }
})
