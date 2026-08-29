import type { Card } from "smithers-shared/Cards"
import { isAgentTurnFrame } from "smithers-shared/NativeAgent"
import type { AgentTurnFrame } from "smithers-shared/NativeAgent"

/*
 * The TUI transcript: the in-memory headless state layer for the terminal chat.
 * Components are projections of this store (via useSyncExternalStore); nothing
 * in the render tree owns application state.
 *
 * TODO: persistence. This round keeps collections in memory; a persisted
 * transcript (and a proper collection boundary) lands with the shared-package
 * extraction. Do NOT pull wa-sqlite into the TUI.
 *
 * TODO(mirror): live mirroring with a running UI instance (shared live
 * session / state sync between the two frontends) plugs in here: the store is
 * the seam a synced authority would replace.
 */

export type MessageStatus = "streaming" | "complete" | "failed" | "interrupted"

export interface MessageEntry {
  readonly kind: "message"
  readonly id: string
  readonly role: "user" | "assistant"
  readonly text: string
  readonly reasoning?: string
  readonly status: MessageStatus
  readonly detail?: string
}

export interface ToolEntry {
  readonly kind: "tool"
  readonly id: string
  readonly name: string
  readonly arguments: string
  /*
   * TODO(tools): the TUI does not execute tools this round — a `tool_call`
   * frame renders compactly and the turn ends. The client tool loop
   * (continuation turn carrying function_call_output) is the follow-up seam.
   */
  readonly output?: string
}

export interface CardEntry {
  readonly kind: "card"
  readonly id: string
  readonly cardKind: Card["kind"]
  readonly title: string
  readonly status: string
}

/** Chain turn frames (link.*, call.*, gate, park) rendered as one compact line. */
export interface EventEntry {
  readonly kind: "event"
  readonly id: string
  readonly text: string
}

export type TranscriptEntry = MessageEntry | ToolEntry | CardEntry | EventEntry

export type ChatPhase = "idle" | "responding"

export class TranscriptStore {
  private entriesValue: Array<TranscriptEntry> = []
  private versionValue = 0
  private phaseValue: ChatPhase = "idle"
  private draftValue = ""
  private draftRevisionValue = 0
  private readonly listeners = new Set<() => void>()
  private sequence = 0

  readonly subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The useSyncExternalStore snapshot: a monotonically increasing version. */
  readonly getVersion = (): number => this.versionValue

  readonly entries = (): ReadonlyArray<TranscriptEntry> => this.entriesValue

  readonly phase = (): ChatPhase => this.phaseValue

  readonly draft = (): string => this.draftValue

  /** Remount key for OpenTUI's stateful InputRenderable after a submit. */
  readonly draftRevision = (): number => this.draftRevisionValue

  readonly setDraft = (draft: string): void => {
    if (this.draftValue === draft) return
    this.draftValue = draft
    this.versionValue += 1
    for (const listener of this.listeners) listener()
  }

  readonly clearDraft = (): void => {
    this.draftValue = ""
    this.draftRevisionValue += 1
    this.versionValue += 1
    for (const listener of this.listeners) listener()
  }

