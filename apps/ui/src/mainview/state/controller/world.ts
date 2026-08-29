import { parseWikilinks, restoreWikilinks } from "@smthrs/ui/vault"
import { MODEL_STREAM_PATH } from "smithers-shared/AgentApiRoutes"
import type { AgentChatMessage } from "smithers-shared/NativeAgent"
import { WORLD_DISPLAY_NAME } from "../AppState"
import type { WorldDocument } from "../AppState"
import type { AppStore } from "../AppStore"
import type { ControllerContext } from "./context"

const documentPath = (store: AppStore): string => {
  const paths = new Set([...store.collections.worldDocuments.values()].map((document) => document.path))
  let suffix = 1
  while (paths.has(`Untitled ${suffix}.md`)) suffix += 1
  return `Untitled ${suffix}.md`
}

const updateDocumentBody = (document: WorldDocument, body: string) => {
  const restoredBody = restoreWikilinks(body)
  return {
    id: document.id,
    path: document.path,
    title: document.title,
    body: restoredBody,
    links: [...new Set(parseWikilinks(restoredBody).map((link) => link.target).filter(Boolean))],
    tags: document.tags,
    sources: [...new Set([...document.sources, "user:world-editor"])],
    confidence: document.confidence
  }
}

export interface WorldController {
  readonly clearConversation: () => Promise<string | void>
  readonly selectWorldDocument: (id: string) => string | void
  readonly changeWorldDocument: (id: string, body: string) => void
  readonly createWorldDocument: () => void
  readonly removeWorldDocument: (id: string) => string | void
  readonly confirmWorldDelete: () => string | void
  readonly cancelWorldDelete: () => void
}

