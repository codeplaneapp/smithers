import { CHAT_TURN_PATH } from "smithers-shared/AgentApiRoutes"
import type { Repo, Target, TargetRunFrame } from "smithers-shared/LocalApp"
import { RepoSchema, TargetRunResponseSchema, TargetsQueryResponseSchema } from "smithers-shared/LocalApp"
import { isAgentTurnFrame } from "smithers-shared/NativeAgent"
import type { AgentTurnFrame } from "smithers-shared/NativeAgent"
import { buildTargetsInstructions, defaultTargetsMessage, parseTargetsPanelReply, renderTargetsPanel } from "smithers-shared/TargetsPanel"
import type { Card } from "../AppState"
import type { TargetRunClient } from "../TargetRunClient"
import type { ControllerContext } from "./context"

/*
 * Lane L3 (docs/LOCAL-APP.md "Auto-load flow"): opening a repository through
 * the local origin, loading its Smithers targets into a `targets` card, the
 * panel turn that yields the `html` card (or the built-in template), and the
 * iframe bridge that turns a panel's `run` / `open` message into a
 * `target-run` card or a highlighted row. Every store change goes through
 * the dispatcher with its actor; the DOM is touched only to find which frame
 * posted a message and to scroll a row into view.
 */

export interface TargetsController {
  /** `POST /api/repo/open`, then the repo card and the auto-load flow. */
  readonly openRepo: (path: string) => Promise<string | void>
  /** `POST /api/targets/run`, then a target-run card fed from the run topic. */
  readonly runTarget: (repoId: string, label: string) => Promise<string | void>
  /** Highlight (and scroll to) the target's row in its targets card. */
  readonly openTarget: (repoId: string, label: string) => string | void
  /** The window `message` listener for the html cards' frames; returns the uninstaller. */
  readonly installBridge: (target: Pick<Window, "addEventListener" | "removeEventListener">) => () => void
}

export interface TargetsControllerDependencies {
  readonly nextOrdinal: () => number
  readonly loadRepos: () => Promise<void>
  readonly runs: TargetRunClient
  readonly surfaceCommandFailure: (name: string, outcome: { readonly status: "executed" | "unknown-command" } | { readonly status: "failed"; readonly error: string }) => void
  /** A run's start, announced so a graph card of the same repo can overlay it (controller/targetGraph.ts). */
  readonly onRunStarted?: (repoId: string, runId: string, label: string) => void
}

export const repoCardId = (repoId: string): string => `repo-${repoId}`
export const targetsCardId = (repoId: string): string => `targets-${repoId}`
export const htmlCardId = (repoId: string): string => `html-${repoId}`
export const targetRunCardId = (runId: string): string => `target-run-${runId}`

/** The bridge frame's own attribute, the door from a `message` event back to its card. */
export const HTML_CARD_FRAME_ATTRIBUTE = "data-html-card"

/** A panel's bridge message, or undefined for anything else that reaches the window. */
export const parseBridgeMessage = (data: unknown): { readonly action: "run" | "open"; readonly label: string } | undefined => {
  if (typeof data !== "object" || data === null) return undefined
  const { smithers, label } = data as { smithers?: unknown; label?: unknown }
  if ((smithers !== "run" && smithers !== "open") || typeof label !== "string" || label.trim() === "") return undefined
  return { action: smithers, label: label.trim() }
}

/** The transcript can hold the whole run; past this the card keeps the tail. */
const MAX_OUTPUT_CHARS = 200_000

