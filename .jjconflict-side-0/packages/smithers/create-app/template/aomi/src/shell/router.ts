/**
 * The shell router: location in, route path out. No dependency, no context.
 *
 * History mode is the default (`/build`); a `#/build` hash is honored so the
 * app also works from a file:// or hash-only host. The `popstate` and
 * `hashchange` subscriptions are installed once at module load, not in a
 * `useEffect`, so the current route is a plain field of the store.
 */
import type { MouseEvent } from "react"
import { actions } from "./store.ts"

/** Collapses a path to a leading slash with no trailing slash. */
export const normalize = (path: string): string => {
  const trimmed = path.replace(/[?#].*$/, "").replace(/\/+$/, "")
  if (trimmed === "" || trimmed === "/") return "/"
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

/** The route the browser is currently showing. */
export const currentRoute = (): string => {
  if (typeof window === "undefined") return "/"
  const hash = window.location.hash
  if (hash.startsWith("#/")) return normalize(hash.slice(1))
  return normalize(window.location.pathname)
}

/** Pushes a route and publishes it to the store. */
export const navigate = (to: string): void => {
  const route = normalize(to)
  if (typeof window !== "undefined" && route !== currentRoute()) {
    window.history.pushState(null, "", route)
  }
  actions.setRoute(route)
}

/** Replaces the current route without adding a history entry. */
export const redirect = (to: string): void => {
  const route = normalize(to)
  if (typeof window !== "undefined") window.history.replaceState(null, "", route)
  actions.setRoute(route)
}

/** Installs the location subscriptions and seeds the store. Call once. */
export const startRouter = (): void => {
  if (typeof window === "undefined") return
  const sync = (): void => actions.setRoute(currentRoute())
  window.addEventListener("popstate", sync)
  window.addEventListener("hashchange", sync)
  sync()
}

/** True when `route` is `href` or a child of it, for sidebar active state. */
export const isActive = (route: string, href: string): boolean => {
  const target = normalize(href)
  return route === target || route.startsWith(`${target}/`)
}

/**
 * Intercepts a left click on an in-app link so it routes instead of reloading.
 * Modified clicks (new tab, download) fall through to the browser.
 */
export const linkHandler = (href: string) => (event: MouseEvent<HTMLAnchorElement>): void => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return
  }
  event.preventDefault()
  navigate(href)
}
