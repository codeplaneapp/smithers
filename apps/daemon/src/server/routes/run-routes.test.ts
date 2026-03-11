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
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  return workspaceId
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("run routes", () => {
  it("validates start-run payloads", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: "Invalid request",
    })
  })

  it("maps Smithers list runs responses to Burns run DTOs", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      expect(url).toContain("/v1/runs")
      expect(init?.method ?? "GET").toBe("GET")

      return Response.json({
        runs: [
          {
            id: "run-123",
            workflowId: "issue-to-pr",
            workflowName: "Issue to PR",
            status: "waiting_approval",
            startedAt: "2026-03-11T10:00:00.000Z",
            summary: {
              done: 2,
              running: 1,
              waiting: 3,
            },
          },
        ],
      })
    }) as typeof fetch

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "GET",
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      {
        id: "run-123",
        workspaceId,
        workflowId: "issue-to-pr",
        workflowName: "Issue to PR",
        status: "waiting-approval",
        startedAt: "2026-03-11T10:00:00.000Z",
        finishedAt: null,
        summary: {
          finished: 2,
          inProgress: 1,
          pending: 3,
        },
      },
    ])
  })

  it("forwards start-run requests to Smithers with workflow path metadata", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()
    const capturedBodies: unknown[] = []

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.body && typeof init.body === "string") {
        capturedBodies.push(JSON.parse(init.body))
      }

      return Response.json({
        run: {
          id: "run-created",
          workflow: {
            id: "issue-to-pr",
            name: "issue-to-pr",
          },
          status: "running",
          startedAt: "2026-03-11T11:00:00.000Z",
          summary: {
            finished: 0,
            inProgress: 1,
            pending: 2,
          },
        },
      })
    }) as typeof fetch

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "issue-to-pr",
          input: {
            task: "sample",
          },
        }),
      })
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      id: "run-created",
      workspaceId,
      workflowId: "issue-to-pr",
      status: "running",
    })
    expect(capturedBodies).toHaveLength(1)
    expect(capturedBodies[0]).toMatchObject({
      input: {
        task: "sample",
      },
      metadata: {
        workspaceId,
        workflowId: "issue-to-pr",
      },
    })
    expect(capturedBodies[0]).toMatchObject({
      workflowPath: expect.stringContaining(`/${workspaceId}/.mr-burns/workflows/issue-to-pr/workflow.tsx`),
    })
  })
})
