import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * REAL end-to-end of the UltraGrill product (workflow + UI), driven through the
 * browser over real RPC — no mocking.
 *
 * A real gateway runs the REAL ultragrill workflow as an open-ended session and
 * serves the REAL UI. A headless browser opens the UI, types a directive, and
 * Sends it — which posts a `utterance` signal over the live gateway, waking the
 * run; a worker dispatches (the repo's standard fake `claude` agent is the only
 * stub), updates the living spec, and emits questions; the UI renders the worker
 * activity, the living spec, and the question pool from real run state. Then End
 * posts the `end` signal and the session finishes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const runnerScript = resolve(here, "ultragrillRunFixture.ts");
const realNodeModules = resolve(repoRoot, "node_modules");
const RUN_ID = "ultragrill-e2e";

// Superset worker response: satisfies the work schema with recognizable tokens.
const FAKE_RESPONSE = JSON.stringify({
  summary: "added a dark-mode toggle to the settings page",
  artifact: "# Settings Page — Living Spec\n\n## Sections\n- Account\n- Appearance: dark-mode toggle\n\n## Open\n- persistence strategy\n",
  questions: ["Tabs or a sidebar for the settings sections?", "Persist preference per-user or per-device?"],
});

let tempRepo = "";
let binDir = "";
let proc: ChildProcess | undefined;
let port = 0;
let base = "";

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
async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function loadChromium() {
  const pkg = "playwright";
  try {
    return (await import(pkg)).chromium;
  } catch {
    return (await import(resolve(repoRoot, "apps/smithers-studio-2/node_modules/playwright/index.js"))).chromium;
  }
}

beforeAll(async () => {
  // No git/worktree needed for ultragrill — just a cwd with node_modules so the
  // subprocess resolves modules from the real repo.
  tempRepo = mkdtempSync(join(tmpdir(), "ultragrill-e2e-"));
  symlinkSync(realNodeModules, join(tempRepo, "node_modules"), "dir");
  writeFileSync(join(tempRepo, "package.json"), JSON.stringify({ name: "ultragrill-e2e", type: "module" }) + "\n");

  binDir = mkdtempSync(join(tmpdir(), "ultragrill-bin-"));
  const claudeSrc = [
    `#!${process.execPath}`,
    `const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? "{}";`,
    `process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n" }] } }) + "\\n");`,
    ``,
  ].join("\n");
  writeFileSync(join(binDir, "claude"), claudeSrc);
  chmodSync(join(binDir, "claude"), 0o755);

  port = await findOpenPort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [runnerScript], {
    cwd: tempRepo,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SMITHERS_FAKE_AGENT_RESPONSE: FAKE_RESPONSE,
      ANTHROPIC_API_KEY: "",
      UG_PORT: String(port),
      UG_RUN_ID: RUN_ID,
    },
    stdio: "ignore",
  });
  expect(await waitForHealth(60_000)).toBe(true);
}, 80_000);

afterAll(() => {
  try { proc?.kill("SIGTERM"); } catch {}
  try { rmSync(tempRepo, { recursive: true, force: true }); } catch {}
  try { rmSync(binDir, { recursive: true, force: true }); } catch {}
});

test("a real UltraGrill session: say something → worker works → spec + questions → end", async () => {
  const browser = await (await loadChromium()).launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));

    await page.goto(`${base}/workflows/ultragrill?runId=${RUN_ID}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="ultragrill-ui"]', { timeout: 20_000 });

    // Say something: type a directive and Send → posts a real `utterance` signal.
    await page.fill('[data-testid="ug-composer"]', "Add an Appearance section with a dark mode toggle");
    await page.click('[data-testid="ug-send"]');

    // The user message shows in the feed immediately (optimistic).
    await page.waitForSelector('[data-testid="ug-feed-me"]', { timeout: 20_000 });

    // The worker really dispatched and finished — its activity appears, and the
    // living spec + question pool render THIS run's real worker output.
    await page.waitForSelector('[data-testid="ug-feed-worker"]', { timeout: 30_000 });
    await page.waitForFunction(
      () => {
        const text = document.body.textContent ?? "";
        return text.includes("Settings Page — Living Spec") && text.includes("dark-mode toggle");
      },
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForSelector('[data-testid="ug-question"]', { timeout: 20_000 });
    const questionText = await page.evaluate(
      () => document.querySelector('[data-testid="ug-questions"]')?.textContent ?? "",
    );
    expect(questionText).toContain("Tabs or a sidebar");

    // End the session → posts the `end` signal; the run leaves the running state.
    await page.waitForSelector('[data-testid="ug-end"]', { timeout: 20_000 });
    await page.click('[data-testid="ug-end"]');
    await page.waitForFunction(
      () => {
        const s = document.querySelector('[data-testid="ug-status"]')?.textContent ?? "";
        return s === "finished" || s === "continued";
      },
      undefined,
      { timeout: 30_000 },
    );

    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);
