import { expect, test } from "@playwright/test";

/**
 * "The concierge can create a workflow." Smithers has a `create-workflow`
 * meta-workflow that builds a brand-new workflow; the concierge is now aware of
 * the gateway's workflows and backgrounds `create-workflow` when asked to make
 * one. No mocks: real gateway, real registered create-workflow, real LLM.
 */

const HAS_LLM = Boolean(
  process.env.CEREBRAS_API_KEY || process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN,
);

// app-control system prompt (the directive protocol the real app sends via
// withAgentSystem); kept minimal here so the direct-API test is self-contained.
const APP_CONTROL_SYSTEM =
  "You can operate this app. When the user asks you to change the app or do real " +
  "work, end your reply with exactly one fenced code block tagged smithers:action " +
  'holding one JSON object per line: first {"tool":"requestControl","reason":"..."}, ' +
  'then actions such as {"tool":"startWorkflow","args":{"workflowKey":"...","inputs":{"prompt":"..."}}}.';

test("create-workflow is registered and launchable on the gateway", async ({ page }) => {
  const list = await page.request.post("/v1/rpc/listWorkflows", { data: {} });
  const keys = (((await list.json()).payload as { key: string }[]) ?? []).map((w) => w.key);
  expect(keys).toContain("create-workflow");

  const before = await page.request
    .post("/v1/rpc/listRuns", { data: {} })
    .then(async (r) => (((await r.json()).payload as unknown[]) ?? []).length);
  const launched = await page.request.post("/v1/rpc/launchRun", {
    data: { workflow: "create-workflow", input: { prompt: "a workflow that greets the user" } },
  });
  expect((await launched.json()).payload?.runId).toBeTruthy();
  await expect
    .poll(() =>
      page.request
        .post("/v1/rpc/listRuns", { data: {} })
        .then(async (r) => (((await r.json()).payload as unknown[]) ?? []).length),
    )
    .toBeGreaterThan(before);
});

test("the concierge emits a create-workflow directive when asked to create one", async ({ page }) => {
  test.skip(!HAS_LLM, "no LLM credential");
  const res = await page.request.post("/api/chat", {
    data: {
      messages: [
        { role: "user", content: "Create a Smithers workflow that runs the linter and fixes issues." },
      ],
      system: APP_CONTROL_SYSTEM,
    },
    timeout: 60_000,
  });
  const raw = await res.text();
  let assistant = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    try {
      const o = JSON.parse(t.slice(5).trim());
      if (o.type === "TEXT_MESSAGE_CONTENT") assistant += o.delta ?? "";
    } catch {
      /* heartbeat / non-json */
    }
  }
  expect(assistant).toContain("smithers:action");
  expect(assistant).toContain("create-workflow");
});

test("asking the concierge to create a workflow backgrounds a real create-workflow run", async ({
  page,
}) => {
  test.skip(!HAS_LLM, "no LLM credential");
  const countCreate = async () => {
    const r = await page.request.post("/v1/rpc/listRuns", { data: {} });
    const runs = (((await r.json()).payload as { workflowName?: string }[]) ?? []);
    return runs.filter((run) => run.workflowName === "create-workflow").length;
  };
  const before = await countCreate();

  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message Smithers" });
  await input.fill("Create a Smithers workflow that runs the linter and fixes issues.");
  await input.press("Enter");

  // The model streams a reply ending in a create-workflow directive; the control
  // ring opens an approval gate. Grant it -> the client launches create-workflow.
  await expect(page.locator(".control-allow")).toBeVisible({ timeout: 60_000 });
  await page.locator(".control-allow").click();

  await expect.poll(countCreate, { timeout: 30_000 }).toBeGreaterThan(before);
});
