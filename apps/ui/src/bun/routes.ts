/*
 * A tiny HTTP router for the local server. Lanes register their routes on
 * the shared instance (`server.router.add(...)`); a path pattern may carry
 * `:param` segments. Errors follow LOCAL-APP.md:
 * `{ error: { code, message } }` with a 4xx/5xx status.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH"

export interface RouteContext {
  readonly request: Request
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>

interface Route {
  readonly method: HttpMethod
  readonly pattern: string
  readonly segments: ReadonlyArray<string>
  readonly handler: RouteHandler
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }
  })

export const jsonError = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status)

export const notImplemented = (what: string): Response =>
  jsonError(501, "not_implemented", `${what} is not implemented in this build.`)

/** Body as JSON, or a 400 the caller returns as-is. */
export const readJson = async (request: Request): Promise<{ readonly body: unknown } | { readonly error: Response }> => {
  const text = await request.text()
  if (text.trim() === "") return { body: undefined }
  try {
    return { body: JSON.parse(text) as unknown }
  } catch {
    return { error: jsonError(400, "invalid_json", "Request body must be valid JSON.") }
  }
}

const split = (path: string): ReadonlyArray<string> => path.split("/").filter((segment) => segment !== "")

export class Router {
  private readonly routes: Array<Route> = []

  add(method: HttpMethod, pattern: string, handler: RouteHandler): this {
    const existing = this.routes.findIndex((route) => route.method === method && route.pattern === pattern)
    const route: Route = { method, pattern, segments: split(pattern), handler }
    // A later registration for the same method and pattern replaces the
    // placeholder a lane's real handler supersedes.
    if (existing >= 0) this.routes[existing] = route
    else this.routes.push(route)
    return this
  }

  match(method: string, pathname: string): { readonly handler: RouteHandler; readonly params: Record<string, string> } | undefined {
    const parts = split(pathname)
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let matched = true
      for (let index = 0; index < parts.length; index += 1) {
        const expected = route.segments[index] ?? ""
        const actual = parts[index] ?? ""
        if (expected.startsWith(":")) {
          params[expected.slice(1)] = decodeURIComponent(actual)
        } else if (expected !== actual) {
          matched = false
          break
        }
      }
      if (matched) return { handler: route.handler, params }
    }
    return undefined
  }

  /** True when some route, of any method, claims the path. */
  knows(pathname: string): boolean {
    const parts = split(pathname)
    return this.routes.some((route) =>
      route.segments.length === parts.length &&
      route.segments.every((segment, index) => segment.startsWith(":") || segment === parts[index])
    )
  }
}
