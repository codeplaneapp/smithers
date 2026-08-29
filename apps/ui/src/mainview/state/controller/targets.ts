import type { Repo, TargetRunFrame } from "smithers-shared/LocalApp"
import { RepoSchema, TargetRunResponseSchema, TargetsQueryResponseSchema } from "smithers-shared/LocalApp"
import { defaultTargetsMessage } from "smithers-shared/TargetPresentation"
import type { Card } from "../AppState"
import type { TargetRunClient } from "../TargetRunClient"
import type { ControllerContext } from "./context"

/*
 * Lane L3 (docs/LOCAL-APP.md "Auto-load flow"): opening a repository through
 * the local origin and loading its Smithers targets into a trusted typed card.
 * The card owns its Run buttons; model output never supplies executable UI.
 * Every store change goes through the dispatcher with its actor.
 */

export interface TargetsController {
  /** `POST /api/repo/open`, then the repo card and the auto-load flow. */
  readonly openRepo: (request: RepositoryOpenRequest) => Promise<string | void>
  /** `POST /api/targets/run`, then a target-run card fed from the run topic. */
  readonly runTarget: (repoId: string, workspace: string, label: string) => Promise<string | void>
  /** Highlight (and scroll to) the target's row in its targets card. */
  readonly openTarget: (repoId: string, label: string) => string | void
}

export type RepositoryOpenRequest =
  | { readonly authorizationId: string; readonly displayName: string }
  | { readonly path: string }

export interface TargetsControllerDependencies {
  readonly nextOrdinal: () => number
  readonly loadRepos: () => Promise<void>
  readonly runs: TargetRunClient
  /** A run's start, announced so a graph card of the same repo can overlay it (controller/targetGraph.ts). */
  readonly onRunStarted?: (repoId: string, runId: string, label: string) => void
}

export const repoCardId = (repoId: string): string => `repo-${repoId}`
export const targetsCardId = (repoId: string): string => `targets-${repoId}`
export const repoPluginCardId = (repoId: string): string => `repo-plugin-${repoId}`
export const targetRunCardId = (runId: string): string => `target-run-${runId}`

/** The transcript can hold the whole run; past this the card keeps the tail. */
const MAX_OUTPUT_CHARS = 200_000

export const createTargetsController = (
  ctx: ControllerContext,
  dependencies: TargetsControllerDependencies
): TargetsController => {
  const { store, baseUrl } = ctx
  const { nextOrdinal, loadRepos, runs, onRunStarted } = dependencies

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

  const loadTargets = async (repo: Repo): Promise<void> => {
    /* A valid repository plugin leads as trusted data, ahead of the target snapshot. */
    if (repo.plugin !== undefined) {
      upsert({
        id: repoPluginCardId(repo.id),
        kind: "repo-plugin",
        title: repo.plugin.title,
        status: "acted",
        createdAt: Date.now(),
        ordinal: nextOrdinal(),
        payload: { repoId: repo.id, manifest: repo.plugin }
      })
    }
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

    store.dispatch({ type: "message.appended", actor: "system", text: defaultTargetsMessage(targets.length, repo.name) })
  }

  const openRepo: TargetsController["openRepo"] = async (request) => {
    const label = "path" in request ? request.path : request.displayName
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}/api/repo/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify("path" in request
          ? { path: request.path }
          : { authorizationId: request.authorizationId })
      })
    } catch (error) {
      return `Could not open ${label}: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!response.ok) return await ctx.errorMessageOf(response, `Could not open ${label}`)
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

  const runTarget: TargetsController["runTarget"] = async (repoId, workspace, label) => {
    const targets = store.collections.cards.get(targetsCardId(repoId))
    const target = targets?.kind === "targets"
      ? targets.payload.targets.find(
        (candidate) => candidate.workspace === workspace && candidate.label === label
      )
      : undefined
    if (target?.id === undefined) return `Could not run ${label}: reload repository targets first.`

    /*
     * The server revalidates the opaque target grant against the live graph
     * before it starts a process. That can take several seconds on a large
     * checkout, so represent the request immediately instead of making the
     * button appear inert. This card keeps its stable UI id when the server's
     * run id arrives; only the payload becomes authoritative.
     */
    const id = targetRunCardId(`pending-${crypto.randomUUID()}`)
    upsert({
      id,
      kind: "target-run",
      title: label,
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: {
        runId: "",
        repoId,
        label,
        status: "running",
        exitCode: null,
        output: "Validating the target against the current repository…\n"
      }
    })
    const failStart = (message: string): string => {
      patch(id, "target-run", (card) => ({
        payload: { ...card.payload, status: "failed", output: `error: ${message}\n` },
        status: "error"
      }))
      return message
    }
    let response: Response
    try {
      response = await ctx.boundedFetch(`${baseUrl}/api/targets/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId, targetId: target.id })
      })
    } catch (error) {
      return failStart(`Could not run ${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) return failStart(await ctx.errorMessageOf(response, `Could not run ${label}`))
    const parsed = TargetRunResponseSchema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) return failStart("The server's answer carried no run id.")
    const { runId } = parsed.data
    patch(id, "target-run", (card) => ({
      payload: { ...card.payload, runId, output: "" },
      status: "active"
    }))
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

  return { openRepo, runTarget, openTarget }
}
