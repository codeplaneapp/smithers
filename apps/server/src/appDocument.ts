import { AVAILABLE_REPOS } from "./publicRepoCatalog"

/*
 * The app document. The smithers.sh Astro build (apps/site) prerenders the
 * product app once per catalog repository at /<owner>/<name>/index.html and
 * mounts it as a React island, and this Worker serves that build's dist as
 * its assets. The document is fetched from the assets layer by its canonical
 * path with a trailing slash: the assets layer answers `/owner/name` with a
 * 307 to `/owner/name/` when only `index.html` exists under it, and a
 * redirect is not the document.
 *
 * The build stamp (`<meta name="smithers-build-sha">`) lives on this document
 * and not on the site's landing page, so scripts/canary/build-probe.ts reads
 * the HTML from here too.
 */

/** The prerendered app page for one catalog repository name, as the assets layer stores it. */
export const appDocumentPath = (repoName: string): string => `/${repoName}/`

/**
 * The document a frame path reloads into. Every prerendered app page is the
 * same shell (only the title differs), so the first catalog repository's page
 * stands in for a path that names no repository.
 */
export const DEFAULT_APP_DOCUMENT_PATH = appDocumentPath(AVAILABLE_REPOS[0].name)

/**
 * The app's frame history writes `/w/<workspace>/b/<branch>/f/<frame>`
 * (apps/ui/src/mainview/runtime/FrameHistory.ts). A reload or a deep link at
 * such a path is the app, and the assets layer has no file for it.
 */
export const FRAME_PATH_PREFIX = "/w/"

export const isFramePath = (pathname: string): boolean =>
  /^\/w\/[^/]+\/b\/[^/]+\/f\/[^/]+\/?$/.test(pathname)

/** The canonical app page for a routed path, or undefined when the path names no catalog repository. */
export const catalogDocumentPath = (pathname: string): string | undefined => {
  // GitHub names are case-insensitive, and `/owner/name/` is the same page.
  const name = pathname.toLowerCase().replace(/\/$/, "")
  const repo = AVAILABLE_REPOS.find((entry) => `/${entry.name.toLowerCase()}` === name)
  return repo === undefined ? undefined : appDocumentPath(repo.name)
}
