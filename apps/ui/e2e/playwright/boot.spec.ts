import { expect, test } from "@playwright/test"

/*
 * M0 boot (LOCAL-APP.md, "Test tiers"): the local origin answers, the SPA
 * renders its chat surface, and the sign-in door is present without gating
 * anything.
 */

test("GET /api/health answers ok with node and sandbox", async ({ request }) => {
  const response = await request.get("/api/health")
  expect(response.status()).toBe(200)
  const body = (await response.json()) as {
    ok: boolean
    version: string
    pid: number
    node: { path: string; version: string } | null
    sandbox: { platform: string; enforced: boolean }
  }
  expect(body.ok).toBe(true)
  expect(typeof body.version).toBe("string")
  expect(typeof body.pid).toBe("number")
  expect(body.node === null || typeof body.node.path === "string").toBe(true)
  expect(typeof body.sandbox.platform).toBe("string")
  expect(typeof body.sandbox.enforced).toBe("boolean")
})

test("the app boots: title, transcript, composer, and the sign-in button", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveTitle(/Smithers/)
  await expect(page.getByTestId("transcript")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(page.getByTestId("chrome-sign-in")).toBeVisible()
  // Anonymous is the open state: the composer invites, nothing gates.
  await expect(page.getByTestId("composer-input")).toBeEnabled()
})
