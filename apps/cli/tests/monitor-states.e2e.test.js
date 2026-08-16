import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createTempRepo, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * Real-browser coverage for the monitor's non-happy-path states (issue #855):
 * a workspace with no runs, a filter that hides every run, and a run id that
 * does not exist. Each must carry a label, an explanation, and the action that
 * recovers from it — against a real gateway over a real workspace, with no
 * transport or collection behavior mocked.
 *
 * The states are also checked in both themes. They are built from the shared
 * smthrs/ui primitives, so their colors come from theme tokens and must move
 * when `data-theme` flips. Chromium is deliberately optional here, matching
 * the other monitor browser suites: CI does not install browsers.
 */
const require = createRequire(import.meta.url);
const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");
const WORKFLOW = "fixture-workflow";
const RUN_ID = "monitor-states-run";
const MISSING_RUN = "monitor-states-missing";

function resolveChromium() {
  try {
    const chromium = require("playwright").chromium;
    const executablePath = chromium?.executablePath?.();
    if (typeof executablePath === "string" && existsSync(executablePath)) return chromium;
  } catch {}
  return null;
}

const CHROMIUM = resolveChromium();
const browserTest = CHROMIUM ? test : test.skip;

async function findOpenPort() {
  const server = createServer();
  await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePort);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!address || typeof address === "string") throw new Error("Could not allocate an open port");
  return address.port;
}

async function waitForHealth(base, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Gateway did not become healthy at ${base}`);
}

async function rpc(base, method, params) {
  const response = await fetch(`${base}/v1/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.ok).toBe(true);
  return body.payload;
}

/** The rendered color of a state's explanation line under one theme. */
async function descriptionColor(page, testId, theme) {
  await page.evaluate((value) => {
    document.documentElement.setAttribute("data-theme", value);
  }, theme);
  return page
    .locator(`[data-testid="${testId}"] .sui-empty-description`)
    .first()
    .evaluate((node) => getComputedStyle(node).color);
}

browserTest(
  "monitor answers no runs, filtered-out runs, and an unavailable run with a label, a reason, and a way out",
  async () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, `.smithers/workflows/${WORKFLOW}.tsx`);
    const port = await findOpenPort();
    const base = `http://127.0.0.1:${port}`;
    const gateway = spawn(
      process.execPath,
      ["run", CLI_ENTRY, "gateway", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: repo.dir,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: "ignore",
      },
    );

    let browser;
    try {
      await waitForHealth(base);
      expect(await rpc(base, "listRuns", { filter: { limit: 1000 } })).toHaveLength(0);

      browser = await CHROMIUM.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(`${base}/monitor`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="monitor-root"]', { timeout: 30_000 });

      // 1. No runs in the workspace at all. The claim is only made once the
      //    gateway actually answered, and it names the command that fixes it.
      await page.waitForSelector('[data-testid="monitor-empty-detail"][data-state="empty"]', { timeout: 30_000 });
      const emptyText = await page.getByTestId("monitor-empty-detail").textContent();
      expect(emptyText).toContain("No runs yet.");
      expect(emptyText).toContain("smithers up");

      // Light and dark are both real: the shared empty state reads its color
      // from theme tokens, so flipping data-theme must move it.
      const lightColor = await descriptionColor(page, "monitor-empty-detail", "light");
      const darkColor = await descriptionColor(page, "monitor-empty-detail", "dark");
      expect(lightColor).not.toBe("");
      expect(lightColor).not.toBe(darkColor);
      await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

      // 2. Runs exist but the filter matches none: a different claim, with a
      //    clear-filters control instead of the "launch one" copy.
      const launched = await rpc(base, "launchRun", { workflow: WORKFLOW, input: {}, runId: RUN_ID });
      expect(launched.runId).toBe(RUN_ID);
      await page.waitForSelector(`[data-run-id="${RUN_ID}"]`, { timeout: 30_000 });

      await page.getByTestId("monitor-filter").fill("no-such-run-anywhere");
      await page.waitForSelector('[data-testid="monitor-empty-detail"][data-state="filtered"]', { timeout: 30_000 });
      const filteredText = await page.getByTestId("monitor-empty-detail").textContent();
      expect(filteredText).toContain("No runs match your filters.");
      expect(filteredText).not.toContain("No runs yet.");
      await page.getByTestId("monitor-empty-detail-reset").click();
      await page.waitForSelector(`[data-run-id="${RUN_ID}"]`, { timeout: 30_000 });
      expect(await page.getByTestId("monitor-filter").inputValue()).toBe("");

      // 3. A requested run that does not exist: an honest unavailable state
      //    with both recovery actions, never a blank detail pane.
      await page.goto(`${base}/monitor?runId=${MISSING_RUN}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="monitor-run-unavailable"]', { timeout: 30_000 });
      const unavailableText = await page.getByTestId("monitor-run-unavailable").textContent();
      expect(unavailableText).toContain("Run unavailable.");
      expect(unavailableText).toContain(MISSING_RUN);
      expect(await page.getByTestId("monitor-run-refresh").count()).toBe(1);
      await page.getByTestId("monitor-run-return").click();
      await page.waitForSelector('[data-testid="monitor-runs-table"]', { timeout: 30_000 });
      expect(await page.locator(`[data-run-id="${RUN_ID}"]`).count()).toBe(1);
    } finally {
      try {
        await browser?.close();
      } catch {}
      try {
        gateway.kill("SIGTERM");
      } catch {}
    }
  },
  180_000,
);
