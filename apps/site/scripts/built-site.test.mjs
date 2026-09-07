import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { checkBuiltSite, releaseReferences } from "./check-built-site.mjs"

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "smithers-built-site-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  return root
}

test("a canonical page alone does not satisfy the versioned URL emitted by the release", (t) => {
  const root = fixture(t, { "changelogs/100-rc0/index.html": "<h1>Release candidate</h1>" })
  const result = checkBuiltSite(root, ["https://smithers.sh/changelogs/1.0.0-rc.0"])
  assert.equal(result.pageCount, 1)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /missing https:\/\/smithers\.sh\/changelogs\/1\.0\.0-rc\.0/)
})

test("built HTTP aliases resolve release URLs and preserve migration anchors", (t) => {
  const root = fixture(t, {
    "changelogs/100-rc0/index.html": "<h1>Release candidate</h1>",
    "docs/migration/1.0/index.html": "<h2 id=\"rewind\">Rewind</h2>",
    "_redirects": "/changelogs/1.0.0-rc.0 /changelogs/100-rc0/ 301\n/migration/1.0 /docs/migration/1.0/ 301\n"
  })
  const references = ["https://smithers.sh/changelogs/1.0.0-rc.0", "https://smithers.sh/migration/1.0#rewind"]
  assert.deepEqual(checkBuiltSite(root, references).failures, [])
  const missingAnchor = checkBuiltSite(root, ["https://smithers.sh/migration/1.0#removed-heading"])
  assert.equal(missingAnchor.failures.length, 1)
  assert.match(missingAnchor.failures[0], /missing anchor.*\/docs\/migration\/1\.0\/#removed-heading/)
})

test("the first redirect overrides an existing asset and preserves explicit fragment replacements", (t) => {
  const root = fixture(t, {
    "old/index.html": "<h2 id=\"old\">Stale page</h2>",
    "new/index.html": "<h2 id=\"new\">Current page</h2>",
    "_redirects": "/old /new/#new 301\n/old /missing 301\n"
  })
  assert.deepEqual(checkBuiltSite(root, ["/old#old"]).failures, [])
})

test("splat redirects and literal exceptions resolve in file order", (t) => {
  const root = fixture(t, {
    "index.html": "<a href=\"/api/renamed#current\">Old link</a><a href=\"/api/other\">Other API</a>",
    "docs/current/index.html": "<h2 id=\"current\">Current API</h2>",
    "docs/api/other/index.html": "<h1>Other API</h1>",
    "_redirects": "/api/renamed /docs/current/ 301\n/api/* /docs/api/:splat/ 301\n"
  })
  assert.deepEqual(checkBuiltSite(root).failures, [])
})

test("missing redirect destinations and cycles fail even without a page linking them", (t) => {
  const root = fixture(t, {
    "index.html": "<h1>Home</h1>",
    "_redirects": "/old /missing 301\n/a /b 301\n/b /a 301\n"
  })
  const { failures } = checkBuiltSite(root)
  assert.ok(failures.some((failure) => /missing \/old/.test(failure)))
  assert.ok(failures.some((failure) => /redirect cycle/.test(failure)))
})

test("page links and assets retain their existing checks", (t) => {
  const root = fixture(t, {
    "index.html":
      "<a href=\"/guide#absent\">Guide</a><img src=\"/missing.png\"><a href=\"https://example.com\">External</a>",
    "guide/index.html": "<h2 id=\"present\">Guide</h2>"
  })
  const { failures } = checkBuiltSite(root)
  assert.equal(failures.length, 2)
  assert.ok(failures.some((failure) => /missing anchor \/guide#absent/.test(failure)))
  assert.ok(failures.some((failure) => /missing \/missing\.png/.test(failure)))
})

test("app-served paths are exempt only when named, and only at that exact path", (t) => {
  const root = fixture(t, {
    "index.html":
      "<a href=\"https://smithers.sh/smithersai/smithers\">Open in Smithers</a><a href=\"/api/public/repos\">Catalog</a><a href=\"https://smithers.sh/smithersai/smithers/issues\">Issues</a>"
  })
  const unnamed = checkBuiltSite(root).failures
  assert.equal(unnamed.length, 3)
  assert.ok(unnamed.some((failure) => /missing https:\/\/smithers\.sh\/smithersai\/smithers /.test(failure)))
  assert.deepEqual(checkBuiltSite(root, [], ["/api/public/repos", "/smithersai/smithers"]).failures, [
    "index.html: missing https://smithers.sh/smithersai/smithers/issues (resolved to /smithersai/smithers/issues)"
  ])
})

test("release URLs use the emitted removal table and exclude canonical verbs and prose punctuation", async (t) => {
  const root = fixture(t, {
    "packages/smithers/src/Unsupported.ts": `
export const migrationUrl = "https://smithers.sh/migration/1.0"
export const removedVerbs = [{ name: "rewind" }, { name: "worktrees", subcommands: ["list"] }, { name: "graph" }, { name: "new-removal" }]
export const removedFlags = [{ anchor: "databases" }]
`,
    "packages/smithers/src/cli/Compatibility.ts":
      `export const legacyArguments = (args) => args[0] === "graph" ? undefined : args`,
    "apps/site/src/data/removed-commands.json": JSON.stringify({
      migrationUrl: "https://smithers.sh/migration/1.0",
      anchors: ["rewind", "worktrees", "databases", "flows", "run-data"]
    }),
    "CHANGELOG.md":
      "See https://smithers.sh/changelogs/1.0.0-rc.0. Older https://smithers.sh/changelogs/0.34.0, also [current](https://smithers.sh/changelogs/1.0.0-rc.0)."
  })
  const references = await releaseReferences(root)
  assert.ok(references.includes("https://smithers.sh/migration/1.0#rewind"))
  assert.ok(references.includes("https://smithers.sh/migration/1.0#worktrees"))
  assert.ok(references.includes("https://smithers.sh/migration/1.0#databases"))
  assert.ok(!references.includes("https://smithers.sh/migration/1.0#graph"))
  assert.ok(references.includes("https://smithers.sh/migration/1.0#new-removal"))
  assert.deepEqual(references.filter((url) => url.includes("/changelogs/")), [
    "https://smithers.sh/changelogs/1.0.0-rc.0",
    "https://smithers.sh/changelogs/0.34.0"
  ])
})

test("social card images are required references, whether emitted by path or by site URL", (t) => {
  const root = fixture(t, {
    "index.html":
      "<meta property=\"og:image\" content=\"https://smithers.sh/media/absent.png\"><meta name=\"twitter:image\" content=\"/media/og.png\">",
    "docs/index.html":
      "<meta property=\"og:image\" content=\"https://cdn.example.com/card.png\"><meta name=\"twitter:image\" content=\"https://smithers.sh/media/og.png\">",
    "media/og.png": "png"
  })
  const { failures } = checkBuiltSite(root)
  assert.deepEqual(failures, [
    "index.html: missing https://smithers.sh/media/absent.png (resolved to /media/absent.png)"
  ])
})
