/**
 * Where the web app sends a visitor for the native app.
 *
 * Null until a native build is published: as of 2026-09-02,
 * `gh release view -R smithersai/smithers --json tagName,assets` answers
 * `{ tagName: "v0.35.0", assets: [] }`, the older releases are npm tags too,
 * and no `apps-v*` release exists — so there is nothing to link, and the app
 * renders no download door (docs/web-mode/PLAN.md §3: the download page
 * renders only rows present in the release manifest). Lane W6 stamps the URL
 * (the site's `/download` route once `apps/site` serves it, else the
 * `apps-v*` GitHub Release) in the same commit as the artifact upload.
 */
export const DOWNLOAD_URL: string | null = null
