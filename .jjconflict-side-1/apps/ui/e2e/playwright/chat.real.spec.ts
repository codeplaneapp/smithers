import { expect, test } from "@playwright/test"

/*
 * The anonymous path against the real endpoint: chat.smithers.sh with
 * origin https://canary.smithers.sh, no login, no key. Runs only when the
 * suite is started with SMITHERS_CHAT_STUB=0 (network, model spend).
 */

test.skip(process.env.SMITHERS_CHAT_STUB !== "0", "set SMITHERS_CHAT_STUB=0 to hit the real endpoint")

test("an anonymous turn gets a non-empty reply from chat.smithers.sh", async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto("/")
  const input = page.getByTestId("composer-input")
  await input.fill("Reply with the single word: ok")
  await page.getByTestId("composer-send").click()
  const assistant = page.locator(".smithers-chat-message[data-role=\"assistant\"]").last()
  await expect(assistant).toBeVisible({ timeout: 90_000 })
  await expect
    .poll(async () => ((await assistant.locator(".message-markdown").textContent()) ?? "").trim().length, {
      timeout: 90_000
    })
    .toBeGreaterThan(0)
  // No failure marker on the bubble: the turn completed, it did not error out.
  await expect(assistant.locator(".bubble-system-note")).toHaveCount(0, { timeout: 90_000 })
})
