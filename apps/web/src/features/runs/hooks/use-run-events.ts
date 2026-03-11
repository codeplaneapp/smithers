import type { RunEvent } from "@mr-burns/shared"

import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

function normalizeEventPayload(payload: unknown, fallbackRunId: string, fallbackSeq: number): RunEvent {
  const asObject =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {}

  const seqValue = asObject.seq
  const parsedSeq =
    typeof seqValue === "number"
      ? seqValue
      : typeof seqValue === "string"
        ? Number(seqValue)
        : fallbackSeq

  return {
    seq: Number.isFinite(parsedSeq) ? Math.floor(parsedSeq) : fallbackSeq,
    runId: typeof asObject.runId === "string" ? asObject.runId : fallbackRunId,
    type: typeof asObject.type === "string" ? asObject.type : "smithers.event",
    timestamp:
      typeof asObject.timestamp === "string" ? asObject.timestamp : new Date().toISOString(),
    nodeId: typeof asObject.nodeId === "string" ? asObject.nodeId : undefined,
    message: typeof asObject.message === "string" ? asObject.message : undefined,
  }
}

export function useRunEvents(workspaceId?: string, runId?: string) {
  const queryClient = useQueryClient()
  const queryKey = ["run-events", workspaceId, runId] as const

  const query = useQuery({
    queryKey,
    queryFn: () => burnsClient.listRunEvents(workspaceId!, runId!),
    enabled: Boolean(workspaceId && runId),
    refetchInterval: 5000,
  })

  useEffect(() => {
    if (!workspaceId || !runId) {
      return
    }

    const targetQueryKey = ["run-events", workspaceId, runId] as const
    const existingEvents = queryClient.getQueryData<RunEvent[]>(targetQueryKey) ?? []
    const lastSeq = existingEvents[existingEvents.length - 1]?.seq
    const streamUrl = burnsClient.getRunEventStreamUrl(workspaceId, runId, lastSeq).toString()
    const source = new EventSource(streamUrl)

    const handleSmithersEvent = (event: MessageEvent<string>) => {
      const currentEvents = queryClient.getQueryData<RunEvent[]>(targetQueryKey) ?? []
      const fallbackSeq = (currentEvents[currentEvents.length - 1]?.seq ?? 0) + 1

      try {
        const parsedPayload = JSON.parse(event.data)
        const nextEvent = normalizeEventPayload(parsedPayload, runId, fallbackSeq)

        queryClient.setQueryData<RunEvent[]>(targetQueryKey, (previous) => {
          const safePrevious = previous ?? []
          if (safePrevious.some((entry) => entry.seq === nextEvent.seq)) {
            return safePrevious
          }

          return [...safePrevious, nextEvent]
        })
      } catch {
        // Ignore malformed event payloads.
      }
    }

    source.addEventListener("smithers", handleSmithersEvent as EventListener)
    source.onerror = () => {
      source.close()
    }

    return () => {
      source.removeEventListener("smithers", handleSmithersEvent as EventListener)
      source.close()
    }
  }, [queryClient, runId, workspaceId])

  return query
}
