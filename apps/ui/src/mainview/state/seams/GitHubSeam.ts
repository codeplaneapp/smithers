/*
 * The GitHub seam (lane sync, ADR 0005), behind the `/api/cloud/*` proxy:
 *
 *   GET  /api/repos/{owner}/{repo}/github-app-status — the GitHub App install
 *        state, with the rate-limit facts when the wire carries them
 *        ({github_rate_limit_limit/remaining/reset}); renders the
 *        connector-setup card, never a transcript line.
 *   POST /api/github-app/reconcile                   — re-derive the App's
 *        wiring after an install (404 in prod today; the message shows verbatim).
 *   POST /api/repos/{owner}/{repo}/mirror-sync       — pull GitHub into the
 *        mirror (202 {run_id}; 404 in prod today). No GET run route is
 *        polled (plue#470) — the card carries no state word the wire didn't.
 *
 * Rate limits (ADR "Rate limits"): a structured 429
 * `{code: "github_rate_limited", limit, remaining, reset_at}` becomes the
 * card's rate-limit line; a status answer whose remaining is under a fifth
 * of the limit shows the same line. Nothing is invented for a plain 429.
 *
 * What does NOT exist and is never faked: the ops feed and per-op retry
 * (plue#468), the sync runs (plue#470) — the sync-ops card renders the
 * degraded note and no run route is ever called.
 */
import { CLOUD_ROUTE_PREFIX } from "smithers-shared/LocalApp"
import type { Card, GitHubAppStatusInput } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { readGitHubRefusal, trustedHttpsUrl } from "./SeamContext"
import type { GitHubRefusal, SeamContext } from "./SeamContext"

export const SIGN_OUT_REFUSAL = "Sign in to Smithers Cloud first — /cloud.sign-in."

/** The degraded note the mirror card carries while the ops feed is plue#468. */
export const NO_MIRROR_OPS_NOTE =
  "The sync ops feed isn't recorded yet (plue#468) — each sync's ops appear here once the backend records them."

export interface GitHubSeam {
  /** `github.app [repo]`: read the App status and render the connector-setup card. */
  readonly app: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** Hidden, card-scoped: open the App's install page in the browser. */
  readonly openInstall: (repo?: string) => Promise<string | void>
  /** `github.reconcile [repo]`: re-derive the wiring, then re-read the status. */
  readonly reconcile: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** `github.mirror-sync [repo]`: pull GitHub into the mirror and render the sync-ops card. */
  readonly mirrorSync: (repo?: string) => Promise<string | void | { readonly value: string }>
}

export interface GitHubSeamDeps {
  /** The native system-browser door; absent in a plain browser (window.open falls back). */
  readonly openExternal?: (url: string) => Promise<boolean>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

/** Only the github.com https install origin is worth linking (multi githubInstallUrl.ts). */
export const trustedInstallUrl = (value: string): string | null => trustedHttpsUrl(value, "github.com")

interface StatusAnswer {
  readonly installed: boolean
  readonly configured: boolean
  readonly installationId: number | null
  readonly installUrl: string | null
  readonly rateLimit: { readonly limit: number; readonly remaining: number; readonly resetAt: string | null } | null
}

/** The github-app-status answer; the rate-limit facts ride along only when the wire names them. */
const parseStatus = (value: unknown): StatusAnswer | null => {
  if (!isRecord(value)) return null
  if (typeof value.github_app_installed !== "boolean" || typeof value.github_app_configured !== "boolean") return null
  const limit = intOrNull(value.github_rate_limit_limit)
  const remaining = intOrNull(value.github_rate_limit_remaining)
  return {
    installed: value.github_app_installed,
    configured: value.github_app_configured,
    installationId: intOrNull(value.installation_id),
    installUrl: str(value.install_url),
    rateLimit: limit !== null && remaining !== null
      ? { limit, remaining, resetAt: str(value.github_rate_limit_reset) }
      : null
  }
}

/** The line the ADR names when the rate limit is in view (a fifth of the budget left, or a 429). */
export const lowRateLimit = (rateLimit: { readonly limit: number; readonly remaining: number }): boolean =>
  rateLimit.limit > 0 && rateLimit.remaining * 5 < rateLimit.limit

export const createGitHubSeam = (ctx: SeamContext, deps: GitHubSeamDeps = {}): GitHubSeam => {
  const cloud = (path: string): string => `${ctx.baseUrl}${CLOUD_ROUTE_PREFIX}api${path}`

  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return SIGN_OUT_REFUSAL
  }

