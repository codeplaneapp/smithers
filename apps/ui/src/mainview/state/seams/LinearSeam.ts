/*
 * The Linear seam (lane sync, ADR 0005), behind the `/api/cloud/*` proxy:
 *
 *   GET    /api/linear                    — the user's integrations (per team, last sync)
 *   GET    /api/linear/setup/{setupKey}   — the OAuth setup: teams[] + expires_at (plue#469)
 *   POST   /api/linear                    — create the integration { setup_key, linear_team_id, repo }
 *   POST   /api/linear/{id}/sync          — start a sync (202 sync_started / 409 sync_already_running)
 *   DELETE /api/linear/{id}               — disconnect (204)
 *
 * The OAuth handoff opens GET /api/auth/linear through the native
 * `openExternal` door; the local origin receives the callback (the Bun
 * server's `/api/linear-auth/*` receiver, LINEAR_AUTH_* in LocalApp.ts) and
 * the seam polls it for the setup key. The settled flow (plue#469) is
 * handoff → GET setup → pick → create; the card is the wizard.
 *
 * What does NOT exist and is never faked: the ops feed, the per-op retry,
 * and the sync runs (plue#468) — the sync-ops card renders the ADR's
 * degraded wording and `sync.retry` refuses with it, and no `/ops` or
 * `/sync/{runId}` route is ever called. Every act gates on the cloud
 * session; writes carry the legacy token's write:repository, so a degraded
 * sign-in is not refused here (the server's own scope check answers).
 */
import {
  CLOUD_ROUTE_PREFIX,
  LINEAR_AUTH_SESSION_PATH,
  LINEAR_AUTH_START_PATH,
  LinearAuthSessionSchema,
  LinearAuthStartResponseSchema
} from "smithers-shared/LocalApp"
import type { Card, LinearIntegrationInput, LinearIntegrationRow } from "../AppState"
import { linearIntegrationRepo } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readErrorMessage } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

export const SIGN_OUT_REFUSAL = "Sign in to Smithers Cloud first — /cloud.sign-in."

/** The degraded wordings for the routes that do not exist (ADR 0005 "Filed"). */
export const NO_OPS_FEED_NOTE =
  "The sync ops feed isn't recorded yet (plue#468) — each sync's ops appear here once the backend records them."
export const NO_OP_RETRY_REFUSAL =
  "Retrying one sync op doesn't exist yet (plue#468) — /linear.sync runs the whole sync again."
export const NO_TEAM_PICK_NOTE =
  "The team pick isn't available yet (plue#469) — the setup lookup has no route, so the teams this key can see aren't listed."
export const SETUP_EXPIRED_NOTE = "authorization expired · Open Linear again"
const HANDOFF_TIMEOUT_NOTE =
  "The Linear authorization didn't come back to the app — the browser step was closed or timed out. Open Linear retries it."

export interface LinearSeamDeps {
  /** The native system-browser door; absent in a plain browser (window.open falls back). */
  readonly openExternal?: (url: string) => Promise<boolean>
  /** The handoff poll cadence while the authorization is out in the browser; tests shorten it. */
  readonly pollMs?: number
  /** The whole handoff wait; production matches the Bun side's five-minute listener. */
  readonly timeoutMs?: number
}