  readonly setPhase = (phase: ChatPhase): void => {
    if (this.phaseValue === phase) return
    this.phaseValue = phase
    this.versionValue += 1
    for (const listener of this.listeners) listener()
  }

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }

  private commit(entries: Array<TranscriptEntry>): void {
    this.entriesValue = entries
    this.versionValue += 1
    for (const listener of this.listeners) listener()
  }

  private append(entry: TranscriptEntry): void {
    this.commit([...this.entriesValue, entry])
  }

  private replace(id: string, entry: TranscriptEntry): void {
    this.commit(this.entriesValue.map((existing) => (existing.id === id ? entry : existing)))
  }

  readonly get = (id: string): TranscriptEntry | undefined => this.entriesValue.find((entry) => entry.id === id)

  readonly appendUserMessage = (turnId: string, text: string): void => {
    this.append({
      kind: "message",
      id: `message-${turnId}-user`,
      role: "user",
      text,
      status: "complete"
    })
  }

  readonly appendDelta = (runId: string, channel: "reasoning" | "text", delta: string): void => {
    if (delta === "") return
    const id = `message-${runId}-assistant`
    const existing = this.get(id)
    if (existing === undefined) {
      this.append({
        kind: "message",
        id,
        role: "assistant",
        text: channel === "text" ? delta : "",
        ...(channel === "reasoning" ? { reasoning: delta } : {}),
        status: "streaming"
      })
      return
    }
    if (existing.kind !== "message") return
    this.replace(id, {
      ...existing,
      text: channel === "text" ? existing.text + delta : existing.text,
      reasoning: channel === "reasoning" ? (existing.reasoning ?? "") + delta : existing.reasoning
    })
  }

  readonly settleAssistant = (
    runId: string,
    status: Exclude<MessageStatus, "streaming">,
    detail?: string
  ): void => {
    const id = `message-${runId}-assistant`
    const existing = this.get(id)
    if (existing === undefined) {
      // A kill or failure before the first delta: say what happened on that
      // turn rather than leaving the user's message hanging with nothing
      // after it. An ordinary stop with no prose settles silently.
      if (status === "complete") return
      this.append({
        kind: "message",
        id,
        role: "assistant",
        // Status detail is projected separately from assistant prose. Keeping
        // this empty avoids rendering it twice and prevents a local transport
        // error from entering the next model request as assistant speech.
        text: "",
        status,
        ...(detail === undefined ? {} : { detail })
      })
      return
    }
    if (existing.kind !== "message") return
    this.replace(id, { ...existing, status, ...(detail === undefined ? {} : { detail }) })
  }

  readonly appendToolCall = (callId: string, name: string, args: string): void => {
    this.append({ kind: "tool", id: `tool-${callId}`, name, arguments: args })
  }

  readonly upsertCard = (card: Card): void => {
    const entry: CardEntry = {
      kind: "card",
      id: `card-${card.id}`,
      cardKind: card.kind,
      title: card.title,
      status: card.status
    }
    if (this.get(entry.id) === undefined) {
      this.append(entry)
    } else {
      this.replace(entry.id, entry)
    }
  }

  readonly patchCard = (cardId: string, patch: { title?: string; status?: string }): void => {
    const id = `card-${cardId}`
    const existing = this.get(id)
    if (existing === undefined || existing.kind !== "card") return
    this.replace(id, {
      ...existing,
      title: patch.title ?? existing.title,
      status: patch.status ?? existing.status
    })
  }

  readonly appendEvent = (text: string): void => {
    this.append({ kind: "event", id: this.nextId("event"), text })
  }

  /** Drops every transcript entry. The draft and phase are untouched. */
  readonly clear = (): void => {
    this.commit([])
  }
}

/** The one-line placeholder the TUI renders for any card (HTML embeds are disabled this round). */
// TODO(open-in-app): render a link that opens this card in the native app
export const cardPlaceholder = (entry: CardEntry): string =>
  `[card] ${entry.cardKind}: ${entry.title} (${entry.status})`

/** The compact one-line rendering of a tool call (and its output, once tools execute). */
export const toolCallLine = (entry: ToolEntry): string =>
  entry.output === undefined
    ? `[tool] ${entry.name} ${entry.arguments}`
    : `[tool] ${entry.name} ${entry.arguments} → ${entry.output}`

/** The visible message history for a turn request: complete, non-empty prose only. */
// TODO(shared): move to a shared package (derived from contextMessages in apps/ui/src/mainview/state/AgentTurnPolicy.ts)
export const transcriptMessages = (
  entries: ReadonlyArray<TranscriptEntry>
): ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }> =>
  entries
    .filter(
      (entry): entry is MessageEntry =>
        entry.kind === "message" && entry.status !== "streaming" && entry.text.trim() !== ""
    )
    .map((entry) => ({
      role: entry.role,
      content: entry.text
    }))

