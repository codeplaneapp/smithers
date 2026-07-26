import { expect, test } from "@playwright/test";
import { expectNoPageErrors, openRenderedSurface, trackPageErrors } from "./surfaceTestUtils";

test("resolves the real workspace repository, metadata, changes, and refresh", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/vcs");
  const repo = page.getByTestId("vcs-git").or(page.getByTestId("vcs-jj")).first();
  await expect(repo).toBeVisible();
  await expect(repo.locator(".vcs-panel-head p")).not.toBeEmpty();
  await expect(repo.locator(".vcs-meta-grid strong").first()).not.toBeEmpty();
  await expect(repo.locator(".vcs-pill")).toHaveText(/Clean|\d+ changed/);
  const changed = await page.getByTestId("vcs-change-row").count();
  if (changed === 0) {
    await expect(repo).toContainText("Working tree is clean");
  } else {
    await expect(page.getByTestId("vcs-change-row").first()).not.toBeEmpty();
  }
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expect(repo).toBeVisible();
  expectNoPageErrors(pageErrors);
});

test("renders loading, no-repository, and backend-error presentations", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await openRenderedSurface(page, "vcs-loading");
  await expect(page.getByText("Loading VCS status...")).toBeVisible();
  await openRenderedSurface(page, "vcs-no-repo");
  await expect(page.getByTestId("vcs-no-repo")).toContainText("No local git or jj repository");
  await openRenderedSurface(page, "vcs-error");
  await expect(page.locator(".vcs-banner.error")).toContainText("failed (500)");
  await expect(page.getByText("Loading VCS status...")).toBeVisible();
  expectNoPageErrors(pageErrors);
});
