import { expect, test, type Browser, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectNoPageErrors, trackPageErrors } from "./surfaceTestUtils";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayPort = Number(process.env.SMITHERS_E2E_GATEWAY_PORT ?? "7331");
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
const gatewayPidFile = resolve(here, ".gateway.pid");

type Run = { runId: string; workflowKey?: string; status?: string };

async function rpc<T>(page: Page, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await page.request.post(`${gatewayOrigin}/v1/rpc/${method}`, { data: params });
  const frame = (await response.json()) as {
    ok?: boolean;
    payload?: T;
    error?: { message?: string };
  };
  if (!frame.ok) throw new Error(frame.error?.message ?? `${method} failed`);
  return frame.payload as T;
}

async function runFor(page: Page, workflowKey: string, predicate?: (run: Run) => boolean): Promise<Run> {
  const runs = await rpc<Run[]>(page, "listRuns");
  const run = runs.find((candidate) => candidate.workflowKey === workflowKey && (predicate?.(candidate) ?? true));
  if (!run) throw new Error(`Missing seeded run for ${workflowKey}`);
  return run;
}

async function openRun(page: Page, run: Run, query = ""): Promise<void> {
  await page.goto(`${gatewayOrigin}/monitor?runId=${encodeURIComponent(run.runId)}${query}`);
  await expect(page.getByTestId("monitor-run-detail")).toBeVisible({
    timeout: 20_000,
  });
}

