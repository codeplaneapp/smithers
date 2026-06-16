import { expect, test, type Page } from "@playwright/test";

/**
 * Deep links. Every URL-routed surface in SURFACES below (`/runs`, `/agents`,
 * `/crons`, `/memory`, `/prompts`, `/scores`, `/issues`, `/tickets`,
 * `/landings`, `/store`) must mount cleanly from a fresh navigation, without an
 * uncaught error. The surface's data-testid is the canonical landing signal
 * because it survives the router/zustand churn.
 */
const SURFACES: { path: string; testId: string }[] = [
  { path: "/runs", testId: "runs-canvas" },
  { path: "/agents", testId: "agents-canvas" },
  { path: "/crons", testId: "crons-canvas" },
  { path: "/memory", testId: "memory-canvas" },
  { path: "/prompts", testId: "prompts-canvas" },
  { path: "/scores", testId: "scores-canvas" },
  { path: "/issues", testId: "issues-canvas" },
  { path: "/tickets", testId: "tickets-canvas" },
  { path: "/landings", testId: "landings-canvas" },
  { path: "/store", testId: "" }, // Store uses a heading, no testid.
];

test.describe("deep links", () => {
  for (const surface of SURFACES) {
    test(`a fresh navigation to ${surface.path} mounts without uncaught errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));

      await page.goto(surface.path);
      if (surface.testId) {
        await expect(page.getByTestId(surface.testId)).toBeVisible();
      } else {
        await expect(page.getByRole("heading", { name: "Workflow Store" })).toBeVisible();
      }
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  test("deep-link survives a reload (URL is the source of truth)", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByTestId("agents-canvas")).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByTestId("agents-canvas")).toBeVisible();
  });
});
