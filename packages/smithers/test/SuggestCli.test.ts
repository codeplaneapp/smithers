/**
 * `smthrs suggest` as an operator runs it: a real process, a real repository
 * on disk, and the exit statuses the contract publishes.
 *
 * What the process boundary proves that an in-process case cannot: that the
 * verb is registered and reachable, that `--json` returns ordered documents
 * in the canonical result, that `--list` stops
 * without asking, and that the two refusals leave the shell with 1 and 2.
 *
 * No model is reached. `--json` and `--list` prompt for nothing and implement
 * nothing, so the checklist is the whole of the work; the seat is pinned to a
 * fabricated Moonshot key over an empty home directory, so the run is
 * deterministic on any machine and a request that did try to leave would fail
 * loudly rather than spend a real credential.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

/**
 * Every case starts a real `smthrs`, which parses the whole module graph
 * through Node's type stripping and opens the project's databases. That is
 * about 15 s per case on an idle machine and, by `test/Bin.test.ts`'s
 * measured ratio, about ten times that on a two-core runner. The budget is
 * per case and finite, so a genuine hang still fails the run.
 */
const processBudget = { timeout: 600_000 }

let project: string
let home: string

/** A repository the checklist has plenty to say about. */
const stage = (root: string): void => {
  mkdirSync(join(root, ".git"), { recursive: true })
  mkdirSync(join(root, ".github", "workflows"), { recursive: true })
  mkdirSync(join(root, "packages", "core"), { recursive: true })
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "acme",
      workspaces: ["packages/*"],
      scripts: { test: "vitest run", release: "changeset publish" }
    })
  )
  writeFileSync(join(root, ".git", "config"), "[remote \"origin\"]\n\turl = git@github.com:acme/acme.git\n")
  writeFileSync(join(root, "vitest.config.ts"), "export default {}\n")
  writeFileSync(join(root, "eslint.config.js"), "export default []\n")
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n")
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), "name: ci\n")
  writeFileSync(join(root, "packages", "core", "package.json"), "{}\n")
}

/**
 * A minimal environment rather than `process.env`: a provider key exported by
 * the developer running the suite would otherwise choose a different seat,
 * and the seat is what these cases assert.
 */
const environment = (overrides: Readonly<Record<string, string>> = {}) => ({
  PATH: process.env["PATH"] ?? "",
  HOME: home,
  NO_COLOR: "1",
  ...overrides
})

const run = (
  args: ReadonlyArray<string>,
  overrides?: Readonly<Record<string, string>>
) =>
  spawnSync(process.execPath, ["--no-warnings", executable, ...args], {
    cwd: project,
    encoding: "utf8",
    timeout: 180_000,
    env: environment(overrides)
  })

const seated = { MOONSHOT_API_KEY: "fabricated-moonshot-key" }

beforeAll(() => {
  // Real path, not the `/var` symlink macOS hands back: the outcome document
  // reports the root the CLI resolved, which is the resolved one.
  project = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-suggest-cli-")))
  // An empty home, so `~/.codex/auth.json` cannot exist and the documented
  // seat order falls through to the key below.
  home = mkdtempSync(join(tmpdir(), "smthrs-suggest-home-"))
  stage(project)
})

afterAll(() => {
  for (const directory of [project, home]) {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

describe("smthrs suggest --json", processBudget, () => {
  it("returns suggestions in order, then the seat and the outcome", () => {
    const result = run(["suggest", "--json"], seated)

    expect(result.status).toBe(0)
    const outcome = JSON.parse(result.stdout) as { status: string; documents: Array<Record<string, unknown>> }
    expect(outcome.status).toBe("listed")
    const documents = outcome.documents
    // Suggestions first, in the order the checklist matched them, then the
    // two documents that close the stream.
    expect(documents.map((document) => document.document)).toEqual([
      ...documents.slice(0, -2).map(() => "suggestion"),
      "seat",
      "outcome"
    ])
    expect(documents.slice(0, -2).map((document) => document.id)).toEqual([
      "test-target",
      "lint-target",
      "agents-md",
      "release-notes",
      "pr-review",
      "repeated-script",
      "changelog",
      "build-graph",
      "sandboxed-review"
    ])
    expect(documents.slice(0, -2).map((document) => document.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(documents.at(-2)).toEqual({
      document: "seat",
      seat: "moonshot:kimi-k3",
      source: "kimi-k3",
      label: "Kimi K3"
    })
    expect(documents.at(-1)).toMatchObject({
      document: "outcome",
      status: "listed",
      seat: "moonshot:kimi-k3",
      root: project,
      implemented: []
    })
    expect(result.stderr).toBe("")
  })
})

describe("smthrs suggest --list", processBudget, () => {
  it("keeps redirected human output structured and exits without asking", () => {
    const result = run(["suggest", "--list", "--audience", "human"], seated)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("status: listed")
    expect(result.stdout).toContain("seat: \"moonshot:kimi-k3\"")
    expect(result.stdout).toContain("vitest is the test runner")
    expect(result.stdout).toContain("sandboxed-review")
    // No question was asked, so no answer is waiting to be given.
    expect(result.stdout + result.stderr).not.toContain("Which one should I implement?")
    expect(result.stderr).toBe("")
  })

  it("reads the directory it is pointed at, not the one it was started in", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "smthrs-suggest-elsewhere-"))
    try {
      writeFileSync(join(elsewhere, "package.json"), JSON.stringify({ scripts: { test: "jest" } }))
      const result = run(["suggest", realpathSync(elsewhere), "--list"], seated)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain("jest is the test runner")
      expect(result.stdout).not.toContain("A review flow for pull requests")
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe("the refusals", processBudget, () => {
  it("exits 1 naming every seat it looked for when the machine has none", () => {
    const result = run(["suggest", "--list", "--json"])

    expect(result.status).toBe(1)
    const error = JSON.parse(result.stdout) as { code: string; message: string }
    expect(error.code).toBe("UnsupportedError")
    expect(error.message).toContain("No model seat is available for `smthrs suggest`. It looked for:")
    expect(error.message).toContain("Kimi K3 (moonshot:kimi-k3): $MOONSHOT_API_KEY is not set")
    // The hint survives the redaction every failure line goes through.
    expect(error.message).toContain("set MOONSHOT_API_KEY to your API key")
    expect(error.message).toContain("Or pass --seat <provider:model>")
  })

  it("exits 2 for a --seat that is not provider:model", () => {
    const result = run(["suggest", "--seat", "kimi", "--list", "--json"], seated)

    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "UsageError",
      message: "--seat must be spelled provider:model, got \"kimi\""
    })
  })

  it("exits 2 for a path that is not a directory", () => {
    const result = run(["suggest", join(project, "package.json"), "--list", "--json"], seated)

    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "UsageError",
      message: expect.stringContaining("must be a directory")
    })
  })
})
