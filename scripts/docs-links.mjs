/**
 * The links a built page turns into anchors, and where each one lands.
 *
 * This is the site's dead-link authority. vocs has its own, but it is a single
 * switch with no way to record a route whose page another body of work writes,
 * so it runs in warning mode and `check-docs` answers here instead. Three
 * spellings become an anchor in the built page: a Markdown link, a reference
 * definition, and an `href` an MDX page writes by hand. All three are read.
 */
import { posix } from "node:path"

/** Every link target a page writes, in the order it writes them. */
export const linkTargets = (body) => [
  ...[...body.matchAll(/\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].map((match) => match[1]),
  ...[...body.matchAll(/href=["']([^"']+)["']/g)].map((match) => match[1]),
  ...[...body.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map((match) => match[1])
]

/**
 * Whether a target addresses something this site can answer for.
 *
 * Anything with a scheme addresses another origin, and a hash-only link
 * addresses the page it is written on.
 */
export const isInternal = (target) => target !== "" && !/^([a-z][a-z0-9+.-]*:|#)/i.test(target)

/**
 * The route a target resolves to, read from the page that writes it.
 *
 * A relative target resolves against the page's own directory, the way a
 * browser resolves the anchor vocs renders. The page extension and a trailing
 * `/index` come off, because vocs serves a directory by its index.
 */
export const resolveLink = (route, target) => {
  const [path] = target.split("#")
  const absolute = path.startsWith("/") ? path : posix.resolve(route.replace(/\/[^/]*$/, "") || "/", path)
  return absolute.replace(/\.mdx?$/, "").replace(/\/index$/, "").replace(/(.)\/$/, "$1")
}

/**
 * Links that answer to nothing, over every page given.
 *
 * `routes` and `assets` are what the site publishes; `deferred` is the recorded
 * set of routes linked before the page answering them exists.
 */
export const deadLinks = (pages, { assets, deferred = new Set(), routes }) => {
  const dead = []
  let checked = 0
  for (const page of pages) {
    for (const target of linkTargets(page.body)) {
      if (!isInternal(target)) continue
      const [path] = target.split("#")
      if (path === "") continue
      checked += 1
      if (assets.has(path)) continue
      const route = resolveLink(page.route, target)
      if (routes.has(route) || deferred.has(route) || assets.has(route)) continue
      dead.push(`${page.path}: ${target}`)
    }
  }
  return { checked, dead }
}
