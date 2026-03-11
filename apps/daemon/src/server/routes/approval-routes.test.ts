import { randomUUID } from "node:crypto"

import { afterEach, describe, expect, it } from "bun:test"

import { insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { createApp } from "@/server/app"

const originalFetch = globalThis.fetch

function seedWorkspace() {
  const workspaceId = `test-workspace-${randomUUID()}`
  const now = new Date().toISOString()

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: `/tmp/${workspaceId}`,
    sourceType: "create",
    runtimeMode: "burns-managed",
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  return workspaceId
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("approval routes", () => {
  it("validates decision payloads", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/runs/run-1/nodes/deploy/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "missing decidedBy" }),
        }
      )
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: "Invalid request",
    })
  })

  it("maps approval decisions and returns updated approval state", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    const capturedUrls: string[] = []

    globalThis.fetch = (async (input: unknown) => {
      capturedUrls.push(String(input))
      return Response.json({
        ok: true,
      })
    }) as typeof fetch

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/runs/run-1/nodes/deploy/deny`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decidedBy: "lewi",
            note: "Needs additional verification",
          }),
        }
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workspaceId,
      runId: "run-1",
      nodeId: "deploy",
      status: "denied",
      decidedBy: "lewi",
      note: "Needs additional verification",
    })
    expect(capturedUrls.some((url) => url.includes("/v1/runs/run-1/nodes/deploy/deny"))).toBe(
      true
    )
  })
})
