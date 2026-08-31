import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { localApiGet, localApiPost } from "./localApi"

/*
 * Lane L3 (docs/LOCAL-APP.md "Auto-load flow"): opening a repository through
 * the chrome loads its Smithers targets into a trusted typed card, and that
 * card's parent-owned Run button streams a target run into a target-run card.
 * The demo repository proves the loader at scale
 * (>= 82 targets); target execution happens in a throwaway copy of the
 * build-cli force-spec fixture, never in the demo checkout.
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; the real endpoint is the manual proof")

const FORCE = "/Users/williamcory/artsy/force"
// Playwright loads specs as CommonJS, so the fixture resolves from __dirname.
const FIXTURE = resolve(__dirname, "../../../../packages/build-cli/test/fixtures/force-spec")

const targetsCard = (page: Page) => page.locator(".smithers-card[data-kind=\"targets\"]")
const repoCard = (page: Page) => page.locator(".smithers-card[data-kind=\"repo\"]")
const runCard = (page: Page) => page.locator(".smithers-card[data-kind=\"target-run\"]")
const opened: Array<string> = []
const temporary: Array<string> = []

/** The chrome's Open repository, answered through the window.prompt fallback. */
const openRepo = async (page: Page, path: string): Promise<void> => {
  page.once("dialog", (dialog) => void dialog.accept(path))
  await page.getByTestId("composer-repo-trigger").click()
  await page.getByTestId("chrome-open-repo").click()
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
  try {
    if (opened.length > 0) {
      const listed = await localApiGet(page, request, "/api/repos")
      if (listed.ok()) {
        const { repos } = (await listed.json()) as { repos: Array<{ id: string; path: string }> }
        for (const repo of repos) {
          if (opened.includes(repo.path)) await localApiPost(page, request, "/api/repo/close", { repoId: repo.id })
        }
      }
    }
  } finally {
    opened.length = 0
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
  }
})

test("opening the demo repository loads its trusted target card", async ({ page }) => {
  test.skip(!existsSync(FORCE), `${FORCE} is not on this machine`)
  await page.goto("/")
  await openRepo(page, FORCE)
  opened.push(realpathSync(FORCE))
  // The selector names the repo; the origin chip shows WHERE it is (the ~-abbreviated path), never the name again.
  await expect(page.getByTestId("composer-repo-trigger")).toContainText("artsy/force")
  await expect(page.getByTestId("repo-chip")).toContainText("~/artsy/force")
  await expect(repoCard(page)).toBeVisible()

  const targets = targetsCard(page)
  await expect(targets).toBeVisible()
  await expect(targets.getByTestId("card-kind-targets")).toBeVisible()
  // The loader answers in a few seconds on force; the row count is the whole workspace.
  await expect.poll(() => targets.locator("[data-target-row]").count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(82)
  await expect(targets.locator("[data-target-row=\"//:detectSecrets\"]")).toBeVisible()

  await expect(page.locator(".smithers-chat-message[data-role=\"assistant\"]").last()).toContainText("Loaded 82 targets for artsy/force")
  await expect(page.locator(".smithers-card[data-kind=\"html\"]")).toHaveCount(0)
})

test("a trusted Run button streams a target run to completion", async ({ page, request }) => {
  const copy = mkdtempSync(join(tmpdir(), "smithers-force-spec-"))
  temporary.push(copy)
  cpSync(FIXTURE, copy, { recursive: true })

  await page.goto("/")
  await openRepo(page, copy)
  const copyPath = realpathSync(copy)
  opened.push(copyPath)
  await expect(repoCard(page)).toBeVisible()
  await expect.poll(() => targetsCard(page).locator("[data-target-row]").count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(81)
  // //.github:dangerCi renders a workflow file and exits 0 with no network.
  const danger = targetsCard(page).locator('[data-target-row="//.github:dangerCi"]')
  await expect(danger).toBeVisible()
  await danger.getByRole("button", { name: "Run //.github:dangerCi" }).click()

  const run = runCard(page)
  await expect(run).toBeVisible()
  await expect(run).toContainText("//.github:dangerCi")
  await expect.poll(() => run.locator("[data-run-status]").getAttribute("data-run-status"), { timeout: 90_000 })
    .toMatch(/^(done|failed)$/)
  const output = run.locator("[data-testid^=\"target-run-output-\"]")
  await expect(output).not.toHaveText("")
  await expect(output).toContainText("dangerCi")
  await expect(run.locator("[data-run-status]")).toHaveAttribute("data-run-status", "done")
  await expect(run).toContainText("exit 0")

  // The maximized targets card offers Open in tab; the tab renders the same trusted card.
  const targetsId = (await targetsCard(page).getAttribute("data-testid"))?.replace(/^card-/, "") ?? ""
  expect(targetsId).toMatch(/^targets-/)
  await targetsCard(page).getByTestId(`card-maximize-${targetsId}`).click()
  await expect(targetsCard(page)).toHaveAttribute("data-maximized", "true")
  await page.getByTestId(`card-open-in-tab-${targetsId}`).click()
  // openCardTab coins the tab id as `card-${cardId}` (state/controller/tabs.ts), and the
  // chrome renders `tab-${tab.id}` / `tab-body-${tab.id}` over it. Compose the id the same
  // way so the literal pin checks each half against the prefixes the app really builds.
  const cardTabId = `card-${targetsId}`
  const tab = page.getByTestId(`tab-${cardTabId}`)
  await expect(tab).toHaveAttribute("data-active", "true")
  const tabBody = page.getByTestId(`tab-body-${cardTabId}`)
  await expect(tabBody).toBeVisible()
  await expect(tabBody.locator('[data-target-row="//.github:dangerCi"]')).toBeVisible()
  await page.getByTestId("tab-main").click()

  const listed = await localApiGet(page, request, "/api/repos")
  expect(listed.status()).toBe(200)
  const { repos } = (await listed.json()) as { repos: Array<{ path: string; smithers: { detected: boolean } }> }
  expect(repos.find((repo) => repo.path === copyPath)?.smithers.detected).toBe(true)
})

test("a directory without Smithers files opens as a repo card and loads no targets", async ({ page }) => {
  const plain = mkdtempSync(join(tmpdir(), "smithers-plain-"))
  temporary.push(plain)
  await page.goto("/")
  await openRepo(page, plain)
  opened.push(realpathSync(plain))
  const card = repoCard(page)
  await expect(card).toBeVisible()
  await expect(card).toContainText("no WORKSPACE.ts")
  await expect(page.getByTestId("repo-chip")).toBeVisible()
  // Nothing else follows: no targets card or run.
  await page.waitForTimeout(1500)
  await expect(targetsCard(page)).toHaveCount(0)
})
