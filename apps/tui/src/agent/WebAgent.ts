import { CANCEL_PATH, TURN_PATH } from "smithers-shared/AgentApiRoutes"
import type {
  AgentTurnFrame,
  FetchLike,
  StartAgentTurnRequest,
  StartAgentTurnResult
} from "smithers-shared/NativeAgent"
import { AgentTurnFrameDecoder } from "../state/Transcript"

/*
 * The Worker-boundary transport: POSTs turns to `/api/agent/turn` on a product
 * Worker origin (`wrangler dev` locally, or a deployed origin) and reads the
 * NDJSON AgentTurnFrame stream back. Esc cancels through the cancel contract
 * (`/api/agent/turn/cancel`) so a server-side turn is killed, not merely
 * disconnected.
 *
 * Auth: the boundary session-gates turns. The native app signs in through its
 * Electrobun OAuth handoff; the TUI has no browser flow this round, so pass an
 * existing session cookie via SMITHERS_TUI_COOKIE (sent as the `cookie`
 * header). Without it, an auth-gated boundary answers 401 and the turn fails
 * honestly.
 */
// TODO(shared): move to a shared package (adapted from apps/ui/src/mainview/native/WebAgent.ts)

const MAX_ERROR_BYTES = 320

export interface WebAgentOptions {
  /** The Worker origin, e.g. http://localhost:8787 for `wrangler dev`. */
  readonly baseUrl: string
  /** Session cookie header value, when the boundary requires a session. */
  readonly cookie?: string
  readonly fetchImpl?: FetchLike
}

type PublishFrame = (frame: AgentTurnFrame) => void

/** The boundary answers failures as `{ status, message }`; surface that, not raw JSON. */
const errorDetail = async (response: Response): Promise<string> => {
  const body = (await response.text().catch(() => "")).trim()
  let detail = body
  try {
    const parsed: unknown = JSON.parse(body)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      detail = parsed.message
    }
  } catch {
    // A non-JSON body (a proxy error page, say) is already the best detail available.
  }
  detail = detail.slice(0, MAX_ERROR_BYTES)
  return `Smithers web agent failed (HTTP ${response.status})${detail === "" ? "." : `: ${detail}`}`
}

const streamFrames = async (
  body: ReadableStream<Uint8Array>,
  expectedRunId: string,
  publish: PublishFrame,
  onTerminal?: () => void
): Promise<void> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let settled = false
  const frames = new AgentTurnFrameDecoder((frame) => {
    if (settled) return
    publish(frame)
    if (frame.type === "done") {
      settled = true
      // Release the turn's cancel handle BEFORE the stream teardown
      // settles: a future continuation seam may re-POST this runId the
      // moment the terminal frame is published.
      onTerminal?.()
    }
  }, expectedRunId)
  for (;;) {
    const { value, done } = await reader.read()
    frames.push(decoder.decode(value, { stream: !done }))
    if (done) frames.finish()
    if (done || settled) break
  }
  // A `done` frame ends the turn even if the boundary keeps the socket open.
  if (settled) {
    await reader.cancel().catch(() => {})
  } else {
    // The stream ended without a terminal frame: the turn died server-side
    // (upstream disconnect). That is an honest failure, never a silent stall.
    publish({
      runId: expectedRunId,
      type: "done",
      error: "The response stream ended before Smithers finished the turn."
    })
  }
}

export interface WebAgent {
  readonly start: (request: StartAgentTurnRequest) => Promise<StartAgentTurnResult>
  readonly cancel: (runId: string) => Promise<void>
}

export const createWebAgent = (publish: PublishFrame, options: WebAgentOptions): WebAgent => {
  const baseUrl = options.baseUrl.replace(/\/$/, "")
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
  const activeTurns = new Map<string, AbortController>()
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(options.cookie === undefined ? {} : { cookie: options.cookie })
  })

  return {
    start: async (request): Promise<StartAgentTurnResult> => {
      if (activeTurns.has(request.runId)) {
        return { status: "error", message: "That Smithers turn is already running." }
      }
      const abortController = new AbortController()
      // Registered before the request so a stop pressed while still connecting aborts it.
      activeTurns.set(request.runId, abortController)
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}${TURN_PATH}`, {
          method: "POST",
          signal: abortController.signal,
          headers: headers(),
          body: JSON.stringify(request)
        })
      } catch (error) {
        activeTurns.delete(request.runId)
        // A cancelled connect is the user's own doing, not a failed turn to report.
        if (abortController.signal.aborted) return { status: "started" }
        return {
          status: "error",
          message: error instanceof Error
            ? `Could not reach the Smithers web agent: ${error.message}`
            : "Could not reach the Smithers web agent."
        }
      }
      if (!response.ok || response.body === null) {
        activeTurns.delete(request.runId)
        return {
          status: "error",
          message: response.ok
            ? "The Smithers web agent returned no response stream."
            : await errorDetail(response)
        }
      }
      void streamFrames(response.body, request.runId, publish, () => activeTurns.delete(request.runId))
        .catch((error: unknown) => {
          if (abortController.signal.aborted) return
          publish({
            runId: request.runId,
            type: "done",
            error: error instanceof Error
              ? error.message
              : "The Smithers web agent stream failed."
          })
        })
        .finally(() => activeTurns.delete(request.runId))
      return { status: "started" }
    },
    cancel: async (runId) => {
      const active = activeTurns.get(runId)
      if (active !== undefined) {
        active.abort()
        activeTurns.delete(runId)
      }
      await fetchImpl(`${baseUrl}${CANCEL_PATH}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ runId })
      }).catch(() => {})
    }
  }
}
