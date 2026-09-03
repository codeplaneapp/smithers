import assert from "node:assert/strict"
import test from "node:test"
import { isHistorical, pages } from "./docs-pages.mjs"
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

test("every sidebar link resolves to a page", async () => {
  const routes = new Set(pages().map((page) => page.route))
  const dangling = [...(await sidebarRoutes())].filter((link) => !link.startsWith("http") && !routes.has(link))
  assert.deepEqual(dangling, [], `dangling links: ${dangling.join(", ")}`)
})

test("the historical changelogs are the only exemption", async () => {
  const links = await sidebarRoutes()
  const listedHistorical = pages()
    .map((page) => page.route)
    .filter((route) => isHistorical(route) && links.has(route))
  assert.deepEqual(listedHistorical, [])
})
