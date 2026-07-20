import { expect, test } from "@playwright/test";
import {
  expectNoPageErrors,
  openRenderedSurface,
  trackPageErrors,
} from "./surfaceTestUtils";

test("renders the honest not-wired state for a real gateway run", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const response = await page.request.post("/v1/rpc/listRuns", { data: {} });
  const frame = (await response.json()) as { payload?: Array<{ runId: string; workflowKey?: string }> };
  const run = frame.payload?.[0];
  expect(run?.runId).toBeTruthy();
  await page.goto(`/gw/${run?.workflowKey ?? "run"}/${run!.runId}/timeline`);
  await expect(page.getByTestId("timeline-not-wired")).toContainText(
    "Time travel isn't wired to the gateway yet.",
  );
  expectNoPageErrors(pageErrors);
});

test("scrubs the populated legacy timeline with keyboard and transport controls", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await openRenderedSurface(page, "timeline");
  await expect(page.getByTestId("tl-counter")).toHaveText("frame 5 / 6");
  await expect(page.getByTestId("tl-frame-label")).toContainText("deploying");

  await page.getByTestId("tl-play").click();
  await expect(page.getByTestId("tl-play")).toContainText("Play");
  await page.getByTestId("tl-jump-start").click();
  await expect(page.getByTestId("tl-counter")).toHaveText("frame 0 / 6");
  await expect(page.getByTestId("tl-historical")).toBeVisible();
  await page.getByTestId("tl-step-fwd").click();
  await expect(page.getByTestId("tl-counter")).toHaveText("frame 1 / 6");

  await page.getByTestId("tl-scrubber").press("ArrowRight");
  await expect(page.getByTestId("tl-counter")).toHaveText("frame 2 / 6");
  await page.getByTestId("tl-return-live").click();
  await expect(page.getByTestId("tl-counter")).toHaveText("frame 5 / 6");

  await page.getByTestId("tl-slider").fill("3");
  await expect(page.getByTestId("tl-counter")).toHaveText("frame 3 / 6");
  await expect(page.getByTestId("tl-frame-label")).toContainText("running tests");
  await page.getByTestId("tl-jump-end").click();
  await expect(page.getByTestId("tl-counter")).toHaveText("frame 6 / 6");
  expectNoPageErrors(pageErrors);
});
