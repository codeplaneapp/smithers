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

/**
 * The anchor a heading answers to.
 *
 * vocs slugs a heading the way GitHub does: lower case, punctuation dropped,
 * spaces joined with hyphens. Inline code fences come off first, so a heading
 * written as `` `smithers ls` `` answers to `smithers-ls`.
 */
export const headingAnchor = (heading) =>
  heading
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\da-z\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")

/**
 * Every anchor a page body answers to, one per heading.
 *
 * Headings inside a fenced block are code, not structure, so they are skipped.
 */
export const headingAnchors = (body) => {
  const found = new Set()
  let fenced = false
  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced
    else if (!fenced) {
      const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)
      if (heading !== null) found.add(headingAnchor(heading[1]))
    }
  }
  return found
}

/**
 * Every anchor a body of text links to on one page url.
 *
 * The text is what a reader gets: the sentences the CLI prints. Reading the
 * anchors out of them, rather than out of the table they are built from,
 * is what makes this check the same claim the operator is holding.
 */
export const anchorsLinkedTo = (url, texts) => {
  const pattern = new RegExp(`${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#([\\w-]+)`, "g")
  return new Set(texts.flatMap((text) => [...text.matchAll(pattern)].map((match) => match[1])))
}

/**
 * The anchors a page has no heading for, sorted.
 *
 * A link to a missing anchor is not a dead link: the page loads and the reader
 * lands at the top with no idea what they were sent to read.
 */
export const missingAnchors = (body, anchors) => {
  const answered = headingAnchors(body)
  return [...anchors].filter((anchor) => !answered.has(anchor)).sort()
}
