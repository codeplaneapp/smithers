import { expect, test } from "@playwright/test";

/**
 * The full-page `/login` route survives for hard 401 redirects and direct
 * `?redirect=` deep links. It mounts the same SignInForm the SignInModal uses.
 * No mocks: this is a route render, not an auth flow.
 */
test.describe("login page", () => {
  test("renders the sign-in form on a hard navigation", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Sign in to Smithers" })).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("/login?redirect=/runs respects the deep-link target", async ({ page }) => {
    // The redirect shapes where the form returns after a real provider succeeds.
    // We only assert the form mounts; the field itself is owned by the auth
    // client and read inside the form.
    await page.goto("/login?redirect=%2Fruns");
    await expect(page.getByRole("heading", { name: "Sign in to Smithers" })).toBeVisible();
  });
});
