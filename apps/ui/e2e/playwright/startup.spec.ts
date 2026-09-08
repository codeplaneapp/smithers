import { expect, test } from "@playwright/test"

test("a late boot recovers after the startup watchdog without losing React's mount point", async ({ page }) => {
  await page.clock.install()
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const requested = new Promise<void>((resolve) => { reached = resolve })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/ControllerBoot.client*.js", async (route) => {
    reached()
    await held
    await route.continue()
  })
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await requested
    await expect(page.locator("[data-server-session=loading]")).toContainText("Smithers is starting your session.")
    await expect(page.locator("body")).not.toContainText("This build isn't connected")
    // The bundle is deliberately still in flight after the watchdog's budget.
    await page.clock.fastForward(90_000)
    await expect(page.locator("[data-startup-failure]")).toContainText("Smithers failed to start")
    await expect(page.locator("#root [data-server-session=loading]")).toHaveCount(1)
    release()
    await page.clock.resume()
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 20_000 })
    await expect(page.locator("[data-startup-failure]")).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    release()
  }
})
