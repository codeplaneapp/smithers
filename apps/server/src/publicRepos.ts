import { AVAILABLE_REPOS, COMING_SOON_REPOS, PUBLIC_REPOS_PATH } from "./publicRepoCatalog"
import type { PublicComingSoonRepository, PublicRepoCatalog, PublicRepoStats, PublicRepository } from "./publicRepoCatalog"

interface Dependencies {
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: () => number
  readonly cache: () => Pick<Cache, "match" | "put"> | undefined
  /** The curated roster; tests pass a larger one to exercise the multi-repo fetch. */
  readonly repos?: ReadonlyArray<Pick<PublicRepository, "name" | "title" | "url" | "summary">>
  /** The coming-soon roster; its stats come from the same GitHub resource. */
  readonly comingSoon?: ReadonlyArray<Pick<PublicComingSoonRepository, "name" | "title" | "url">>
}

/**
 * The Worker bindings the catalog reads. GITHUB_TOKEN is an optional secret
 * (`wrangler secret put GITHUB_TOKEN`): with it, GitHub meters the stats reads
 * at 5000 requests an hour instead of the 60 an unauthenticated address gets.
 * The token leaves this module only inside the GitHub request's authorization
 * header; it never reaches a log, the cache, or the response.
 */
export interface PublicReposEnv {
  readonly GITHUB_TOKEN?: string
}

/** How GitHub answered one stats read. */
interface StatsResult {
  readonly stats: PublicRepoStats | null
  /**
   * A transient failure (a network error, a timeout, or a 5xx) is worth retrying
   * soon. A 403 or 429 means GitHub is rate limiting this Worker, and any other
   * settled answer (a 404, private metadata, an invalid body) will not change in
   * the next few minutes either; retrying those every 30 s would keep the limit
   * tripped, so they cache for the full TTL.
   */
  readonly transient: boolean
}

/** The cache TTL in seconds: the full window, or a short retry after a transient outage. */
const FULL_TTL = 300
const RETRY_TTL = 30

const headers = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "x-content-type-options": "nosniff"
}

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** Only public, matching GitHub metadata can enter the public catalog. */
const parseStats = (value: unknown, name: string): PublicRepoStats | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const repo = value as Record<string, unknown>
  if (repo.full_name !== name || repo.private !== false || repo.disabled === true) return null
  if (!count(repo.stargazers_count) || !count(repo.forks_count) || !count(repo.open_issues_count)) return null
  const license = repo.license as { spdx_id?: unknown } | null | undefined
  return {
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssuesAndPulls: repo.open_issues_count,
    language: typeof repo.language === "string" ? repo.language : null,
    license: typeof license?.spdx_id === "string" && license.spdx_id !== "NOASSERTION" ? license.spdx_id : null
  }
}

/**
 * An anonymous read on the app Worker. The app's GitHub source-repository
 * route is account-scoped; this route uses the same GitHub metadata resource
 * for the curated public roster, without borrowing any visitor's credentials.
 * Edge caching and an in-flight join bound GitHub traffic on this public page.
 */
export const createPublicReposHandler = (deps: Dependencies) => {
  const roster = deps.repos ?? AVAILABLE_REPOS
  const comingSoonRoster = deps.comingSoon ?? COMING_SOON_REPOS
  let snapshot: { body: string; expiresAt: number } | undefined
  let pending: Promise<void> | undefined

  const statsFor = async (name: string, token: string | undefined): Promise<StatsResult> => {
    let response: Response
    try {
      response = await deps.fetch(new Request(`https://api.github.com/repos/${name}`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "Smithers-public-repos",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" })
        },
        // workerd refuses redirect: "error" (it throws before the request is
        // sent, which nulled every card's stats in production while Bun let the
        // tests pass), so the redirect is requested manually and a 3xx answer
        // below is a settled non-answer.
        redirect: "manual",
        signal: AbortSignal.timeout(10_000)
      }))
    } catch {
      // Availability is curated independently of a transient metadata outage.
      return { stats: null, transient: true }
    }
    if (response.status >= 500) return { stats: null, transient: true }
    // GitHub metadata never redirects; a 3xx is not metadata and will not
    // change in the next few minutes, so it caches for the full window.
    if (response.status >= 300 && response.status < 400) return { stats: null, transient: false }
    if (!response.ok) return { stats: null, transient: false }
    try {
      return { stats: parseStats(await response.json(), name), transient: false }
    } catch {
      return { stats: null, transient: false }
    }
  }

  const refresh = async (cacheKey: Request, token: string | undefined): Promise<void> => {
    const cache = deps.cache()
    const cached = await cache?.match(cacheKey).catch(() => undefined)
    if (cached) {
      const ttl = Math.max(0, Number(cached.headers.get("x-catalog-expires")) - deps.now()) / 1000
      if (ttl > 0) {
        snapshot = { body: await cached.text(), expiresAt: deps.now() + ttl * 1000 }
        return
      }
    }
    const results = await Promise.all([...roster, ...comingSoonRoster].map((repo) => statsFor(repo.name, token)))
    const statsOf = (index: number) => results[index]!.stats
    const body: PublicRepoCatalog = {
      // Only the public fields; the catalog's Cloud mirror path stays server-side.
      repos: roster.map((repo, index) => ({
        name: repo.name, title: repo.title, url: repo.url, summary: repo.summary, stats: statsOf(index)
      })),
      comingSoon: comingSoonRoster.map((repo, index) => ({
        name: repo.name, title: repo.title, url: repo.url, stats: statsOf(roster.length + index)
      }))
    }
    const ttl = results.some((result) => result.transient) ? RETRY_TTL : FULL_TTL
    snapshot = { body: JSON.stringify(body), expiresAt: deps.now() + ttl * 1000 }
    await cache?.put(cacheKey, new Response(snapshot.body, {
      headers: { ...headers, "cache-control": `public, max-age=${ttl}`, "x-catalog-expires": String(snapshot.expiresAt) }
    })).catch(() => undefined)
  }

  return async (request: Request, env: PublicReposEnv = {}): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers })
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(JSON.stringify({ message: "Method not allowed." }), {
        status: 405, headers: { ...headers, allow: "GET, HEAD, OPTIONS" }
      })
    }
    if (snapshot === undefined || snapshot.expiresAt <= deps.now()) {
      // Query strings and visitor headers never change the public cache key.
      const key = new Request(new URL(PUBLIC_REPOS_PATH, request.url))
      pending ??= refresh(key, env.GITHUB_TOKEN?.trim() || undefined).finally(() => { pending = undefined })
      await pending
    }
    return new Response(request.method === "HEAD" ? null : snapshot!.body, {
      headers: { ...headers, "cache-control": `public, max-age=${Math.max(0, Math.ceil((snapshot!.expiresAt - deps.now()) / 1000))}` }
    })
  }
}

export const handlePublicRepos = createPublicReposHandler({
  fetch: (request) => fetch(request),
  now: () => Date.now(),
  cache: () => (globalThis as typeof globalThis & { caches?: CacheStorage & { default?: Cache } }).caches?.default
})