export interface LinearSeam {
  /** `linear.connect [repo]`: upsert the connector-setup wizard card for the repository. */
  readonly connect: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** Hidden, card-scoped: step 1's Open Linear — the handoff, then the setup lookup. */
  readonly openLinear: (repo?: string) => Promise<string | void>
  /** Hidden, card-scoped: step 2's one-click team pick. */
  readonly pickTeam: (teamId: string, repo?: string) => Promise<string | void>
  /** Hidden, card-scoped: step 3's repository pick (the tree from ADR 0001). */
  readonly pickRepository: (cardRepo: string, repo: string) => Promise<string | void>
  /** `linear.connect.confirm [repo]`: post the integration and turn the card connected. */
  readonly confirmConnect: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** The integrations list load (boot and after every mutation); only definitive answers dispatch. */
  readonly refreshIntegrations: () => Promise<void>
  /** `linear.sync [integration]`: start a sync and render the sync-ops card. */
  readonly syncNow: (integration?: string) => Promise<string | void | { readonly value: string }>
  /** `linear.activity [integration]`: the last 24 hours' ops card (the feed is plue#468 — degraded). */
  readonly activity: (integration?: string) => Promise<string | void | { readonly value: string }>
  /**
   * `linear.disconnect <integration> <teamKey>`: delete the integration; the
   * connected card leaves the transcript. The team key typed back is the
   * confirm — a slash, an agent's confirmed invocation, and the card's second
   * click all carry it, and only the integration's own key disconnects.
   */
  readonly disconnect: (integration: string, confirmKey?: string) => Promise<string | void | { readonly value: string }>
  /** `sync.retry <opId>`: refuses honestly until plue#468 records ops. */
  readonly retryOp: (opId: string) => Promise<string | void>
  /** Hidden, card-scoped: the sync-ops card's Show more — widens the ops window. */
  readonly showMoreOps: (cardId: string) => Promise<string | void>
}

type Step = { readonly id: string; readonly label: string; readonly state: "pending" | "active" | "done" | "error"; readonly detail: string | null; readonly error?: string }
type SetupPayload = Extract<Card, { kind: "connector-setup" }>["payload"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const LINEAR_STEP_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["authorize", "Authorize in your browser"],
  ["team", "Team"],
  ["repository", "Repository"],
  ["confirm", "Confirm"]
]

const freshSteps = (repo: string): Array<Step> =>
  LINEAR_STEP_LABELS.map(([id, label], index) => ({
    id,
    label,
    state: index === 0 ? "active" : "pending",
    detail: id === "repository" ? repo : null
  }))

/** The steps with one step's patch applied (state, detail, error). */
const patchStep = (steps: ReadonlyArray<Step>, id: string, patch: Partial<Step>): Array<Step> =>
  steps.map((step) => (step.id === id ? { ...step, ...patch } : step))

const cardIdOf = (repo: string): string => `connector-setup-linear-${repo}`
const syncCardIdOf = (integrationId: string): string => `sync-ops-linear-${integrationId}`

/** One integration row off the wire (GET /api/linear); malformed rows drop. */
const parseIntegration = (value: unknown): LinearIntegrationInput | null => {
  if (!isRecord(value)) return null
  const id = intOrNull(value.id)
  if (id === null) return null
  return {
    id: String(id),
    teamId: str(value.linear_team_id) ?? "",
    teamName: str(value.linear_team_name) ?? "",
    teamKey: str(value.linear_team_key) ?? "",
    repoOwner: str(value.repo_owner) ?? "",
    repoName: str(value.repo_name) ?? "",
    active: value.is_active === true,
    remediation: str(value.remediation_state),
    lastSyncAt: str(value.last_sync_at),
    createdAt: str(value.created_at)
  }
}

interface SetupAnswer {
  readonly teams: ReadonlyArray<{ readonly id: string; readonly name: string; readonly key: string }>
  readonly expiresAt: string | null
  readonly actor: string | null
}

/** The setup lookup's answer (plue#469): teams + expires_at; the viewer only when the wire names them. */
const parseSetup = (value: unknown): SetupAnswer | null => {
  if (!isRecord(value)) return null
  if (!Array.isArray(value.teams)) return null
  const teams = value.teams.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const id = str(entry.id)
    const name = str(entry.name)
    const key = str(entry.key)
    return id === null || name === null || key === null ? [] : [{ id, name, key }]
  })
  const viewer = isRecord(value.viewer) ? str(value.viewer.name) : null
  return { teams, expiresAt: str(value.expires_at), actor: viewer }
}

