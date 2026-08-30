import assert from "node:assert/strict"
import test from "node:test"
import { isHistorical, pages } from "./docs-pages.mjs"
import { deferredRoutes } from "./docs-routes.mjs"
import { linksOf, sidebarRoutes } from "./docs-sidebar.mjs"

test("collects links from a nested sidebar and ignores a group with none", () => {
  const links = linksOf([
    { text: "Introduction", link: "/" },
    { text: "Guides", items: [{ text: "Writing", link: "/guides/writing-a-flow" }] },
    { text: "Empty", items: [] }
  ])
  assert.deepEqual([...links], ["/", "/guides/writing-a-flow"])
})

test("collects a link on a group that also has children", () => {
  const links = linksOf([{ text: "Patterns", link: "/api/patterns", items: [{ text: "Loops", link: "/api/patterns-loops" }] }])
  assert.deepEqual([...links], ["/api/patterns", "/api/patterns-loops"])
})

test("every page the site publishes is reachable from the sidebar", async () => {
  const links = await sidebarRoutes()
  const unlisted = pages()
    .map((page) => page.route)
    .filter((route) => !isHistorical(route) && !links.has(route))
  assert.deepEqual(unlisted, [], `unlisted pages: ${unlisted.join(", ")}`)
})

test("every sidebar link resolves to a page, or to a route recorded as deferred", async () => {
  // The site links one route whose page another body of work writes. The
  // sidebar keeps the entry so the section reads in order once the page lands,
  // and the exemption is the recorded list rather than a free pass.
  const routes = new Set(pages().map((page) => page.route))
  const deferred = new Set(deferredRoutes.map((entry) => entry.route))
  const dangling = [...(await sidebarRoutes())].filter(
    (link) => !link.startsWith("http") && !routes.has(link) && !deferred.has(link)
  )
  assert.deepEqual(dangling, [], `dangling links: ${dangling.join(", ")}`)
  const landed = [...deferred].filter((route) => routes.has(route))
  assert.deepEqual(landed, [], `no longer deferred, drop from scripts/docs-routes.mjs: ${landed.join(", ")}`)
})

test("the historical changelogs are the only exemption", async () => {
  const links = await sidebarRoutes()
  const listedHistorical = pages()
    .map((page) => page.route)
    .filter((route) => isHistorical(route) && links.has(route))
  assert.deepEqual(listedHistorical, [])
})
