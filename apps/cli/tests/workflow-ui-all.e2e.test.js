import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeAntigravityBinary,
  writeFakeClaudeBinary,
  writeFakeCodexBinary,
} from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * Real-browser e2e for EVERY init-pack workflow UI. No route mocking, no faked
 * assertions: a real `smithers init`, the generated gateway.ts booted as a real
 * server bundling each UI on demand via Bun, and a headless Chromium loading
 * every UI from the live gateway.
 *
 * Two real, layered checks:
 *   - ALL 16 UIs: build + boot + mount in the browser (catches bundle errors,
 *     bad imports, and mount-time crashes — this is the check that caught an
 *     MDX import failure and a gateway-wide crash).
 *   - The OUTPUT-VERIFIED subset (workflows that complete deterministically with
 *     the stub agent): the workflow is EXECUTED for real and the UI is asserted
 *     to render that run's real node output.
 *
 * The remaining UIs are build+boot only — not as a shortcut, but because they
 * either loop forever / interview a human (ralph, grill-me, mission) or don't
 * complete deterministically headless, and node OUTPUT cannot
 * be hand-seeded (it lives in per-node, schema-bound output tables). The agent
 * is the ONLY stub — the repo's standard e2e fixture — everything else is real.
 *
 * Runs under bun (init helpers shell out to bun; the gateway uses bun:sqlite);
 * Chromium is resolved from the playwright devDependency declared in apps/cli.
 * If the binary is not installed (e.g. CI), the test is skipped.
 */

const DESCRIPTORS = JSON.parse(readFileSync(resolve(import.meta.dir, "workflow-ui-descriptors.json"), "utf8"));
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
const workflowUiTest = CHROMIUM ? test : test.skip;

// A free port picked at run time, so rapid re-runs (or a lingering gateway from
// a prior run) can't collide and leave the new gateway unable to bind.
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

async function loadChromium() {
  if (!CHROMIUM) throw new Error("Playwright Chromium executable is not installed");
  return CHROMIUM;
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

async function checkUi(page, base, descriptor, runId) {
  const url = `${base}/workflows/${descriptor.key}${runId ? `?runId=${runId}` : ""}`;
  await page.goto(url, { waitUntil: "networkidle" });
  // Real bundle built + app mounted to its root element.
  if (descriptor.primaryTestId) {
    await page.waitForSelector(`[data-testid="${descriptor.primaryTestId}"]`, { timeout: 20_000 });
  } else {
    await page.waitForFunction(() => (document.body.textContent ?? "").trim().length > 0, { timeout: 20_000 });
    if (!descriptor.verifyOutput && descriptor.expectedText?.length) {
      await page.waitForFunction(
        (expected) => {
          const text = document.body.textContent ?? "";
          return expected.every((t) => text.includes(t));
        },
        descriptor.expectedText,
        { timeout: 20_000 },
      );
    }
  }
  if (!(descriptor.verifyOutput && runId)) return null;
  // The run-output region appears once node output binds, then the run's real
  // (stub-produced) output text must be present in the rendered DOM.
  if (descriptor.populatedTestId) {
    await page.waitForSelector(`[data-testid="${descriptor.populatedTestId}"]`, { timeout: 20_000 });
  }
  await page
    .waitForFunction(
      (expected) => {
        const text = document.body.textContent ?? "";
        return expected.every((t) => text.includes(t));
      },
      descriptor.expectedText,
      { timeout: 20_000 },
    )
    .catch(() => {});
  const bodyText = (await page.evaluate(() => document.body.textContent)) ?? "";
  const missing = descriptor.expectedText.filter((t) => !bodyText.includes(t));
  return missing.length ? `rendered output missing: ${missing.join(" | ")}` : null;
}

workflowUiTest("every init-pack workflow UI builds + boots; the output-verified set renders real runs", async () => {
  const binDir = createExecutableDir();
  writeFakeClaudeBinary(binDir);
  writeFakeCodexBinary(binDir);
  writeFakeAntigravityBinary(binDir);
  const repo = createTempRepo();
  const env = {
    HOME: repo.dir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "test-openai-key",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
  repo.write(".claude/.credentials.json", "{}\n");
  repo.write(".codex/auth.json", "{}\n");
  repo.write(".gemini/antigravity-cli/settings.json", "{}\n");

  expect(runSmithers(["init"], { cwd: repo.dir, format: "json", env }).exitCode).toBe(0);

  // Execute the output-verified workflows for real and capture their run ids.
  const runIdByKey = {};
  const runFailures = [];
  for (const d of DESCRIPTORS.filter((x) => x.verifyOutput)) {
    const r = runSmithers(["workflow", ...d.launchArgs], { cwd: repo.dir, format: "json", env, timeoutMs: 180_000 });
    if (r.exitCode === 0 && typeof r.json?.runId === "string") {
      runIdByKey[d.key] = r.json.runId;
    } else {
      runFailures.push(`${d.key}: run exit=${r.exitCode}`);
    }
  }

  const port = await findOpenPort();
  const base = `http://127.0.0.1:${port}`;
  const gatewayProc = spawn(process.execPath, ["run", ".smithers/gateway.ts"], {
    cwd: repo.dir,
    env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  let browser;
  const uiFailures = [];
  try {
    expect(await waitForHealth(base)).toBe(true);
    browser = await (await loadChromium()).launch({ headless: true });
    const page = await browser.newPage();
    for (const d of DESCRIPTORS) {
      const tag = d.verifyOutput ? "output" : "boot  ";
      try {
        const problem = await checkUi(page, base, d, runIdByKey[d.key]);
        console.log(`  ${problem ? "FAIL" : "ok  "} [${tag}] ${d.key}${problem ? " — " + problem : ""}`);
        if (problem) uiFailures.push(`${d.key}: ${problem}`);
      } catch (err) {
        console.log(`  FAIL [${tag}] ${d.key} — ${err.message.split("\n")[0]}`);
        uiFailures.push(`${d.key}: ${err.message.split("\n")[0]}`);
      }
    }
  } finally {
    try { await browser?.close(); } catch {}
    try { gatewayProc.kill("SIGTERM"); } catch {}
  }

  expect(runFailures).toEqual([]);
  expect(uiFailures).toEqual([]);
}, 600_000);
