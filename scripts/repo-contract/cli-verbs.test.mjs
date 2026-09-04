/**
 * The CLI reference pages match the shipped command tree.
 *
 * This checks `Verb.subcommands`, not `Verb.names`: `completions` is shipped
 * as the built-in `--completions` flag rather than as a command-tree
 * subcommand, so it does not have a CLI reference page. Reading `Verb.ts` as
 * text keeps this repository-wide gate from loading the CLI and its control
 * runtime just to inspect its declarative command table.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..")

const subcommands = (source) => {
  const table = source.match(/export const shipped:[\s\S]*?= \[([\s\S]*?)\n\]/)?.[1]
  assert.ok(table, "packages/smithers/src/Verb.ts must declare the shipped verb table")
  return [...table.matchAll(/verb\("([^"]+)"/g)]
    .filter((match) => match[1] !== "completions")
    .map((match) => match[1])
}

const compare = (verbs, pages) => {
  const expected = new Set(verbs)
  const documented = new Set(pages)
  return [
    ...[...documented].filter((page) => !expected.has(page)).map((page) => `reference/cli/${page}.mdx documents no shipped verb: ${page}`),
    ...[...expected].filter((verb) => !documented.has(verb)).map((verb) => `shipped verb has no reference/cli page: ${verb}`)
  ]
}

const cliPages = (directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".mdx") && name !== "index.mdx")
    .map((name) => name.slice(0, -4))

const markdownFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", "coverage", ".git", ".flows"].includes(entry.name)) return []
    const path = join(directory, entry.name)
    return entry.isDirectory() ? markdownFiles(path) : entry.isFile() && /\.mdx?$/.test(entry.name) ? [path] : []
  })

describe("the CLI reference", () => {
  const verbSource = readFileSync(join(root, "packages/smithers/src/Verb.ts"), "utf8")
  const pagesDirectory = join(root, "apps/site/src/content/docs/docs/reference/cli")

  it("has one page for each shipped subcommand and no other verb pages", () => {
    assert.deepEqual(compare(subcommands(verbSource), cliPages(pagesDirectory)), [])
  })

  it("rejects an added page for a nonexistent verb", () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-cli-reference-"))
    try {
      writeFileSync(join(directory, "run.mdx"), "")
      writeFileSync(join(directory, "imaginary.mdx"), "")
      assert.deepEqual(compare(["run"], cliPages(directory)), [
        "reference/cli/imaginary.mdx documents no shipped verb: imaginary"
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects a removed page for a shipped verb", () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-cli-reference-"))
    try {
      writeFileSync(join(directory, "run.mdx"), "")
      assert.deepEqual(compare(["run", "status"], cliPages(directory)), [
        "shipped verb has no reference/cli page: status"
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("names the dist-tag the update command actually reads", () => {
    const files = [
      ...markdownFiles(join(root, "packages/smithers/docs")),
      ...markdownFiles(join(root, "apps/docs/cli/src/content/docs")),
      ...markdownFiles(join(root, "apps/site/src/content/docs/docs"))
    ]
    const stale = files.flatMap((file) => {
      const contents = readFileSync(file, "utf8")
      return /(?:the |against the? )?`rc` and `latest`|under the `rc` tag|compares `rc` first|available \(rc\)/.test(contents)
        ? [file.slice(root.length + 1)]
        : []
    })

    assert.deepEqual(stale, [], `update documentation must name the next dist-tag:\n${stale.join("\n")}`)
  })

  it("keeps installation commands on a published CLI tag", () => {
    const files = [
      ...markdownFiles(join(root, "packages")),
      ...markdownFiles(join(root, "apps/site/src/content/docs"))
    ]
    const stale = files.flatMap((file) => readFileSync(file, "utf8").split("\n")
      .filter((line) => /(?:npm (?:install|i)|npx|pnpm (?:add|dlx)|bun (?:add|x))\b/.test(line) && !line.includes("--filter"))
      .filter((line) => /@smthrs\/cli(?=[\s`";]|$)/.test(line))
      .map(() => file.slice(root.length + 1)))
    assert.deepEqual(stale, [], `CLI install commands need an explicit tag: ${stale.join(", ")}`)
  })

  it("documents the built-in input and logging flags", () => {
    const page = readFileSync(join(pagesDirectory, "index.mdx"), "utf8")
    for (const flag of ["--wizard", "--log-level"]) assert.ok(page.includes(`| \`${flag}\` |`))
  })

  it("identifies the review service separately from the removed CLI verb", () => {
    const page = readFileSync(join(root, "apps/site/src/content/docs/docs/guides/pr-review-action.mdx"), "utf8")
    assert.ok(page.includes("`smithers-review`"))
    assert.ok(page.includes("review` subcommand was removed"))
    assert.ok(!page.includes("`smthrs review` runs"))
  })

})
