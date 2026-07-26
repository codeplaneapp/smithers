import { expect, test } from "@playwright/test";
import { expectNoPageErrors, openRenderedSurface, trackPageErrors } from "./surfaceTestUtils";

test("renders every file status and exercises file and global expansion", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await openRenderedSurface(page, "diff");
  const rows = page.getByTestId("diff-file-row");
  await expect(rows).toHaveCount(6);
  await expect(rows.filter({ hasText: "auth/session.ts" })).toContainText("M");
  await expect(rows.filter({ hasText: "auth/index.ts" })).toContainText("A");
  await expect(rows.filter({ hasText: "auth/legacy-session.ts" })).toContainText("D");
  await expect(rows.filter({ hasText: "auth/middleware.ts" })).toContainText("R");
  await expect(rows.filter({ hasText: "avatar-default.png" })).toContainText("Binary");

  await rows.filter({ hasText: "auth/index.ts" }).click();
  await expect(page.locator('.diff-file-block[data-active="true"]')).toContainText("New file");
  await rows.filter({ hasText: "auth/legacy-session.ts" }).click();
  await expect(page.locator('.diff-file-block[data-active="true"]')).toContainText("File deleted");
  await rows.filter({ hasText: "auth/middleware.ts" }).click();
  await expect(page.locator('.diff-file-block[data-active="true"]')).toContainText("from auth/auth-mw.ts");
  await rows.filter({ hasText: "avatar-default.png" }).click();
  await expect(page.locator('.diff-file-block[data-active="true"]')).toContainText("Binary file");

  await page.getByTestId("diff-expand-controls").getByRole("button", { name: "Collapse all" }).click();
  await expect(page.locator(".diff-file-block:not(.diff-collapsed)")).toHaveCount(0);
  await page.getByTestId("diff-expand-controls").getByRole("button", { name: "Expand all" }).click();
  await expect(page.locator(".diff-file-block:not(.diff-collapsed)")).toHaveCount(6);
  await page.getByTestId("diff-file-head").first().click();
  await expect(page.locator(".diff-file-block:not(.diff-collapsed)")).toHaveCount(5);
  expectNoPageErrors(pageErrors);
});

test("renders the empty diff state", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await openRenderedSurface(page, "diff-empty");
  await expect(page.getByText("No file changes.")).toBeVisible();
  expectNoPageErrors(pageErrors);
});
