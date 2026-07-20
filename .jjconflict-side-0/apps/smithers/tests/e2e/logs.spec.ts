import { expect, test } from "@playwright/test";
import {
  expectNoPageErrors,
  openRenderedSurface,
  trackPageErrors,
} from "./surfaceTestUtils";

test("renders transcript roles and applies Follow, Hide noise, and Redact", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await openRenderedSurface(page, "logs");
  await expect(page.getByText("Reading auth/session.ts to map the token flow.")).toBeVisible();
  await expect(page.getByText(/grep "sign\("/)).toBeVisible();
  await expect(page.locator(".log-line.role-noise")).toHaveCount(2);
  await expect(page.getByText(/ROTATE_TTL=•••••/)).toBeVisible();
  await expect(page.getByText(/sk-rotate-9f21/)).toHaveCount(0);

  await page.getByRole("button", { name: /^Redact/ }).click();
  await expect(page.getByText(/ROTATE_TTL=sk-rotate-9f21/)).toBeVisible();
  await page.getByRole("button", { name: "Hide noise" }).click();
  await expect(page.locator(".log-line.role-noise")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Follow ▾/ })).toBeVisible();
  await page.getByRole("button", { name: /Follow ▾/ }).click();
  await expect(page.getByRole("button", { name: /Follow ▸/ })).toBeVisible();
  expectNoPageErrors(pageErrors);
});

test("renders populated and empty states on the real gateway logs route", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const response = await page.request.post("/v1/rpc/listRuns", { data: {} });
  const frame = (await response.json()) as { payload?: Array<{ runId: string; workflowKey?: string }> };
  const run = frame.payload?.find((row) => row.workflowKey === "e2e-task") ?? frame.payload?.[0];
  expect(run?.runId).toBeTruthy();

  await page.goto(`/gw/${run?.workflowKey ?? "e2e-task"}/${run!.runId}/logs`);
  await expect(page.getByTestId("logs-canvas")).toBeVisible();
  await expect(page.locator(".logs-stream .log-line").first()).toBeVisible();

  await page.goto("/gw/e2e-task/run-does-not-exist/logs");
  await expect(page.getByTestId("logs-canvas")).toBeVisible();
  await expect(page.locator(".surface-empty")).toBeVisible();
  expectNoPageErrors(pageErrors);
});
