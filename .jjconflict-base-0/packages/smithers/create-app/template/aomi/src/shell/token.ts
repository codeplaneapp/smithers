/**
 * The API credential the shell sends, when the deploy it is talking to has one.
 *
 * A Worker that sets `APP_API_TOKEN` refuses every `/api/*` route but health
 * without `Authorization: Bearer <token>` (`worker/guard.ts`). A browser bundle
 * cannot hold a secret, so the operator hands it to the browser once: open the
 * app as `https://<host>/?token=<value>`, and this module stores the value and
 * strips it back out of the address bar so it is not left in a link, a
 * screenshot, or the referrer of the next navigation.
 *
 * Local development sets no token, `readToken` returns `undefined`, and every
 * request goes out exactly as it did before.
 */

const KEY = "aomi.api-token"

/** Whether this bundle is running somewhere with a URL and a `localStorage`. */
const inBrowser = (): boolean => typeof window !== "undefined" && typeof window.localStorage !== "undefined"

/**
 * The stored credential, taking one out of `?token=` first.
 *
 * Reading is what claims a token from the URL, so any call site works: the
 * first request the shell makes is what strips the query parameter.
 */
export const readToken = (): string | undefined => {
  if (!inBrowser()) return undefined
  try {
    const url = new URL(window.location.href)
    const supplied = url.searchParams.get("token")
    if (supplied !== null && supplied !== "") {
      window.localStorage.setItem(KEY, supplied)
      url.searchParams.delete("token")
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
      return supplied
    }
    return window.localStorage.getItem(KEY) ?? undefined
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
    window.localStorage.removeItem(KEY)
  } catch {
    // Nothing to forget if storage refused to remember in the first place.
  }
}

/** The `Authorization` header for every API call, or nothing when there is no token. */
export const authHeaders = (): Record<string, string> => {
  const token = readToken()
  return token === undefined ? {} : { authorization: `Bearer ${token}` }
}
