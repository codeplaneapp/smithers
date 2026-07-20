import { expect, test } from "@playwright/test";

/** Composer command handling: layout slashes and submit behavior. */
async function send(page: import("@playwright/test").Page, text: string) {
  const input = page.getByRole("textbox", { name: "Message Smithers" });
  await input.fill(text);
  await input.press("Enter");
}

test("/sidebar switches to the sidebar layout", async ({ page }) => {
  await page.goto("/");
  await send(page, "/sidebar");
  await expect(page.locator(".chat-rail")).toBeVisible();
});

test("/normal returns to the centered layout", async ({ page }) => {
  await page.goto("/");
  await send(page, "/sidebar");
  await expect(page.locator(".chat-rail")).toBeVisible();
  await send(page, "/normal");
  await expect(page.locator(".chat-rail")).toHaveCount(0);
});

test("the composer clears after submitting", async ({ page }) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Smithers" });
  await input.fill("ship a landing page");
  await input.press("Enter");
  await expect(input).toHaveValue("");
});
