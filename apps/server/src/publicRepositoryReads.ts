/** Public repository documents, not account, workspace, gateway, or secret reads. */
export const isPublicRepositoryRead = (method: string, pathname: string): boolean => {
  if (method !== "GET") return false
  const match = /^\/api\/repos\/([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,100})(.*)$/i.exec(pathname)
  if (!match || match[2] === "." || match[2] === "..") return false
  return /^(?:\/?|\/contents(?:\/.*)?|\/topics|\/stargazers|\/bookmarks(?:\/[^/]+)?|\/changes(?:\/[^/]+(?:\/(?:diff|files))?)?|\/issues(?:\/\d+(?:\/comments)?)?|\/labels|\/git\/(?:refs|trees\/[^/]+|commits\/[^/]+))$/.test(match[3]!)
}

interface Dependencies {
  readonly fetch: (request: Request) => Promise<Response>
  readonly cache: () => Pick<Cache, "match" | "put"> | undefined
}

/**
 * The Cloud backend remains the authority for public visibility. Anonymous
 * reads carry no credentials and only successful public answers enter the
 * shared cache; authenticated responses never pass through this cache.
 */
export const createPublicRepositoryReader = (deps: Dependencies) => {
  return async (url: URL, base: string): Promise<Response> => {
    const target = new URL(url.pathname + url.search, base)
    const key = new Request(target)
    const cache = deps.cache()
    const cached = await cache?.match(key).catch(() => undefined)
    if (cached) return cached
    try {
      const upstream = await deps.fetch(new Request(target, {
        headers: { accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(15_000)
      }))
      const headers = new Headers(upstream.headers)
      headers.delete("set-cookie")
      headers.delete("vary")
      headers.set("cache-control", upstream.ok ? "public, max-age=60" : "no-store")
      const response = new Response(upstream.body, { status: upstream.status, headers })
      // Cache API copies stay in this request's I/O context; never retain a
      // live response stream for another Worker request to consume.
      if (upstream.ok) await cache?.put(key, response.clone()).catch(() => undefined)
      return response
    } catch {
      return Response.json({ message: "Repository data is temporarily unavailable." }, {
        status: 502, headers: { "cache-control": "no-store" }
      })
    }
  }
}

export const readPublicRepository = createPublicRepositoryReader({
  fetch: (request) => fetch(request),
  cache: () => (globalThis as typeof globalThis & { caches?: CacheStorage & { default?: Cache } }).caches?.default
})
