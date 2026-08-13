// End-to-end check against the deployed site.
//
// Drives the real page in headless Chromium and asserts, in order:
//   - the WebContainer simulation tab is gone
//   - the Live demo tab starts a REAL run on the demo host, end to end, and the
//     engine-reported status reaches `finished` with guest-produced evidence
//   - approval-demo parks at `waiting-approval`, the Approve button inside the
//     embedded run UI resolves it, and the run then finishes
//   - the How it works tab still carries both recorded captures and the
//     registry diagnosis
//   - the Implementation tab renders the file tree, opens a file, and shows
//     highlighted source matching the repository
//
// Nothing here is mocked. A failure means the page or the demo host is broken.
//
// Run: node apps/stereos-site/e2e/stereos.e2e.mjs [url]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
async function waitFor(label, predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null);
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  say(`timeout waiting for ${label}`);
  return null;
}

// A cold demo host has to boot the guest before the first run answers, so the
// budgets here are VM budgets, not page budgets.
const CONNECT_MS = 60_000;
const RUN_MS = 180_000;

await mkdir(here, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("pageerror", (error) => say(`pageerror: ${error.message.slice(0, 200)}`));

const response = await page.goto(url, { waitUntil: "load" });

// ── 1. page shell ────────────────────────────────────────────────────────────
check(
  "inline favicon",
  (await page.locator('link[rel="icon"]').getAttribute("href"))?.startsWith("data:image/svg+xml") === true,
);
check(
  "meta description",
  ((await page.locator('meta[name="description"]').getAttribute("content")) ?? "").includes("real stereOS VM"),
);
check("no COEP isolation left over from the WebContainer", !response.headers()["cross-origin-embedder-policy"]);

const tabNames = await page.locator("nav.tabs button").allTextContents();
check("four tabs", tabNames.length === 4, tabNames.join(" | "));
check("Live demo is the default tab", (await page.locator("#tab-live").getAttribute("aria-selected")) === "true");

// ── 2. the simulation tab is gone ────────────────────────────────────────────
const bodyText = (await page.locator("body").textContent()) ?? "";
check(
  "no simulation tab",
  !tabNames.some((name) => /simulat|browser demo|webcontainer/i.test(name)),
  tabNames.join(" | "),
);
check("no WebContainer boot on the page", !(await page.locator("#panel-demo, #start, #terminal").count()));
check(
  "the WebContainer work is credited, not hidden",
  bodyText.includes("WebContainer") && (await page.locator('a[href*="/pull/1506"]').count()) === 1,
);

// ── 3. the Live demo tab runs on a real VM ───────────────────────────────────
const status = page.locator("#live-status");
const connected = await waitFor(
  "the demo host to answer",
  async () => !["connecting", "host offline"].includes(((await status.textContent()) ?? "").trim()),
  CONNECT_MS,
);
check("demo host reachable", Boolean(connected), (await status.textContent()) ?? "");

if (connected) {
  const origin = (await page.locator("#live-origin").textContent()) ?? "";
  check("backend is a tunnel hostname, not an open port", /\.(smithers\.sh|trycloudflare\.com)$/.test(origin), origin);

  const embedded = page.frameLocator("#live-frame");
  check("embedded run UI is served by the demo host", (await embedded.locator("body").count()) === 1);

  // hello: start it from the page, watch the engine-reported status.
  await page.click('[data-start="hello"]');
  const finished = await waitFor(
    "hello to finish",
    async () => ((await status.textContent()) ?? "").trim() === "finished",
    RUN_MS,
  );
  check("hello reaches finished", Boolean(finished), (await status.textContent()) ?? "");

  const evidence = (await page.locator("#live-tiles").textContent()) ?? "";
  check("guest evidence is shown", /coder-dev/.test(evidence) && /stereOS/.test(evidence), evidence.slice(0, 160));
  check("guest is not the host", /Linux 6\.18/.test(evidence) && /denied/.test(evidence), evidence.slice(0, 220));
  check("run id is reported", /^[0-9a-f-]{36}$/.test(((await page.locator("#live-runid").textContent()) ?? "").trim()));

  await page.screenshot({ path: join(here, "tab-live-demo.png"), fullPage: true });

  // approval-demo: park at the gate, approve inside the embedded UI, finish.
  await page.click('[data-start="approval-demo"]');
  const waiting = await waitFor(
    "approval-demo to park",
    async () => ((await status.textContent()) ?? "").trim() === "waiting-approval",
    RUN_MS,
  );
  check("approval-demo parks at waiting-approval", Boolean(waiting), (await status.textContent()) ?? "");

  if (waiting) {
    const approve = embedded.locator('[data-testid="approve"]');
    await approve.waitFor({ state: "visible", timeout: 30_000 });
    await approve.click();
    const approved = await waitFor(
      "approval-demo to finish",
      async () => ((await status.textContent()) ?? "").trim() === "finished",
      RUN_MS,
    );
    check("approval in the embedded UI finishes the run", Boolean(approved), (await status.textContent()) ?? "");
    const applied = (await page.locator("#live-evidence").textContent()) ?? "";
    check("the approved work reports guest facts", /coder-dev/.test(applied), applied.slice(0, 160));
  }
}

// ── 4. How it works keeps the recorded evidence ──────────────────────────────
await page.click("#tab-how");
const howText = (await page.locator("#panel-how").textContent()) ?? "";
check("both recorded hosts", howText.includes("QEMU/KVM") && howText.includes("Apple Virtualization.framework"));
check("recorded run ids", howText.includes("55c1ccb5-9ddf-4912-82eb-eb35efd69767"));
check("sandbox timings", howText.includes("1,877 ms") && howText.includes("768 ms"));
check(
  "registry diagnosis",
  howText.includes("d335283a") && howText.includes("bf212e02") && howText.includes("Decoding error"),
);
const captures = page.locator("#captures details");
check("two full captures, collapsed", (await captures.count()) === 2);
check("captures start closed", (await captures.first().evaluate((node) => node.open)) === false);
await captures.first().locator("summary").click();
const capture = (await captures.first().locator("pre").textContent()) ?? "";
check("capture is the raw terminal output", capture.includes("== smithers run ==") && capture.includes("SandboxCreated"));
const walk = await page.locator("ol.walk li").count();
check("stepped walkthrough", walk >= 5 && walk <= 7, String(walk));
await page.screenshot({ path: join(here, "tab-how-it-works.png"), fullPage: true });

// ── 5. Implementation file tree ──────────────────────────────────────────────
await page.click("#tab-impl");
const tree = page.locator('[data-testid="impl-tree"]');
await tree.waitFor({ state: "visible", timeout: 30_000 });
const leaves = await tree.locator('[data-slot="file-tree-file"], [role="treeitem"], button').allTextContents();
check("file tree renders many files", leaves.length >= 20, String(leaves.length));
check(
  "tree covers provider, demo service, and page",
  leaves.some((leaf) => leaf.includes("stereos-provider.ts")) &&
    leaves.some((leaf) => leaf.includes("guard.ts")) &&
    leaves.some((leaf) => leaf.includes("live.js")),
);

// Open a file and compare what is on screen against the repository source.
await page.getByText("stereos-provider.ts", { exact: false }).first().click();
const viewer = page.locator('[data-testid="impl-viewer"]');
const opened = await waitFor(
  "the viewer to open the file",
  async () => ((await viewer.getAttribute("data-path")) ?? "").endsWith("stereos-provider.ts"),
  15_000,
  300,
);
check("clicking a file opens it", Boolean(opened), (await viewer.getAttribute("data-path")) ?? "");

// CodeBlock prefixes each rendered line with its number, so strip that before
// comparing the visible source against the committed file line for line.
const shownLines = ((await viewer.locator("pre, code").first().textContent()) ?? "")
  .split("\n")
  .map((line) => line.replace(/^\d+/, ""));
const onDiskLines = readFileSync(join(here, "../real/stereos-provider.ts"), "utf8").split("\n");
const at = onDiskLines.findIndex((line) => line.startsWith("export const WORKDIR"));
const wanted = onDiskLines.slice(at, at + 8);
const found = shownLines.findIndex((line) => line === wanted[0]);
check(
  "viewer shows the repository source",
  found >= 0 && wanted.every((line, index) => shownLines[found + index] === line),
  wanted[0],
);
check(
  "source is syntax highlighted",
  (await viewer.locator("span[style*='color']").count()) > 20,
  String(await viewer.locator("span[style*='color']").count()),
);
check("per-file GitHub link", (await viewer.locator('a[href*="github.com"]').getAttribute("href")).includes("real/stereos-provider.ts"));
await page.screenshot({ path: join(here, "tab-implementation.png"), fullPage: true });

// ── 6. Proposed API is demoted but intact ────────────────────────────────────
await page.click("#tab-api");
const spec = page.frameLocator("#api-frame");
await spec.locator("h1").first().waitFor({ state: "visible", timeout: 20_000 });
check("proposed API document loads", ((await spec.locator("h1").first().textContent()) ?? "").includes("stereOS"));
await page.screenshot({ path: join(here, "tab-proposed-api.png"), fullPage: true });

await browser.close();

say("");
if (failures.length) {
  say(`${failures.length} failing check(s): ${failures.join(", ")}`);
  process.exit(1);
}
say("all checks passed");
