import { expect, test } from "@playwright/test";
import { expectNoPageErrors, trackPageErrors } from "./surfaceTestUtils";

test("renders grouped ordinary results and every mode tab", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/palette");
  await expect(page.getByText("FILES", { exact: true })).toBeVisible();
  await expect(page.getByText("WORKSPACES", { exact: true })).toBeVisible();
  await expect(page.getByText("COMMANDS", { exact: true })).toBeVisible();
  await expect(page.getByTestId("palette-row").first()).toHaveClass(/is-selected/);

  const input = page.getByTestId("palette-input");
  await input.fill("auth");
  await expect(page.getByTestId("palette-results")).toContainText("auth/session.ts");
  await page.getByTestId("palette-tabs").getByRole("button", { name: "@ Files" }).click();
  await expect(input).toHaveValue("@auth");
  await page.getByTestId("palette-tabs").getByRole("button", { name: "> Commands" }).click();
  await expect(input).toHaveValue(">auth");
  await page.getByTestId("palette-tabs").getByRole("button", { name: "/ Slash" }).click();
  await expect(input).toHaveValue("/auth");
  await page.getByTestId("palette-tabs").getByRole("button", { name: "? Ask AI" }).click();
  await expect(input).toHaveValue("?auth");
  await page.getByTestId("palette-tabs").getByRole("button", { name: "All" }).click();
  await expect(input).toHaveValue("auth");
  expectNoPageErrors(pageErrors);
});

test("supports keyboard selection and pointer execution", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/palette");
  const input = page.getByTestId("palette-input");
  await input.fill("> ");
  await expect(page.getByTestId("palette-row").first()).toHaveClass(/is-selected/);
  await input.press("ArrowDown");
  await expect(page.getByTestId("palette-row").nth(1)).toHaveClass(/is-selected/);
  await input.press("Enter");
  await expect(page.getByTestId("palette-canvas")).toHaveCount(0);

  await page.goto("/palette");
  await page.getByTestId("palette-input").fill("/memory");
  await page.getByTestId("palette-row").filter({ hasText: "/memory" }).click();
  await expect(page.getByTestId("memory-canvas")).toBeVisible();
  expectNoPageErrors(pageErrors);
});

test("renders no results with the Ask AI action", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/palette");
  await page.getByTestId("palette-input").fill("no-result-zzzzzz");
  await expect(page.getByTestId("palette-empty")).toContainText("No matching results");
  await expect(page.getByRole("button", { name: "Ask AI: no-result-zzzzzz" })).toBeVisible();
  expectNoPageErrors(pageErrors);
});
