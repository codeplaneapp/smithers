import assert from "node:assert/strict"
import test from "node:test"
import { isHistorical, pages, parseFrontmatter, routeOf } from "./docs-pages.mjs"
import { build, demoteHeadings, excluded, orderRoutes, renderPage, topics } from "./generate-llms.ts"
import { bundlePaths, checkedPaths, collapseWhitespace, dropNavigation, optimize, stripInternalLinks } from "./optimize-llms-full.ts"

test("splits frontmatter off a page", () => {
  const { frontmatter, body } = parseFrontmatter('---\ndescription: "one"\n---\n\n# Title\n\nBody\n')
  assert.equal(frontmatter.description, "one")
  assert.equal(body, "# Title\n\nBody\n")
})

test("a page with no frontmatter keeps its whole body", () => {
  const { frontmatter, body } = parseFrontmatter("# Title\n")
  assert.deepEqual(frontmatter, {})
  assert.equal(body, "# Title\n")
})

test("maps a page file to its route", () => {
  assert.equal(routeOf(`${process.cwd()}/docs/pages/index.mdx`), "/")
  assert.equal(routeOf(`${process.cwd()}/docs/pages/cli/ps.md`), "/cli/ps")
})

test("every route the tree serves belongs to one topic or is excluded", () => {
  for (const page of pages()) {
    if (excluded(page.route)) continue
    const matched = topics.filter((topic) => topic.matches(page.route))
    assert.ok(matched.length > 0, `${page.route} belongs to no topic`)
  }
})

test("the Smithers 0.x changelogs are excluded and marked historical", () => {
  assert.equal(excluded("/changelogs/0.35.0"), true)
  assert.equal(isHistorical("/changelogs/0.35.0"), true)
  assert.equal(excluded("/changelogs/compatibility-policy"), false)
  assert.equal(isHistorical("/changelogs/compatibility-policy"), false)
})

test("orders a topic by its leading routes, then alphabetically", () => {
  const topic = topics.find((candidate) => candidate.name === "core")
  const ordered = orderRoutes(topic, ["/guides/testing", "/installation", "/"])
  assert.deepEqual(ordered, ["/", "/installation", "/guides/testing"])
})

test("demotes headings outside code fences only", () => {
  const body = ["## Section", "", "```bash", "# not a heading", "```", "", "### Deeper"].join("\n")
  assert.equal(demoteHeadings(body), ["### Section", "", "```bash", "# not a heading", "```", "", "#### Deeper"].join("\n"))
})

test("renders a page section with its route and description", () => {
  const section = renderPage({
    route: "/cli/ps",
    title: "smithers ps",
    description: "List durable runs",
    body: "# smithers ps\n\n## Usage\n\nText\n"
  })
  assert.match(section, /^## smithers ps\n\nRoute: \/cli\/ps\n\n> List durable runs\n\n### Usage/)
})

test("drops a navigation section and keeps the one after it", () => {
  const text = "### Source\n\nGenerated.\n\n## Next page\n\nKept.\n"
  assert.doesNotMatch(dropNavigation(text), /Generated\./)
  assert.match(dropNavigation(text), /Kept\./)
})

test("strips an internal link and keeps an external one", () => {
  assert.equal(stripInternalLinks("see [the CLI](/cli)"), "see the CLI")
  assert.equal(stripInternalLinks("see [npm](https://npmjs.com)"), "see [npm](https://npmjs.com)")
})

test("collapses the whitespace a removal leaves", () => {
  assert.equal(collapseWhitespace("a\n\n\n\nb   \n"), "a\n\nb\n")
})

test("optimizing twice changes nothing the second time", () => {
  const once = optimize("# Title\n\nsee [the CLI](/cli)\n\n### Source\n\nGenerated.\n\n---\n\n---\n\n## Next\n")
  assert.equal(optimize(once), once)
})

test("builds every artifact the CLI, the skill, and the site read", () => {
  const { artifacts } = build()
  for (const path of [
    "docs/llms.txt",
    "docs/llms-full.txt",
    "docs/llms-core.txt",
    "packages/cli/docs/llms.txt",
    "packages/cli/docs/llms-full.txt",
    "skills/smithers/llms-full.txt"
  ]) {
    assert.ok(artifacts.has(path), `${path} was not built`)
  }
  assert.equal(artifacts.get("docs/llms-full.txt"), artifacts.get("skills/smithers/llms-full.txt"))
  assert.match(artifacts.get("docs/llms.txt"), /^# Smithers\n/)
  assert.match(artifacts.get("docs/llms-full.txt"), /Version: \d+\.\d+\.\d+/)
})

test("building twice from one tree produces the same bytes", () => {
  const first = build().artifacts
  const second = build().artifacts
  for (const [path, content] of first) assert.equal(second.get(path), content, `${path} is not byte-stable`)
})

test("no bundle carries a Smithers 0.x changelog", () => {
  const full = build().artifacts.get("docs/llms-full.txt")
  assert.doesNotMatch(full, /Route: \/changelogs\/0\./)
})

test("every artifact the pipeline writes is one check-llms compares", () => {
  // `packages/cli/docs/SKILL.md` is copied rather than optimized, so it does not
  // belong in `bundlePaths`, which is the optimizer's input. It is still an
  // artifact this pipeline writes, and an artifact no gate reads goes stale the
  // first time its source changes.
  const written = [...build().artifacts.keys(), "packages/cli/docs/SKILL.md"]
  const checked = new Set(checkedPaths)
  const ungated = written.filter((path) => !checked.has(path))
  assert.deepEqual(ungated, [])
})

test("the optimizer's input is the bundles, not the copies", () => {
  assert.ok(!bundlePaths.includes("packages/cli/docs/SKILL.md"))
  assert.ok(checkedPaths.length > bundlePaths.length)
})
