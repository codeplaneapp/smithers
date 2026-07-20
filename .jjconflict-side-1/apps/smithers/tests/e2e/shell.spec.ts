import { expect, test } from "@playwright/test";

/**
 * The chat-first shell. The home view is the concierge hero + composer; there is
 * no nav rail. You reach surfaces by talking to the concierge (slash commands or
 * the command menu). No mocks: everything rides the real gateway + concierge.
 */
test("home shows the concierge hero and composer", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("How can I help you?")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Smithers" })).toBeVisible();
});

test("the composer accepts input", async ({ page }) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Smithers" });
  await input.fill("hello there");
  await expect(input).toHaveValue("hello there");
});

test("the theme toggle flips light/dark", async ({ page }) => {
  await page.goto("/");
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.getByRole("button", { name: /Switch to (light|dark) mode/ }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .not.toBe(before);
});

test("the layout toggle switches to the sidebar shell", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /sidebar layout/ }).click();
  await expect(page.locator(".chat-rail")).toBeVisible();
});

test("unknown route renders the not-found page", async ({ page }) => {
  await page.goto("/does-not-exist");
  await expect(page.getByTestId("app-shell-not-found")).toBeVisible();
});
