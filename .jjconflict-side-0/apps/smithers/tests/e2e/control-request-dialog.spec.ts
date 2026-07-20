import { expect, test } from "@playwright/test";

const isCi = Boolean(process.env.CI);
const dialogName = "Let Smithers control the app?";
const reason = "Switch the theme for this review.";

test.describe("control request dialog", () => {
  test.skip(isCi, "browser-driven coverage is skipped in CI");

  test.beforeEach(async ({ page }) => {
    await page.goto("/tests/e2e/control-request-dialog.html");
  });

  test("exposes its modal role, name, description, and actions", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "Request control" });
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: dialogName });
    const deny = dialog.getByRole("button", { name: "Deny" });
    const allow = dialog.getByRole("button", { name: "Allow" });

    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(dialogName);
    await expect(dialog).toHaveAccessibleDescription(
      new RegExp(`${reason}.*Switch to dark theme`),
    );
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("aria-labelledby", "control-dialog-title");
    await expect(dialog).toHaveAttribute("aria-describedby", "control-dialog-description");
    await expect(dialog.getByRole("heading", { name: dialogName })).toHaveAttribute(
      "id",
      "control-dialog-title",
    );
    await expect(dialog.getByText(reason)).toBeVisible();
    await expect(dialog.getByText("Switch to dark theme")).toBeVisible();
    await expect(deny).toHaveAccessibleName("Deny");
    await expect(allow).toHaveAccessibleName("Allow");
    await expect(deny).toBeFocused();
  });

  test("supports keyboard approval and denial while keeping focus in the dialog", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "Request control" });
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: dialogName });
    const deny = dialog.getByRole("button", { name: "Deny" });
    const allow = dialog.getByRole("button", { name: "Allow" });

    await expect(deny).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(allow).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(deny).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("status")).toHaveCount(0);

    await trigger.click();
    await expect(deny).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(allow).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("status")).toContainText("Smithers is controlling the app");
  });

  test("denies the control request when its backdrop is clicked", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "Request control" });
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: dialogName });
    await expect(dialog).toBeVisible();
    await page.locator(".control-dialog-backdrop").click({ position: { x: 1, y: 1 } });
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("status")).toHaveCount(0);
  });
});