/** Fold one wire frame into transcript state. */
// TODO(shared): move to a shared package (derived from the frame handling in apps/ui/src/mainview/state/AppController.ts)
export const applyFrame = (store: TranscriptStore, frame: AgentTurnFrame): void => {
  switch (frame.type) {
    case "delta":
      store.appendDelta(frame.runId, frame.kind, frame.text)
      break
    case "done":
      if (frame.error !== undefined) {
        store.settleAssistant(frame.runId, "failed", `That turn failed. ${frame.error}`)
      } else if (frame.reason === "cancelled") {
        store.settleAssistant(frame.runId, "interrupted", "Stopped the current response.")
      } else {
        store.settleAssistant(frame.runId, "complete")
      }
      break
    case "card":
      store.upsertCard(frame.card)
      break
    case "card.update":
      store.patchCard(frame.id, frame.patch)
      break
    case "tool_call":
      store.appendToolCall(frame.call_id, frame.name, frame.arguments)
      break
    case "link.authored":
      store.appendEvent(`[chain] link ${frame.link} authored`)
      break
    case "call.started":
      store.appendEvent(`[chain] call ${frame.name} started`)
      break
    case "call.settled":
      store.appendEvent(`[chain] call ${frame.name} settled (${frame.verdict})`)
      break
    case "gate.rejected":
      store.appendEvent(
        `[chain] gate rejected (${frame.kind})${frame.message === undefined ? "" : `: ${frame.message}`}`
      )
      break
    case "link.ended":
      store.appendEvent(`[chain] link ${frame.link} ended (${frame.outcome})`)
      break
    case "steering.drained":
      store.appendEvent(`[chain] steering drained (${frame.count})`)
      break
    case "park":
      store.appendEvent(`[chain] parked (${frame.code})`)
      if (frame.card !== undefined) store.upsertCard(frame.card)
      break
  }
}

/**
 * Incremental decoder for the boundary's NDJSON AgentTurnFrame stream. A
 * chunk may end anywhere inside a UTF-8-decoded JSON line; only complete
 * lines are parsed until finish() flushes the final unterminated line.
 */
// TODO(shared): move to a shared package (the line fold mirrors apps/ui/src/mainview/native/WebAgent.ts streamFrames)
export class AgentTurnFrameDecoder {
  private buffer = ""
  private invalidLinesValue = 0

  constructor(
    private readonly publish: (frame: AgentTurnFrame) => void,
    private readonly expectedRunId?: string,
    private readonly injectExpectedRunId = false
  ) {}

  private decodeLine(line: string): number {
    if (line.trim() === "") return 0
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.invalidLinesValue += 1
      return 0
    }
    const candidate =
      this.injectExpectedRunId && this.expectedRunId !== undefined && typeof parsed === "object" && parsed !== null
        ? { ...parsed, runId: this.expectedRunId }
        : parsed
    if (!isAgentTurnFrame(candidate)) {
      this.invalidLinesValue += 1
      return 0
    }
    if (this.expectedRunId !== undefined && candidate.runId !== this.expectedRunId) return 0
    this.publish(candidate)
    return 1
  }

  readonly invalidLines = (): number => this.invalidLinesValue

  readonly push = (chunk: string): number => {
    this.buffer += chunk
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""
    let applied = 0
    for (const line of lines) applied += this.decodeLine(line)
    return applied
  }

  readonly finish = (): number => {
    const trailing = this.buffer
    this.buffer = ""
    return this.decodeLine(trailing)
  }
}

/*
 * Decode an NDJSON AgentTurnFrame stream into transcript state: the same
 * line-split/parse/validate fold both transports run, exposed on the headless
 * layer so tests (and the smoke script) drive the store without a network.
 * Returns the number of frames applied.
 */
export const feedNdjson = (store: TranscriptStore, text: string): number => {
  const decoder = new AgentTurnFrameDecoder((frame) => applyFrame(store, frame))
  return decoder.push(text) + decoder.finish()
}
