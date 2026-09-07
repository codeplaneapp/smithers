import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  APP_DOCUMENT_CHECK_PATH,
  FRAME_PATH_SAMPLE,
  originFromHostname,
  REDIRECT_HOP_LIMIT,
  renderTable,
  runSiteChecks,
  tally
} from "./site-checks.ts"
import type { Fetcher, Observed } from "./site-checks.ts"

const ORIGIN = "https://canary.test"

const html = (status: number, headers: Record<string, string> = {}): Observed => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8", ...headers }
})
const isolated = html(200, { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" })
const json = (): Observed => ({ status: 200, headers: { "content-type": "application/json" } })
const redirect = (status: number, location: string): Observed => ({ status, headers: { location } })

/** A deployment that answers exactly what the Worker over the site build should. */
const healthy: Record<string, Observed> = {
  "/": html(200),
  "/docs/": html(200),
  "/nope": html(404),
  [APP_DOCUMENT_CHECK_PATH]: isolated,
  [FRAME_PATH_SAMPLE]: isolated,
  "/api/bootstrap": json(),
  "/api/public/repos": json(),
  "/__build.json": json(),
  "/llms.txt": { status: 200, headers: { "content-type": "text/plain" } },
  "/sitemap-index.xml": { status: 200, headers: { "content-type": "application/xml" } },
  "/agents/codex": redirect(301, "/docs/guides/model-seats/"),
  "/docs/guides/model-seats/": html(200),
  "/reference/journal": redirect(301, "/docs/reference/journal/"),
  "/docs/reference/journal/": html(200)
}

const fakeFetch = (table: Record<string, Observed>): { readonly fetch: Fetcher; readonly requested: Array<string> } => {
  const requested: Array<string> = []
  return {
    requested,
    fetch: async (url) => {
      const { pathname } = new URL(url)
      requested.push(pathname)
      return table[pathname] ?? html(404)
    }
  }
}

const failures = (checks: Awaited<ReturnType<typeof runSiteChecks>>) =>
  checks.filter((entry) => entry.status === "fail").map((entry) => `${entry.path}: ${entry.got}`)

describe("the site probe grades a deployment of the Worker over the site build", () => {
  test("a healthy deployment passes every check, and the aliases were followed to a 200", async () => {
    const { fetch, requested } = fakeFetch(healthy)
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: ["/agents/codex", "/reference/journal"] })
    expect(failures(checks)).toEqual([])
    expect(tally(checks)).toEqual({ passed: 12, failed: 0 })
    expect(requested).toContain("/docs/guides/model-seats/")
    expect(requested).toContain("/docs/reference/journal/")
  })

  test("the app document without its isolation headers fails, naming the missing header", async () => {
    const { fetch } = fakeFetch({ ...healthy, [APP_DOCUMENT_CHECK_PATH]: html(200) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual([`${APP_DOCUMENT_CHECK_PATH}: 200 + COOP absent + COEP absent`])
  })

  test("an assets-layer redirect on the app document fails: the Worker did not answer first", async () => {
    const { fetch } = fakeFetch({ ...healthy, [APP_DOCUMENT_CHECK_PATH]: redirect(307, `${APP_DOCUMENT_CHECK_PATH}/`) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual([
      `${APP_DOCUMENT_CHECK_PATH}: 307 -> ${APP_DOCUMENT_CHECK_PATH}/ + COOP absent + COEP absent`
    ])
  })

  test("a 404 page for the frame path fails: /w/* is not run_worker_first", async () => {
    const { fetch } = fakeFetch({ ...healthy, [FRAME_PATH_SAMPLE]: html(404) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual([`${FRAME_PATH_SAMPLE}: 404`])
  })

  test("a SPA shell answering an unknown path fails: the build's 404 page is what /nope must serve", async () => {
    const { fetch } = fakeFetch({ ...healthy, "/nope": html(200) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual(["/nope: 200"])
  })

  test("an HTML answer on an API path fails: the assets layer answered before the Worker", async () => {
    const { fetch } = fakeFetch({ ...healthy, "/api/bootstrap": html(200) })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: [] })
    expect(failures(checks)).toEqual(["/api/bootstrap: 200 text/html; charset=utf-8"])
  })

  test("an alias whose redirect lands on a 404 fails and shows the chain", async () => {
    const { fetch } = fakeFetch({ ...healthy, "/reference/journal": redirect(301, "/docs/reference/gone/") })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: ["/reference/journal"] })
    expect(failures(checks)).toEqual(["/reference/journal: 301 -> /docs/reference/gone/, 404"])
  })

  test("an alias may take the assets layer's trailing-slash hop after the 301", async () => {
    const { fetch } = fakeFetch({
      ...healthy,
      "/cli/overview": redirect(301, "/docs/reference/cli"),
      "/docs/reference/cli": redirect(308, "/docs/reference/cli/"),
      "/docs/reference/cli/": html(200)
    })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: ["/cli/overview"] })
    expect(failures(checks)).toEqual([])
  })

  test("a redirect cycle fails at the hop limit instead of looping", async () => {
    const { fetch, requested } = fakeFetch({ ...healthy, "/loop": redirect(301, "/loop") })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: ["/loop"] })
    expect(failures(checks)).toEqual([
      `/loop: ${Array.from({ length: REDIRECT_HOP_LIMIT + 1 }, () => "301 -> /loop").join(", ")} (more than ${REDIRECT_HOP_LIMIT} hops)`
    ])
    expect(requested.filter((path) => path === "/loop")).toHaveLength(REDIRECT_HOP_LIMIT + 1)
  })

  test("a redirect that leaves the site fails", async () => {
    const { fetch } = fakeFetch({ ...healthy, "/away": redirect(301, "https://elsewhere.test/") })
    const checks = await runSiteChecks(fetch, { origin: ORIGIN, legacyPaths: ["/away"] })
    expect(failures(checks)).toEqual(["/away: 301 -> https://elsewhere.test/ (leaves the site)"])
  })

  test("every path in the captured Mintlify sitemap is a same-site path the probe can ask for", () => {
    const legacy = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../site/src/data/mintlify-paths.json", import.meta.url)), "utf8")
    ) as { readonly paths: ReadonlyArray<string> }
    expect(legacy.paths.length).toBeGreaterThan(100)
    for (const path of legacy.paths) expect(path).toMatch(/^\/[^\s]*$/)
  })
})

describe("the probe's shell helpers", () => {
  test("a bare hostname, an origin, and a local dev URL each name one origin", () => {
    expect(originFromHostname("canary.smithers.sh")).toBe("https://canary.smithers.sh")
    expect(originFromHostname("https://canary.smithers.sh/")).toBe("https://canary.smithers.sh")
    expect(originFromHostname("http://localhost:8787")).toBe("http://localhost:8787")
  })

  test("the table has one row per check under a header, columns aligned", () => {
    const table = renderTable([
      { path: "/", expected: "200", got: "200", status: "pass" },
      { path: "/nope", expected: "404", got: "200", status: "fail" }
    ])
    expect(table.split("\n")).toEqual([
      "verdict  path   expected  got",
      "ok       /      200       200",
      "FAIL     /nope  404       200"
    ])
  })
})
