import { expect, test } from "@playwright/test";
import {
  expectNoPageErrors,
  openRenderedSurface,
  trackPageErrors,
} from "./surfaceTestUtils";

async function ticketRows(
  page: import("@playwright/test").Page,
): Promise<Array<{ path: string; content: string }>> {
  const response = await page.request.post("/v1/rpc/listTickets", { data: {} });
  const frame = (await response.json()) as {
    payload?: Array<{ path: string; content: string }>;
  };
  return frame.payload ?? [];
}

test("searches, edits, creates, cancels, submits, and deletes real tickets", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.goto("/tickets");
  await expect(page.getByTestId("tickets-row")).toHaveCount(2);
  await expect(page.getByTestId("tickets-row").filter({ hasText: "e2e-auth-rotation" })).toBeVisible();

  const search = page.getByPlaceholder("Search tickets");
  await search.fill("release checklist");
  await expect(page.getByTestId("tickets-row")).toHaveCount(1);
  await expect(page.getByTestId("tickets-row")).toContainText("e2e-release-checklist");
  await search.fill("no-ticket-matches-this");
  await expect(page.getByText("No tickets match.")).toBeVisible();
  await search.fill("");

  await page.getByTestId("tickets-row").filter({ hasText: "e2e-auth-rotation" }).click();
  await expect(page.locator(".rev-detail-title")).toHaveText("e2e-auth-rotation");
  const editor = page.locator(".rev-detail textarea.rev-editor");
  await editor.fill("# Rotate auth tokens\n\nSaved from rendered browser coverage.");
  const save = page.locator(".rev-detail").getByRole("button", { name: "Save" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await expect
    .poll(async () => (await ticketRows(page)).find((row) => row.path === "e2e-auth-rotation")?.content)
    .toContain("Saved from rendered browser coverage.");

  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByPlaceholder("ticket-id").fill("e2e-cancelled-draft");
  await page.locator(".rev-create textarea").fill("# Cancel me");
  await page.locator(".rev-create").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("e2e-cancelled-draft", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByPlaceholder("ticket-id").fill("e2e-created-ticket");
  await page.locator(".rev-create textarea").fill("# Created ticket\n\nPersisted through the gateway.");
  await page.locator(".rev-create").getByRole("button", { name: "Create" }).click();
  const created = page.getByTestId("tickets-row").filter({ hasText: "e2e-created-ticket" });
  await expect(created).toBeVisible();
  await expect(page.locator(".rev-detail-title")).toHaveText("e2e-created-ticket");
  await expect
    .poll(async () => (await ticketRows(page)).some((row) => row.path === "e2e-created-ticket"))
    .toBe(true);
  await page.locator(".rev-detail").getByRole("button", { name: "Delete" }).click();
  await expect(created).toHaveCount(0);
  await expect(page.locator(".rev-detail-title")).not.toHaveText("e2e-created-ticket");
  await expect
    .poll(async () => (await ticketRows(page)).some((row) => row.path === "e2e-created-ticket"))
    .toBe(false);
  expectNoPageErrors(pageErrors);
});

test("renders the empty ticket list and detail states", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await openRenderedSurface(page, "tickets-empty");
  await expect(page.getByText("No tickets match.")).toBeVisible();
  await expect(page.getByText("Select a ticket to edit.")).toBeVisible();
  expectNoPageErrors(pageErrors);
});
