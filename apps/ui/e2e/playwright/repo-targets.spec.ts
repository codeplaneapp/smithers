import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { cpSync, existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/*
 * Lane L3 (docs/LOCAL-APP.md "Auto-load flow"): opening a repository through
 * the chrome loads its Smithers targets, the stubbed panel turn renders an
 * html card, and a Run button inside that card's frame streams a target run
 * into a target-run card. The demo repository proves the loader at scale
 * (>= 82 targets); target execution happens in a throwaway copy of the
 * build-cli force-spec fixture, never in the demo checkout.
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; the real endpoint is the manual proof")

const FORCE = "/Users/williamcory/artsy/force"
// Playwright loads specs as CommonJS, so the fixture resolves from __dirname.
const FIXTURE = resolve(__dirname, "../../../../packages/build-cli/test/fixtures/force-spec")

const targetsCard = (page: Page) => page.locator(".smithers-card[data-kind=\"targets\"]")
const htmlCard = (page: Page) => page.locator(".smithers-card[data-kind=\"html\"]")
const repoCard = (page: Page) => page.locator(".smithers-card[data-kind=\"repo\"]")
const runCard = (page: Page) => page.locator(".smithers-card[data-kind=\"target-run\"]")
const htmlFrame = (page: Page) => page.locator("iframe[data-testid^=\"html-card-frame-\"]")

/** The chrome's Open repository, answered through the window.prompt fallback. */
const openRepo = async (page: Page, path: string): Promise<void> => {
  page.once("dialog", (dialog) => void dialog.accept(path))
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

test("opening the demo repository loads its targets and the stub panel", async ({ page }) => {
  test.skip(!existsSync(FORCE), `${FORCE} is not on this machine`)
  await page.goto("/")
  await openRepo(page, FORCE)
  await expect(page.getByTestId("repo-chip")).toHaveText("artsy/force")
  await expect(repoCard(page)).toBeVisible()

  const targets = targetsCard(page)
  await expect(targets).toBeVisible()
  await expect(targets.getByTestId("card-kind-targets")).toBeVisible()
  // The loader answers in a few seconds on force; the row count is the whole workspace.
  await expect.poll(() => targets.locator("[data-target-row]").count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(82)
  await expect(targets.locator("[data-target-row=\"//:detectSecrets\"]")).toBeVisible()

  const panel = htmlCard(page)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const frame = htmlFrame(page)
  await expect(frame).toBeVisible()
  const frameId = await frame.getAttribute("data-testid")
  expect(frameId).toMatch(/^html-card-frame-html-/)
  await expect(page.frameLocator("iframe[data-testid^=\"html-card-frame-\"]").getByTestId("stub-panel")).toBeVisible()
  await expect(page.locator(".smithers-chat-message[data-role=\"assistant\"]").last()).toContainText("Loaded 82 targets for artsy/force")
})

test("a Run button inside the panel streams a target run to completion", async ({ page, request }) => {
  const copy = mkdtempSync(join(tmpdir(), "smithers-force-spec-"))
  cpSync(FIXTURE, copy, { recursive: true })

  await page.goto("/")
  await openRepo(page, copy)
  await expect(repoCard(page)).toBeVisible()
  await expect.poll(() => targetsCard(page).locator("[data-target-row]").count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(81)
  await expect(htmlCard(page)).toBeVisible({ timeout: 30_000 })

  // The stub offers the first three targets; //.github:dangerCi renders a workflow file and exits 0 with no network.
  const inner = page.frameLocator("iframe[data-testid^=\"html-card-frame-\"]")
  await expect(inner.getByTestId("stub-panel")).toBeVisible()
  await inner.getByTestId("stub-run-dangerCi").click()

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

  // The maximized html card offers Open in tab (L2's card tabs); the tab renders the same card with its frame.
  const panelId = (await htmlCard(page).getAttribute("data-testid"))?.replace(/^card-/, "") ?? ""
  expect(panelId).toMatch(/^html-/)
  await htmlCard(page).getByTestId(`card-maximize-${panelId}`).click()
  await expect(htmlCard(page)).toHaveAttribute("data-maximized", "true")
  await page.getByTestId(`card-open-in-tab-${panelId}`).click()
  // openCardTab coins the tab id as `card-${cardId}` (state/controller/tabs.ts), and the
  // chrome renders `tab-${tab.id}` / `tab-body-${tab.id}` over it. Compose the id the same
  // way so the literal pin checks each half against the prefixes the app really builds.
  const cardTabId = `card-${panelId}`
  const tab = page.getByTestId(`tab-${cardTabId}`)
  await expect(tab).toHaveAttribute("data-active", "true")
  const tabBody = page.getByTestId(`tab-body-${cardTabId}`)
  await expect(tabBody).toBeVisible()
  await expect(tabBody.getByTestId(`html-card-frame-${panelId}`)).toBeVisible()
  await expect(tabBody.frameLocator("iframe").getByTestId("stub-panel")).toBeVisible()
  await page.getByTestId("tab-main").click()

  const listed = await request.get("/api/repos")
  expect(listed.status()).toBe(200)
  const { repos } = (await listed.json()) as { repos: Array<{ path: string; smithers: { detected: boolean } }> }
  const paths = repos.map((repo) => repo.path)
  expect(paths.some((path) => path.endsWith(copy.slice(copy.lastIndexOf("/"))))).toBe(true)
  if (existsSync(FORCE)) expect(paths).toContain(FORCE)
  expect(repos.every((repo) => repo.smithers.detected)).toBe(true)
})

test("a directory without Smithers files opens as a repo card and loads no targets", async ({ page }) => {
  const plain = mkdtempSync(join(tmpdir(), "smithers-plain-"))
  await page.goto("/")
  await openRepo(page, plain)
  const card = repoCard(page)
  await expect(card).toBeVisible()
  await expect(card).toContainText("no WORKSPACE.ts")
  await expect(page.getByTestId("repo-chip")).toBeVisible()
  // Nothing else follows: no targets card, no panel, no run.
  await page.waitForTimeout(1500)
  await expect(targetsCard(page)).toHaveCount(0)
  await expect(htmlCard(page)).toHaveCount(0)
})
