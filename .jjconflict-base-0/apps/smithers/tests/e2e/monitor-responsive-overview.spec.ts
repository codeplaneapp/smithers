import { expect, test } from "@playwright/test";

const gatewayPort = Number(process.env.SMITHERS_E2E_GATEWAY_PORT ?? "7331");
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;

// This is a real-browser assertion over the real seeded gateway. CI deliberately
// has no browser binary, so keep the test discoverable but harmless there.
test.skip(Boolean(process.env.CI), "browser tests are unavailable in CI");

test.describe("responsive monitor overview", () => {
  test("keeps populated, filtered, and empty overview states usable at desktop, tablet, and mobile widths", async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${gatewayOrigin}/monitor`);
      await expect(page.getByTestId("monitor-root")).toBeVisible();
      await expect(page.getByTestId("monitor-runs")).toBeVisible();
      await expect(page.getByTestId("monitor-runs-table")).toBeVisible();
      await expect(page.getByTestId("monitor-runs-pagination")).toBeVisible();
      await expect(page.getByTestId("monitor-page-prev")).toBeDisabled();
      await expect(page.getByTestId("monitor-page-next")).toBeDisabled();

      // The shell, not just an inner table scrollport, must fit the viewport.
      expect(
        await page.evaluate(() => ({
          html: document.documentElement.scrollWidth - window.innerWidth,
          shell: (document.querySelector<HTMLElement>(".mon-shell")?.scrollWidth ?? window.innerWidth) - window.innerWidth,
        })),
      ).toEqual({ html: 0, shell: 0 });

      await page.getByTestId("monitor-filter").fill("e2e-monitor");
      await expect(page.getByTestId("monitor-runs-table")).toContainText("e2e-monitor");
      await expect(page.getByTestId("monitor-runs-pagination")).toContainText("Showing 1–1 of 1");

      await page.getByTestId("monitor-filter").fill("no-responsive-match");
      await expect(page.getByTestId("monitor-empty-detail")).toContainText("No runs match.");
      await expect(page.getByTestId("monitor-empty")).toContainText("No runs match.");
    }
  });
});
