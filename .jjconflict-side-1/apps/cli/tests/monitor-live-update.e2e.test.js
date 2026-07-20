import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExecutableDir,
  createTempRepo,
  pinSqliteBackend,
  runSmithers,
  writeFakeAntigravityBinary,
  writeFakeClaudeBinary,
  writeFakeCodexBinary,
} from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * Browser coverage for the Monitor's live collection invalidation. The page
 * starts on an empty real gateway, then a separate CLI process creates a real
 * suspended approval run in the same workspace. No browser routing or websocket
 * frames are fabricated: the assertion only passes when the gateway notices the
 * out-of-band run and pushes the resulting collection change to the page.
 */

const require = createRequire(import.meta.url);
const CLI_ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));

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

const APPROVAL_WORKFLOW = `
/** @jsxImportSource smithers-orchestrator */
import { Approval, createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, smithers, outputs } = createSmithers({
  approval: z.object({ approved: z.boolean() }),
});

export default smithers(() => (
  <Workflow name="monitor-live-update-probe">
    <Approval
      id="live-gate"
      output={outputs.approval}
      request={{ title: "Live monitor approval", summary: "Created after the monitor connects." }}
      onDeny="fail"
    />
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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
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

browserTest("monitor renders an out-of-band approval run without a reload", async () => {
  const binDir = createExecutableDir();
  writeFakeClaudeBinary(binDir);
  writeFakeCodexBinary(binDir);
  writeFakeAntigravityBinary(binDir);
  const repo = createTempRepo();
  pinSqliteBackend(repo.dir);
  const env = {
    HOME: repo.dir,
    PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "sk-test-openai-key",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
  repo.write(".claude/.credentials.json", "{}\n");
  repo.write(".codex/auth.json", "{}\n");
  repo.write(".gemini/antigravity-cli/settings.json", "{}\n");

  expect(runSmithers(["init"], { cwd: repo.dir, format: "json", env }).exitCode).toBe(0);
  repo.write(".smithers/workflows/monitor-live-update-probe.tsx", APPROVAL_WORKFLOW);

  const port = await findOpenPort();
  const base = `http://127.0.0.1:${port}`;
  // Use the real CLI gateway rather than the init-pack gateway entry: it owns
  // the Monitor mount at /monitor.
  const gatewayProc = spawn(process.execPath, ["run", CLI_ENTRY, "gateway", "--port", String(port)], {
    cwd: repo.dir,
    env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  let browser;
  try {
    expect(await waitForHealth(base)).toBe(true);
    browser = await CHROMIUM.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${base}/monitor`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="monitor-root"]', { timeout: 20_000 }).catch(async (error) => {
      throw new Error(`${error.message}\nMonitor body: ${(await page.locator("body").textContent())?.slice(0, 2000)}`);
    });

    const runId = "monitor-live-update-run";
    const navigationCount = await page.evaluate(() => performance.getEntriesByType("navigation").length);
    expect((await page.locator("body").textContent()) ?? "").not.toContain(runId);
    const launched = await rpc(base, "launchRun", {
      workflow: "monitor-live-update-probe",
      input: {},
      runId,
    });
    expect(launched.runId).toBe(runId);

    // The gateway's real collection stream invalidates the already-mounted
    // monitor; this waits for the new DOM state and deliberately never reloads.
    await page.waitForFunction(
      () => (document.body.textContent ?? "").includes("monitor-live-update-probe"),
      { timeout: 30_000 },
    );
    await page.waitForFunction(
      () => (document.body.textContent ?? "").includes("Live monitor approval"),
      { timeout: 30_000 },
    );
    expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(navigationCount);
  } finally {
    try { await browser?.close(); } catch {}
    try { await stopGateway(gatewayProc); } catch {}
  }
}, 180_000);
