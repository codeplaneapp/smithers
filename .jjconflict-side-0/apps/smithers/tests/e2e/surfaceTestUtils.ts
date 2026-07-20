import { expect, type Page } from "@playwright/test";

/** Collect uncaught browser errors and assert them at the end of a rendered flow. */
export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

export function expectNoPageErrors(errors: string[]): void {
  expect(errors, errors.join("\n")).toEqual([]);
}

/** Open a component-only rendered state through the real Vite browser bundle. */
export async function openRenderedSurface(page: Page, surface: string): Promise<void> {
  await page.goto(`/tests/e2e/rendered-harness.html?surface=${encodeURIComponent(surface)}`);
  await expect(page.getByTestId("harness-error")).toHaveCount(0);
}
