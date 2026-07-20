import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoPageErrors, trackPageErrors } from "./surfaceTestUtils";

const gatewayPort = Number(process.env.SMITHERS_E2E_GATEWAY_PORT ?? "7331");
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;

/** A keyboard focus cue is either an explicit outline or a visible shadow. */
async function expectFocusIndicator(locator: Locator, indicator = locator): Promise<void> {
  await expect(locator).toBeFocused();
  const matchesFocusVisible = await locator.evaluate((element) => element.matches(":focus-visible"));
  const focus = await indicator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
  expect(matchesFocusVisible).toBe(true);
  expect(
    (focus.outlineStyle !== "none" && focus.outlineWidth !== "0px") || focus.boxShadow !== "none",
  ).toBe(true);
}

async function refocusThroughKeyboard(page: Page, locator: Locator): Promise<void> {
  await locator.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
}

async function openMonitor(page: Page): Promise<void> {
  await page.goto(`${gatewayOrigin}/monitor`);
  await expect(page.getByTestId("monitor-root")).toBeVisible();
  await expect(page.getByTestId("monitor-conn")).toHaveAttribute("data-conn", "online");
  await expect(page.getByTestId("monitor-filter")).toBeVisible();
}

test.describe("keyboard navigation and focus visibility", () => {
  // The repository's CI jobs intentionally do not install a browser for this
  // package. Keep this browser-only coverage available locally without making a
  // clean CI checkout fail before it can run the normal package tests.
  test.skip(Boolean(process.env.CI), "browser coverage is run locally; CI has no browser for this package");

  test("keeps the shell composer controls in a predictable Tab order", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await page.goto("/");

    const input = page.getByRole("textbox", { name: "Message Smithers" });
    const layout = page.getByRole("button", { name: "Switch to sidebar layout" });
    const theme = page.getByRole("button", { name: /Switch to (light|dark) mode/ });
    const command = page.locator(".command-pill");

    await input.focus();
    await expect(input).toBeFocused();
    await expectFocusIndicator(input, page.locator(".composer-card"));

    await page.keyboard.press("Tab");
    await expectFocusIndicator(layout);

    await page.keyboard.press("Tab");
    await expectFocusIndicator(theme);

    await page.keyboard.press("Tab");
    await expectFocusIndicator(command);

    await page.keyboard.press("Shift+Tab");
    await expect(theme).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(layout).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(input).toBeFocused();

    expectNoPageErrors(pageErrors);
  });

  test("activates the sidebar and resizes its rail from the keyboard", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await page.goto("/");

    const layout = page.getByRole("button", { name: "Switch to sidebar layout" });
    await layout.focus();
    await layout.press("Enter");

    const rail = page.locator(".chat-rail");
    await expect(rail).toBeVisible();
    const separator = page.getByRole("separator", { name: "Resize chat panel" });
    await expect(separator).toBeVisible();
    await refocusThroughKeyboard(page, separator);
    await expectFocusIndicator(separator);

    const initialWidth = Number(await separator.getAttribute("aria-valuenow"));
    expect(initialWidth).toBeGreaterThan(0);

    await separator.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", String(initialWidth + 20));
    await separator.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", String(initialWidth));

    await separator.press("End");
    await expect(separator).toHaveAttribute("aria-valuenow", "560");
    await separator.press("Home");
    await expect(separator).toHaveAttribute("aria-valuetext", "Collapsed");
    await expect(rail).toBeHidden();

    await separator.press(" ");
    await expect(rail).toBeVisible();
    await expect(separator).toHaveAttribute("aria-valuenow", "560");
    await separator.press("Enter");
    await expect(rail).toBeHidden();
    await separator.press("Enter");
    await expect(rail).toBeVisible();

    expectNoPageErrors(pageErrors);
  });

  test("tabs through monitor filters, activates metrics, and selects a real run", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await openMonitor(page);

    const filter = page.getByTestId("monitor-filter");
    const status = page.getByTestId("monitor-status-filter");
    const workflow = page.getByTestId("monitor-workflow-filter");
    const metrics = page.getByTestId("monitor-metrics-chip");
    const refresh = page.getByRole("button", { name: "Refresh" });

    await filter.focus();
    await page.keyboard.press("Tab");
    await expectFocusIndicator(status);
    await page.keyboard.press("Tab");
    await expectFocusIndicator(workflow);
    await page.keyboard.press("Tab");
    await expectFocusIndicator(metrics);
    await metrics.press("Enter");
    await expect(page.getByTestId("monitor-metrics")).toBeVisible();
    await metrics.press("Enter");
    await expect(page.getByTestId("monitor-metrics")).toHaveCount(0);

    await page.keyboard.press("Tab");
    await expectFocusIndicator(refresh);
    await page.keyboard.press("Shift+Tab");
    await expect(metrics).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(workflow).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(status).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(filter).toBeFocused();

    const firstRun = page.getByTestId("monitor-run-row").first();
    await expect(firstRun).toBeVisible();
    await refocusThroughKeyboard(page, firstRun);
    await expectFocusIndicator(firstRun);
    await firstRun.press("Enter");
    await expect(page.getByTestId("monitor-run-detail")).toBeVisible();
    await expect(firstRun).toHaveAttribute("data-active", "true");

    expectNoPageErrors(pageErrors);
  });
});
