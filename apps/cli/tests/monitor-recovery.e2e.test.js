import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { createSmithers } from "../../../packages/smithers/src/create.js";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * Real-browser coverage for Monitor view state across a real gateway outage.
 * The browser stays mounted while the gateway stops, the SQLite rows change,
 * and a replacement gateway starts on the same port. No transport or
 * collection behavior is mocked.
 */

const require = createRequire(import.meta.url);
const CLI_ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));
const WORKFLOW = "monitor-recovery-probe";
const SELECTED_RUN = "monitor-recovery-selected";
const REMOVED_RUN = "monitor-recovery-seed-000";
const ADDED_RUN = "monitor-recovery-new";

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

const RECOVERY_WORKFLOW = `
/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod";

const { Workflow, Task, smithers, outputs } = createSmithers({
  result: z.object({ ok: z.boolean() }),
});

export default smithers(() => (
  <Workflow name="${WORKFLOW}">
    <Task id="probe" output={outputs.result}>{{ ok: true }}</Task>
  </Workflow>
));
`;

function findOpenPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
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

async function waitForRunStatus(base, runId, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/v1/rpc/getRun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    const body = await response.json();
    if (response.status !== 404) {
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.ok).toBe(true);
      status = body.payload?.status;
    }
    if (status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} stayed ${status}; expected ${expected}`);
}

function startGateway(repo, port, env) {
  return spawn(process.execPath, ["run", CLI_ENTRY, "gateway", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repo.dir,
    env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
}

async function stopGateway(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise((resolve) => process.once("exit", resolve));
  process.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
    await exited;
  }
}

function seedRuns(repo) {
  const api = createSmithers({}, { dbPath: repo.path("smithers.db"), backend: "sqlite" });
  ensureSmithersTables(api.db);
  const configJson = JSON.stringify({ gatewayWorkflowKey: WORKFLOW, gatewaySystem: false });
  const insert = api.db.$client.query(
    "INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms, started_at_ms, finished_at_ms, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const future = Date.now() + 86_400_000;
  for (let index = 0; index < 100; index += 1) {
    const timestamp = future + index;
    insert.run(
      `monitor-recovery-seed-${String(index).padStart(3, "0")}`,
      WORKFLOW,
      "finished",
      timestamp,
      timestamp,
      timestamp,
      configJson,
    );
  }
  api.db.$client.close();
}

function replaceRunWhileOffline(repo) {
  const sqlite = new Database(repo.path("smithers.db"));
  const timestamp = Date.now() + 172_800_000;
  const configJson = JSON.stringify({ gatewayWorkflowKey: WORKFLOW, gatewaySystem: false });
  sqlite.transaction(() => {
    sqlite.query("DELETE FROM _smithers_runs WHERE run_id = ?").run(REMOVED_RUN);
    sqlite
      .query(
        "INSERT INTO _smithers_runs (run_id, workflow_name, status, created_at_ms, started_at_ms, finished_at_ms, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ADDED_RUN, WORKFLOW, "finished", timestamp, timestamp, timestamp, configJson);
  })();
  sqlite.close();
}

async function chooseFilter(page, testId, option) {
  await page.getByTestId(testId).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

browserTest(
  "monitor preserves selection, filters, and pagination across gateway recovery",
  async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    const env = { HOME: repo.dir, NO_COLOR: "1", FORCE_COLOR: "0" };
    expect(runSmithers(["init"], { cwd: repo.dir, format: "json", env }).exitCode).toBe(0);
    repo.write(`.smithers/workflows/${WORKFLOW}.tsx`, RECOVERY_WORKFLOW);
    seedRuns(repo);

    const port = await findOpenPort();
    const base = `http://127.0.0.1:${port}`;
    let gateway = startGateway(repo, port, env);
    let browser;
    try {
      expect(await waitForHealth(base)).toBe(true);
      const launched = await rpc(base, "launchRun", { workflow: WORKFLOW, input: {}, runId: SELECTED_RUN });
      expect(launched.runId).toBe(SELECTED_RUN);
      await waitForRunStatus(base, SELECTED_RUN, "finished");
      const listed = await rpc(base, "listRuns", { filter: { limit: 1000 } });
      expect(listed).toHaveLength(101);

      browser = await CHROMIUM.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(`${base}/monitor`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="monitor-root"]', { timeout: 30_000 });
      await page
        .waitForFunction(() => (document.body.textContent ?? "").includes("101/101 runs"), { timeout: 30_000 })
        .catch(async (error) => {
          throw new Error(
            `${error.message}\nMonitor body: ${(await page.locator("body").textContent())?.slice(0, 2_000)}`,
          );
        });

      await page.getByTestId("monitor-filter").fill("monitor-recovery");
      await chooseFilter(page, "monitor-status-filter", "finished");
      await chooseFilter(page, "monitor-workflow-filter", WORKFLOW);
      await page.getByTestId("monitor-page-next").click();
      expect(await page.getByTestId("monitor-runs-pagination").textContent()).toContain("Page 2 / 2");
      await page.locator(`[data-run-id="${SELECTED_RUN}"]`).click();
      await page
        .locator(".mon-tree-name")
        .filter({ hasText: /^probe$/ })
        .locator("..")
        .click();
      await page.waitForSelector('[data-testid="monitor-inspector"]');
      expect(new URL(page.url()).searchParams.get("runId")).toBe(SELECTED_RUN);
      expect(new URL(page.url()).searchParams.get("nodeId")).toBe("probe");

      await stopGateway(gateway);
      await page.waitForSelector('[data-testid="monitor-conn"][data-conn="offline"]', { timeout: 30_000 });
      await page.waitForSelector('[data-testid="monitor-run-detail"]');
      await page.waitForSelector('[data-testid="monitor-inspector"]');
      expect(await page.getByTestId("monitor-filter").inputValue()).toBe("monitor-recovery");
      expect(await page.getByTestId("monitor-status-filter").textContent()).toContain("finished");
      expect(await page.getByTestId("monitor-workflow-filter").textContent()).toContain(WORKFLOW);

      replaceRunWhileOffline(repo);
      gateway = startGateway(repo, port, env);
      expect(await waitForHealth(base)).toBe(true);
      await page.waitForSelector('[data-testid="monitor-conn"][data-conn="online"]', { timeout: 30_000 });
      await page.waitForSelector('[data-testid="monitor-run-detail"]');
      await page.waitForSelector('[data-testid="monitor-inspector"]');
      expect(new URL(page.url()).searchParams.get("runId")).toBe(SELECTED_RUN);
      expect(new URL(page.url()).searchParams.get("nodeId")).toBe("probe");

      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="monitor-inspector"]', { state: "detached" });
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-testid="monitor-runs-table"]');
      expect(await page.getByTestId("monitor-filter").inputValue()).toBe("monitor-recovery");
      expect(await page.getByTestId("monitor-status-filter").textContent()).toContain("finished");
      expect(await page.getByTestId("monitor-workflow-filter").textContent()).toContain(WORKFLOW);
      expect(await page.getByTestId("monitor-runs-pagination").textContent()).toContain("Page 2 / 2");
      expect(await page.locator(`[data-run-id="${SELECTED_RUN}"]`).count()).toBe(1);

      await page.getByTestId("monitor-page-prev").click();
      expect(await page.locator(`[data-run-id="${ADDED_RUN}"]`).count()).toBe(1);
      expect(await page.locator(`[data-run-id="${REMOVED_RUN}"]`).count()).toBe(0);
    } finally {
      try {
        await browser?.close();
      } catch {}
      try {
        await stopGateway(gateway);
      } catch {}
    }
  },
  180_000,
);
