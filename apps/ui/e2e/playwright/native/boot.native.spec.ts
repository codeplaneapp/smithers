import { chromium, expect, test } from "@playwright/test"

/*
 * T2 smoke on the real window (LOCAL-APP.md, "Test tiers"): the launcher
 * (run.ts) builds the app with CEF, starts it with
 * ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT and SMITHERS_LOCAL_PORT, and exports
 * the CDP endpoint as SMITHERS_NATIVE_CDP. Without it the spec is skipped
 * with the reason, so `playwright test` never fails for lack of a window.
 */
const cdp = process.env.SMITHERS_NATIVE_CDP
const origin = process.env.SMITHERS_NATIVE_ORIGIN

test.skip(cdp === undefined, "no SMITHERS_NATIVE_CDP; run `pnpm --filter smithers-ui test:e2e:native` to build and launch the app")

test("the Electrobun window loaded the local origin and rendered the composer", async () => {
  const browser = await chromium.connectOverCDP(cdp ?? "")
  try {
    const contexts = browser.contexts()
    const pages = contexts.flatMap((context) => context.pages())
    const page = pages.find((candidate) => origin !== undefined && candidate.url().startsWith(origin)) ?? pages[0]
    expect(page, "the window exposes one page over CDP").toBeDefined()
    if (page === undefined) return
    if (origin !== undefined) expect(page.url().startsWith(origin)).toBe(true)
    await expect(page).toHaveTitle(/Smithers/, { timeout: 60_000 })
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId("transcript")).toBeVisible()
  } finally {
    await browser.close()
  }
})
