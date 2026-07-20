import { expect, test } from "@playwright/test";

/**
 * Slash-command navigation. In the chat-first shell you reach surfaces by typing
 * a slash command to the concierge composer; runSlash opens the matching canvas.
 */
const SURFACES: ReadonlyArray<{ slash: string; testid: string }> = [
  { slash: "/runs", testid: "runs-canvas" },
  { slash: "/approvals", testid: "approvals-canvas" },
  { slash: "/agents", testid: "agents-canvas" },
  { slash: "/memory", testid: "memory-canvas" },
  { slash: "/scores", testid: "scores-canvas" },
  { slash: "/crons", testid: "crons-canvas" },
  { slash: "/prompts", testid: "prompts-canvas" },
  { slash: "/tickets", testid: "tickets-canvas" },
  { slash: "/palette", testid: "palette-canvas" },
];

for (const { slash, testid } of SURFACES) {
  test(`${slash} opens ${testid}`, async ({ page }) => {
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "Message Smithers" });
    await input.fill(slash);
    await input.press("Enter");
    await expect(page.getByTestId(testid)).toBeVisible();
  });
}

test("typing 'store' opens the workflow store", async ({ page }) => {
  await page.goto("/runs");
  await expect(page.getByTestId("runs-canvas")).toBeVisible();
  const input = page.getByRole("textbox", { name: "Message Smithers" });
  await input.fill("store");
  await input.press("Enter");
  await expect(page.locator(".store")).toBeVisible();
});