export const createLinearSeam = (ctx: SeamContext, deps: LinearSeamDeps = {}): LinearSeam => {
  const pollMs = deps.pollMs ?? 2000
  const timeoutMs = deps.timeoutMs ?? 5 * 60 * 1000
  const cloud = (path: string): string => `${ctx.baseUrl}${CLOUD_ROUTE_PREFIX}api${path}`

  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return SIGN_OUT_REFUSAL
  }

  const getJson = async (path: string): Promise<{ readonly body: unknown } | { readonly error: string }> => {
    let response: Response
    try {
      response = await ctx.http(cloud(path))
    } catch (error) {
      return { error: `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!response.ok) return { error: await readErrorMessage(response, `Reading ${path} failed (${response.status})`) }
    return { body: await response.json().catch(() => null) }
  }

  const sendJson = async (
    method: "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>
  ): Promise<{ readonly body: unknown; readonly status: number } | { readonly error: string; readonly status: number }> => {
    let response: Response
    try {
      response = await ctx.http(cloud(path), {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      })
    } catch (error) {
      return { error: `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}`, status: 0 }
    }
    if (!response.ok) {
      return { error: await readErrorMessage(response, `The ${method} to ${path} failed (${response.status})`), status: response.status }
    }
    return { body: await response.json().catch(() => null), status: response.status }
  }

  /* ---- the card ---- */

  /*
   * The wizard card an act addresses. The id is keyed on the repository the
   * wizard was OPENED on and stays put for the card's life (the SAME card
   * turns connected), while step 3 may point `payload.repo` at another
   * repository — so the card's own buttons arrive carrying the picked repo.
   * A card under that id answers first; otherwise the card whose payload
   * names the repo does. Keying the lookup on the payload's repo alone made
   * Connect fail for every pick but the default.
   */
  const findCard = (repo: string): { readonly id: string; readonly payload: SetupPayload } | undefined => {
    const direct = ctx.store.collections.cards.get(cardIdOf(repo))
    if (direct?.kind === "connector-setup" && direct.payload.connector === "linear") {
      return { id: direct.id, payload: direct.payload }
    }
    for (const card of ctx.store.collections.cards.values()) {
      if (card.kind === "connector-setup" && card.payload.connector === "linear" && card.payload.repo === repo) {
        return { id: card.id, payload: card.payload }
      }
    }
    return undefined
  }

  const upsertCard = (id: string, repo: string, patch: Partial<SetupPayload>): void => {
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "connector-setup" && existing.payload.connector === "linear" ? existing.payload : undefined
    const payload: SetupPayload = {
      connector: "linear",
      repo,
      phase: patch.phase ?? prior?.phase ?? "setup",
      steps: (patch.steps ?? prior?.steps ?? freshSteps(repo)).map((step) => ({ ...step })),
      ...(patch.setupKey !== undefined ? { setupKey: patch.setupKey } : prior?.setupKey !== undefined ? { setupKey: prior.setupKey } : {}),
      ...(patch.setupExpiresAt !== undefined ? { setupExpiresAt: patch.setupExpiresAt } : prior?.setupExpiresAt !== undefined ? { setupExpiresAt: prior.setupExpiresAt } : {}),
      ...(patch.actor !== undefined ? { actor: patch.actor } : prior?.actor !== undefined ? { actor: prior.actor } : {}),
      ...(patch.teams !== undefined ? { teams: patch.teams.map((team) => ({ ...team })) } : prior?.teams !== undefined ? { teams: prior.teams.map((team) => ({ ...team })) } : {}),
      ...(patch.teamId !== undefined ? { teamId: patch.teamId } : prior?.teamId !== undefined ? { teamId: prior.teamId } : {}),
      ...(patch.integration !== undefined ? { integration: patch.integration } : prior?.integration !== undefined ? { integration: prior.integration } : {}),
      ...(patch.rateLimit !== undefined ? { rateLimit: patch.rateLimit } : prior?.rateLimit !== undefined ? { rateLimit: prior.rateLimit } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {})
    }
    const connected = payload.phase === "connected" && payload.integration !== undefined
    const card: Card = {
      id,
      kind: "connector-setup",
      title: connected
        ? `Linear · ${payload.integration!.teamKey} → ${repo}`
        : `Connect Linear · ${repo}`,
      status: payload.error !== undefined ? "error" : connected ? "acted" : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /* ---- the integrations list ---- */

  const refreshIntegrations = async (): Promise<void> => {
    const answer = await getJson("/linear")
    if ("error" in answer || !Array.isArray(answer.body)) return
    ctx.dispatch({
      type: "linear.integrations.loaded",
      actor: "system",
      integrations: answer.body.flatMap((entry) => {
        const parsed = parseIntegration(entry)
        return parsed === null ? [] : [parsed]
      })
    })
  }

  /*
   * The integration an act routes through: the explicit id or team key, else
   * the single loaded integration, else an honest answer naming what exists.
   * The list is re-read first so a stale collection never refuses wrongly.
   */
  const resolveIntegration = async (
    token: string | undefined
  ): Promise<{ readonly integration: LinearIntegrationRow } | { readonly error: string }> => {
    await refreshIntegrations()
    const rows = [...ctx.store.collections.linearIntegrations.values()]
    const named = token?.trim() ?? ""
    if (named !== "") {
      const found = rows.find((row) => row.id === named) ??
        rows.find((row) => row.teamKey.toLowerCase() === named.toLowerCase())
      if (found !== undefined) return { integration: found }
      return {
        error: rows.length === 0
          ? `No Linear integration named ${named} — none are connected. /linear.connect opens the card.`
          : `No Linear integration named ${named} — connected: ${rows.map((row) => `${row.teamKey} → ${linearIntegrationRepo(row)}`).join(", ")}.`
      }
    }
    if (rows.length === 1) return { integration: rows[0]! }
    if (rows.length === 0) return { error: "No Linear integration is connected — /linear.connect opens the card." }
    return {
      error: `linear.sync names an integration: ${rows.map((row) => `${row.teamKey} (${row.id}) → ${linearIntegrationRepo(row)}`).join(", ")}.`
    }
  }

  /** The sync-ops card both sync acts render; the ops feed is plue#468 — degraded, never faked. */
  const renderSyncCard = (
    integration: LinearIntegrationRow,
    overrides: { readonly trigger?: string | null; readonly window?: string; readonly error?: string }
  ): void => {
    const id = syncCardIdOf(integration.id)
    const existing = ctx.store.collections.cards.get(id)
    const repo = linearIntegrationRepo(integration)
    const card: Card = {
      id,
      kind: "sync-ops",
      title: `Sync · Linear ${integration.teamKey} ↔ ${repo}`,
      status: overrides.error !== undefined ? "error" : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload: {
        subject: `Linear ${integration.teamKey} ↔ ${repo}`,
        source: "linear",
        integrationId: integration.id,
        repo,
        runState: null,
        ops: [],
        opsNote: NO_OPS_FEED_NOTE,
        ...(overrides.trigger !== undefined ? { trigger: overrides.trigger } : {}),
        ...(overrides.window !== undefined ? { window: overrides.window } : {}),
        ...(overrides.error !== undefined ? { error: overrides.error } : {})
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /* ---- the acts ---- */

  const connect: LinearSeam["connect"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    upsertCard(cardIdOf(target.repo), target.repo, { phase: "setup", steps: freshSteps(target.repo) })
    return { value: `Connect Linear on ${target.repo} — the card walks the handoff.` }
  }

  const openLinear: LinearSeam["openLinear"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const repoId = target.repo
    const found = findCard(repoId)
    if (found === undefined) return `No Linear connect card for ${repoId} — /linear.connect opens it.`
    const { id } = found
    const prior = found.payload
    const readCard = (): SetupPayload | undefined => {
      const current = ctx.store.collections.cards.get(id)
      return current?.kind === "connector-setup" ? current.payload : undefined
    }
    /* The handoff: the local origin listens for the setup key. */
    let response: Response
    try {
      response = await ctx.http(`${ctx.baseUrl}${LINEAR_AUTH_START_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    } catch (error) {
      const message = `Could not reach the local app to start the Linear authorization: ${error instanceof Error ? error.message : String(error)}`
      upsertCard(id, repoId, { steps: patchStep(prior.steps, "authorize", { state: "error", error: message }) })
      return message
    }
    if (!response.ok) {
      const message = await readErrorMessage(response, `The Linear authorization couldn't start (${response.status}).`)
      upsertCard(id, repoId, { steps: patchStep(prior.steps, "authorize", { state: "error", error: message }) })
      return message
    }
    const started = LinearAuthStartResponseSchema.safeParse(await response.json().catch(() => null))
    if (!started.success) {
      const message = "The local app answered the Linear authorization with an unreadable payload."
      upsertCard(id, repoId, { steps: patchStep(prior.steps, "authorize", { state: "error", error: message }) })
      return message
    }
    if (deps.openExternal !== undefined) void deps.openExternal(started.data.url)
    else if (typeof window !== "undefined") window.open(started.data.url, "_blank", "noopener")
    /* Poll the local receiver for the setup key. */
    const deadline = Date.now() + timeoutMs
    let setupKey: string | null = null
    for (;;) {
      await wait(pollMs)
      try {
        const sessionResponse = await ctx.http(`${ctx.baseUrl}${LINEAR_AUTH_SESSION_PATH}`)
        if (sessionResponse.ok) {
          const session = LinearAuthSessionSchema.safeParse(await sessionResponse.json().catch(() => null))
          if (session.success && session.data.state === "authorized" && session.data.setupKey !== undefined) {
            setupKey = session.data.setupKey
            break
          }
        }
      } catch {
        // A dropped poll is retried until the deadline; the listener is still up.
      }
      if (Date.now() > deadline) break
    }
    if (setupKey === null) {
      const current = readCard() ?? prior
      upsertCard(id, repoId, { steps: patchStep(current.steps, "authorize", { state: "error", error: HANDOFF_TIMEOUT_NOTE }) })
      return HANDOFF_TIMEOUT_NOTE
    }
    /* The setup lookup: the teams the key can see (plue#469). */
    const answer = await getJson(`/linear/setup/${encodeURIComponent(setupKey)}`)
    if ("error" in answer) {
      const current = readCard() ?? prior
      const expired = /setup/i.test(answer.error) && /(expired|not found)/i.test(answer.error)
      if (expired) {
        upsertCard(id, repoId, { steps: patchStep(current.steps, "authorize", { state: "error", error: SETUP_EXPIRED_NOTE }) })
        return SETUP_EXPIRED_NOTE
      }
      const routeMissing = /\(404\)$/.test(answer.error)
      upsertCard(id, repoId, {
        setupKey,
        steps: routeMissing
          ? patchStep(patchStep(current.steps, "authorize", { state: "done", detail: "authorized" }), "team", { state: "error", error: NO_TEAM_PICK_NOTE })
          : patchStep(current.steps, "authorize", { state: "error", error: answer.error })
      })
      return routeMissing ? NO_TEAM_PICK_NOTE : answer.error
    }
    const setup = parseSetup(answer.body)
    if (setup === null) {
      const current = readCard() ?? prior
      const message = "Smithers Cloud's answer for the Linear setup was malformed."
      upsertCard(id, repoId, { steps: patchStep(current.steps, "authorize", { state: "error", error: message }) })
      return message
    }
    if (setup.expiresAt !== null && Date.parse(setup.expiresAt) <= Date.now()) {
      const current = readCard() ?? prior
      upsertCard(id, repoId, { steps: patchStep(current.steps, "authorize", { state: "error", error: SETUP_EXPIRED_NOTE }) })
      return SETUP_EXPIRED_NOTE
    }
    const current = readCard() ?? prior
    upsertCard(id, repoId, {
      setupKey,
      ...(setup.expiresAt !== null ? { setupExpiresAt: setup.expiresAt } : {}),
      actor: setup.actor,
      teams: [...setup.teams],
      steps: patchStep(
        patchStep(current.steps, "authorize", { state: "done", detail: setup.actor === null ? "authorized" : `authorized as ${setup.actor}` }),
        "team",
        { state: "active" }
      )
    })
    return
  }

  const pickTeam: LinearSeam["pickTeam"] = async (teamId, repo) => {
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const found = findCard(target.repo)
    if (found === undefined) return `No Linear connect card for ${target.repo} — /linear.connect opens it.`
    const prior = found.payload
    const team = prior.teams?.find((candidate) => candidate.id === teamId)
    if (team === undefined) return `Team ${teamId} is not one this authorization can see.`
    upsertCard(found.id, prior.repo, {
      teamId: team.id,
      steps: patchStep(
        patchStep(prior.steps, "team", { state: "done", detail: `${team.key} · ${team.name}` }),
        "repository",
        { state: "active" }
      )
    })
    return
  }

  const pickRepository: LinearSeam["pickRepository"] = async (cardRepo, repo) => {
    const found = findCard(cardRepo)
    if (found === undefined) return `No Linear connect card for ${cardRepo} — /linear.connect opens it.`
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    /* The card id stays where the wizard was opened; the repository the
       create posts (and the title) follows the pick. */
    upsertCard(found.id, target.repo, {
      steps: patchStep(found.payload.steps, "repository", { detail: target.repo, state: "active" })
    })
    return
  }

  const confirmConnect: LinearSeam["confirmConnect"] = async (repo) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    const found = findCard(target.repo)
    if (found === undefined) return `No Linear connect card for ${target.repo} — /linear.connect opens it.`
    const prior = found.payload
    if (prior.setupKey === undefined) return "Step 1 first: Open Linear and authorize."
    if (prior.teamId === undefined) return "Step 2 first: pick the Linear team."
    const created = await sendJson("POST", "/linear", {
      setup_key: prior.setupKey,
      linear_team_id: prior.teamId,
      repo: prior.repo
    })
    if ("error" in created) {
      upsertCard(found.id, prior.repo, { error: created.error })
      return created.error
    }
    await refreshIntegrations()
    const row = [...ctx.store.collections.linearIntegrations.values()].find(
      (candidate) => linearIntegrationRepo(candidate) === prior.repo && candidate.teamId === prior.teamId
    )
    const wire = isRecord(created.body) ? created.body : {}
    upsertCard(found.id, prior.repo, {
      phase: "connected",
      error: undefined,
      integration: {
        id: intOrNull(wire.id) ?? (row !== undefined ? Number(row.id) : 0),
        teamKey: str(wire.linear_team_key) ?? row?.teamKey ?? prior.teams?.find((team) => team.id === prior.teamId)?.key ?? "",
        teamName: str(wire.linear_team_name) ?? row?.teamName ?? "",
        active: wire.is_active !== false,
        lastSyncAt: row?.lastSyncAt ?? null
      },
      steps: LINEAR_STEP_LABELS.map(([id, label]) => ({
        id,
        label,
        state: "done" as const,
        detail: id === "repository" ? prior.repo : (prior.steps.find((step) => step.id === id)?.detail ?? null)
      }))
    })
    return { value: `Linear ${row?.teamKey ?? ""} connected to ${prior.repo} — the card tracks it.` }
  }

  const syncNow: LinearSeam["syncNow"] = async (integration) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = await resolveIntegration(integration)
    if ("error" in resolved) return resolved.error
    const row = resolved.integration
    /* 202 sync_started and 409 sync_already_running are both states, not
       errors; anything else is the verbatim refusal on the card. */
    let response: Response
    try {
      response = await ctx.http(cloud(`/linear/${encodeURIComponent(row.id)}/sync`), { method: "POST" })
    } catch (error) {
      const message = `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}`
      renderSyncCard(row, { error: message })
      return message
    }
    const body = await response.json().catch(() => null)
    const status = isRecord(body) ? str(body.status) : null
    if (response.ok || (response.status === 409 && status === "sync_already_running")) {
      renderSyncCard(row, { trigger: status === "sync_started" ? "sync started" : status === "sync_already_running" ? "already running" : null })
      return { value: `Sync started for Linear ${row.teamKey} ↔ ${linearIntegrationRepo(row)} — the card tracks it.` }
    }
    /* The server's sentence leads; its machine token stands in only when no sentence came. */
    const message = (isRecord(body) && typeof body.message === "string" && body.message !== ""
      ? body.message.slice(0, 240)
      : null) ?? status ?? `Starting the sync failed (${response.status})`
    renderSyncCard(row, { error: message })
    return message
  }

  const activity: LinearSeam["activity"] = async (integration) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const resolved = await resolveIntegration(integration)
    if ("error" in resolved) return resolved.error
    renderSyncCard(resolved.integration, { window: "24h" })
    return { value: `The last 24 hours of Linear ${resolved.integration.teamKey} — the feed is plue#468, the card says so.` }
  }

  const disconnect: LinearSeam["disconnect"] = async (integration, confirmKey) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    if (integration.trim() === "") return "linear.disconnect needs an integration: /linear.disconnect <id|team> <teamKey>"
    const resolved = await resolveIntegration(integration)
    if ("error" in resolved) return resolved.error
    const row = resolved.integration
    const repo = linearIntegrationRepo(row)
    /*
     * The typed-key gate lives HERE, not only in the card's chrome (the
     * workspace delete's rule): a slash, an agent's confirmed invocation, and
     * the card's second click all arrive with the key the invoker typed, and
     * only the integration's own team key disconnects. A row the wire left
     * without a key takes its id instead — never an empty match.
     */
    const expected = row.teamKey !== "" ? row.teamKey : row.id
    if ((confirmKey ?? "").trim() !== expected) {
      return `Disconnecting Linear ${row.teamKey} from ${repo} needs its team key typed back exactly — /linear.disconnect ${row.id} ${expected}.`
    }
    const removed = await sendJson("DELETE", `/linear/${encodeURIComponent(row.id)}`)
    if ("error" in removed) return removed.error
    await refreshIntegrations()
    /*
     * A disconnected card leaves the transcript: any state it could show now
     * would be a lie. The connected card carries the integration's id; a
     * wizard opened on another repository and pointed here at step 3 is
     * still found through its payload.
     */
    const connected = [...ctx.store.collections.cards.values()].find(
      (card) => card.kind === "connector-setup" && card.payload.connector === "linear" && card.payload.integration?.id === Number(row.id)
    )
    const cardId = connected?.id ?? findCard(repo)?.id
    if (cardId !== undefined) {
      ctx.dispatch({ type: "card.removed", actor: ctx.actor(), id: cardId })
    }
    return { value: `Linear ${row.teamKey} disconnected from ${repo}.` }
  }

  const retryOp: LinearSeam["retryOp"] = async (opId) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    if (opId.trim() === "") return "sync.retry needs an op id: /sync.retry <opId>"
    return NO_OP_RETRY_REFUSAL
  }

  const showMoreOps: LinearSeam["showMoreOps"] = async (cardId) => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card === undefined || card.kind !== "sync-ops") return `No sync card ${cardId}.`
    ctx.dispatch({
      type: "card.upsert",
      actor: ctx.actor(),
      card: { ...card, payload: { ...card.payload, expanded: true } }
    })
    return undefined
  }

  return {
    connect,
    openLinear,
    pickTeam,
    pickRepository,
    confirmConnect,
    refreshIntegrations,
    syncNow,
    activity,
    disconnect,
    retryOp,
    showMoreOps
  }
}
