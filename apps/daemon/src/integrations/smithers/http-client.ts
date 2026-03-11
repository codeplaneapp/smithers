import { HttpError } from "@/utils/http-error"

function buildSmithersUrl(baseUrl: string, pathname: string, searchParams?: URLSearchParams) {
  const url = new URL(pathname, baseUrl)

  if (searchParams) {
    url.search = searchParams.toString()
  }

  return url
}

async function parseErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as { error?: string; message?: string }
    return data.error ?? data.message ?? `Smithers request failed: ${response.status}`
  } catch {
    return `Smithers request failed: ${response.status}`
  }
}

async function requestJson<T>(baseUrl: string, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildSmithersUrl(baseUrl, pathname), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    throw new HttpError(response.status, await parseErrorMessage(response))
  }

  return (await response.json()) as T
}

export async function listSmithersRuns(baseUrl: string) {
  return await requestJson<unknown>(baseUrl, "/v1/runs")
}

export async function getSmithersRun(baseUrl: string, runId: string) {
  return await requestJson<unknown>(baseUrl, `/v1/runs/${runId}`)
}

export async function createSmithersRun(baseUrl: string, payload: unknown) {
  return await requestJson<unknown>(baseUrl, "/v1/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function resumeSmithersRun(baseUrl: string, runId: string, payload: unknown) {
  return await requestJson<unknown>(baseUrl, `/v1/runs/${runId}/resume`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function cancelSmithersRun(baseUrl: string, runId: string, payload: unknown) {
  return await requestJson<unknown>(baseUrl, `/v1/runs/${runId}/cancel`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function approveSmithersNode(
  baseUrl: string,
  runId: string,
  nodeId: string,
  payload: unknown
) {
  return await requestJson<unknown>(baseUrl, `/v1/runs/${runId}/nodes/${nodeId}/approve`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function denySmithersNode(
  baseUrl: string,
  runId: string,
  nodeId: string,
  payload: unknown
) {
  return await requestJson<unknown>(baseUrl, `/v1/runs/${runId}/nodes/${nodeId}/deny`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function streamSmithersRunEvents(baseUrl: string, runId: string, afterSeq?: number) {
  const searchParams = new URLSearchParams()
  if (afterSeq !== undefined) {
    searchParams.set("afterSeq", String(afterSeq))
  }

  const response = await fetch(
    buildSmithersUrl(baseUrl, `/v1/runs/${runId}/events`, searchParams),
    {
      headers: {
        accept: "text/event-stream",
      },
    }
  )

  if (!response.ok || !response.body) {
    throw new HttpError(response.status || 502, await parseErrorMessage(response))
  }

  return response
}
