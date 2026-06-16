import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const runnerScript = resolve(here, "openCodeReviewRunFixture.ts");
const realNodeModules = resolve(repoRoot, "node_modules");
const RUN_ID = "open-code-review-e2e-run";

let tempRepo = "";
let proc: ChildProcess | undefined;
let port = 0;
let base = "";

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}
function write(path: string, content: string) {
  writeFileSync(path, content);
}
function findOpenPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolvePort(typeof addr === "object" && addr ? addr.port : 0);
      server.close();
    });
  });
}
async function waitForHealth(timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
// Resolve a Chromium with an installed browser binary. CI runs `pnpm test`
// without `playwright install`, so the browser is often absent — skip rather
// than fail there (matches apps/cli's workflow-ui e2e). Runs wherever a browser
// is installed (local dev, or a job that ran `playwright install`).
const require = createRequire(import.meta.url);
const STUDIO_PLAYWRIGHT_ENTRY = resolve(repoRoot, "apps/smithers-studio-2/node_modules/playwright/index.js");
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
const browserTest = CHROMIUM ? test : test.skip;

beforeAll(async () => {
  if (!CHROMIUM) return; // browser test will skip; don't spawn the fixture server
  tempRepo = mkdtempSync(join(tmpdir(), "open-code-review-e2e-"));
  symlinkSync(realNodeModules, join(tempRepo, "node_modules"), "dir");
  write(join(tempRepo, "package.json"), JSON.stringify({ name: "open-code-review-e2e", type: "module" }) + "\n");
  write(join(tempRepo, ".gitignore"), ["node_modules/", ".smithers/", "smithers.db*"].join("\n") + "\n");

  run("git", ["init"], tempRepo);
  run("git", ["config", "user.email", "test@example.com"], tempRepo);
  run("git", ["config", "user.name", "Test User"], tempRepo);
  mkdirSync(join(tempRepo, "src"), { recursive: true });
  write(join(tempRepo, "src/app.ts"), "export function risky(value: string | null) {\n  return value!.trim();\n}\n");
  run("git", ["add", "."], tempRepo);
  run("git", ["commit", "-m", "initial"], tempRepo);
  write(join(tempRepo, "src/app.ts"), "export function risky(value: string | null) {\n  return value!.trim().toUpperCase();\n}\n");
  write(join(tempRepo, "src/app.test.ts"), "test('risky', () => {});\n");

  port = await findOpenPort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [runnerScript], {
    cwd: tempRepo,
    env: {
      ...process.env,
      OCR_REPO: tempRepo,
      OCR_PORT: String(port),
      OCR_RUN_ID: RUN_ID,
    },
    stdio: "ignore",
  });
  expect(await waitForHealth()).toBe(true);
}, 80_000);

afterAll(() => {
  if (!CHROMIUM) return;
  try { proc?.kill("SIGTERM"); } catch {}
  try { rmSync(tempRepo, { recursive: true, force: true }); } catch {}
});

browserTest("Open Code Review UI renders a real workflow run", async () => {
  const browser = await CHROMIUM.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err: Error) => errors.push(err.message));

    await page.goto(`${base}/workflows/open-code-review?runId=${RUN_ID}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="open-code-review-ui"]', { timeout: 20_000 });

    await page.waitForFunction(
      () => {
        const status = document.querySelector('[data-testid="ocr-workflow-status"]')?.textContent ?? "";
        return status.includes("success") || status.includes("finished");
      },
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="ocr-kpi-reviewable"]')?.textContent ?? "").includes("1"),
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="ocr-kpi-excluded"]')?.textContent ?? "").includes("1"),
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForFunction(
      () => {
        const text = document.body.textContent ?? "";
        return text.includes("src/app.ts") &&
          text.includes("src/app.test.ts") &&
          text.includes("default_path") &&
          text.includes("Guard against null before trimming.") &&
          text.includes("321");
      },
      undefined,
      { timeout: 20_000 },
    );

    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);
