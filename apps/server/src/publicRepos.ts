import { AVAILABLE_REPOS, PUBLIC_REPOS_PATH } from "./publicRepoCatalog"
import type { PublicRepoCatalog, PublicRepoStats, PublicRepository } from "./publicRepoCatalog"

interface Dependencies {
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: () => number
  readonly cache: () => Pick<Cache, "match" | "put"> | undefined
  /** The curated roster; tests pass a larger one to exercise the multi-repo fetch. */
  readonly repos?: ReadonlyArray<Pick<PublicRepository, "name" | "title" | "url">>
}

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
  let snapshot: { body: string; expiresAt: number } | undefined
  let pending: Promise<void> | undefined

  const refresh = async (cacheKey: Request): Promise<void> => {
    const cache = deps.cache()
    const cached = await cache?.match(cacheKey).catch(() => undefined)
    if (cached) {
      const ttl = Math.max(0, Number(cached.headers.get("x-catalog-expires")) - deps.now()) / 1000
      if (ttl > 0) {
        snapshot = { body: await cached.text(), expiresAt: deps.now() + ttl * 1000 }
        return
      }
    }
    const repos = await Promise.all(roster.map(async (repo) => {
      let stats: PublicRepoStats | null = null
      try {
        const response = await deps.fetch(new Request(`https://api.github.com/repos/${repo.name}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "Smithers-public-repos" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000)
        }))
        if (response.ok) stats = parseStats(await response.json(), repo.name)
      } catch {
        // Availability is curated independently of a transient metadata outage.
      }
      return { ...repo, stats }
    }))
    const body: PublicRepoCatalog = { repos }
    const ttl = repos.every((repo) => repo.stats !== null) ? 300 : 30
    snapshot = { body: JSON.stringify(body), expiresAt: deps.now() + ttl * 1000 }
    await cache?.put(cacheKey, new Response(snapshot.body, {
      headers: { ...headers, "cache-control": `public, max-age=${ttl}`, "x-catalog-expires": String(snapshot.expiresAt) }
    })).catch(() => undefined)
  }

  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers })
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(JSON.stringify({ message: "Method not allowed." }), {
        status: 405, headers: { ...headers, allow: "GET, HEAD, OPTIONS" }
      })
    }
    if (snapshot === undefined || snapshot.expiresAt <= deps.now()) {
      // Query strings and visitor headers never change the public cache key.
      const key = new Request(new URL(PUBLIC_REPOS_PATH, request.url))
      pending ??= refresh(key).finally(() => { pending = undefined })
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
