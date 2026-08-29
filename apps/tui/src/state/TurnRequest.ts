import type { AgentChatMessage, StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import { SMITHERS_TUI_INSTRUCTIONS } from "./Instructions"
import { transcriptMessages } from "./Transcript"
import type { TranscriptEntry } from "./Transcript"

/*
 * Composer submit → StartAgentTurnRequest. The byte bound mirrors the product
 * Worker's limit so the TUI refuses an oversized turn the same way the app
 * does, instead of shipping a request the boundary will reject.
 */

/** The deployed Worker rejects request bodies above 64 KiB. Leave framing headroom. */
// TODO(shared): move to a shared package (copied from apps/ui/src/mainview/state/AgentTurnPolicy.ts)
export const MAX_TURN_REQUEST_BYTES = 60 * 1024

const encoder = new TextEncoder()

// TODO(shared): move to a shared package (copied from apps/ui/src/mainview/state/AgentTurnPolicy.ts)
export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength

// TODO(shared): move to a shared package (copied from apps/ui/src/mainview/state/AgentTurnPolicy.ts)
export const turnRequestBytes = (request: StartAgentTurnRequest): number => utf8Bytes(JSON.stringify(request))

export type SubmitResult =
  | { readonly status: "ok"; readonly request: StartAgentTurnRequest }
  | { readonly status: "empty" }
  | { readonly status: "oversized"; readonly bytes: number }

/**
 * Build the turn request for one composer submit: the visible transcript as
 * role/content messages (cards, tool lines, and chain events never enter the
 * model's context — exactly the app's contextMessages discipline).
 */
export const buildTurnRequest = (
  runId: string,
  entries: ReadonlyArray<TranscriptEntry>,
  draft: string
): SubmitResult => {
  const text = draft.trim()
  if (text === "") return { status: "empty" }
  const messages: ReadonlyArray<AgentChatMessage> = [
    ...transcriptMessages(entries),
    { role: "user" as const, content: text }
  ]
  const request: StartAgentTurnRequest = {
    runId,
    messages,
    instructions: SMITHERS_TUI_INSTRUCTIONS
  }
  const bytes = turnRequestBytes(request)
  if (bytes > MAX_TURN_REQUEST_BYTES) return { status: "oversized", bytes }
  return { status: "ok", request }
}
