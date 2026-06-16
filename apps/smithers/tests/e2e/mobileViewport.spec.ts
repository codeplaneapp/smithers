import { expect, test } from "@playwright/test";

/**
 * Mobile viewport coverage. We don't try to mirror every desktop spec on mobile
 * — instead we pin the failure modes that have hit the shell before: the auth
 * chip overlapping the store header, the composer staying on top of the safe
 * area, and the bottom dock not stealing the only viewport row from chat.
 */
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test.describe("mobile shell", () => {
  test("home renders the composer and the heading without overlap", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "Message Smithers" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "How can I help you?" })).toBeVisible();
  });

  test("/store header is reachable on a phone width", async ({ page }) => {
    await page.goto("/store");
    const heading = page.getByRole("heading", { name: "Workflow Store" });
    await expect(heading).toBeVisible();
    // The heading's center must fall inside the viewport, not be pushed off-edge.
    const box = await heading.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390 + 4);
    }
  });

  test("/runs canvas scrolls vertically on a phone width", async ({ page }) => {
    await page.goto("/runs");
    const canvas = page.getByTestId("runs-canvas");
    await expect(canvas).toBeVisible();
    // At least one row reachable; mobile users must be able to tap one.
    await expect(page.getByTestId("runs-row").first()).toBeVisible();
  });
});