export const createWorldController = (ctx: ControllerContext): WorldController => {
  /*
   * /clear (§2h): sweep the outgoing transcript for anything that belongs in
   * world (decisions, facts, preferences — provenance chat-sweep, actor
   * smithers), apply it, THEN clear. A failed sweep clears nothing.
   */
  const SWEEP_INSTRUCTIONS = [
    "You are sweeping a chat transcript before it is cleared.",
    "Extract anything that belongs in long-term world memory: decisions the user made, durable facts about their work, stated preferences.",
    "Answer with ONLY JSON: {\"notes\":[{\"title\":\"...\",\"body\":\"...\",\"confidence\":0.0}...]} — body is markdown, confidence is 0..1.",
    "If nothing is worth keeping, answer {\"notes\":[]}. No prose, no fences."
  ].join("\n")

  interface SweepNote {
    readonly title: string
    readonly body: string
    readonly confidence: number
  }

  const runSweep = async (transcript: ReadonlyArray<AgentChatMessage>): Promise<SweepNote[] | undefined> => {
    let response: Response
    try {
      response = await ctx.http(`${ctx.baseUrl}${MODEL_STREAM_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: transcript, instructions: SWEEP_INSTRUCTIONS })
      })
    } catch {
      return undefined
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      return undefined
    }
    const raw = await response.text()
    let text = ""
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue
      try {
        const frame: unknown = JSON.parse(line)
        if (
          typeof frame === "object" && frame !== null &&
          (frame as { type?: unknown }).type === "delta" &&
          (frame as { kind?: unknown }).kind === "text" &&
          typeof (frame as { text?: unknown }).text === "string"
        ) text += (frame as { text: string }).text
      } catch {
        // An unparseable line is not sweep output.
      }
    }
    const match = /\{[\s\S]*\}/.exec(text)
    if (match === null) return undefined
    try {
      const parsed: unknown = JSON.parse(match[0])
      if (typeof parsed !== "object" || parsed === null) return undefined
      const notes = (parsed as { notes?: unknown }).notes
      if (!Array.isArray(notes)) return undefined
      return notes
        .filter((note) =>
          typeof note === "object" && note !== null &&
          typeof (note as { title?: unknown }).title === "string" &&
          typeof (note as { body?: unknown }).body === "string" &&
          (note as { title: string }).title.trim() !== ""
        )
        .map((note) => {
          const row = note as { title: string; body: string; confidence?: unknown }
          return {
            title: row.title.trim(),
            body: row.body,
            confidence: typeof row.confidence === "number" && row.confidence >= 0 && row.confidence <= 1
              ? row.confidence :
              0.6
          }
        })
    } catch {
      return undefined
    }
  }

  const clearConversationImpl = async (): Promise<true | string> => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    const canSweep = identity?.state === "signed-in" && identity.allowlisted
    const transcript = ctx.contextMessages()
    const sweptRevision = ctx.store.session().revision
    let kept = 0
    if (canSweep && transcript.length > 0) {
      const notes = await runSweep(transcript)
      if (ctx.store.session().revision !== sweptRevision) {
        return "The conversation changed while I was reviewing it, so I left it exactly as it is. Try /clear again."
      }
      if (notes === undefined) {
        // A failed sweep leaves the chat UNcleared — nothing is silently lost.
        const message =
          "I couldn't finish reviewing the conversation, so I left it exactly as it was. Try /clear again in a moment."
        ctx.store.dispatch({ type: "message.appended", actor: "system", text: message })
        return message
      }
      for (const note of notes) {
        const path = `${note.title.replace(/[\\/:*?"<>|]/g, "-")}.md`
        const existing = [...ctx.store.collections.worldDocuments.values()].find(
          (document) => document.path === path
        )
        ctx.store.dispatch({
          type: "world.document.upserted",
          actor: "smithers",
          document: {
            id: existing?.id ?? crypto.randomUUID(),
            path,
            title: note.title,
            body: note.body.startsWith("#") ? note.body : `# ${note.title}\n\n${note.body}\n`,
            links: existing?.links ?? [],
            tags: existing?.tags ?? [],
            sources: [...new Set([...(existing?.sources ?? []), "chat-sweep"])],
            confidence: note.confidence
          }
        })
        kept += 1
      }
    }
    if (ctx.activeTurn !== undefined) void ctx.agent.cancelTurn(ctx.activeTurn.id)
    ctx.activeTurn = undefined
    ctx.stopWorkflowPumps()
    ctx.store.dispatch({ type: "conversation.cleared", actor: "user", kept })
    return true
  }

  const clearConversation = (): Promise<string | void> =>
    ctx.withToast(
      "chat.clear",
      `Reviewing the conversation for what to keep…`,
      "Conversation reviewed",
      clearConversationImpl
    )
      .then((outcome) => (outcome === true ? undefined : outcome))

  /*
   * A.34: an id-scoped act used to dispatch blindly, so a note id that does
   * not exist was a silent no-op — the reducer dropped it and the human was
   * told nothing. An act names what it could not find.
   */
  const selectWorldDocument = (id: string): string | void => {
    if (ctx.store.collections.worldDocuments.get(id) === undefined) {
      return `There is no ${WORLD_DISPLAY_NAME} note with id ${id}.`
    }
    ctx.store.dispatch({ type: "world.document.selected", actor: "user", id })
  }

  const changeWorldDocument = (id: string, body: string): void => {
    const document = ctx.store.collections.worldDocuments.get(id)
    if (document === undefined || document.body === body) return
    ctx.store.dispatch({ type: "world.document.upserted", actor: "user", document: updateDocumentBody(document, body) })
  }

  const createWorldDocument = (): void => {
    const path = documentPath(ctx.store)
    const title = path.replace(/\.md$/, "")
    ctx.store.dispatch({
      type: "world.document.upserted",
      actor: ctx.commandActor,
      document: {
        id: crypto.randomUUID(),
        path,
        title,
        body: `# ${title}\n\n`,
        links: [],
        tags: [],
        sources: ["user:world-editor"],
        confidence: 1
      }
    })
  }

  /*
   * §10.6 / §28.4 / A.34: deleting a note is not undoable, so `/world.delete`
   * ASKS — from the trash button and from the composer alike. It used to
   * delete outright whenever it was typed, because the only confirm lived in
   * a component's local state and the flow bypassed it.
   */
  const removeWorldDocument = (id: string): string | void => {
    if (ctx.store.collections.worldDocuments.get(id) === undefined) {
      return `There is no ${WORLD_DISPLAY_NAME} note with id ${id} to delete.`
    }
    ctx.store.dispatch({ type: "world.delete.asked", actor: ctx.commandActor, id })
  }

  /** The human's answer to that question: yes. */
  const confirmWorldDelete = (): string | void => {
    const id = ctx.store.session().pendingWorldDeleteId ?? null
    if (id === null) return "No note is waiting to be deleted."
    ctx.store.dispatch({ type: "world.document.removed", actor: "user", id })
  }

  /** The human's answer to that question: no. */
  const cancelWorldDelete = (): void => {
    ctx.store.dispatch({ type: "world.delete.asked", actor: "user", id: null })
  }

  return {
    clearConversation,
    selectWorldDocument,
    changeWorldDocument,
    createWorldDocument,
    removeWorldDocument,
    confirmWorldDelete,
    cancelWorldDelete
  }
}
