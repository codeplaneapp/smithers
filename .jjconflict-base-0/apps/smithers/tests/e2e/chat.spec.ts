import { expect, test } from "@playwright/test";

/**
 * The concierge — a REAL LLM, exactly like ../multi's /api/chat: a thin
 * single-turn streaming proxy (Cerebras -> Codex subscription -> OpenAI). No
 * mocks. These specs need a real model credential; in CI none is set, so the
 * concierge returns 500 and we skip rather than fake a reply.
 */
const HAS_LLM = Boolean(
  process.env.CEREBRAS_API_KEY || process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN,
);
test.skip(!HAS_LLM, "no LLM credential (CEREBRAS_API_KEY / OPENAI_API_KEY / CODEX_ACCESS_TOKEN)");

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

test("the concierge streams a real reply", async ({ page }) => {
  await page.goto("/");
  await send(page, "In one sentence, what is your role?");
  const reply = page.locator(".message.assistant").last();
  // A real model reply: substantial text, mentioning Smithers / the app.
  await expect(reply).toContainText(/Smithers|app|workflow|assist|help/i, { timeout: 30_000 });
  expect((await reply.innerText()).trim().length).toBeGreaterThan(15);
});

test("the concierge stops streaming (pending clears)", async ({ page }) => {
  await page.goto("/");
  await send(page, "say hi");
  await expect(page.locator(".message.assistant").last()).not.toHaveText("", { timeout: 30_000 });
  // After the stream ends the composer accepts a new message (not stuck pending).
  const input = page.getByRole("textbox", { name: "Message Smithers" });
  await expect(input).toBeEnabled();
});
