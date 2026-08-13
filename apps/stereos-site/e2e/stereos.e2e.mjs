// End-to-end check against the deployed site.
//
// Boots the real page in headless Chromium, waits for the WebContainer to
// install smthrs and run the three workflows, clicks the approval in the
// embedded app, and asserts the engine-reported statuses.
//
// Run: node apps/stereos-site/e2e/stereos.e2e.mjs [url]
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/williamcory/smithers/e2e/node_modules/playwright/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? "https://stereos.smithers.sh/";
const logPath = join(here, "last-run.log");
const failures = [];

writeFileSync(logPath, `${url}\n`);

/** Write a line to stdout and to the log file, so a killed run still leaves evidence. */
function say(line) {
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
}

/** Record a check result. */
function check(name, ok, detail = "") {
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures.push(name);
  }
}

/** Poll until predicate returns truthy or the deadline passes. */
async function waitFor(label, predicate, timeoutMs, intervalMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  say(`timeout waiting for ${label}`);
  return null;
}

await mkdir(here, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("pageerror", (error) => say(`pageerror: ${error.message.slice(0, 200)}`));

// 1. Headers and cross-origin isolation.
const response = await page.goto(url, { waitUntil: "load" });
const headers = response.headers();
check(
  "COOP/COEP headers",
  headers["cross-origin-opener-policy"] === "same-origin" &&
    headers["cross-origin-embedder-policy"] === "require-corp",
  `coop=${headers["cross-origin-opener-policy"]} coep=${headers["cross-origin-embedder-policy"]}`,
);
check("crossOriginIsolated", await page.evaluate(() => window.crossOriginIsolated === true));

// 2. Tab 1 renders.
const h1 = await page.locator("#panel-api h1").first().textContent();
const shikiBlocks = await page.locator("#panel-api pre.shiki").count();
check("tab 1 h1", h1?.includes("stereOS Sandbox Provider"), h1 ?? "");
check("tab 1 shiki blocks", shikiBlocks > 0, `${shikiBlocks} blocks`);
await page.screenshot({ path: join(here, "tab1-proposed-api.png"), fullPage: false });

// 3. Tab 2 runs the workflows.
await page.click("#tab-demo");
await page.click("#start");

const installed = await waitFor(
  "install",
  async () => (await page.locator('[data-step="install"]').getAttribute("data-state")) === "done",
  15 * 60 * 1000,
);
check("npm install inside WebContainer", Boolean(installed));

const helloStatus = await waitFor(
  "hello",
  async () => {
    const text = await page.locator("#hello-status").textContent();
    return text && text !== "—" ? text : null;
  },
  10 * 60 * 1000,
);
check("hello finished (engine-reported)", helloStatus === "finished", String(helloStatus));

const pipelineStatus = await waitFor(
  "pipeline",
  async () => {
    const text = await page.locator("#pipeline-status").textContent();
    return text && text !== "—" ? text : null;
  },
  10 * 60 * 1000,
);
check("pipeline finished (engine-reported)", pipelineStatus === "finished", String(pipelineStatus));

const approvalStatus = await waitFor(
  "approval gate",
  async () => {
    const text = await page.locator("#approval-status").textContent();
    return text && text !== "—" ? text : null;
  },
  10 * 60 * 1000,
);
check("approval-demo pauses at the gate", approvalStatus === "waiting-approval", String(approvalStatus));

// 4. Click Approve inside the app served from the container.
const appFrame = page.frameLocator("#app-frame");
const approveButton = appFrame.locator('button:has-text("Approve")').first();
const approveReady = await waitFor(
  "approve button",
  async () => ((await approveButton.count()) > 0 ? true : null),
  6 * 60 * 1000,
);
check("embedded app shows the pending approval", Boolean(approveReady));
await page.screenshot({ path: join(here, "tab2-live-demo.png"), fullPage: false });

if (approveReady) {
  await approveButton.click();
  const finished = await waitFor(
    "approval-demo finish",
    async () => {
      const text = await page.locator("#approval-status").textContent();
      return text === "finished" ? text : null;
    },
    8 * 60 * 1000,
  );
  check("approval-demo finishes after the click", finished === "finished", String(finished));
  const iframeFinished = await waitFor(
    "gateway final state",
    async () => ((await appFrame.locator('[data-testid="run-row"][data-status="finished"]').count()) > 0 ? true : null),
    4 * 60 * 1000,
  );
  check("embedded app shows an engine-finished run", Boolean(iframeFinished));
}

await page.screenshot({ path: join(here, "tab2-live-demo-final.png"), fullPage: false });
await browser.close();

say(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures.join(", ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);
