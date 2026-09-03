/*
 * The code-intel seam (docs/code-intel/PLAN.md §4): `code.hover`,
 * `code.definition` and `code.diagnostics` against the local app's language
 * server (LspClient.ts → `/api/lsp/*`). Each is ONE act with three doors and
 * answers two things: a `{ value }` the MODEL reads (the FilesSeam rule — a
 * read the model cannot read is a confabulation waiting to happen), and a
 * patch to the human's FILE card through `card.updated` (no new card kind):
 * `hover`, `diagnostics`, and `intel` — what the card knows about the server.
 * The definition opens its target through files.read's line anchor.
 *
 * Honesty: a missing language server is stated with its install line and
 * never installed; a position the server has nothing for is stated; a Cloud
 * target is refused until plue relays a workspace language server (§3).
 * Diagnostics the server publishes on `/ws` (`lsp:<repoId>`) patch the card
 * they belong to with no request; a publication for a file nobody opened
 * has nowhere to render and is dropped.
 */
import { LSP_LANGUAGE_SERVER_MISSING, LSP_REQUEST_TIMEOUT_MS } from "@smthrs/rpc/LocalApp"
import type { LspDiagnostic, LspLocation, Repo } from "@smthrs/rpc/LocalApp"
import type { Card } from "../AppState"
import type { LspAnswer, LspClient, LspRefusal } from "../LspClient"
import { resolveFileTarget } from "./FilesSeam"
import type { FileAnchor, FilesSeam } from "./FilesSeam"
import type { SeamContext } from "./SeamContext"

