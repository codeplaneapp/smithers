import { randomUUID } from "node:crypto"

import { describe, expect, it } from "bun:test"

import { insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { createApp } from "@/server/app"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

function seedWorkspace() {
  const workspaceId = `test-workspace-${randomUUID()}`
  const now = new Date().toISOString()

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: resolveTestWorkspacePath(workspaceId),
    sourceType: "create",
    runtimeMode: "burns-managed",
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  return workspaceId
}

const validWorkflowSource = `import { createSmithers, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  plan: z.object({ summary: z.string() }),
})

export default smithers(() => (
  <Workflow name="valid-workflow">
    <Sequence>
      <Task id="plan" output={outputs.plan}>
        {{ summary: "ready" }}
      </Task>
    </Sequence>
  </Workflow>
))
`

const invalidLegacySource = `import { Sequence } from "smithers-orchestrator"

export default smithers(() => (
  <Workflow name="legacy">
    <Task id="plan" output="plan">Legacy</Task>
  </Workflow>
))
`

const inferableLaunchFieldsSource = `import { createSmithers, Sequence } from "smithers-orchestrator"
import { z } from "zod"

const { Workflow, Task, smithers, outputs } = createSmithers({
  analysis: z.object({ summary: z.string() }),
  fix: z.object({ patch: z.string() }),
})

export default smithers((ctx) => (
  <Workflow name="code-review">
    <Sequence>
      <Task id="analyze" output={outputs.analysis}>
        {\`Review repository \${ctx.input.repo} and area \${ctx.input.focusArea ?? "general"}\`}
      </Task>
      <Task id="fix" output={outputs.fix}>
        {"Fix issues"}
      </Task>
    </Sequence>
  </Workflow>
))
`

describe("workflow routes", () => {
  it("saves valid workflow source", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: validWorkflowSource }),
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: "custom-flow",
      workspaceId,
      name: "custom-flow",
    })
  })

  it("rejects invalid legacy-style workflow source", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: invalidLegacySource }),
      })
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("createSmithers"),
    })
  })

  it("streams authoring errors for generate/stream requests", async () => {
    const app = createApp()
    const missingWorkspaceId = `missing-${randomUUID()}`

    const response = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${missingWorkspaceId}/workflows/generate/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "streamed-workflow",
          agentId: "codex",
          prompt: "Create a workflow",
        }),
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/x-ndjson")

    const body = await response.text()
    const events = body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("Workspace not found"),
    })
  })

  it("infers launch fields from first task ctx.input references", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const saveResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/inferred-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: inferableLaunchFieldsSource }),
      })
    )

    expect(saveResponse.status).toBe(200)

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/inferred-flow/launch-fields`
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workflowId: "inferred-flow",
      mode: "inferred",
      entryTaskId: "analyze",
      fields: [
        { key: "repo", label: "Repo", type: "string" },
        { key: "focusArea", label: "Focus Area", type: "string" },
      ],
    })
  })

  it("returns fallback mode when launch fields cannot be inferred", async () => {
    const app = createApp()
    const workspaceId = seedWorkspace()

    const saveResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: validWorkflowSource }),
      })
    )

    expect(saveResponse.status).toBe(200)

    const response = await app.fetch(
      new Request(
        `http://localhost:7332/api/workspaces/${workspaceId}/workflows/custom-flow/launch-fields`
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workflowId: "custom-flow",
      mode: "fallback",
      entryTaskId: "plan",
      fields: [],
      message: "Unable to determine inputs automatically.",
    })
  })
})
