import { expect, test } from "@playwright/test";

/**
 * Shell + navigation: the app boots, connects to the real gateway, and every
 * nav entry routes to its surface. No mocks — the connection badge only reads
 * "Connected" once the real RPC/WS link to the seed gateway is live.
 */
test("boots and connects to the gateway", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".nav-rail")).toBeVisible();
  // The ConnectionBadge flips to "Connected" off real gateway traffic.
  await expect(page.getByText("Connected")).toBeVisible({ timeout: 15_000 });
});

const SURFACES: ReadonlyArray<{ nav: string; testid: string }> = [
  { nav: "Runs", testid: "runs-canvas" },
  { nav: "Approvals", testid: "approvals-canvas" },
  { nav: "Agents", testid: "agents-canvas" },
  { nav: "Memory", testid: "memory-canvas" },
  { nav: "Scores", testid: "scores-canvas" },
  { nav: "Triggers", testid: "crons-canvas" },
  { nav: "Prompts", testid: "prompts-canvas" },
  { nav: "Tickets", testid: "tickets-canvas" },
  { nav: "Palette", testid: "palette-canvas" },
];

for (const surface of SURFACES) {
  test(`nav: ${surface.nav} opens ${surface.testid}`, async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: surface.nav, exact: true }).click();
    await expect(page.getByTestId(surface.testid)).toBeVisible();
  });
}

test("nav: Workflows returns to the store landing", async ({ page }) => {
  await page.goto("/runs");
  await expect(page.getByTestId("runs-canvas")).toBeVisible();
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page).toHaveURL(/\/$|\/\?/);
  // The store landing renders the workflow grid (the seeded e2e-task has a UI).
  await expect(page.locator(".store")).toBeVisible();
});

test("unknown route renders the not-found page", async ({ page }) => {
  await page.goto("/does-not-exist");
  await expect(page.getByTestId("app-shell-not-found")).toBeVisible();
});
