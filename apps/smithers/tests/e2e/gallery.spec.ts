import { expect, test } from "@playwright/test";
import {
  expectNoPageErrors,
  openRenderedSurface,
  trackPageErrors,
} from "./surfaceTestUtils";

test.beforeEach(async ({ page }) => {
  await openRenderedSurface(page, "gallery");
  await expect(page.getByTestId("ui-gallery")).toBeVisible();
});

test("every new family is discoverable in the gallery", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  for (const section of [
    "transcript",
    "composer",
    "reasoning-tools",
    "plans",
    "approvals",
    "sources",
    "agents",
    "artifacts",
    "test-results",
    "sandbox",
    "canvas",
  ]) {
    await expect(page.getByTestId(`gallery-section-${section}`)).toBeVisible();
  }
  expectNoPageErrors(pageErrors);
});

test("streaming transcript pins the scroller to the latest chunk", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const viewport = page.getByTestId("transcript-viewport");
  await expect(page.getByTestId("transcript-log")).toHaveAttribute("role", "log");
  for (let index = 0; index < 15; index += 1) {
    await page.getByTestId("stream-chunk").click();
  }
  await expect(page.getByText("Streaming chunk 15")).toBeVisible();
  const overflows = await viewport.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(overflows).toBe(true);
  const atBottom = await viewport.evaluate((el) => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 8);
  expect(atBottom).toBe(true);

  // Scrolling up breaks the follow and surfaces the jump-to-latest affordance.
  await viewport.evaluate((el) => { el.scrollTop = 0; });
  await viewport.dispatchEvent("scroll");
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect
    .poll(() =>
      viewport.evaluate((el) => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 24),
    )
    .toBe(true);
  expectNoPageErrors(pageErrors);
});

test("keyboard navigates branch alternates and the transcript viewport", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await expect(page.getByText("First draft of the answer.")).toBeVisible();
  await page.getByRole("button", { name: "Next branch" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Second draft of the answer.")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByText("Third draft of the answer.")).toBeVisible();
  await page.getByRole("button", { name: "Previous branch" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Second draft of the answer.")).toBeVisible();
  // The scroller viewport is a labelled region and a single tab stop.
  await expect(page.getByTestId("transcript-viewport")).toHaveAttribute("role", "region");
  await expect(page.getByTestId("transcript-viewport")).toHaveAttribute("tabindex", "0");
  expectNoPageErrors(pageErrors);
});

test("prompt submits with Enter and stop cancels streaming", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const textarea = page.getByRole("textbox", { name: "Message" });
  await textarea.click();
  await textarea.fill("Ship the integration");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  await expect(page.getByTestId("transcript-log").getByText("Ship the integration")).toBeVisible();
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  expectNoPageErrors(pageErrors);
});

test("attachments render state and remove", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const group = page.getByTestId("attachment-group");
  await expect(group.getByText("trace.log")).toBeVisible();
  await expect(group.getByText("uploading")).toBeVisible();
  await page.getByRole("button", { name: "Remove trace.log" }).click();
  await expect(group.getByText("trace.log")).toHaveCount(0);
  await expect(group.getByText("screenshot.png")).toBeVisible();
  expectNoPageErrors(pageErrors);
});

test("tool call disclosure expands input and output", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const toolCall = page.getByTestId("tool-call");
  const trigger = toolCall.getByRole("button").first();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(toolCall.getByText("src/index.ts")).toHaveCount(0);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(toolCall.getByText(/src\/index\.ts/)).toBeVisible();
  await expect(toolCall.getByText(/226/)).toBeVisible();
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  expectNoPageErrors(pageErrors);
});

test("approval approve, deny, and reviewer note", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const demo = page.getByTestId("approval-demo");
  await expect(demo.getByText("Run terraform apply against the production workspace?")).toBeVisible();
  await demo.getByRole("textbox").fill("Looks safe; staging passed.");
  await expect(demo.getByRole("textbox")).toHaveValue("Looks safe; staging passed.");
  await demo.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("confirmation-demo").getByText("Approved")).toBeVisible();
  expectNoPageErrors(pageErrors);
});

test("checkpoint fork, replay, and rewind require confirmation", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const demo = page.getByTestId("checkpoint-demo");
  await demo.getByRole("button", { name: "Fork" }).click();
  await expect(page.getByRole("alertdialog", { name: "Confirm fork" })).toBeVisible();
  await page.getByTestId("checkpoint-confirm-no").click();
  await expect(demo.getByTestId("checkpoint-log").getByRole("listitem")).toHaveCount(0);

  await demo.getByRole("button", { name: "Replay" }).click();
  await page.getByTestId("checkpoint-confirm-yes").click();
  await expect(demo.getByTestId("checkpoint-log").getByText("replay")).toBeVisible();

  await demo.getByRole("button", { name: "Rewind" }).click();
  await expect(page.getByRole("alertdialog", { name: "Confirm rewind" })).toBeVisible();
  await expect(page.getByText("Rewind deletes later frames. Continue?")).toBeVisible();
  await page.getByTestId("checkpoint-confirm-yes").click();
  await expect(demo.getByTestId("checkpoint-log").getByText("rewind")).toBeVisible();
  expectNoPageErrors(pageErrors);
});

test("structured node output renders response and tool calls", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const demo = page.getByTestId("node-output-demo");
  await expect(demo.getByText("Implemented the integration barrel.")).toBeVisible();
  await expect(demo.getByText(/edit/)).toBeVisible();
  expectNoPageErrors(pageErrors);
});

test("test failure and stack trace render", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const demo = page.getByTestId("test-results-demo");
  const failingRow = demo.locator("[data-slot='test-row'][data-status='failed']");
  await failingRow.scrollIntoViewIfNeeded();
  await expect(failingRow).toContainText("composes lane css");
  await expect(failingRow).toContainText("Expected reducedMotionCss composed last");
  await expect(demo.getByTestId("stack-trace")).toContainText("packages/ui/tests/css.test.ts:12:9");
  expectNoPageErrors(pageErrors);
});

test("theme switching drives the explicit data-theme override", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const token = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  await page.emulateMedia({ colorScheme: "light" });
  const lightToken = await token();
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkToken = await token();
  expect(darkToken).not.toEqual(lightToken);
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await token()).toEqual(lightToken);
  expectNoPageErrors(pageErrors);
});

test("reduced motion is composed last and honored", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const sheet = await page.evaluate(() => {
    const el = document.querySelector<HTMLStyleElement>("style[data-smithers-ui]");
    return el?.textContent ?? "";
  });
  expect(sheet).toContain("prefers-reduced-motion");
  expect(sheet.lastIndexOf("prefers-reduced-motion")).toBeGreaterThan(sheet.indexOf(".sui-alert"));
  expectNoPageErrors(pageErrors);
});

test("screen-reader names and live regions are present", async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await expect(page.getByRole("region", { name: "Conversation messages" })).toBeVisible();
  await expect(page.getByRole("log")).toBeVisible();
  await expect(page.getByRole("group", { name: "Checkpoint actions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle theme" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  // Confirmation announces state changes through a polite live region.
  const demo = page.getByTestId("confirmation-demo");
  await expect(demo.locator("[role='status']")).toBeAttached();
  await page.getByTestId("approval-demo").getByRole("button", { name: "Deny" }).click();
  await expect(demo.locator("[data-slot='confirmation-rejected']")).toHaveText("Denied");
  await expect(demo.locator("[role='status']")).toHaveText("Denied");
  expectNoPageErrors(pageErrors);
});