  const repoPath = (repo: string, suffix: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${suffix}`
  }

  const readStatus = async (
    repo: string
  ): Promise<{ readonly status: StatusAnswer } | { readonly refusal: GitHubRefusal }> => {
    let response: Response
    try {
      response = await ctx.http(cloud(repoPath(repo, "github-app-status")))
    } catch (error) {
      return { refusal: { message: `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}` } }
    }
    if (!response.ok) {
      return { refusal: await readGitHubRefusal(response, `The GitHub App status for ${repo} couldn't be read (${response.status})`) }
    }
    const parsed = parseStatus(await response.json().catch(() => null))
    if (parsed === null) return { refusal: { message: `The GitHub App status answer for ${repo} was malformed.` } }
    return { status: parsed }
  }

  /** The status row lands in the collection; the card renders from the same answer. */
  const dispatchStatus = (repo: string, status: StatusAnswer): void => {
    const row: GitHubAppStatusInput = {
      repo,
      installed: status.installed,
      configured: status.configured,
      installationId: status.installationId,
      installUrl: status.installUrl,
      rateLimit: status.rateLimit
    }
    ctx.dispatch({ type: "github.app-status.loaded", actor: "system", status: row })
  }

  const renderCard = (
    repo: string,
    answer: { readonly status: StatusAnswer } | { readonly refusal: GitHubRefusal },
    error?: GitHubRefusal
  ): void => {
    const id = `connector-setup-github-${repo}`
    const existing = ctx.store.collections.cards.get(id)
    const rateLimit = error?.rateLimit ?? ("status" in answer
      ? answer.status.rateLimit !== null && lowRateLimit(answer.status.rateLimit)
        ? answer.status.rateLimit
        : null
      : answer.refusal.rateLimit ?? null)
    const message = error?.message ?? ("status" in answer ? undefined : answer.refusal.message)
    const card: Card = {
      id,
      kind: "connector-setup",
      title: `GitHub · ${repo}`,
      status: message !== undefined
        ? "error"
        : "status" in answer && answer.status.installed && answer.status.configured
        ? "acted"
        : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload: {
        connector: "github",
        repo,
        phase: "status" in answer && answer.status.installed && answer.status.configured ? "connected" : "setup",
        steps: [],
        ...("status" in answer
          ? {
              installationId: answer.status.installationId,
              configured: answer.status.configured,
              ...(answer.status.installUrl !== null ? { installUrl: answer.status.installUrl } : {})
            }
          : {}),
        ...(message !== undefined ? { error: message } : {}),
        ...(rateLimit !== null ? { rateLimit } : {})
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  const app: GitHubSeam["app"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const answer = await readStatus(target.repo)
    if ("status" in answer) dispatchStatus(target.repo, answer.status)
    renderCard(target.repo, answer)
    if ("refusal" in answer) return answer.refusal.message
    return {
      value: answer.status.installed && answer.status.configured
        ? `The Smithers GitHub App is installed on ${target.repo} — the card tracks it.`
        : `The Smithers GitHub App is not installed on ${target.repo} — the card has the install link.`
    }
  }

  const openInstall: GitHubSeam["openInstall"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const row = ctx.store.collections.githubAppStatuses.get(target.repo)
    const card = ctx.store.collections.cards.get(`connector-setup-github-${target.repo}`)
    const installUrl = (card?.kind === "connector-setup" ? card.payload.installUrl : undefined) ?? row?.installUrl ?? null
    const trusted = installUrl !== null ? trustedInstallUrl(installUrl) : null
    if (trusted === null) return `No install link for ${target.repo} yet — /github.app reads the status first.`
    if (deps.openExternal !== undefined) void deps.openExternal(trusted)
    else if (typeof window !== "undefined") window.open(trusted, "_blank", "noopener")
    return undefined
  }

  const reconcile: GitHubSeam["reconcile"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    let response: Response
    try {
      response = await ctx.http(cloud("/github-app/reconcile"), { method: "POST" })
    } catch (error) {
      return `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!response.ok) {
      /* 404 in prod today (plue#473 family): the platform's own words show verbatim. */
      const refusal2 = await readGitHubRefusal(response, `The reconcile failed (${response.status})`)
      const answer = await readStatus(target.repo)
      if ("status" in answer) dispatchStatus(target.repo, answer.status)
      renderCard(target.repo, answer, refusal2)
      return refusal2.message
    }
    const answer = await readStatus(target.repo)
    if ("status" in answer) dispatchStatus(target.repo, answer.status)
    renderCard(target.repo, answer)
    if ("refusal" in answer) return answer.refusal.message
    return { value: `Reconciled — the GitHub card for ${target.repo} re-read the App status.` }
  }

  const mirrorSync: GitHubSeam["mirrorSync"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const cardId = `sync-ops-mirror-${target.repo}`
    const render = (patch: { readonly trigger?: string | null; readonly error?: string; readonly rateLimit?: GitHubRefusal["rateLimit"] }): void => {
      const existing = ctx.store.collections.cards.get(cardId)
      const card: Card = {
        id: cardId,
        kind: "sync-ops",
        title: `Mirror sync · GitHub → ${target.repo}`,
        status: patch.error !== undefined ? "error" : "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
        payload: {
          subject: `GitHub → ${target.repo} mirror`,
          source: "github-mirror",
          repo: target.repo,
          runState: null,
          ops: [],
          opsNote: NO_MIRROR_OPS_NOTE,
          ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.rateLimit !== undefined ? { rateLimit: patch.rateLimit } : {})
        }
      }
      ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
    }
    let response: Response
    try {
      response = await ctx.http(cloud(repoPath(target.repo, "mirror-sync")), { method: "POST" })
    } catch (error) {
      const message = `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}`
      render({ error: message })
      return message
    }
    if (!response.ok) {
      const refusal2 = await readGitHubRefusal(response, `The mirror sync failed (${response.status})`)
      render({ error: refusal2.message, ...(refusal2.rateLimit !== undefined ? { rateLimit: refusal2.rateLimit } : {}) })
      return refusal2.message
    }
    const body = await response.json().catch(() => null)
    const runId = isRecord(body) ? intOrNull(body.run_id) : null
    render({ trigger: runId !== null ? `sync started · run ${runId}` : "sync started" })
    return { value: `Mirror sync started for ${target.repo} — the card tracks it.` }
  }

  return { app, openInstall, reconcile, mirrorSync }
}
