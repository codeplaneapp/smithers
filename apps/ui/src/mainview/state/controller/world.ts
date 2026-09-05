import { MODEL_STREAM_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { parseWikilinks, restoreWikilinks } from "@smthrs/ui/vault"
import { DEFAULT_BRANCH_ID, DEFAULT_WORKSPACE_ID, rootFrameId, WORLD_DISPLAY_NAME } from "../AppState"
import type { WorldDocument } from "../AppState"
import type { AppStore } from "../AppStore"
import type { ControllerContext } from "./context"
import { sweepConversation, SweepRequestTooLargeError } from "./ConversationSweep"
import type { SweepNote } from "./ConversationSweep"

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
  readonly clearConversation: (options?: { readonly summarize?: boolean }) => Promise<string | void>
  readonly selectWorldDocument: (id: string) => string | void
  readonly changeWorldDocument: (id: string, body: string) => void
  readonly createWorldDocument: () => void
  readonly removeWorldDocument: (id: string) => string | void
  readonly confirmWorldDelete: () => string | void
  readonly cancelWorldDelete: () => void
}

export const createWorldController = (ctx: ControllerContext): WorldController => {
  let pendingClear: AbortController | undefined
  let disposed = false
  ctx.onDispose(() => {
    disposed = true
    pendingClear?.abort()
  })

  // Toasts and unrelated World edits must not invalidate a summary. Changes
  // to the conversation, its owner or identity do: never clear unseen input.
  const conversationVersion = (): string =>
    JSON.stringify({
      branch: ctx.store.session().activeBranchId,
      workspace: ctx.store.session().activeWorkspaceId,
      draft: ctx.store.session().draft,
      messages: [...ctx.store.collections.messages.values()],
      cards: [...ctx.store.collections.cards.values()],
      identity: ctx.store.collections.identitySessions.get("identity"),
      turn: ctx.activeTurn?.id,
      accountEpoch: ctx.accountEpoch
    })

  const clearConversation: WorldController["clearConversation"] = async (options = {}) => {
    if (disposed) return "This conversation is closed."
    pendingClear?.abort()
    const operation = new AbortController()
    pendingClear = operation
    const summarize = options.summarize === true
    try {
      const outcome = await ctx.withToast(
        "chat.clear",
        summarize ? "Summarizing the conversation…" : "Archiving the conversation…",
        "Conversation archived",
        async () => {
          const version = conversationVersion()
          let notes: SweepNote[] = []
          if (summarize) {
            const identity = ctx.store.collections.identitySessions.get("identity")
            if (identity?.state !== "signed-in" || !identity.allowlisted) {
              return "Sign in to summarize, or run /chat.clear without arguments to archive locally."
            }
            const transcript = ctx.contextMessages()
            if (transcript.length > 0) {
              try {
                notes = await sweepConversation(
                  ctx.http,
                  `${ctx.baseUrl}${MODEL_STREAM_PATH}`,
                  transcript,
                  operation.signal
                )
              } catch (error) {
                if (error instanceof SweepRequestTooLargeError) {
                  return "This conversation is too large for a summary (768 KiB request limit). Nothing was cleared or saved; run /chat.clear without arguments to archive it locally."
                }
                return "The summary did not finish; nothing was cleared or saved. Run /chat.clear without arguments to archive locally, or try summarizing again."
              }
            }
          }
          if (operation.signal.aborted || version !== conversationVersion()) {
            return "The conversation changed while I was reviewing it. Nothing was cleared or saved; try again."
          }
          const branchId = `branch-${crypto.randomUUID()}`
          const workspaceId = ctx.store.session().activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
          const previousBranchId = ctx.store.session().activeBranchId ?? DEFAULT_BRANCH_ID
          const accountEpoch = ctx.accountEpoch
          const turn = ctx.activeTurn
          const pumps = [...ctx.runPumps.entries()]
          // Fence the old stream before publishing the optimistic new branch.
          // Do not detach a newer turn that starts while this commit is pending.
          ctx.activeTurn = undefined
          if (turn !== undefined) {
            void Promise.resolve().then(() => ctx.agent.cancelTurn(turn.id)).catch(() => {
              if (
                disposed || ctx.accountEpoch !== accountEpoch || ctx.store.session().activeBranchId !== branchId
              ) return
              void ctx.store.dispatch({
                type: "message.appended",
                actor: "system",
                text: "Stopping the archived turn could not be confirmed by the remote agent."
              }).isPersisted.promise.catch(() => {})
            })
          }
          try {
            await ctx.store.dispatch({
              type: "conversation.cleared",
              actor: "user",
              branchId,
              notes,
              ...(turn === undefined ? {} : { interruptedTurnId: turn.id })
            }).isPersisted.promise
          } catch {
            if (
              turn !== undefined && ctx.activeTurn === undefined && !disposed &&
              ctx.accountEpoch === accountEpoch && ctx.store.session().activeBranchId === previousBranchId
            ) {
              // The transcript survived, but a stopped live stream cannot be
              // resumed. Mark that distinction if storage can accept a retry.
              await ctx.store.dispatch({
                type: "message.response.cancelled",
                actor: "system",
                turnId: turn.id,
                detail: "This turn stopped while trying to archive the conversation; the archive was not saved."
              }).isPersisted.promise.catch(() => {})
            }
            return "The archive could not be saved. Your conversation and World notes were not cleared; check local storage and reload before retrying."
          }
          for (const [cardId, pump] of pumps) {
            pump.stopped = true
            if (ctx.runPumps.get(cardId) === pump) ctx.runPumps.delete(cardId)
          }
          if (!disposed && ctx.accountEpoch === accountEpoch && ctx.store.session().activeBranchId === branchId) {
            // The old branch's root is a stable recovery URL, including after reload.
            try {
              ctx.services.frameHistory?.replace({
                workspaceId,
                branchId: previousBranchId,
                frameId: rootFrameId(previousBranchId)
              })
              ctx.services.frameHistory?.push({ workspaceId, branchId, frameId: rootFrameId(branchId) })
            } catch {
              // History is presentation, not the commit point. Its failure
              // must not tell the user that a saved archive failed to save.
              void ctx.store.dispatch({
                type: "message.appended",
                actor: "system",
                text:
                  "The archive was saved, but browser history could not be updated. Use the archive link above to open it."
              }).isPersisted.promise.catch(() => {})
            }
          }
          return true
        }
      )
      return outcome === true ? undefined : outcome
    } finally {
      if (pendingClear === operation) pendingClear = undefined
    }
  }

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
    /*
     * A note created from the chat (`/world.new-note` typed, or the agent's
     * call) used to land in a pane that stayed closed: the act "executed"
     * and nothing on screen changed. The new note is the selected document
     * of the World pane, so the pane opens to show it — for the USER's act
     * only: the agent's output embeds (THE EMBED LAW), never opens a pane.
     */
    if (ctx.commandActor === "user" && ctx.store.session().surface !== "world") {
      ctx.store.dispatch({ type: "surface.changed", actor: "user", surface: "world" })
    }
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
