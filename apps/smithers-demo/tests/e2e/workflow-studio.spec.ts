import { expect, type Page, test } from "@playwright/test";

async function expectNodesDoNotOverlap(page: Page) {
  const boxes = await page.locator(".react-flow__node").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        text: node.textContent ?? "",
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    }),
  );

  expect(boxes.length).toBeGreaterThanOrEqual(5);
  for (let first = 0; first < boxes.length; first += 1) {
    for (let second = first + 1; second < boxes.length; second += 1) {
      const a = boxes[first];
      const b = boxes[second];
      const separated = a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
      expect(separated, `${a.text} overlaps ${b.text}`).toBe(true);
    }
  }
}

test("generates, lays out, persists settings, and runs a provider-backed workflow", async ({ page }) => {
  let providerCall = 0;
  await page.route("https://api.openai.com/v1/chat/completions", async (route) => {
    providerCall += 1;
    const body = route.request().postDataJSON();
    expect(body.model).toBe("gpt-5.5");
    expect(body.messages.at(0).role).toBe("system");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: `stubbed provider response ${providerCall}`,
            },
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Workflow Studio" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run Workflow" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Run (Cerebras|OpenAI|Claude)/ })).toHaveCount(0);
  await expect(page.getByLabel("Generated workflow graph")).toContainText("Debate Loop");
  await expect(page.getByLabel("Generated workflow graph")).toContainText("Judge LM");
  await expect(page.getByText("layout valid")).toBeVisible();
  await expectNodesDoNotOverlap(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  await page.getByLabel("Provider API key").fill("test-openai-key");
  await page.getByLabel("Provider model").fill("gpt-5.5");
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("openai");
  await expect(page.getByLabel("Provider API key")).toHaveValue("test-openai-key");
  await expect(page.getByLabel("Provider model")).toHaveValue("gpt-5.5");

  await page.getByLabel("Workflow prompt").fill("Research and audit a dependency update, implement the fix, then verify with tests");
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByLabel("Generated workflow graph")).toContainText("Research");
  await expect(page.getByLabel("Generated workflow graph")).toContainText("Validate");
  await expect(page.getByText("Local generation updated 1 time.")).toBeVisible();
  await expectNodesDoNotOverlap(page);

  await page.getByLabel("Workflow prompt").fill(
    "Do a loop where you have two LMs debate communism versus capitalism and then have a judge LM output a final result.",
  );
  await page.getByRole("button", { name: "Run Workflow" }).click();
  await expect(page.getByLabel("Generation output")).toContainText("Running OpenAI debate loop with gpt-5.5");
  await expect(page.getByLabel("Generation output")).toContainText("[judge-final]");
  await expect(page.getByLabel("Generation output")).toContainText("[final]");
  expect(providerCall).toBe(5);
});

test("keeps the bottom composer usable on mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Generated workflow graph")).toContainText("Debate Loop");
  await expect(page.getByLabel("Workflow prompt")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run Workflow" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Run (Cerebras|OpenAI|Claude)/ })).toHaveCount(0);
  await expect(page.getByText("layout valid")).toBeVisible();
});
