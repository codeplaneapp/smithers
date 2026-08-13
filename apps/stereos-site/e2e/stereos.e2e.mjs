// End-to-end check against the deployed site.
//
// Boots the real page in headless Chromium, asserts the tab-3 stereOS-run
// evidence, then waits for the WebContainer to install smthrs and run the three
// workflows, clicks the approval in the embedded app, and asserts the
// engine-reported statuses.
//
// Run: node apps/stereos-site/e2e/stereos.e2e.mjs [url]
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// apps/cli declares Playwright. Resolve through that package so this works in
// any checkout and with any pnpm virtual-store layout.
const require = createRequire(new URL("../../cli/package.json", import.meta.url));
const { chromium } = require("playwright");

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
  headers["cross-origin-opener-policy"] === "same-origin" && headers["cross-origin-embedder-policy"] === "require-corp",
  `coop=${headers["cross-origin-opener-policy"]} coep=${headers["cross-origin-embedder-policy"]}`,
);
check("crossOriginIsolated", await page.evaluate(() => window.crossOriginIsolated === true));
check(
  "inline favicon",
  (await page.locator('link[rel="icon"]').getAttribute("href"))?.startsWith("data:image/svg+xml") === true,
);
check(
  "meta description",
  ((await page.locator('meta[name="description"]').getAttribute("content")) ?? "").includes("real Smithers Sandbox"),
);
check("Real stereOS is the default tab", (await page.locator("#tab-real").getAttribute("aria-selected")) === "true");
check("default real panel is visible", await page.locator("#panel-real").isVisible());
const registryText = (await page.locator("#panel-real").textContent()) ?? "";
check(
  "registry defect is documented",
  registryText.includes("d335283a5c0c9fde") &&
    registryText.includes("bf212e026f722ccc") &&
    registryText.includes("Data corruption detected"),
);

// 2. Tab 1 renders.
await page.click("#tab-api");
const h1 = await page.locator("#panel-api h1").first().textContent();
const shikiBlocks = await page.locator("#panel-api pre.shiki").count();
check("tab 1 h1", h1?.includes("stereOS Sandbox Provider"), h1 ?? "");
check("tab 1 shiki blocks", shikiBlocks > 0, `${shikiBlocks} blocks`);
await page.screenshot({ path: join(here, "tab1-proposed-api.png"), fullPage: false });

// 3. Tab 3 carries the real-stereOS evidence.
await page.click("#tab-real");
const realTitle = await page.locator("#panel-real h1").first().textContent();
check("tab 3 h1", realTitle?.includes("real stereOS VM"), realTitle ?? "");

const transcript = (await page.locator("#real-terminal").textContent()) ?? "";
check("tab 3 shows the raw recorded run", transcript.includes("mb up"), `${transcript.length} chars`);
check(
  "transcript proves the guest produced the output",
  transcript.includes("child workflow executed inside stereOS as agent@coder") &&
    transcript.includes("Linux 6.12.74 aarch64") &&
    transcript.includes("Bun 1.2.21 arm64") &&
    transcript.includes('"primeCount"'),
);
check("transcript shows the sandbox lifecycle", transcript.includes("SandboxCompleted"));
check("transcript shows the restriction model", transcript.includes('"writeOutsideWorkspace": "denied"'));

// Capture the default (macOS) recording before switching hosts, so the two
// committed tab-3 screenshots both stay reproducible output of this script.
await page.screenshot({ path: join(here, "tab3-real-stereos.png"), fullPage: false });

// The second recording is the Linux/KVM host, so the page must show both.
const runNames = await page.locator("#real-run-select option").allTextContents();
check("tab 3 offers both hosts", runNames.length === 2, runNames.join(" | "));
await page.selectOption("#real-run-select", { index: 1 });
const linuxTranscript = (await page.locator("#real-terminal").textContent()) ?? "";
check(
  "second recording is the x86_64 KVM run",
  linuxTranscript.includes("agent@coder-dev on Linux 6.18.33 x86_64") &&
    linuxTranscript.includes("Bun 1.2.21 x64") &&
    linuxTranscript.includes("QEMU/KVM"),
  `${linuxTranscript.length} chars`,
);

const sourceNames = await page.locator("#real-source-select option").allTextContents();
check(
  "tab 3 offers the provider source",
  sourceNames.includes("stereos-provider.ts") &&
    sourceNames.includes("guest-runner.sh") &&
    sourceNames.includes("bootstrap-vm.sh") &&
    sourceNames.includes("README.md"),
  sourceNames.join(","),
);
const providerSource = (await page.locator("#real-source").textContent()) ?? "";
check(
  "provider source is the shipped kit",
  providerSource.includes("createCommandSandboxProvider"),
  `${providerSource.length} chars`,
);
await page.screenshot({ path: join(here, "tab3-real-stereos-linux.png"), fullPage: false });

// The WebContainer tab must still say plainly that it is the simulation.
await page.click("#tab-demo");
const demoBanner = (await page.locator("#panel-demo .banner").first().textContent()) ?? "";
check(
  "tab 2 is labelled as the simulation",
  demoBanner.includes("simulates the seam") && demoBanner.includes("Nothing in"),
  demoBanner.slice(0, 80),
);
check("app placeholder starts visible", await page.locator("#app-frame-empty").isVisible());

// 4. Tab 2 runs the workflows.
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

// 5. Click Approve inside the app served from the container.
const appFrame = page.frameLocator("#app-frame");
const approveButton = appFrame.locator('button:has-text("Approve")').first();
const approveReady = await waitFor(
  "approve button",
  async () => ((await approveButton.count()) > 0 ? true : null),
  6 * 60 * 1000,
);
check("embedded app shows the pending approval", Boolean(approveReady));
check(
  "app placeholder hides when iframe is live",
  (await page.locator("#app-frame-empty").getAttribute("hidden")) !== null &&
    (await page.locator("#app-frame-empty").evaluate((element) => getComputedStyle(element).display)) === "none",
);
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
