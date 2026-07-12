import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeAntigravityBinary,
  writeFakeClaudeBinary,
  writeFakeCodexBinary,
} from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * Focused real-browser e2e for two surfaces a first-time user hits the moment
 * they boot the gateway a fresh `smithers init` ships:
 *
 *   1. Gateway ROOT routing (the 0.25.2 fix, #464): `GET /` must route to the
 *      console (302) or serve a real landing page (200 text/html "Smithers
 *      Gateway"), NOT the bare `404 {error:{code:"NOT_FOUND"}}` JSON it used to
 *      return. The server package has unit coverage for the handler, but nothing
 *      exercised it through the generated `.smithers/gateway.ts` in a browser —
 *      this closes that gap.
 *   2. A workflow-owned <UI> declaration is discovered from workflow source.
 *   3. A workflow UI bundle builds, boots, and mounts in a real Chromium loaded
 *      from the live gateway (`/workflows/docs-driven-development`).
 *
 * No route mocking: a real `smithers init`, the generated gateway booted as a
 * real server, and a headless Chromium driving it. Chromium is resolved from the
 * `playwright` devDependency declared in apps/cli; if it is not installed (CI),
 * the test skips.
 */

const require = createRequire(import.meta.url);

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
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function listWorkflowUi(base, key) {
  const response = await fetch(`${base}/v1/rpc/listWorkflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filter: { hasUi: true } }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  return body.payload.find((workflow) => workflow.key === key);
}

browserTest(
  "gateway root routes to console/landing (not 404 JSON) and a workflow UI mounts",
  async () => {
    const binDir = createExecutableDir();
    writeFakeClaudeBinary(binDir);
    writeFakeCodexBinary(binDir);
    writeFakeAntigravityBinary(binDir);
    const repo = createTempRepo();
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
    expect(repo.read(".smithers/gateway.ts")).not.toContain("ui: { entry:");
    expect(repo.read(".smithers/workflows/docs-driven-development.tsx")).toContain(
      '<UI entry="../ui/docs-driven-development.tsx"',
    );

    const port = await findOpenPort();
    const base = `http://127.0.0.1:${port}`;
    const gatewayProc = spawn(process.execPath, ["run", ".smithers/gateway.ts"], {
      cwd: repo.dir,
      env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const gatewayLogs = [];
    for (const stream of [gatewayProc.stdout, gatewayProc.stderr]) {
      stream?.on("data", (chunk) => {
        gatewayLogs.push(String(chunk));
        if (gatewayLogs.length > 100) gatewayLogs.shift();
      });
    }

    let browser;
    try {
      expect(await waitForHealth(base)).toBe(true);
      expect(await listWorkflowUi(base, "docs-driven-development")).toEqual(
        expect.objectContaining({
          key: "docs-driven-development",
          hasUi: true,
          uiPath: "/workflows/docs-driven-development",
        }),
      );

      // 1a — Raw HTTP: `GET /` is a 302 (to a mounted console) or a 200 HTML
      // landing page. It must never be the old bare 404 NOT_FOUND JSON.
      const rootRes = await fetch(`${base}/`, { redirect: "manual" });
      expect([200, 302]).toContain(rootRes.status);
      if (rootRes.status === 302) {
        expect(rootRes.headers.get("location")).toBeTruthy();
      } else {
        const contentType = rootRes.headers.get("content-type") ?? "";
        expect(contentType).toContain("text/html");
        const body = await rootRes.text();
        expect(body).toContain("Smithers Gateway");
        // The landing page links operators onward, not a dead end.
        expect(body).toContain("/health");
      }

      browser = await CHROMIUM.launch({ headless: true });
      const page = await browser.newPage();
      const browserErrors = [];
      page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
      });

      // 1b — In a real browser, `/` lands on a real page (it follows the 302),
      // never a JSON error document.
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      const rootText = (await page.evaluate(() => document.body.textContent)) ?? "";
      expect(rootText).not.toContain('"code":"NOT_FOUND"');
      expect(rootText.trim().length).toBeGreaterThan(0);

      // 2 — A workflow UI bundle builds + boots + mounts. The seeded DDD UI
      // ships a stable root test id.
      await page.goto(`${base}/workflows/docs-driven-development`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="docs-driven-development-ui"]', { timeout: 30_000 }).catch(async (error) => {
        const body = ((await page.evaluate(() => document.body.textContent)) ?? "").trim().slice(0, 2_000);
        const assetResponse = await fetch(`${base}/workflows/docs-driven-development/__smithers_ui/client.js`);
        const assetError = (await assetResponse.text()).trim().slice(0, 4_000);
        throw new Error(
          `${error.message}\nBrowser errors: ${browserErrors.join(" | ") || "none"}\n` +
          `Asset ${assetResponse.status}: ${assetError || "(empty)"}\n` +
          `Gateway: ${gatewayLogs.join("").slice(-8_000) || "(no logs)"}\nBody: ${body || "(empty)"}`,
        );
      });

      // An unknown runId must still serve the bundle (empty-run state handled
      // client-side), not 500 the route.
      const unknownRun = await fetch(`${base}/workflows/docs-driven-development?runId=does-not-exist`);
      expect(unknownRun.status).toBe(200);
      expect(unknownRun.headers.get("content-type") ?? "").toContain("text/html");
    } finally {
      try {
        await browser?.close();
      } catch {}
      try {
        gatewayProc.kill("SIGTERM");
      } catch {}
    }
  },
  180_000,
);
