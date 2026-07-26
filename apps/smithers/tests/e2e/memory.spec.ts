import { expect, test } from "@playwright/test";
import { expectNoPageErrors, openRenderedSurface, trackPageErrors } from "./surfaceTestUtils";

test("renders real facts, namespace filtering, detail, recall results, and no results", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/memory");
  await expect(page.getByTestId("memory-fact-row")).toHaveCount(3);
  await expect(page.getByText("testing-style", { exact: true })).toBeVisible();

  await page.getByTestId("memory-namespaces").getByRole("button", { name: "agent:codex-main" }).click();
  await expect(page.getByTestId("memory-fact-row")).toHaveCount(1);
  await expect(page.getByText("specialty", { exact: true })).toBeVisible();
  await page.getByTestId("memory-fact-row").click();
  await expect(page.getByTestId("memory-fact-detail")).toContainText("Rendered browser coverage");
  await page.getByRole("button", { name: "‹ Back to list" }).click();

  await page.getByTestId("memory-mode").getByRole("button", { name: "Recall" }).click();
  await expect(page.getByTestId("memory-recall-idle")).toBeVisible();
  await page.getByTestId("memory-topk-input").fill("1");
  await page.getByTestId("memory-recall-query").fill("browser coverage");
  await page.getByTestId("memory-search").click();
  await expect(page.getByTestId("memory-result")).toHaveCount(1);
  await expect(page.getByTestId("memory-results")).toContainText("Rendered browser coverage");

  await page.getByTestId("memory-recall-query").fill("zzzz-no-memory-match");
  await page.getByTestId("memory-search").click();
  await expect(page.getByTestId("memory-recall-empty")).toContainText("No results found");
  expectNoPageErrors(pageErrors);
});

test("renders the no-facts state", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await openRenderedSurface(page, "memory-empty");
  await expect(page.getByTestId("memory-canvas")).toBeVisible();
  await expect(page.getByText("No memory facts")).toBeVisible();
  expectNoPageErrors(pageErrors);
});
