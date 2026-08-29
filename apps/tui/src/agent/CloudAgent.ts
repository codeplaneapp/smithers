import { composeAgentInstructions } from "smithers-shared/AgentContext"
import type {
  AgentTurnFrame,
  FetchLike,
  StartAgentTurnRequest,
  StartAgentTurnResult
} from "smithers-shared/NativeAgent"
import { AgentTurnFrameDecoder } from "../state/Transcript"

// TODO(shared): move to a shared package (copied from apps/ui/src/bun/CloudAgent.ts)

const DEFAULT_CHAT_URL = "https://chat.smithers.sh/chat"
const DEFAULT_APP_ORIGIN = "https://smithers.sh"
const MAX_ERROR_BYTES = 320

export interface CloudAgentConfig {
  readonly chatUrl?: string
  readonly origin?: string
  readonly fetchImpl?: FetchLike
}

type PublishFrame = (frame: AgentTurnFrame) => void

const responseError = async (response: Response): Promise<string> => {
  const detail = (await response.text().catch(() => "")).trim().slice(0, MAX_ERROR_BYTES)
  return `Smithers Cloud chat failed (HTTP ${response.status})${detail === "" ? "." : `: ${detail}`}`
}

const streamTurn = async (
  request: StartAgentTurnRequest,
  abortController: AbortController,
  publish: PublishFrame,
  config: CloudAgentConfig
): Promise<void> => {
  const response = await (config.fetchImpl ?? fetch)(config.chatUrl?.trim() || DEFAULT_CHAT_URL, {
    method: "POST",
    signal: abortController.signal,
    headers: {
      "content-type": "application/json",
      origin: config.origin?.trim() || DEFAULT_APP_ORIGIN,
      "x-smithers-run-id": request.runId
    },
    body: JSON.stringify({
      messages: request.messages,
      // The hidden runtime context is rendered server-side into the
      // instructions: upstream sees one string, secrets and structure
      // stay on this side, and the visible transcript never holds it.
      instructions: composeAgentInstructions(request.instructions, request.context),
      // The tool-loop contract (Wave 3b): the tool specs ride every turn on
      // this boundary exactly as they do on the product Worker, otherwise the
      // model is never offered a command and the loop can never start.
      ...(request.tools === undefined ? {} : { tools: request.tools })
    })
  })
  if (!response.ok || response.body === null) {
    throw new Error(
      response.ok ? "Smithers Cloud returned no response stream." : await responseError(response)
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let settled = false
  const frames = new AgentTurnFrameDecoder(
    (frame) => {
      if (settled) return
      publish(frame)
      if (frame.type === "done") settled = true
    },
    request.runId,
    true
  )

  for (;;) {
    const { value, done } = await reader.read()
    frames.push(decoder.decode(value, { stream: !done }))
    if (done) frames.finish()
    if (!settled && frames.invalidLines() > 0) {
      await reader.cancel().catch(() => {})
      throw new Error("Smithers Cloud returned a malformed stream frame.")
    }
    if (done || settled) break
  }
  if (settled) {
    await reader.cancel().catch(() => {})
  } else {
    publish({
      runId: request.runId,
      type: "done",
      error: "The response stream ended before Smithers Cloud finished the turn."
    })
  }
}

export interface CloudAgent {
  readonly start: (request: StartAgentTurnRequest) => StartAgentTurnResult
  readonly cancel: (runId: string) => { readonly status: "cancelled" | "not-found" }
}

export const createCloudAgent = (
  publish: PublishFrame,
  config: CloudAgentConfig = {}
): CloudAgent => {
  const activeTurns = new Map<string, AbortController>()
  return {
    start: (request) => {
      if (activeTurns.has(request.runId)) {
        return { status: "error", message: "That Smithers turn is already running." }
      }
      const abortController = new AbortController()
      activeTurns.set(request.runId, abortController)
      void streamTurn(request, abortController, publish, config)
        .catch((error: unknown) => {
          if (abortController.signal.aborted) return
          publish({
            runId: request.runId,
            type: "done",
            error: error instanceof Error ? error.message : "Smithers Cloud chat failed."
          })
        })
        .finally(() => activeTurns.delete(request.runId))
      return { status: "started" }
    },
    cancel: (runId) => {
      const active = activeTurns.get(runId)
      if (active === undefined) return { status: "not-found" }
      active.abort()
      activeTurns.delete(runId)
      return { status: "cancelled" }
    }
  }
}
