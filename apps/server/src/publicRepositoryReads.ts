import { cloudRepoFor } from "./publicRepoCatalog"

/** Public repository documents, not account, workspace, gateway, or secret reads. */
export const isPublicRepositoryRead = (method: string, pathname: string): boolean => {
  if (method !== "GET") return false
  const match = /^\/api\/repos\/([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,100})(.*)$/i.exec(pathname)
  if (!match || match[2] === "." || match[2] === "..") return false
  return /^(?:\/?|\/contents(?:\/.*)?|\/topics|\/stargazers|\/bookmarks(?:\/[^/]+)?|\/changes(?:\/[^/]+(?:\/(?:diff|files))?)?|\/issues(?:\/\d+(?:\/comments)?)?|\/labels|\/git\/(?:refs|trees\/[^/]+|commits\/[^/]+))$/.test(match[3]!)
}

interface Dependencies {
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * A catalog repository is read from its Smithers Cloud mirror namespace; the
 * rest of the path and the query are unchanged. Any other repository keeps
 * the name the browser asked for.
 */
export const cloudReadPath = (pathname: string): string => {
  const match = /^\/api\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(pathname)
  if (!match) return pathname
  const cloudRepo = cloudRepoFor(`${match[1]}/${match[2]}`)
  return cloudRepo === undefined ? pathname : `/api/repos/${cloudRepo}${match[3]}`
}

/**
 * The Cloud backend remains the authority for public visibility. Anonymous
 * reads carry no credentials. Repository visibility and documents can change,
 * so every read reaches the backend and neither browsers nor the edge retain
 * an answer that could outlive its public visibility.
 */
export const createPublicRepositoryReader = (deps: Dependencies) => {
  return async (url: URL, base: string): Promise<Response> => {
    const target = new URL(cloudReadPath(url.pathname) + url.search, base)
    try {
      const upstream = await deps.fetch(new Request(target, {
        headers: { accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(15_000)
      }))
      const headers = new Headers(upstream.headers)
      headers.delete("set-cookie")
      headers.set("cache-control", "private, no-store")
      return new Response(upstream.body, { status: upstream.status, headers })
    } catch {
      return Response.json({ message: "Repository data is temporarily unavailable." }, {
        status: 502, headers: { "cache-control": "private, no-store" }
      })
    }
  }
}

export const readPublicRepository = createPublicRepositoryReader({
  fetch: (request) => fetch(request)
})
