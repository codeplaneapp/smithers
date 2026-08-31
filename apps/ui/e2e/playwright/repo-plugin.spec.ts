import { expect, test } from "@playwright/test"
import type { APIRequestContext, Page } from "@playwright/test"
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { localApiGet, localApiPost } from "./localApi"

/*
 * The repo plugin (docs/LOCAL-APP.md "Plugin manifest"): a repository with a
 * valid smithers-ui.json opens with the repo-plugin card ahead of its
 * targets card, the generative panel turn is skipped (no html card), and an
 * entry's Run streams a target run from the entry's workspace. The primary
 * fixture is the tiny two-workspace repo under e2e/fixtures/repo-plugin
 * (copied to a temp dir so its .flows cache never dirties the checkout);
 * the secondary test opens the real multi-workspace aomi repo when present.
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; the real endpoint is the manual proof")

const FIXTURE = resolve(__dirname, "../fixtures/repo-plugin")
const AOMI = "/Users/williamcory/aomi"

const pluginCard = (page: Page) => page.locator(".smithers-card[data-kind=\"repo-plugin\"]")
const targetsCard = (page: Page) => page.locator(".smithers-card[data-kind=\"targets\"]")
const htmlCard = (page: Page) => page.locator(".smithers-card[data-kind=\"html\"]")
const runCard = (page: Page) => page.locator(".smithers-card[data-kind=\"target-run\"]")

/** The chrome's Open repository, answered through the window.prompt fallback. */
const openRepo = async (page: Page, path: string): Promise<void> => {
  page.once("dialog", (dialog) => void dialog.accept(path))
  await page.getByTestId("composer-repo-trigger").click()
  await page.getByTestId("chrome-open-repo").click()
}

/*
 * The web server is shared by the whole suite and the chrome's repo chip
 * names the FIRST open repository, so every repo this spec opens is closed
 * again on the way out — a leaked temp copy would steal the chip from the
 * repo-targets suite that runs after this one.
 */
const opened: Array<string> = []
const temporary: Array<string> = []

const closeOpened = async (page: Page, request: APIRequestContext): Promise<void> => {
  try {
    if (opened.length > 0) {
      const listed = await localApiGet(page, request, "/api/repos")
      if (listed.ok()) {
        const { repos } = (await listed.json()) as { repos: Array<{ id: string; path: string }> }
        for (const repo of repos) {
          if (opened.includes(repo.path)) {
            await localApiPost(page, request, "/api/repo/close", { repoId: repo.id })
          }
        }
      }
    }
  } finally {
    opened.length = 0
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
  }
}

test.beforeEach(async ({ page }) => {
  // Cards persist per browser profile; every test starts from an empty transcript.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test.afterEach(async ({ page, request }) => {
  await closeOpened(page, request)
})

test("a repo with smithers-ui.json opens with the plugin card, no panel, and Run streams from the workspace", async ({ page }) => {
  const copy = mkdtempSync(join(tmpdir(), "smithers-repo-plugin-"))
  temporary.push(copy)
  cpSync(FIXTURE, copy, { recursive: true })

  await page.goto("/")
  await openRepo(page, copy)
  // The server stores the realpath (/var/... is a symlink into /private/var on macOS).
  opened.push(realpathSync(copy))

  // The plugin card leads: manifest summary, group sections, entries, badges.
  const plugin = pluginCard(page)
  await expect(plugin).toBeVisible()
  await expect(plugin.getByTestId("card-kind-repo-plugin")).toBeVisible()
  await expect(plugin).toContainText("The tiny two-workspace fixture")
  await expect(plugin.locator("[data-group=\"checks\"]")).toContainText("Checks")
  await expect(plugin.locator("[data-group=\"recipes\"]")).toContainText("Recipes")
  const polish = plugin.locator("[data-plugin-entry=\"polish\"]")
  await expect(polish).toContainText("Polish recipe")
  await expect(polish.locator("[data-badge=\"workspace\"]")).toContainText("tools")
  await expect(polish.locator("[data-badge=\"kind\"]")).toContainText("recipe")
  await expect(polish.locator("[data-badge=\"approval\"]")).toContainText("approval")
  await expect(polish.locator("[data-badge=\"agentic\"]")).toContainText("agentic")

  // The targets card still loads, every row stamped with its workspace; the panel is skipped.
  const targets = targetsCard(page)
  await expect(targets).toBeVisible()
  await expect.poll(() => targets.locator("[data-target-row]").count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
  await expect(targets.locator("[data-target-row][data-workspace=\".\"]").first()).toBeVisible()
  await expect(targets.locator("[data-target-row][data-workspace=\"tools\"]").first()).toBeVisible()
  await expect(targets.locator("[data-target-row=\"//:polish\"][data-workspace=\"tools\"]")).toBeVisible()
  await expect(htmlCard(page)).toHaveCount(0)

  // Run the tools entry: the run streams from join(repo, "tools") to a target-run card.
  await plugin.getByTestId("plugin-run-polish").click()
  const run = runCard(page)
  await expect(run).toBeVisible()
  await expect(run).toContainText("//:polish")
  await expect.poll(() => run.locator("[data-run-status]").getAttribute("data-run-status"), { timeout: 90_000 })
    .toMatch(/^(done|failed)$/)
  await expect(run.locator("[data-run-status]")).toHaveAttribute("data-run-status", "done")
  await expect(run).toContainText("exit 0")
})

test("the aomi checkout opens with its declared plugin groups when present", async ({ page }) => {
  test.skip(!existsSync(join(AOMI, "smithers-ui.json")), `${AOMI} with a plugin manifest is not on this machine`)
  await page.goto("/")
  await openRepo(page, AOMI)
  opened.push(realpathSync(AOMI))

  const plugin = pluginCard(page)
  await expect(plugin).toBeVisible({ timeout: 30_000 })
  // Structural assertions only: the live manifest's copy is free to change.
  await expect(plugin.locator("[data-group=\"checks\"]")).toBeVisible()
  // An entry's workspace badge proves the manifest validated against the detected child workspaces.
  const sdkEntry = plugin.locator("[data-plugin-entry]", { has: page.locator("[data-badge=\"workspace\"]", { hasText: "aomi-sdk" }) }).first()
  await expect(sdkEntry).toBeVisible()
  await expect(sdkEntry.locator("[data-badge=\"kind\"]")).toBeVisible()
  // The manifest leads; the generative panel never runs for it.
  await expect(htmlCard(page)).toHaveCount(0)
})
