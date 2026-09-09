/**
 * The API credential the shell sends, when the deploy it is talking to has one.
 *
 * A Worker that sets `APP_API_TOKEN` refuses every `/api/*` route but health
 * without `Authorization: Bearer <token>` (`worker/guard.ts`). A browser bundle
 * cannot hold a secret, so the operator hands it to the browser once: open the
 * app as `https://<host>/#token=<value>`. The fragment stays in the browser.
 * main.tsx claims it before routing, stores it for this tab in sessionStorage,
 * and strips it from the address bar. Reloads keep it; closing the tab clears it.
 *
 * Local development sets no token, `readToken` returns `undefined`, and every
 * request goes out exactly as it did before.
 */

const KEY = "aomi.api-token"

/** Whether this bundle is running in a browser. Storage access can still throw. */
const inBrowser = (): boolean => typeof window !== "undefined"

/**
 * The session credential, claiming `#token=` before the initial route redirect.
 * Legacy `?token=` links remain supported for one release with a warning.
 */
export const readToken = (): string | undefined => {
  if (!inBrowser()) return undefined
  try {
    const url = new URL(window.location.href)
    // Hash routes are navigation, not bootstrap parameters.
    const fragment = new URLSearchParams(url.hash.startsWith("#/") ? "" : url.hash.slice(1))
    const legacy = url.searchParams.get("token")
    const supplied = fragment.get("token") || legacy
    if (legacy !== null) {
      console.warn("Aomi: ?token= is deprecated; use #token= to keep credentials out of HTTP request URLs.")
    }
    if (fragment.has("token") || legacy !== null) {
      if (fragment.has("token")) {
        fragment.delete("token")
        url.hash = fragment.toString()
      }
      url.searchParams.delete("token")
      // Strip even if storage is disabled, and preserve unrelated history state.
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
    }
    if (supplied !== null && supplied !== "") window.sessionStorage.setItem(KEY, supplied)
    return window.sessionStorage.getItem(KEY) ?? undefined
  } catch {
    // A browser with storage disabled is not a reason to fail every request.
    // The app then behaves the way it does against an open Worker.
    return undefined
  }
}

/** Forgets the stored credential. */
export const clearToken = (): void => {
  if (!inBrowser()) return
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    // Nothing to forget if storage refused to remember in the first place.
  }
}

/** The `Authorization` header for every API call, or nothing when there is no token. */
export const authHeaders = (): Record<string, string> => {
  const token = readToken()
  return token === undefined ? {} : { authorization: `Bearer ${token}` }
}
