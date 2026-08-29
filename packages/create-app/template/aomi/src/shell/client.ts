/**
 * Fetch helpers for the routes declared in src/api.ts. Every response is
 * decoded with the contract schema, so a Worker that drifts from the contract
 * fails here instead of halfway through a render.
 *
 * `POST /api/agent/turn` answers with NDJSON: one JSON `TurnFrame` per line.
 * `streamTurn` splits the byte stream on newlines and yields decoded frames.
 */
import * as Schema from "effect/Schema"
import {
  CancelRequest,
  CancelResponse,
  FlowList,
  FlowRunRequest,
  FlowRunResponse,
  Routes,
  SessionList,
  type SessionSummary,
  SessionState,
  TurnFrame,
  TurnRequest
} from "../api.ts"

const decodeSessionState = Schema.decodeUnknownSync(SessionState)
const decodeSessionList = Schema.decodeUnknownSync(SessionList)
const decodeCancelResponse = Schema.decodeUnknownSync(CancelResponse)
const decodeFlowList = Schema.decodeUnknownSync(FlowList)
const decodeFlowRunResponse = Schema.decodeUnknownSync(FlowRunResponse)
const decodeTurnFrame = Schema.decodeUnknownSync(TurnFrame)

export type { SessionSummary }

export class ApiError extends Error {
  override readonly name = "ApiError"
  constructor(readonly status: number, readonly route: string, message: string) {
    super(`${route} failed with ${status}: ${message}`)
  }
}

const json = async (response: Response, route: string): Promise<unknown> => {
  if (!response.ok) throw new ApiError(response.status, route, await response.text())
  return await response.json()
}

const postJson = (route: string, body: unknown): Promise<Response> =>
  fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

// ---------------------------------------------------------------------------
// NDJSON
// ---------------------------------------------------------------------------

export interface NdjsonSplit {
  readonly lines: ReadonlyArray<string>
  readonly rest: string
}

/** Splits a buffer into complete lines plus the unterminated remainder. */
export const splitNdjson = (buffer: string): NdjsonSplit => {
  const parts = buffer.split("\n")
  const rest = parts.pop() ?? ""
  return { lines: parts.map((line) => line.trim()).filter((line) => line.length > 0), rest }
}

/** Yields every decoded frame of an NDJSON response body. */
export async function* readFrames(response: Response, route: string): AsyncGenerator<TurnFrame> {
  if (!response.ok) throw new ApiError(response.status, route, await response.text())
  const body = response.body
  if (body === null) throw new ApiError(response.status, route, "response has no body")
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const split = splitNdjson(buffer)
    buffer = split.rest
    for (const line of split.lines) yield decodeTurnFrame(JSON.parse(line))
  }
  const tail = buffer.trim()
  if (tail.length > 0) yield decodeTurnFrame(JSON.parse(tail))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** `POST /api/agent/turn`: streams the turn's frames. */
export const streamTurn = async function* (
  request: TurnRequest,
  signal?: AbortSignal
): AsyncGenerator<TurnFrame> {
  const response = await fetch(Routes.turn, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(request satisfies TurnRequest),
    ...(signal === undefined ? {} : { signal })
  })
  yield* readFrames(response, Routes.turn)
}

/**
 * `POST /api/agent/turn/cancel`.
 *
 * Answers whether there was anything to abort, so a shell that pressed Esc
 * after the turn already ended learns that rather than assuming it killed a
 * live turn.
 */
export const cancelTurn = async (sessionId: string): Promise<boolean> => {
  const body: typeof CancelRequest.Type = { sessionId }
  return decodeCancelResponse(await json(await postJson(Routes.turnCancel, body), Routes.turnCancel)).cancelled
}

/** `GET /api/session?id=<sessionId>`. */
export const getSession = async (id: string): Promise<SessionState> => {
  const route = `${Routes.session}?id=${encodeURIComponent(id)}`
  return decodeSessionState(await json(await fetch(route), route))
}

/** `GET /api/session`: the Recent column. */
export const listSessions = async (): Promise<ReadonlyArray<SessionSummary>> =>
  decodeSessionList(await json(await fetch(Routes.session), Routes.session)).sessions

/** `GET /api/flows`. */
export const listFlows = async () =>
  decodeFlowList(await json(await fetch(Routes.flows), Routes.flows)).flows

/** `POST /api/flows/run`. */
export const runFlow = async (request: typeof FlowRunRequest.Type): Promise<string> =>
  decodeFlowRunResponse(await json(await postJson(Routes.flowRun, request), Routes.flowRun)).executionId

/** `GET /api/health`. */
export const health = async (): Promise<boolean> => (await fetch(Routes.health)).ok
