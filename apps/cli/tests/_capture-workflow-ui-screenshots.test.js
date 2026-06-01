import { test } from "bun:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  REPO_ROOT,
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeAntigravityBinary,
  writeFakeClaudeBinary,
  writeFakeCodexBinary,
} from "../../../packages/smithers/tests/e2e-helpers.js";

// One-off screenshot capturer (NOT a real test — a generation tool). Boots a
// real init-pack gateway with stub agents, executes the completable workflows
// for real run data, then captures each UI from the live gateway in Chromium to
// docs/images/workflow-ui/<key>.png. Run with:
// SMITHERS_CAPTURE_WORKFLOW_UI_SCREENSHOTS=1 bun test <thisfile>

const DESCRIPTORS = JSON.parse(readFileSync(resolve(import.meta.dir, "workflow-ui-descriptors.json"), "utf8"));
const OUT_DIR = resolve(REPO_ROOT, "docs/images/workflow-ui");
const VIEWPORT = { width: 1280, height: 832 };
const require = createRequire(import.meta.url);
const STUDIO_PLAYWRIGHT_ENTRY = resolve(REPO_ROOT, "apps/smithers-studio-2/node_modules/playwright/index.js");

function resolveChromium() {
  const entries = ["playwright"];
  if (existsSync(STUDIO_PLAYWRIGHT_ENTRY)) entries.push(STUDIO_PLAYWRIGHT_ENTRY);
  for (const entry of entries) {
    try {
      const chromium = require(entry).chromium;
      const executablePath = chromium?.executablePath?.();
      if (typeof executablePath === "string" && existsSync(executablePath)) return chromium;
    } catch {}
  }
  return null;
}

const CHROMIUM = resolveChromium();
const captureTest =
  process.env.SMITHERS_CAPTURE_WORKFLOW_UI_SCREENSHOTS === "1" && CHROMIUM
    ? test
    : test.skip;

function findOpenPort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
async function loadChromium() {
  if (!CHROMIUM) throw new Error("Playwright Chromium executable is not installed");
  return CHROMIUM;
}
async function waitForHealth(base, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

captureTest("capture workflow UI screenshots", async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const binDir = createExecutableDir();
  writeFakeClaudeBinary(binDir);
  writeFakeCodexBinary(binDir);
  writeFakeAntigravityBinary(binDir);
  const repo = createTempRepo();
  const env = {
    HOME: repo.dir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "test-openai-key", GEMINI_API_KEY: "", GOOGLE_API_KEY: "",
  };
  repo.write(".claude/.credentials.json", "{}\n");
  repo.write(".codex/auth.json", "{}\n");
  repo.write(".gemini/antigravity-cli/settings.json", "{}\n");
  if (runSmithers(["init"], { cwd: repo.dir, format: "json", env }).exitCode !== 0) throw new Error("init failed");

  // Run every workflow that can complete with the stub so its UI shows real data.
  // Best-effort: a non-completing run just yields an empty-state screenshot.
  const runIdByKey = {};
  for (const d of DESCRIPTORS) {
    if (!d.verifyOutput) continue;
    const r = runSmithers(["workflow", d.key, "--prompt", "Ship the new login flow"], { cwd: repo.dir, format: "json", env, timeoutMs: 180_000 });
    if (r.exitCode === 0 && typeof r.json?.runId === "string") runIdByKey[d.key] = r.json.runId;
  }

  const port = await findOpenPort();
  const base = `http://127.0.0.1:${port}`;
  const gw = spawn(process.execPath, ["run", ".smithers/gateway.ts"], {
    cwd: repo.dir, env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" }, stdio: "ignore",
  });
  let browser;
  try {
    if (!(await waitForHealth(base))) throw new Error("gateway not healthy");
    browser = await (await loadChromium()).launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize(VIEWPORT);
    for (const d of DESCRIPTORS) {
      const runId = runIdByKey[d.key];
      const url = `${base}/workflows/${d.key}${runId ? `?runId=${runId}` : ""}`;
      await page.goto(url, { waitUntil: "networkidle" });
      try { await page.waitForSelector(`[data-testid="${d.primaryTestId}"]`, { timeout: 15_000 }); } catch {}
      if (d.verifyOutput && d.populatedTestId) {
        try { await page.waitForSelector(`[data-testid="${d.populatedTestId}"]`, { timeout: 10_000 }); } catch {}
      }
      await new Promise((r) => setTimeout(r, 400)); // settle fonts/layout
      const file = resolve(OUT_DIR, `${d.key}.png`);
      await page.screenshot({ path: file });
      console.log(`  shot ${d.key}${runId ? " (run " + runId.slice(0, 8) + ")" : " (empty state)"} -> ${file}`);
    }
    // Also capture kanban (its own UI, not in descriptors).
    await page.goto(`${base}/workflows/kanban`, { waitUntil: "networkidle" });
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: resolve(OUT_DIR, "kanban.png") });
    console.log("  shot kanban (empty state)");
  } finally {
    try { await browser?.close(); } catch {}
    try { gw.kill("SIGTERM"); } catch {}
  }
}, 600_000);
