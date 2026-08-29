import type { StartAgentTurnRequest } from "smithers-shared/NativeAgent"
import type { AgentTurnFrame } from "smithers-shared/NativeAgent"
import { defaultTargetsMessage, escapeHtml, parseTargetsInstructions, TARGETS_PANEL_MARKER } from "smithers-shared/TargetsPanel"
import type { CloudAgent } from "./CloudAgent"

/*
 * SMITHERS_CHAT_STUB=1: a deterministic CloudAgent so the Playwright suite and
 * CI run offline. It streams one reasoning delta, then the text
 * `stub: <last user message>`, then done. When the instructions carry the
 * targets-panel marker it answers the exact `{ message, html }` JSON the
 * auto-load flow parses (LOCAL-APP.md, "Auto-load flow").
 */

export { TARGETS_PANEL_MARKER }

/** How many of the repository's targets the stub panel offers a Run button for. */
export const STUB_PANEL_BUTTONS = 3

/**
 * The stub's `{ message, html }` for the targets prompt: the real target list
 * read back out of the instructions, one Run button (posting the bridge
 * message) for each of the first STUB_PANEL_BUTTONS targets.
 */
export const stubTargetsReply = (instructions: string): { readonly message: string; readonly html: string } => {
  const parsed = parseTargetsInstructions(instructions)
  const targets = parsed?.targets ?? []
  const repoName = parsed?.repoName === undefined || parsed.repoName === "" ? "the repository" : parsed.repoName
  const buttons = targets
    .slice(0, STUB_PANEL_BUTTONS)
    .map((target) =>
      `<button type="button" data-testid="stub-run-${escapeHtml(target.name)}" onclick="parent.postMessage({smithers:'run',label:'${
        escapeHtml(target.label)
      }'},'*')">Run ${escapeHtml(target.label)}</button>`
    )
    .join("")
  return {
    message: defaultTargetsMessage(targets.length, repoName),
    html: `<div data-testid="stub-panel"><h1>Targets</h1><p>${targets.length} targets (stub panel)</p>${buttons}</div>`
  }
}

const lastUserMessage = (request: StartAgentTurnRequest): string => {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message !== undefined && "role" in message && message.role === "user") return message.content
  }
  return ""
}

export const stubReply = (request: StartAgentTurnRequest): string => {
  if (request.instructions.includes(TARGETS_PANEL_MARKER)) {
    return JSON.stringify(stubTargetsReply(request.instructions))
  }
  return `stub: ${lastUserMessage(request)}`
}

export const createChatStub = (publish: (frame: AgentTurnFrame) => void): CloudAgent => {
  const active = new Set<string>()
  return {
    start: (request) => {
      if (active.has(request.runId)) {
        return { status: "error", message: "That Smithers turn is already running." }
      }
      active.add(request.runId)
      const frames: ReadonlyArray<AgentTurnFrame> = [
        { runId: request.runId, type: "delta", kind: "reasoning", text: "stub: thinking" },
        { runId: request.runId, type: "delta", kind: "text", text: stubReply(request) },
        { runId: request.runId, type: "done", reason: "stop" }
      ]
      let index = 0
      const step = (): void => {
        if (!active.has(request.runId)) return
        const frame = frames[index]
        index += 1
        if (frame === undefined) {
          active.delete(request.runId)
          return
        }
        publish(frame)
        setTimeout(step, 5)
      }
      setTimeout(step, 5)
      return { status: "started" }
    },
    cancel: (runId) => {
      if (!active.has(runId)) return { status: "not-found" }
      active.delete(runId)
      return { status: "cancelled" }
    }
  }
}
