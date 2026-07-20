import { expect, test } from "@playwright/test";
import {
  expectNoPageErrors,
  openRenderedSurface,
  trackPageErrors,
} from "./surfaceTestUtils";

test("edits live prompts across Source, Imports, Inputs, and Preview", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/prompts");
  await expect(page.getByTestId("prompts-row")).toHaveCount(2);
  await expect(page.getByTestId("prompts-editor")).toHaveValue(/Refactor/);

  await page.getByTestId("prompts-tab-imports").click();
  await expect(page.getByTestId("prompts-imports")).toContainText("Guidelines");
  await expect(page.getByTestId("prompts-imports")).toContainText("./guidelines.mdx");

  await page.getByTestId("prompts-tab-inputs").click();
  await expect(page.getByTestId("prompts-input")).toHaveCount(2);
  await page.getByTestId("prompts-input").first().fill("src/auth/session.ts");
  await expect(page.getByText("Unsaved values")).toBeVisible();
  await page.getByRole("button", { name: "Preview with values" }).click();
  await expect(page.getByTestId("prompts-preview")).toContainText("src/auth/session.ts");

  await page.getByTestId("prompts-tab-source").click();
  const editor = page.getByTestId("prompts-editor");
  await editor.fill(`${await editor.inputValue()}\nKeep the public API stable.`);
  await expect(page.getByTestId("prompts-save")).toBeVisible();
  await page.getByTestId("prompts-save").click();
  await expect(page.getByTestId("prompts-save")).toHaveCount(0);

  await page.getByTestId("prompts-tab-inputs").click();
  await page.getByTestId("prompts-input").first().fill("src/dirty.ts");
  const reviewRow = page.getByTestId("prompts-row").filter({ hasText: "review" });
  await reviewRow.click();
  await expect(page.getByTestId("prompts-discard")).toBeVisible();
  await page.getByTestId("prompts-discard").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("prompts-row").filter({ hasText: "refactor" })).toHaveClass(/is-on/);
  await reviewRow.click();
  await page.getByTestId("prompts-discard").getByRole("button", { name: "Discard" }).click();
  await expect(reviewRow).toHaveClass(/is-on/);
  await expect(page.getByTestId("prompts-editor")).toHaveValue(/Review/);
  expectNoPageErrors(pageErrors);
});

test("renders an empty prompt list", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await openRenderedSurface(page, "prompts-empty");
  await expect(page.getByText("No prompts found")).toBeVisible();
  await expect(page.getByText("Select a prompt")).toBeVisible();
  expectNoPageErrors(pageErrors);
});
