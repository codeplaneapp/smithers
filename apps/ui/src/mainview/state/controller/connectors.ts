import {
  REPO_CANDIDATES_PATH,
  WATCHED_REPOS_PATH
} from "smithers-shared/AgentApiRoutes"
import type { RepositoryAccess } from "smithers-shared/NativeRepository"
import type { Card } from "../AppState"
import { REPO_CHOOSER_CARD_ID } from "../AppStore"
import type { ControllerContext } from "./context"

export interface ConnectorController {
  readonly openRepoChooser: (preselect?: string) => Promise<string | void>
  readonly toggleWatchedRepo: (fullName: string) => string | void
  readonly selectAllWatchedRepos: () => void
  readonly selectNoWatchedRepos: () => void
  readonly confirmWatchedRepos: () => Promise<string | void>
  readonly openFirstRunRepos: () => Promise<void>
  readonly connectLocalRepository: (access: RepositoryAccess) => Promise<void>
  readonly makeConnectorReadOnly: (id: string) => void
  readonly askConnectorRemoval: (id: string) => string | void
  readonly cancelConnectorRemoval: () => void
  readonly removeConnector: (id: string) => string | void
}

export const createConnectorController = (
  ctx: ControllerContext,
  promptSignIn: () => void
): ConnectorController => {
  const { store, repositories, baseUrl } = ctx
  const http = ctx.boundedFetch
  const errorMessageOf = ctx.errorMessageOf
  const withToast = ctx.withToast
  const resumeDeferredCommand = (): void => ctx.resumeDeferredCommand()

  /*
   * The watched-repos seam (Wave 10): the identity worker owns the session,
   * the GitHub token vault, the chooser's candidate list, and the durable
   * selection. Beat 5 is the selection read: a never-chosen login gets the
   * repo chooser as the one onboarding question; an existing selection just
   * mirrors locally and the chat opens clean.
   */
  interface RepoCandidate {
    readonly fullName: string
    readonly private: boolean
    readonly pushedAt: string | null
    readonly openIssues: number
  }

  /** The reco seam's candidate rows, validated; anything off-shape is dropped. */
  const parseRepoCandidates = (wire: unknown): RepoCandidate[] =>
    (Array.isArray(wire) ? wire : [])
      .filter(
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          typeof (candidate as { fullName?: unknown }).fullName === "string"
      )
      .map((candidate) => {
        const row = candidate as {
          fullName: string
          private?: unknown
          pushedAt?: unknown
          openIssues?: unknown
        }
        return {
          fullName: row.fullName,
          private: row.private === true,
          pushedAt: typeof row.pushedAt === "string" ? row.pushedAt : null,
          openIssues: typeof row.openIssues === "number" ? row.openIssues : 0
        }
      })

  /** Mirror the seam's selection locally, keeping provenance the row already holds. */
  const mirrorWatched = (selected: ReadonlyArray<string>): void => {
    const existing = store.collections.watchedRepos.get("watched")
    if (
      existing !== undefined &&
      existing.selected !== null &&
      existing.selected.length === selected.length &&
      existing.selected.every((name, index) => name === selected[index])
    ) {
      return
    }
    store.dispatch({
      type: "watched.replaced",
      actor: "system",
      selected: [...selected],
      selectedAt: existing?.selectedAt ?? null,
      via: existing?.via ?? null
    })
  }

  /** The chooser card, when one is in the transcript. */
  const chooserCard = (): Extract<Card, { kind: "repo-chooser" }> | undefined => {
    const card = store.collections.cards.get(REPO_CHOOSER_CARD_ID)
    return card?.kind === "repo-chooser" ? card : undefined
  }

  const patchChooser = (
    patch: Partial<Extract<Card, { kind: "repo-chooser" }>["payload"]>,
    status?: Card["status"]
  ): void => {
    const card = chooserCard()
    if (card === undefined) return
    store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, ...patch }, ...(status === undefined ? {} : { status }) }
    })
  }

  /*
   * Open the repo chooser — the one onboarding question, and the "just ask"
   * path later. Candidates come from the selection read when one exists
   * (pre-filled), else from GET /api/identity/repos; the agent's optional repo
   * argument pre-selects on top. The card is embedded in the transcript for
   * every actor — a chooser is never a takeover.
   */
  const openRepoChooserImpl = async (preselect?: string): Promise<true | string> => {
    /*
     * The chooser lists the USER'S repositories: without a signed-in
     * session it can only open empty (the live bug: an empty "No
     * repositories match" chooser while signed out). The sign-in step
     * renders instead — promptSignIn answers every identity state
     * honestly, including a build with no identity seam at all.
     */
    const chooserIdentity = store.collections.identitySessions.get("identity")
    if (chooserIdentity?.state !== "signed-in") {
      promptSignIn()
      return "GitHub isn't connected yet — the chooser lists your repositories, so the sign-in step comes first."
    }
    const via = ctx.commandActor === "smithers" ? "agent" : "command"
    let candidates: RepoCandidate[] | undefined
    let selected: string[] = []
    try {
      const watchedResponse = await http(`${baseUrl}${WATCHED_REPOS_PATH}`)
      if (watchedResponse.ok) {
        const watchedBody = (await watchedResponse.json().catch(() => undefined)) as
          | { selected?: unknown }
          | undefined
        if (Array.isArray(watchedBody?.selected)) {
          selected = watchedBody.selected.filter((name): name is string => typeof name === "string")
        }
      } else {
        await watchedResponse.body?.cancel()
      }
      const reposResponse = await http(`${baseUrl}${REPO_CANDIDATES_PATH}`)
      if (reposResponse.ok) {
        const reposBody = (await reposResponse.json().catch(() => undefined)) as
          | { candidates?: unknown }
          | undefined
        candidates = parseRepoCandidates(reposBody?.candidates)
      } else {
        await reposResponse.body?.cancel()
      }
    } catch {
      return "The repositories service didn't answer — the chooser couldn't open. Try again."
    }
    if (candidates === undefined) {
      return "The repositories service didn't answer — the chooser couldn't open. Try again."
    }
    // A pre-selected name the candidates list doesn't know is stated, not
    // silently dropped — and the chooser still opens with what IS visible.
    const preselectKnown = preselect === undefined || candidates.some((candidate) => candidate.fullName === preselect)
    const mergedSelection = preselect === undefined || !preselectKnown || selected.includes(preselect)
      ? selected
      : [...selected, preselect]
    const existing = chooserCard()
    let highest = -1
    for (const message of store.collections.messages.values()) highest = Math.max(highest, message.ordinal)
    for (const card of store.collections.cards.values()) highest = Math.max(highest, card.ordinal)
    const card: Card = {
      id: REPO_CHOOSER_CARD_ID,
      kind: "repo-chooser",
      title: "Choose the repositories Smithers watches",
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: highest + 1,
      payload: { candidates, selected: mergedSelection, via, phase: "choosing" }
    }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    if (!preselectKnown && preselect !== undefined) {
      return `I couldn't find ${preselect} among your repositories — the chooser is open with the ones I can see.`
    }
    return true
  }

  const openRepoChooser = (preselect?: string): Promise<string | void> =>
    withToast(
      "repos.chooser",
      "Reading your repositories…",
      "Your repositories are ready to choose",
      () => openRepoChooserImpl(preselect)
    ).then((outcome) => (outcome === true ? undefined : outcome))

  /*
   * A.12: the toggle used to add ANY name to the selection, so
   * `/repos.watch.toggle no-such/repo` silently put a repository the account
   * does not have into the set the confirm would persist. The chooser's own
   * rows are the universe — the sibling `/repos.watch <repo>` already refuses
   * by name, and this now answers the same way.
   */
  const toggleWatchedRepo = (fullName: string): string | void => {
    const card = chooserCard()
    if (card === undefined) return "The repository chooser isn't open — run /repos.watch first."
    if (card.payload.phase === "saving") return
    const known = card.payload.candidates.some((repo) => repo.fullName === fullName)
    if (!known) {
      return `I couldn't find ${fullName} among your repositories — the chooser is open with the ones I can see.`
    }
    const selected = card.payload.selected.includes(fullName)
      ? card.payload.selected.filter((name) => name !== fullName)
      : [...card.payload.selected, fullName]
    patchChooser({ selected, phase: "choosing" })
  }

  const selectAllWatchedRepos = (): void => {
    const card = chooserCard()
    if (card === undefined || card.payload.phase === "saving") return
    patchChooser({ selected: card.payload.candidates.map((candidate) => candidate.fullName), phase: "choosing" })
  }

  const selectNoWatchedRepos = (): void => {
    const card = chooserCard()
    if (card === undefined || card.payload.phase === "saving") return
    patchChooser({ selected: [], phase: "choosing" })
  }

  /*
   * Confirm → PUT /api/identity/watched with the chooser's via → one calm
   * line naming what is watched AND that asking changes it.
   */
  const confirmWatchedReposImpl = async (): Promise<true | string> => {
    const card = chooserCard()
    if (card === undefined) return "There is no repository chooser open."
    if (card.payload.phase === "saving") return true
    const { selected, via } = card.payload
    patchChooser({ phase: "saving" })
    let echoed: { selected?: unknown; selectedAt?: unknown; via?: unknown } | undefined
    try {
      const response = await http(`${baseUrl}${WATCHED_REPOS_PATH}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selected, via })
      })
      if (!response.ok) {
        const message = await errorMessageOf(response, "The selection didn't save. Try again.")
        patchChooser({ phase: "failed", error: message }, "error")
        return message
      }
      echoed = (await response.json().catch(() => undefined)) as typeof echoed
    } catch {
      const message = "The selection didn't save — the repositories service is unreachable."
      patchChooser({ phase: "failed", error: message }, "error")
      return message
    }
    const saved = Array.isArray(echoed?.selected)
      ? echoed.selected.filter((name): name is string => typeof name === "string")
      : selected
    store.dispatch({
      type: "watched.replaced",
      actor: ctx.commandActor,
      selected: saved,
      selectedAt: typeof echoed?.selectedAt === "string" ? echoed.selectedAt : new Date().toISOString(),
      via: typeof echoed?.via === "string" && ["onboarding", "command", "agent"].includes(echoed.via)
        ? (echoed.via as "onboarding" | "command" | "agent")
        : via
    })
    store.dispatch({ type: "card.removed", actor: ctx.commandActor, id: card.id })
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: saved.length === 0
        ? "Watching no repositories for now. You can change this anytime — just ask."
        : `Watching ${saved.length} ${saved.length === 1 ? "repository" : "repositories"}: ${
          saved.join(", ")
        }. You can change this anytime — just ask.`
    })
    // A confirmed selection can satisfy a parked command's repos-selected
    // requirement — the command that deferred into this chooser continues.
    resumeDeferredCommand()
    return true
  }

  const confirmWatchedRepos = (): Promise<string | void> =>
    withToast("repos.watched.save", "Saving your selection…", "Selection saved", confirmWatchedReposImpl).then(
      (outcome) => (outcome === true ? undefined : outcome)
    )

  /*
   * Beat 5: entering chat signed-in reads the durable watched selection.
   * selected === null (never chosen) opens the repo chooser — the one
   * onboarding question, candidates inline. An existing selection just
   * mirrors locally; the transcript stays clean. A failed read appends no
   * message — the chat opens anyway and /repos.watch still reaches the
   * chooser — but the toast states the failure honestly.
   */
  const openFirstRunReposImpl = async (): Promise<true | string> => {
    const identity = store.collections.identitySessions.get("identity")
    const epoch = ctx.accountEpoch
    const state = identity?.state
    const login = identity?.login
    const isCurrent = (): boolean => {
      const latest = store.collections.identitySessions.get("identity")
      return ctx.accountEpoch === epoch && latest?.state === state && latest?.login === login
    }
    let response: Response
    try {
      response = await http(`${baseUrl}${WATCHED_REPOS_PATH}`)
    } catch {
      return "Your watched repositories couldn't be read right now."
    }
    if (!response.ok) {
      const message = await errorMessageOf(response, "Your watched repositories couldn't be read.")
      if (!isCurrent()) return true
      return message
    }
    const watchedBody = (await response.json().catch(() => undefined)) as { selected?: unknown } | undefined
    if (!isCurrent()) return true
    if (Array.isArray(watchedBody?.selected)) {
      mirrorWatched(watchedBody.selected.filter((name): name is string => typeof name === "string"))
      return true
    }
    // Never chosen: the onboarding question needs its candidate rows.
    let candidates: RepoCandidate[] | undefined
    try {
      const reposResponse = await http(`${baseUrl}${REPO_CANDIDATES_PATH}`)
      if (reposResponse.ok) {
        const reposBody = (await reposResponse.json().catch(() => undefined)) as
          | { candidates?: unknown }
          | undefined
        candidates = parseRepoCandidates(reposBody?.candidates)
      } else {
        await reposResponse.body?.cancel()
      }
    } catch {
      candidates = undefined
    }
    if (!isCurrent()) return true
    if (candidates === undefined) {
      store.dispatch({
        type: "message.appended",
        actor: "system",
        text: "I couldn't read your repositories just now — ask me anything and we'll start from here."
      })
      return true
    }
    store.dispatch({ type: "repos.selection.needed", actor: "system", candidates })
    return true
  }

  const openFirstRunRepos = (): Promise<void> =>
    withToast(
      "repos.first-run",
      "Reading your repositories…",
      "Your repositories are ready",
      () => openFirstRunReposImpl()
    ).then(() => undefined)
  ctx.openFirstRunRepos = openFirstRunRepos

  const connectLocalRepository = async (access: RepositoryAccess): Promise<void> => {
    const operation = store.collections.connectorOperations.get("connector-operation")
    if (operation?.phase !== "idle") return
    store.dispatch({ type: "connector.local.requested", actor: "user", access })
    try {
      const result = await repositories.pickLocalRepository(access)
      switch (result.status) {
        case "connected":
          store.dispatch({
            type: "connector.local.connected",
            actor: "system",
            access,
            repository: result.repository
          })
          break
        case "cancelled":
          store.dispatch({ type: "connector.local.cancelled", actor: "user" })
          break
        case "error":
          store.dispatch({
            type: "connector.local.failed",
            actor: "system",
            message: result.message
          })
          break
      }
    } catch {
      store.dispatch({
        type: "connector.local.failed",
        actor: "system",
        message: "The native repository picker stopped responding. Try again."
      })
    }
  }

  const makeConnectorReadOnly = (id: string): void => {
    store.dispatch({
      type: "connector.access.changed",
      actor: "user",
      id,
      access: "read"
    })
  }

  const askConnectorRemoval = (id: string): string | void => {
    if (store.collections.connectors.get(id) === undefined) return `There is no connector with id ${id}.`
    store.dispatch({ type: "connector.removal.asked", actor: "user", id })
  }

  const cancelConnectorRemoval = (): void => {
    if (store.session().pendingConnectorRemovalId === null) return
    store.dispatch({ type: "connector.removal.asked", actor: "user", id: null })
  }

  const removeConnector = (id: string): string | void => {
    if (store.session().pendingConnectorRemovalId !== id) return "Ask before disconnecting this repository."
    store.dispatch({ type: "connector.removed", actor: "user", id })
  }

  return {
    openRepoChooser,
    toggleWatchedRepo,
    selectAllWatchedRepos,
    selectNoWatchedRepos,
    confirmWatchedRepos,
    openFirstRunRepos,
    connectLocalRepository,
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector
  }
}
