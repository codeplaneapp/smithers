import { expect, test } from "@playwright/test";

/**
 * The concierge. You chat in the composer and the concierge answers in the
 * transcript and aggressively backgrounds real Smithers workflows on the gateway.
 * No mocks: the reply streams from the real local concierge server (its
 * deterministic heuristic path, since there's no API key in CI), and a build
 * request launches a real run.
 */
async function send(page: import("@playwright/test").Page, text: string) {
  const input = page.getByRole("textbox", { name: "Message Smithers" });
  await input.fill(text);
  await input.press("Enter");
}

test("a user message appears in the transcript", async ({ page }) => {
  await page.goto("/");
  await send(page, "hello concierge");
  await expect(page.locator(".message.user")).toContainText("hello concierge");
});

test("a build request backgrounds a workflow and the concierge confirms", async ({ page }) => {
  await page.goto("/");
  await send(page, "build me a dark mode toggle");
  const reply = page.locator(".message.assistant").last();
  await expect(reply).toContainText(/backgrounding/i, { timeout: 15_000 });
  await expect(reply).toContainText(/Run/i);
});

test("a build request actually creates a run on the gateway", async ({ page }) => {
  await page.goto("/");
  const countRuns = async () => {
    const res = await page.request.post("/v1/rpc/listRuns", { data: {} });
    const body = await res.json();
    return Array.isArray(body.payload) ? body.payload.length : 0;
  };
  const before = await countRuns();
  await send(page, "implement a new settings page");
  await expect(page.locator(".message.assistant").last()).toContainText(/Run/i, { timeout: 15_000 });
  await expect.poll(countRuns, { timeout: 15_000 }).toBeGreaterThan(before);
});

test("a question gets a conversational reply, not a launch", async ({ page }) => {
  await page.goto("/");
  await send(page, "what can you do?");
  const reply = page.locator(".message.assistant").last();
  await expect(reply).toContainText(/concierge|workflow/i, { timeout: 15_000 });
});
