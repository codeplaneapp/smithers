import { expect, test } from "@playwright/test";

/**
 * Keyboard navigation through the CommandMenu pill. The pill is a menu-button
 * with aria-haspopup="menu"; Space and Enter open the menu, Escape closes it,
 * and Tab moves focus through the items. We only assert the controls the user
 * actually drives via the keyboard, never the menu's internal arrow-key model
 * (which differs by implementation and is brittle to pin).
 */
test.describe("command menu keyboard", () => {
  test("Enter opens the menu, Escape closes it and returns focus", async ({ page }) => {
    await page.goto("/");

    const viewNav = page.getByRole("navigation", { name: "View navigation" });
    const pill = viewNav.getByRole("button", { name: "Chat" });
    await pill.focus();
    await expect(pill).toBeFocused();
    await expect(pill).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("Enter");
    await expect(pill).toHaveAttribute("aria-expanded", "true");
    await expect(viewNav.getByRole("menuitemradio", { name: /Store/ })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(pill).toHaveAttribute("aria-expanded", "false");
    await expect(pill).toBeFocused();
  });
});