async function waitForGateway(up: boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let healthy = false;
    try {
      healthy = (await fetch(`${gatewayOrigin}/health`)).ok;
    } catch {
      healthy = false;
    }
    if (healthy === up) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Gateway did not become ${up ? "healthy" : "unavailable"}`);
}

function stopGateway(): void {
  const pid = Number(readFileSync(gatewayPidFile, "utf8").trim());
  if (!pid) throw new Error("Missing gateway pid");
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    process.kill(pid, "SIGKILL");
  }
}

async function restartGateway(authToken?: string): Promise<void> {
  const child = spawn("bun", [resolve(here, "seedGateway.ts")], {
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      HOST: "127.0.0.1",
      SMITHERS_E2E_RESET_DB: "0",
      SMITHERS_HOME: resolve(here, "fixtures", "smithers-home"),
      ...(authToken ? { SMITHERS_E2E_GATEWAY_AUTH_TOKEN: authToken } : {}),
    },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  writeFileSync(gatewayPidFile, String(child.pid ?? ""));
  await waitForGateway(true);
}

async function authenticatedPage(browser: Browser, token: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  return { page: await context.newPage(), close: () => context.close() };
}

test.describe.serial("served Smithers Monitor", () => {
  test("uses explicit and OS-fallback themes without viewport overflow", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    for (const { width, height, theme } of [
      { width: 390, height: 844, theme: "light" },
      { width: 1440, height: 900, theme: "dark" },
      { width: 1920, height: 1080, theme: "dark" },
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${gatewayOrigin}/monitor?theme=${theme}`);
      await expect(page.getByTestId("monitor-root")).toBeVisible();
      await expect(page.getByTestId("monitor-conn")).toHaveAttribute("data-conn", "online");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }

    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${gatewayOrigin}/monitor`);
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toContain("dark");
    expectNoPageErrors(pageErrors);
  });

  test("supports complete keyboard and ARIA tree semantics in live and historical XML views", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    const rich = await runFor(page, "e2e-monitor");
    await openRun(page, rich);

    const tree = page.getByTestId("monitor-tree");
    await expect(tree).toHaveRole("tree");
    await expect(tree).toHaveAttribute("aria-label", "Execution tree");
    const rootItem = tree.getByRole("treeitem").first();
    await expect(rootItem).toHaveAttribute("aria-level", "1");
    await expect(rootItem).toHaveAttribute("aria-posinset", "1");
    await expect(rootItem).toHaveAttribute("aria-setsize", "1");
    await expect(rootItem).toHaveAttribute("aria-expanded", "true");
    await expect(rootItem).toHaveAttribute("aria-selected", "false");
    await expect(rootItem.locator(':scope > [role="group"]')).toHaveCount(1);
    await expect(rootItem.getByRole("button", { name: /^(Collapse|Expand)/ }).first()).toHaveAccessibleName(
      /workflow/i,
    );

    await tree.focus();
    await expect(tree).toBeFocused();
    const rootActiveId = await tree.getAttribute("aria-activedescendant");
    expect(rootActiveId).toBeTruthy();
    await tree.press("End");
    expect(await tree.getAttribute("aria-activedescendant")).not.toBe(rootActiveId);
    await tree.press("Home");
    expect(await tree.getAttribute("aria-activedescendant")).toBe(rootActiveId);
    await tree.press("ArrowLeft");
    await expect(tree.getByRole("treeitem")).toHaveCount(1);
    await tree.press("ArrowRight");
    await expect(tree.getByRole("treeitem")).not.toHaveCount(1);
    await tree.press("End");
    await tree.press("Enter");
    await expect
      .poll(async () => {
        const activeId = await tree.getAttribute("aria-activedescendant");
        return activeId ? page.locator(`[id="${activeId}"]`).getAttribute("aria-selected") : null;
      })
      .toBe("true");
    await expect.poll(() => new URL(page.url()).searchParams.get("nodeId")).not.toBeNull();
    const liveNodeId = new URL(page.url()).searchParams.get("nodeId");

    await page.getByTestId("monitor-debug-chip").click();
    await page.getByTestId("monitor-xml-chip").click();
    await page.getByTestId("monitor-frames-chip").click();
    const frame = page.getByRole("slider", { name: "Frame" });
    await expect(frame).toBeEnabled();
    await frame.fill((await frame.getAttribute("min")) ?? "0");

    const xmlTree = page.getByTestId("monitor-tree-xml");
    await expect(xmlTree).toHaveRole("tree");
    await expect(xmlTree).toHaveAttribute("aria-label", "Execution tree XML");
    await expect(xmlTree.getByRole("treeitem").first()).toHaveAttribute("aria-level", "1");
    await xmlTree.focus();
    await xmlTree.press("End");
    await xmlTree.press("Enter");
    const historicalActiveId = await xmlTree.getAttribute("aria-activedescendant");
    await expect(page.locator(`[id="${historicalActiveId ?? "missing"}"]`)).toHaveAttribute("aria-selected", "true");
    expect(new URL(page.url()).searchParams.get("nodeId")).toBe(liveNodeId);
    expectNoPageErrors(pageErrors);
  });

  test("renders real nested iterations, retries, failure rollups, output, XML, timeline, and frames", async ({
    page,
  }) => {
    const pageErrors = trackPageErrors(page);
    await page.addInitScript(() => {
      (globalThis as typeof globalThis & { __sawMonitorTreeLoading?: boolean }).__sawMonitorTreeLoading = false;
      new MutationObserver(() => {
        if (document.body?.innerText.includes("Loading execution tree")) {
          (
            globalThis as typeof globalThis & {
              __sawMonitorTreeLoading?: boolean;
            }
          ).__sawMonitorTreeLoading = true;
        }
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    const rich = await runFor(page, "e2e-monitor");
    await openRun(page, rich);
    expect(
      await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __sawMonitorTreeLoading?: boolean;
            }
          ).__sawMonitorTreeLoading,
      ),
    ).toBe(true);
    const tree = page.getByTestId("monitor-tree");
    await expect(tree).toBeVisible();
    await expect(tree.getByRole("treeitem").first()).toHaveAttribute("aria-expanded", /true|false/);

    const intake = tree.locator(".mon-tree-main").filter({ hasText: "intake" });
    await expect(intake).toBeVisible();
    await intake.focus();
    await intake.press("Enter");
    await expect(page.getByTestId("monitor-inspector")).toContainText("intake");
    await expect(page.getByTestId("monitor-output-fields")).toContainText("seeded intake output");

    // Frames + XML are folded behind the Debug chip — open it first.
    await page.getByTestId("monitor-debug-chip").click();
    await page.getByTestId("monitor-xml-chip").click();
    await expect(page.getByTestId("monitor-tree-xml")).toContainText("review-loop");
    await page.getByTestId("monitor-timeline-chip").click();
    const timeline = page.getByTestId("monitor-timeline");
    await expect(timeline).toBeVisible();
    await expect(page.getByTestId("monitor-timeline-row").filter({ hasText: "review-api" })).toHaveCount(2);
    await expect(timeline).toContainText("#1");
    await expect(timeline).toContainText("a2");
    await page.getByTestId("monitor-timeline-row").filter({ hasText: "review-tests" }).last().click();
    await expect(page.getByTestId("monitor-inspector")).toContainText("review-tests");

    await page.getByTestId("monitor-frames-chip").click();
    await expect(page.getByTestId("monitor-scrub")).toBeVisible();
    const frame = page.getByRole("slider", { name: "Frame" });
    await expect(frame).toBeEnabled();
    const min = Number(await frame.getAttribute("min"));
    await frame.fill(String(min));
    await expect(page.getByTestId("monitor-scrub")).toContainText(`frame ${min}`);

    const failed = await runFor(page, "e2e-monitor-failure");
    await openRun(page, failed);
    await expect(page.getByTestId("monitor-tree")).toContainText("deterministic-failure");
    const failureContainer = page.getByRole("treeitem").filter({ hasText: "nested-failure-container" }).last();
    await failureContainer.getByRole("button", { name: /^(Collapse|Expand).*nested-failure-container/ }).click();
    await expect(failureContainer).toHaveAttribute("aria-expanded", "false");
    await expect(failureContainer.locator(".mon-dot")).toHaveCount(2);

    await openRun(page, { runId: "e2e-empty-tree", workflowKey: "e2e-task" });
    await expect(page.getByText("No nodes recorded yet.")).toBeVisible();
    expectNoPageErrors(pageErrors);
  });

  test("filters real events, follows live updates, and pauses then resumes scrolling", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    const rich = await runFor(page, "e2e-monitor");
    await openRun(page, rich);
    const eventRows = page.locator(".mon-event");
    await expect(eventRows.first()).toBeVisible();
    const activityCount = await eventRows.count();
    await page.getByRole("button", { name: "Notable" }).click();
    const notableCount = await eventRows.count();
    expect(notableCount).toBeLessThanOrEqual(activityCount);
    await page.getByRole("button", { name: "All" }).click();
    const allCount = await eventRows.count();
    expect(allCount).toBeGreaterThanOrEqual(activityCount);

    const launched = await rpc<{ runId: string }>(page, "launchRun", {
      workflow: "e2e-monitor-live",
    });
    await openRun(page, {
      runId: launched.runId,
      workflowKey: "e2e-monitor-live",
    });
    const runningNode = page
      .getByTestId("monitor-tree")
      .locator(".mon-tree-main")
      .filter({ hasText: "live-step", has: page.locator(".tone-running") })
      .first();
    await expect(runningNode).toBeVisible({ timeout: 10_000 });
    await runningNode.click();
    await expect(page.getByTestId("monitor-inspector")).toBeVisible();
    await expect(page.getByTestId("monitor-live-output")).toBeVisible();
    const before = await eventRows.count();
    await expect.poll(() => eventRows.count(), { timeout: 20_000 }).toBeGreaterThan(before);
    await expect.poll(() => eventRows.count(), { timeout: 20_000 }).toBeGreaterThan(20);

    const events = page.getByTestId("monitor-events");
    await events.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const follow = page.getByRole("button", { name: /Follow/ });
    await expect(follow).toHaveAttribute("aria-pressed", "false");
    await follow.click();
    await expect(follow).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => events.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expectNoPageErrors(pageErrors);
  });

  test("opens approvals and accessible custom UI and PTY dialogs with Escape focus restoration", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await rpc(page, "launchRun", { workflow: "e2e-approval" });
    await page.goto(`${gatewayOrigin}/monitor`);
    // The overview has no rail: pending approvals surface in the "Needs you"
    // band, with the decision inline.
    await expect(page.getByTestId("monitor-needs-you")).toContainText("Approve the deploy");

    const task = await runFor(page, "e2e-task", (run) => run.runId !== "e2e-empty-tree");
    await openRun(page, task);
    const open = page.getByRole("button", { name: "Open UI" });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "e2e-task custom UI" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("data-slot", "dialog-content");
    await expect(dialog).toHaveAccessibleDescription("Embedded workflow interface for e2e-task.");
    await expect(dialog.locator("iframe")).toHaveAttribute("title", "e2e-task custom UI");
    await expect(dialog.getByRole("link", { name: "Open in new tab" })).toBeFocused();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();

    await open.click();
    await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 4, y: 4 } });
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();

    await open.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();

    const rich = await runFor(page, "e2e-monitor");
    await openRun(page, rich);
    await page.getByTestId("monitor-tree").locator(".mon-tree-main").filter({ hasText: "intake" }).click();
    const hijack = page.getByTestId("monitor-hijack-button");
    await expect(hijack).toBeVisible();
    await hijack.click();
    const terminalDialog = page.getByTestId("monitor-hijack-modal");
    await expect(terminalDialog).toBeVisible();
    await expect(terminalDialog).toHaveRole("dialog", { name: "Reopen session: intake · codex" });
    await expect(terminalDialog).toHaveAttribute("aria-modal", "true");
    await expect(terminalDialog).toHaveAttribute("data-slot", "dialog-content");
    await expect(terminalDialog).toHaveAccessibleDescription(
      "Interactive run controls, activity, changes, and terminal for Reopen session: intake · codex.",
    );
    await expect(page.getByTestId("hijack-terminal")).toBeVisible();
    await terminalDialog.getByRole("button", { name: "Close" }).click();
    await expect(terminalDialog).toHaveCount(0);
    await expect(hijack).toBeFocused();

    await hijack.click();
    await expect(terminalDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(terminalDialog).toHaveCount(0);
    await expect(hijack).toBeFocused();
    expectNoPageErrors(pageErrors);
  });

  test("recovers from a real gateway restart with cached data, selection, and filters intact", async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    const rich = await runFor(page, "e2e-monitor");
    await openRun(page, rich);
    await page.getByTestId("monitor-filter").fill("e2e-monitor");
    await expect(page.getByTestId("monitor-run-detail")).toContainText("e2e-monitor");

    stopGateway();
    await waitForGateway(false);
    try {
      await expect(page.getByTestId("monitor-conn")).toHaveAttribute("data-conn", "offline", { timeout: 20_000 });
      await expect(page.getByTestId("monitor-conn-hint")).toContainText("last-known data");
      await expect(page.getByTestId("monitor-run-detail")).toContainText("e2e-monitor");
      await expect(page.getByTestId("monitor-filter")).toHaveValue("e2e-monitor");

      await restartGateway();
      await expect(page.getByTestId("monitor-conn")).toHaveAttribute("data-conn", "online", { timeout: 30_000 });
      await expect(page.getByTestId("monitor-run-detail")).toContainText("e2e-monitor");
      await expect(page.getByTestId("monitor-filter")).toHaveValue("e2e-monitor");
    } finally {
      try {
        await waitForGateway(true, 1_000);
      } catch {
        await restartGateway();
      }
    }
    expectNoPageErrors(pageErrors);
  });

  test("shows connecting and unauthorized states through a real authenticated gateway", async ({ browser }) => {
    test.skip(!!process.env.CI, "requires an installed browser; clean CI images intentionally have none");

    const acceptedToken = "monitor-e2e-accepted";
    const replacementToken = "monitor-e2e-replacement";
    stopGateway();
    await waitForGateway(false);
    await restartGateway(acceptedToken);

    const authenticated = await authenticatedPage(browser, acceptedToken);
    try {
      await authenticated.page.addInitScript(() => {
        const statuses: string[] = [];
        Object.defineProperty(globalThis, "__monitorConnectionStatuses", {
          value: statuses,
        });
        new MutationObserver(() => {
          const status = document.querySelector('[data-testid="monitor-conn"]')?.getAttribute("data-conn");
          if (status && statuses.at(-1) !== status) statuses.push(status);
        }).observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      });
      await authenticated.page.goto(`${gatewayOrigin}/monitor`);
      await expect(authenticated.page.getByTestId("monitor-conn")).toHaveAttribute("data-conn", "online", {
        timeout: 20_000,
      });
      expect(
        (
          await authenticated.page.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  __monitorConnectionStatuses: string[];
                }
              ).__monitorConnectionStatuses,
          )
        ).some((status) => status === "idle" || status === "connecting"),
      ).toBe(true);

      stopGateway();
      await waitForGateway(false);
      await restartGateway(replacementToken);
      await expect(authenticated.page.getByTestId("monitor-conn")).toHaveAttribute("data-conn", "unauthorized", {
        timeout: 30_000,
      });
      await expect(authenticated.page.getByTestId("monitor-conn-hint")).toContainText("Credentials or permissions");
    } finally {
      await authenticated.close();
      try {
        stopGateway();
        await waitForGateway(false);
      } catch {
        // The replacement gateway may already have exited; restore the shared fixture either way.
      }
      await restartGateway();
    }
  });
});
