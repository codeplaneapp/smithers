import { expect, test } from "@playwright/test";

/**
 * The `create-workflow` meta-workflow ships a rich custom UI
 * (`.smithers/ui/create-workflow.tsx`) built from @xyflow/react (the n8n graph),
 * @milkdown/crepe (WYSIWYG markdown), and the gateway-react real-time hooks. The
 * seed gateway registers it WITH that UI, served at `/workflows/create-workflow`
 * and proxied through the app origin.
 *
 * No mocks: this drives the real bundled UI in a real browser against the real
 * gateway. Its main job is to prove the heavy bundle actually mounts (xyflow +
 * crepe load without throwing) and renders the multi-style tabbed shell — the
 * thing that can't be verified from a headless screenshot tool. Assertions are
 * independent of whether the workspace happens to have create-workflow runs, so
 * they hold on a clean CI box (empty state) and locally (existing runs) alike.
 */

const STEP_TABS = ["clarify", "provision", "design", "approve", "scaffold", "verify", "document", "result"] as const;

test("create-workflow custom UI mounts and renders the tabbed shell", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto("/workflows/create-workflow");

  // The bundle (xyflow + crepe + gateway-react) mounts in a real browser.
  await expect(page.getByTestId("create-workflow-ui")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Create Workflow" })).toBeVisible();

  // The multi-style step tab bar renders one tab per workflow step (always
  // present, regardless of whether a run exists).
  await expect(page.getByTestId("create-workflow-tabbar")).toBeVisible();
  for (const id of STEP_TABS) {
    await expect(page.getByTestId(`create-workflow-tab-${id}`)).toBeVisible();
  }

  // The bundle mounted with no uncaught runtime errors (xyflow/crepe are happy).
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("create-workflow tabs switch selected state across the whole tab bar", async ({ page }) => {
  await page.goto("/workflows/create-workflow");
  await expect(page.getByTestId("create-workflow-ui")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("create-workflow-tabbar")).toBeVisible();

  // The tab bar is a real tablist whose selection state is client-side, so it
  // works in every run state. Click through every tab and assert the selected
  // state moves with it (aria-selected drives the is-active styling).
  for (const id of STEP_TABS) {
    await page.getByTestId(`create-workflow-tab-${id}`).click();
    await expect(page.getByTestId(`create-workflow-tab-${id}`)).toHaveAttribute("aria-selected", "true");
    for (const other of STEP_TABS) {
      if (other === id) continue;
      await expect(page.getByTestId(`create-workflow-tab-${other}`)).toHaveAttribute("aria-selected", "false");
    }
  }
});

test("create-workflow renders exactly one content surface per state", async ({ page }) => {
  await page.goto("/workflows/create-workflow");
  await expect(page.getByTestId("create-workflow-ui")).toBeVisible({ timeout: 30_000 });

  // Once the runs query settles, the content area shows exactly one of the two
  // state surfaces: the empty-state launch card (no run selected) or the
  // active step pane of a selected run. Both are valid; showing neither or
  // both is a rendering bug.
  const emptyCard = page.getByTestId("create-workflow-empty");
  const activePane = page.locator("[data-testid^='create-workflow-pane-']:not([hidden])");
  await expect(emptyCard.or(activePane.first())).toBeVisible({ timeout: 15_000 });

  if (await emptyCard.isVisible()) {
    // Empty run state: the launch card gates Build Workflow on a prompt, the
    // same disabled → enabled wiring as the top-bar Build.
    const launch = page.getByTestId("create-workflow-launch-empty");
    const prompt = page.getByTestId("create-workflow-prompt-empty");
    await prompt.fill("");
    await expect(launch).toBeDisabled();
    await prompt.fill("Build a workflow that hunts flaky tests and proposes fixes.");
    await expect(launch).toBeEnabled();
    // No step panes render without a selected run.
    expect(await activePane.count()).toBe(0);
  } else {
    // Populated state: exactly one pane is visible — the active tab's — and
    // switching tabs swaps which pane is shown.
    expect(await activePane.count()).toBe(1);
    await page.getByTestId("create-workflow-tab-result").click();
    await expect(page.getByTestId("create-workflow-pane-result")).toBeVisible();
    expect(await emptyCard.count()).toBe(0);
  }
});

test("create-workflow Build is gated on a non-empty prompt", async ({ page }) => {
  await page.goto("/workflows/create-workflow");
  await expect(page.getByTestId("create-workflow-ui")).toBeVisible({ timeout: 30_000 });

  // The top-bar prompt + Build exist in every state. Build is disabled until a
  // prompt is typed, then enabled — proving the launch control is wired.
  const build = page.getByTestId("create-workflow-launch");
  const prompt = page.getByTestId("create-workflow-prompt");
  await prompt.fill("");
  await expect(build).toBeDisabled();
  await prompt.fill("Build a workflow that hunts flaky tests and proposes fixes.");
  await expect(build).toBeEnabled();
});

test("the gateway serves create-workflow with a mounted UI", async ({ page }) => {
  await page.goto("/workflows/create-workflow");
  await expect(page.getByTestId("create-workflow-ui")).toBeVisible({ timeout: 30_000 });

  // listWorkflows (proxied to the real gateway) reports create-workflow with a
  // UI mounted — the seed registration + serving path is real.
  const summary = await page.evaluate(async () => {
    const res = await fetch(`${location.origin}/v1/rpc/listWorkflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return (await res.json()) as { ok?: boolean; payload?: Array<{ key: string; hasUi?: boolean }> };
  });
  expect(summary.ok).toBe(true);
  const cw = (summary.payload ?? []).find((w) => w.key === "create-workflow");
  expect(cw, "create-workflow registered on gateway").toBeTruthy();
  expect(cw?.hasUi).toBe(true);
});
