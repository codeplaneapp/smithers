import { expect, test } from "@playwright/test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/*
 * Durable frame contract: the same card node expands in chat, frame identity
 * is addressable, browser history restores presentation, and a fork gets a
 * new branch without losing its source URL. The local server's explicitly
 * enabled manual-path adapter is used only to create a deterministic repo
 * card; production browser builds accept repository grants instead.
 */
test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the deterministic local-app lane")

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // A browser that denies storage is already an empty profile.
    }
  })
})

test("frame URLs survive reload, traverse history, preserve the card node, and fork", async ({ page }) => {
  const repository = mkdtempSync(join(tmpdir(), "smithers-frame-repo-"))
  await page.goto("/")

  page.once("dialog", (dialog) => void dialog.accept(repository))
  await page.getByTestId("chrome-open-repo").click()

  const card = page.locator('.smithers-card[data-kind="repo"]')
  await expect(card).toBeVisible()
  const cardId = (await card.getAttribute("data-testid"))?.replace(/^card-/, "")
  expect(cardId).toBeTruthy()

  await card.evaluate((node) => {
    ;(node as HTMLElement & { frameIdentity?: string }).frameIdentity = "preserved"
  })
  await card.getByTestId(`card-maximize-${cardId}`).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toMatch(/^\/w\/workspace-main\/b\/branch-main\/f\/frame-card:branch-main:/)
  expect(await card.evaluate((node) =>
    (node as HTMLElement & { frameIdentity?: string }).frameIdentity
  )).toBe("preserved")

  const maximizedUrl = page.url()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await page.getByTestId("composer-input").click()

  await page.getByTestId("frame-back").click()
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe("/w/workspace-main/b/branch-main/f/frame-root:branch-main")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await page.goForward()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")

  await page.reload()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(page.getByTestId("composer-input")).toBeVisible()

  await page.getByTestId("frame-fork").click()
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toMatch(/^\/w\/workspace-main\/b\/branch-[^/]+\/f\/frame-card:branch-[^:]+:/)
  expect(page.url()).not.toBe(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")

  await page.goBack()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
})
