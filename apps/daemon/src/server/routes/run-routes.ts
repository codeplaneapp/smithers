import { cancelRunInputSchema, resumeRunInputSchema, startRunInputSchema } from "@mr-burns/shared"

import { listRunEvents, persistSmithersEvent } from "@/services/run-event-service"
import {
  cancelRun,
  connectRunEventStream,
  getRun,
  listRuns,
  resumeRun,
  startRun,
} from "@/services/smithers-service"
import { syncApprovalFromEvent } from "@/services/approval-service"
import { toErrorResponse } from "@/utils/http-error"

function parseAfterSeq(request: Request) {
  const rawValue = new URL(request.url).searchParams.get("afterSeq")
  if (!rawValue) {
    return 0
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0
  }

  return Math.floor(parsed)
}

function maybeSyncApprovalFromPersistedEvent(workspaceId: string, event: { runId: string; nodeId?: string; type: string; message?: string }) {
  if (!event.nodeId) {
    return
  }

  const lowerType = event.type.toLowerCase()

  if (!lowerType.includes("approval")) {
    return
  }

  if (lowerType.includes("approved")) {
    syncApprovalFromEvent({
      workspaceId,
      runId: event.runId,
      nodeId: event.nodeId,
      status: "approved",
      message: event.message,
    })
    return
  }

  if (lowerType.includes("denied") || lowerType.includes("rejected")) {
    syncApprovalFromEvent({
      workspaceId,
      runId: event.runId,
      nodeId: event.nodeId,
      status: "denied",
      message: event.message,
    })
    return
  }

  if (
    lowerType.includes("wait") ||
    lowerType.includes("pending") ||
    lowerType.includes("needs")
  ) {
    syncApprovalFromEvent({
      workspaceId,
      runId: event.runId,
      nodeId: event.nodeId,
      status: "pending",
      message: event.message,
    })
  }
}

async function createEventProxyStream(workspaceId: string, runId: string, afterSeq: number) {
  const upstream = await connectRunEventStream(workspaceId, runId, afterSeq)
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  async function processFrame(frame: string) {
    if (!frame.trim()) {
      return
    }

    const lines = frame.split("\n")
    let eventName = "message"
    const dataLines: string[] = []

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim()
        continue
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart())
      }
    }

    if (eventName !== "smithers" || dataLines.length === 0) {
      return
    }

    try {
      const payload = JSON.parse(dataLines.join("\n"))
      const persistedEvent = persistSmithersEvent(workspaceId, runId, payload)
      maybeSyncApprovalFromPersistedEvent(workspaceId, persistedEvent)
    } catch {
      // Ignore malformed SSE payloads and keep proxy stream alive.
    }
  }

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()

      if (done) {
        if (buffer.trim()) {
          await processFrame(buffer)
          controller.enqueue(encoder.encode(buffer))
          buffer = ""
        }

        controller.close()
        return
      }

      buffer += decoder.decode(value, { stream: true })

      let splitIndex = buffer.indexOf("\n\n")
      while (splitIndex >= 0) {
        const frame = buffer.slice(0, splitIndex)
        buffer = buffer.slice(splitIndex + 2)
        await processFrame(frame)
        controller.enqueue(encoder.encode(`${frame}\n\n`))
        splitIndex = buffer.indexOf("\n\n")
      }
    },
    async cancel() {
      await reader.cancel()
    },
  })
}

export async function handleRunRoutes(request: Request, pathname: string) {
  try {
    const runsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs$/)
    if (runsMatch && request.method === "GET") {
      return Response.json(await listRuns(runsMatch[1]))
    }

    if (runsMatch && request.method === "POST") {
      const input = startRunInputSchema.parse(await request.json().catch(() => null))
      return Response.json(await startRun(runsMatch[1], input), { status: 201 })
    }

    const runResumeMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/resume$/)
    if (runResumeMatch && request.method === "POST") {
      const input = resumeRunInputSchema.parse(await request.json().catch(() => null))
      return Response.json(await resumeRun(runResumeMatch[1], runResumeMatch[2], input))
    }

    const runCancelMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/cancel$/)
    if (runCancelMatch && request.method === "POST") {
      const input = cancelRunInputSchema.parse(await request.json().catch(() => null))
      return Response.json(await cancelRun(runCancelMatch[1], runCancelMatch[2], input))
    }

    const runEventsStreamMatch = pathname.match(
      /^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/events\/stream$/
    )
    if (runEventsStreamMatch && request.method === "GET") {
      const afterSeq = parseAfterSeq(request)
      const stream = await createEventProxyStream(
        runEventsStreamMatch[1],
        runEventsStreamMatch[2],
        afterSeq
      )

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      })
    }

    const runEventsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/events$/)
    if (runEventsMatch && request.method === "GET") {
      const afterSeq = parseAfterSeq(request)
      return Response.json(listRunEvents(runEventsMatch[1], runEventsMatch[2], afterSeq))
    }

    const runDetailMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)$/)
    if (runDetailMatch && request.method === "GET") {
      return Response.json(await getRun(runDetailMatch[1], runDetailMatch[2]))
    }

    return null
  } catch (error) {
    return toErrorResponse(error)
  }
}