export interface CodeIntelSeam {
  readonly hover: (path: string, line: number, column: number, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly definition: (path: string, line: number, column: number, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly diagnostics: (path: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** Detach every diagnostics subscription (the controller's disposal scope). */
  readonly dispose: () => void
}

export interface CodeIntelSeamOptions {
  readonly lsp: LspClient
  /**
   * files.read: the definition target opens through it at its line, and a
   * file with no card yet renders one (at the asked position) before the
   * answer patches it — a hover with no card to show it on is nothing the
   * human can see.
   */
  readonly readFile: FilesSeam["readFile"]
  /**
   * How long a first request may run before the card states the server is
   * starting (the 300 ms law): the host spawns on first use and tsserver
   * loads the project for seconds; a card that already saw the server
   * answer is never told "starting" again.
   */
  readonly startingAfterMs?: number
}

/** The plan's sentence (§3) until plue relays a workspace language server. */
const CLOUD_HOVER_REFUSAL = "Hover and definitions need a workspace language server; Smithers Cloud does not relay one yet."
const CLOUD_DIAGNOSTICS_REFUSAL = "Diagnostics need a workspace language server; Smithers Cloud does not relay one yet."

type FilePayload = Extract<Card, { kind: "file" }>["payload"]
type Intel = NonNullable<FilePayload["intel"]>

const cardIdOf = (repo: Repo, path: string): string => `file-${repo.name}-${path}`

/** `line:col severity message (source code)` — one diagnostic as the model reads it. */
const diagnosticRow = (item: LspDiagnostic): string => {
  const origin = [item.source, item.code].filter((part): part is string => part !== undefined).join(" ")
  return `${item.line}:${item.character} ${item.severity} ${item.message}${origin === "" ? "" : ` (${origin})`}`
}

const locationRow = (location: LspLocation): string => `${location.path}:${location.line}:${location.character}`

/** The refusal as the model reads it and as the card states it. */
const refused = (refusal: LspRefusal): { readonly intel: Intel; readonly text: string } =>
  refusal.code === LSP_LANGUAGE_SERVER_MISSING && refusal.install !== undefined
    ? { intel: { state: "missing", note: refusal.install }, text: `${refusal.message} Install: ${refusal.install}` }
    : { intel: { state: "unavailable", note: refusal.message }, text: refusal.message }

export const createCodeIntelSeam = (ctx: SeamContext, options: CodeIntelSeamOptions): CodeIntelSeam => {
  const startingAfterMs = options.startingAfterMs ?? 300

  const fileCard = (id: string): Extract<Card, { kind: "file" }> | undefined => {
    const card = ctx.store.collections.cards.get(id)
    return card?.kind === "file" ? card : undefined
  }

  /** Patch the file card's payload through the dispatcher; false when no such card exists. */
  const patch = (id: string, fields: Partial<FilePayload>): boolean => {
    const card = fileCard(id)
    if (card === undefined) return false
    ctx.dispatch({ type: "card.updated", actor: ctx.actor(), id, patch: { payload: { ...card.payload, ...fields } } })
    return true
  }

  /*
   * One subscription per repository for as long as the controller lives:
   * every publication patches the card of the file it names. The first
   * code.* call on a repository opens it, so a repository nobody asked about
   * costs no socket topic.
   */
  const watching = new Map<string, () => void>()
  const watch = (repo: Repo): void => {
    if (watching.has(repo.id)) return
    watching.set(
      repo.id,
      options.lsp.subscribe(repo.id, (message) => {
        patch(cardIdOf(repo, message.path), { diagnostics: message.items })
      })
    )
  }

  /** The file card the answer lands on, rendered through files.read when absent; the read's refusal is the answer then. */
  const ensureCard = async (repo: Repo, path: string, anchor?: FileAnchor): Promise<string | undefined> => {
    if (fileCard(cardIdOf(repo, path)) !== undefined) return undefined
    const read = await options.readFile(path, repo.name, anchor)
    return typeof read === "string" ? read : undefined
  }

  /** Run one request; past the 300 ms mark a card that never saw the server answer states "starting". */
  const request = async <T>(id: string, work: () => Promise<LspAnswer<T>>): Promise<LspAnswer<T>> => {
    const timer = setTimeout(() => {
      if (fileCard(id)?.payload.intel?.state !== "ready") patch(id, { intel: { state: "starting" } })
    }, startingAfterMs)
    ;(timer as { unref?: () => void }).unref?.()
    try {
      return await work()
    } finally {
      clearTimeout(timer)
    }
  }

  /** The target, its card, and the subscription, or the honest refusal — shared by the three acts. */
  const prepare = async (
    pathArg: string,
    repoArg: string | undefined,
    cloudRefusal: string,
    anchor?: FileAnchor
  ): Promise<{ readonly repo: Repo; readonly path: string; readonly id: string } | string> => {
    const target = resolveFileTarget(ctx.store, pathArg, repoArg)
    if ("error" in target) return target.error
    if (target.kind === "cloud") {
      // A cloud file card states the state under its header and unbinds its gestures (L4), so one rest is one refusal, not one per rest.
      patch(`file-${target.repo}-${target.path}`, { intel: { state: "unavailable", note: cloudRefusal } })
      return cloudRefusal
    }
    if (target.path === "") return "code intelligence needs a file path"
    const refusal = await ensureCard(target.repo, target.path, anchor)
    if (refusal !== undefined) return refusal
    watch(target.repo)
    return { repo: target.repo, path: target.path, id: cardIdOf(target.repo, target.path) }
  }

  return {
    hover: async (pathArg, line, column, repoArg) => {
      const prepared = await prepare(pathArg, repoArg, CLOUD_HOVER_REFUSAL, { line, column })
      if (typeof prepared === "string") return prepared
      const { repo, path, id } = prepared
      const answer = await request(id, () => options.lsp.hover({ repoId: repo.id, path, line, character: column }))
      if ("refusal" in answer) {
        const { intel, text } = refused(answer.refusal)
        patch(id, { intel })
        return text
      }
      const hover = answer.ok.hover
      patch(id, {
        intel: { state: "ready" },
        hover: hover === null ? null : { line, character: column, contents: hover.contents }
      })
      return {
        value: hover === null
          ? `The language server has nothing at ${path}:${line}:${column} in ${repo.name}.`
          : `${path}:${line}:${column} in ${repo.name}\n${hover.contents}`
      }
    },

    definition: async (pathArg, line, column, repoArg) => {
      const prepared = await prepare(pathArg, repoArg, CLOUD_HOVER_REFUSAL, { line, column })
      if (typeof prepared === "string") return prepared
      const { repo, path, id } = prepared
      const answer = await request(id, () => options.lsp.definition({ repoId: repo.id, path, line, character: column }))
      if ("refusal" in answer) {
        const { intel, text } = refused(answer.refusal)
        patch(id, { intel })
        return text
      }
      patch(id, { intel: { state: "ready" } })
      const [first, ...rest] = answer.ok.locations
      if (first === undefined) return { value: `No definition found for ${path}:${line}:${column} in ${repo.name}.` }
      /*
       * The card effect (§4): the first target opens at its line through
       * files.read's anchor — the same card id, the same dedupe, the same
       * scroll. The read's own value stays out of this answer: the model
       * asked where, not what; it reads the target with files.read.
       */
      await options.readFile(first.path, repo.name, { line: first.line, column: first.character })
      return { value: `${path}:${line}:${column} in ${repo.name} is defined at:\n${[first, ...rest].map(locationRow).join("\n")}` }
    },

    diagnostics: async (pathArg, repoArg) => {
      const prepared = await prepare(pathArg, repoArg, CLOUD_DIAGNOSTICS_REFUSAL)
      if (typeof prepared === "string") return prepared
      const { repo, path, id } = prepared
      const answer = await request(id, () => options.lsp.diagnostics({ repoId: repo.id, path }))
      if ("refusal" in answer) {
        const { intel, text } = refused(answer.refusal)
        patch(id, { intel })
        return text
      }
      const { items } = answer.ok
      if (items === null) {
        // The server published nothing within the wait: the card keeps no count rather than a false zero.
        patch(id, { intel: { state: "ready" } })
        return { value: `The language server published no diagnostics for ${path} in ${repo.name} within ${LSP_REQUEST_TIMEOUT_MS / 1000} s.` }
      }
      patch(id, { intel: { state: "ready" }, diagnostics: items })
      return {
        value: items.length === 0
          ? `${path} in ${repo.name}: no diagnostics.`
          : `${path} in ${repo.name}: ${items.length} diagnostic${items.length === 1 ? "" : "s"}\n${items.map(diagnosticRow).join("\n")}`
      }
    },

    dispose: () => {
      for (const detach of watching.values()) detach()
      watching.clear()
    }
  }
}