export const createTargetsController = (
  ctx: ControllerContext,
  dependencies: TargetsControllerDependencies
): TargetsController => {
  const { store, baseUrl } = ctx
  const { nextOrdinal, loadRepos, runs, surfaceCommandFailure, onRunStarted } = dependencies

  const upsert = (card: Card): void => {
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
  }

  const patch = <K extends Card["kind"]>(
    id: string,
    kind: K,
    update: (card: Extract<Card, { kind: K }>) => { payload: Extract<Card, { kind: K }>["payload"]; status?: Card["status"] }
  ): void => {
    const existing = store.collections.cards.get(id)
    if (existing === undefined || existing.kind !== kind) return
    const next = update(existing as unknown as Extract<Card, { kind: K }>)
    store.dispatch({
      type: "card.updated",
      actor: "system",
      id,
      patch: { payload: next.payload, ...(next.status === undefined ? {} : { status: next.status }) }
    })
  }

  /*
   * The panel turn: one system instruction with the target JSON and the
   * bridge contract, the streamed NDJSON read to its `done`, and the reply
   * parsed as `{ message, html }`. Anything short of valid JSON with a
   * non-empty html renders the built-in template. This is not a transcript
   * turn: no user bubble, no phase change, and the plain http seam because a
   * model answer has no deadline.
   */
  const panelTurn = async (repo: Repo, targets: ReadonlyArray<Target>): Promise<{
    readonly message: string
    readonly html: string
    readonly source: "agent" | "template"
  }> => {
    const fallback = (text: string) => ({
      message: text.trim() !== "" && !text.trim().startsWith("{") ? text.trim().slice(0, 2000) : defaultTargetsMessage(targets.length, repo.name),
      html: renderTargetsPanel(targets),
      source: "template" as const
    })
    const runId = `targets-panel-${crypto.randomUUID()}`
    let response: Response
    try {
      response = await ctx.http(`${baseUrl}${CHAT_TURN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          messages: [{ role: "user", content: `Build the targets panel for ${repo.name}.` }],
          instructions: buildTargetsInstructions({ repoName: repo.name, repoPath: repo.path, targets })
        })
      })
    } catch {
      return fallback("")
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      return fallback("")
    }
    let text = ""
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let settled = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split("\n")
        buffer = done ? "" : (lines.pop() ?? "")
        for (const line of lines) {
          if (line.trim() === "") continue
          let frame: unknown
          try {
            frame = JSON.parse(line)
          } catch {
            continue
          }
          if (!isAgentTurnFrame(frame) || frame.runId !== runId) continue
          const typed: AgentTurnFrame = frame
          if (typed.type === "delta" && typed.kind === "text") text += typed.text
          if (typed.type === "done") settled = true
        }
        if (done || settled) break
      }
    } catch {
      // A broken stream is answered by whatever text arrived, or the template.
    }
    await reader.cancel().catch(() => {})
    const reply = parseTargetsPanelReply(text)
    if (reply === undefined) return fallback(text)
    return {
      message: reply.message.trim() === "" ? defaultTargetsMessage(targets.length, repo.name) : reply.message,
      html: reply.html,
      source: "agent"
    }
  }

  const loadTargets = async (repo: Repo): Promise<void> => {
    const id = targetsCardId(repo.id)
    upsert({
      id,
      kind: "targets",
      title: `${repo.name} targets`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repoId: repo.id, repoName: repo.name, status: "pending", targets: [], warnings: [] }
    })
    let response: Response
    try {
      response = await ctx.http(`${baseUrl}/api/targets/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: repo.id })
      })
    } catch (error) {
      patch(id, "targets", (card) => ({
        payload: { ...card.payload, status: "failed", warnings: [error instanceof Error ? error.message : String(error)] },
        status: "error"
      }))
      return
    }
    if (!response.ok) {
      const message = await ctx.errorMessageOf(response, `The targets query answered ${response.status}`)
      patch(id, "targets", (card) => ({ payload: { ...card.payload, status: "failed", warnings: [message] }, status: "error" }))
      return
    }
    const parsed = TargetsQueryResponseSchema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) {
      patch(id, "targets", (card) => ({
        payload: { ...card.payload, status: "failed", warnings: ["The targets query answered an unexpected shape."] },
        status: "error"
      }))
      return
    }
    const { targets, warnings } = parsed.data
    patch(id, "targets", (card) => ({ payload: { ...card.payload, status: "done", targets, warnings }, status: "acted" }))

    const panel = await panelTurn(repo, targets)
    store.dispatch({ type: "message.appended", actor: "system", text: panel.message })
    upsert({
      id: htmlCardId(repo.id),
      kind: "html",
      title: `${repo.name} panel`,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { title: `${repo.name} panel`, html: panel.html, source: panel.source, repoId: repo.id }
    })
  }

  const openRepo: TargetsController["openRepo"] = async (path) => {
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}/api/repo/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path })
      })
    } catch (error) {
      return `Could not open ${path}: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!response.ok) return await ctx.errorMessageOf(response, `Could not open ${path}`)
    const body = (await response.json().catch(() => undefined)) as { repo?: unknown } | undefined
    const parsed = RepoSchema.safeParse(body?.repo)
    if (!parsed.success) return "The server's answer carried no repository."
    const repo = parsed.data
    await loadRepos()
    upsert({
      id: repoCardId(repo.id),
      kind: "repo",
      title: repo.name,
      status: "acted",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { repo }
    })
    if (repo.smithers.detected) void loadTargets(repo)
  }

  const runTarget: TargetsController["runTarget"] = async (repoId, label) => {
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}/api/targets/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId, label })
      })
    } catch (error) {
      return `Could not run ${label}: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!response.ok) return await ctx.errorMessageOf(response, `Could not run ${label}`)
    const parsed = TargetRunResponseSchema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) return "The server's answer carried no run id."
    const { runId } = parsed.data
    const id = targetRunCardId(runId)
    upsert({
      id,
      kind: "target-run",
      title: label,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { runId, repoId, label, status: "running", exitCode: null, output: "" }
    })
    onRunStarted?.(repoId, runId, label)
    const append = (card: Extract<Card, { kind: "target-run" }>, data: string): string => {
      const joined = card.payload.output + data
      return joined.length > MAX_OUTPUT_CHARS ? joined.slice(joined.length - MAX_OUTPUT_CHARS) : joined
    }
    const detach = runs.attach(runId, (frame: TargetRunFrame) => {
      if (frame.type === "stdout" || frame.type === "stderr") {
        patch(id, "target-run", (card) => ({ payload: { ...card.payload, output: append(card, frame.data) } }))
        return
      }
      if (frame.type === "error") {
        patch(id, "target-run", (card) => ({
          payload: { ...card.payload, status: "failed", output: append(card, `error: ${frame.message}\n`) },
          status: "error"
        }))
        return
      }
      /* The structured graph frames (started/node/summary) are the targetGraph controller's, not this card's. */
      if (frame.type !== "exit") return
      const failed = frame.code !== 0
      patch(id, "target-run", (card) => ({
        payload: { ...card.payload, status: failed ? "failed" : "done", exitCode: frame.code },
        status: failed ? "error" : "acted"
      }))
      detach()
    })
  }

  const openTarget: TargetsController["openTarget"] = (repoId, label) => {
    const id = targetsCardId(repoId)
    const card = store.collections.cards.get(id)
    if (card === undefined || card.kind !== "targets") return `There is no targets card for repository ${repoId}.`
    if (!card.payload.targets.some((target) => target.label === label)) return `${label} is not a target of ${card.payload.repoName}.`
    patch(id, "targets", (current) => ({ payload: { ...current.payload, highlighted: label } }))
    if (typeof document !== "undefined" && typeof CSS !== "undefined") {
      document.querySelector(`[data-target-row="${CSS.escape(label)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }

  /*
   * The bridge (docs/LOCAL-APP.md "HTML bridge"): a frame's postMessage is
   * matched to its card through the frame element that sent it, so a panel
   * can only ever act on the repository its own card belongs to.
   */
  const installBridge: TargetsController["installBridge"] = (target) => {
    const onMessage = (event: MessageEvent): void => {
      const message = parseBridgeMessage(event.data)
      if (message === undefined || typeof document === "undefined") return
      const frames = document.querySelectorAll<HTMLIFrameElement>(`iframe[${HTML_CARD_FRAME_ATTRIBUTE}]`)
      const frame = [...frames].find((candidate) => candidate.contentWindow === event.source)
      const cardId = frame?.getAttribute(HTML_CARD_FRAME_ATTRIBUTE)
      if (cardId === undefined || cardId === null) return
      const card = store.collections.cards.get(cardId)
      if (card === undefined || card.kind !== "html") return
      const name = message.action === "run" ? "target.run" : "target.open"
      void ctx.commands.run(name, `${card.payload.repoId} ${message.label}`).then((outcome) => surfaceCommandFailure(name, outcome))
    }
    target.addEventListener("message", onMessage as EventListener)
    return () => target.removeEventListener("message", onMessage as EventListener)
  }

  return { openRepo, runTarget, openTarget, installBridge }
}
