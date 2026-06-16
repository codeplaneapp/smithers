import { expect, test } from "@playwright/test";

/**
 * The corner notification stack: an aria-live polite region. Launching a run
 * via "ship …" raises an ambient companion toast carrying launchRun's static
 * title ("Open Code Review", not the run's own title); submitting an "/askme"
 * topic raises an "Ask Me" workflow toast. Together they exercise the stack's
 * accumulate + per-toast dismiss path. The dev-only "Demo workflow" toast is
 * scoped out by matching specific titles, not the whole stack.
 */
test.describe("notifications stack", () => {
  test("multiple workflow toasts accumulate and dismiss independently", async ({ page }) => {
    await page.goto("/");

    const input = page.getByRole("textbox", { name: "Message Smithers" });
    const stack = page.locator(".toast-stack");

    // Launch a run via "ship …" — that posts a run card + raises a toast.
    await input.fill("ship the auth refactor");
    await input.press("Enter");

    // Send a /askme prompt; it raises an "Ask Me" workflow toast.
    await input.fill("/askme system design");
    await input.press("Enter");

    // The run launch toast is titled "Open Code Review" (launchRun's static
    // title, not the run's own title).
    const runToast = stack.locator(".toast").filter({ hasText: "Open Code Review" }).first();
    const askMeToast = stack.locator(".toast").filter({ hasText: "Ask Me" }).first();
    await expect(runToast).toBeVisible();
    await expect(askMeToast).toBeVisible();

    // Dismiss the Ask Me toast via its actions menu. The run toast stays.
    await askMeToast.locator(".toast-main").click();
    await askMeToast.getByRole("menuitem", { name: "Dismiss" }).click();
    await expect(stack.locator(".toast", { hasText: "Ask Me" })).toHaveCount(0);
    await expect(runToast).toBeVisible();
  });
});
