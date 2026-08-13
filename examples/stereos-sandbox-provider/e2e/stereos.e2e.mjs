// End-to-end check against the deployed site.
//
// Everything asserted here is real: the Live demo tab starts a workflow on the
// demo host, the run parks at its approval gate, the Approve button inside the
// embedded run UI resolves it, and the engine reports `finished`. The check also
// asserts that the old WebContainer simulation tab is gone, that the recorded
// evidence renders, and that the Implementation tree opens a file whose text
// matches the repository.
//
// Run: node examples/stereos-sandbox-provider/e2e/stereos.e2e.mjs [url]
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// apps/cli declares Playwright. Resolve through that package so this works in
// any checkout and with any pnpm virtual-store layout.
const require = createRequire(new URL("../../../apps/cli/package.json", import.meta.url));
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const example = join(here, "..");
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
  if (!ok) failures.push(name);
}

/** Poll until predicate returns truthy or the deadline passes. */
async function waitFor(label, predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  say(`timeout waiting for ${label}`);
  return null;
}

await mkdir(here, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("pageerror", (error) => say(`pageerror: ${error.message.slice(0, 200)}`));

const requested = [];
page.on("request", (request) => requested.push(request.url()));

const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
check("page responds 200", response?.status() === 200, String(response?.status()));

// 1. Tab set: four tabs, and no simulation tab.
const tabNames = await page.$$eval('[role="tab"]', (nodes) => nodes.map((node) => node.textContent.trim()));
check(
  "four tabs with first-read names",
  JSON.stringify(tabNames) === JSON.stringify(["Live demo", "How it works", "Implementation", "Proposed API"]),
  tabNames.join(" · "),
);
check("no simulation tab", !tabNames.some((name) => /browser demo|simulat/i.test(name)));
const panels = await page.$$eval('[role="tabpanel"]', (nodes) => nodes.map((node) => node.id));
check("no simulation panel", !panels.includes("panel-demo"), panels.join(" · "));
check(
  "no WebContainer bundle requested",
  !requested.some((entry) => /webcontainer|project-files/.test(entry)),
);
// The WebContainer work is preserved as one footer sentence and nothing more.
const footer = (await page.locator("footer").textContent()) ?? "";
check("the WebContainer work survives only as a footer credit", /WebContainer/.test(footer));

// 2. Live demo against the real backend.
const status = page.locator("#live-status");
const connected = await waitFor(
  "the demo host to answer",
  async () => ((await status.textContent()) ?? "").trim() === "ready",
  90_000,
);
check("live demo reaches the demo host", Boolean(connected), (await status.textContent()) ?? "");

if (connected) {
  const origin = (await page.locator("#live-origin").textContent()) ?? "";
  check("embedded run UI is served from the demo host", origin.length > 0, origin);
  const frame = await waitFor(
    "the embedded run UI",
    async () => page.frames().find((candidate) => candidate.url().includes(origin)) ?? null,
    60_000,
  );
  check("embedded run UI loads", Boolean(frame));

  await page.click('[data-start="approval-demo"]');
  const parked = await waitFor(
    "the approval gate",
    async () => ((await status.textContent()) ?? "").trim() === "waiting-approval",
    180_000,
  );
  check("approval-demo parks at its gate", Boolean(parked), (await status.textContent()) ?? "");

  if (parked && frame) {
    const approve = frame.locator('[data-testid="approve"]');
    await approve.waitFor({ state: "visible", timeout: 60_000 });
    await approve.click();
    const finished = await waitFor(
      "the run to finish",
      async () => ((await status.textContent()) ?? "").trim() === "finished",
      180_000,
    );
    check("approval in the embedded UI finishes the run", Boolean(finished), (await status.textContent()) ?? "");
  }

  const tiles = await page.$$eval("#live-tiles .tile dd", (nodes) => nodes.map((node) => node.textContent.trim()));
  check("guest evidence is shown for the run", tiles.some((value) => value.includes("coder-dev")), tiles.join(" | "));
  const runId = (await page.locator("#live-runid").textContent()) ?? "";
  check("the run id is reported", /^[0-9a-f-]{36}$/.test(runId.trim()), runId);
}
await page.screenshot({ path: join(here, "tab-live-demo.png"), fullPage: true });

// 3. How it works: cards, walkthrough, raw captures.
await page.click("#tab-how");
const hostCards = await page.$$eval('#panel-how .card .cap span:first-child', (nodes) =>
  nodes.map((node) => node.textContent.trim()),
);
check("both recorded hosts have a result card", hostCards.length >= 2, hostCards.join(" · "));
const steps = await page.$$eval("#panel-how ol.walk li", (nodes) => nodes.length);
check("the walkthrough has 5-7 steps", steps >= 5 && steps <= 7, String(steps));
const excerpt = await page.locator("#panel-how ol.walk pre.excerpt").first().textContent();
check("walkthrough excerpts are verbatim capture text", (excerpt ?? "").includes("== guest =="), (excerpt ?? "").slice(0, 40));
const captures = await page.$$eval("#captures details summary", (nodes) => nodes.map((node) => node.textContent.trim()));
check("full captures are collapsed disclosures", captures.length === 2 && captures.every((label) => label.startsWith("Full capture (unedited)")), captures.join(" · "));
await page.screenshot({ path: join(here, "tab-how-it-works.png"), fullPage: true });

// 4. Implementation tree and viewer.
await page.click("#tab-impl");
const treeFiles = await waitFor(
  "the file tree",
  async () => {
    const names = await page.$$eval('#impl-root [data-slot="file-tree-file"]', (nodes) =>
      nodes.map((node) => node.getAttribute("title")),
    );
    return names.length > 0 ? names : null;
  },
  60_000,
);
check("the implementation file tree renders", Boolean(treeFiles), `${treeFiles?.length ?? 0} files`);
check(
  "the tree covers provider, demo service, and page",
  Boolean(
    treeFiles?.includes("real/stereos-provider.ts") &&
      treeFiles?.includes("demo/guard.ts") &&
      treeFiles?.includes("page/live.js"),
  ),
);

const target = "demo/guard.ts";
await page.click(`#impl-root [data-slot="file-tree-file"][title="${target}"]`);
const shown = await waitFor(
  "the file viewer",
  async () => {
    const node = page.locator('[data-testid="impl-code"]');
    if ((await node.count()) === 0) return null;
    return (await node.getAttribute("data-path")) === target ? node : null;
  },
  30_000,
);
check("clicking a file opens it", Boolean(shown));
if (shown) {
  // The gutter is rendered inside <code>, so drop it before comparing text.
  const rendered = await page.$eval('[data-testid="impl-code"] code', (node) => {
    const clone = node.cloneNode(true);
    for (const gutter of clone.querySelectorAll(".sui-codeblock-lineno")) gutter.remove();
    return clone.textContent;
  });
  const onDisk = await readFile(join(example, target), "utf8");
  const firstLines = onDisk.split("\n").slice(0, 12).join("\n");
  check("viewer source matches the repository", rendered.includes(firstLines), rendered.slice(0, 60));
  const colored = await page.$$eval('[data-testid="impl-code"] code span[style*="color"]', (nodes) => nodes.length);
  check("source is syntax highlighted", colored > 20, `${colored} colored tokens`);
}
await page.screenshot({ path: join(here, "tab-implementation.png"), fullPage: true });

// 5. Proposed API is the secondary reference.
await page.click("#tab-api");
const apiFrame = await waitFor(
  "the reference document",
  async () => page.frames().find((candidate) => candidate.url().endsWith("proposed-api.html")) ?? null,
  30_000,
);
check("the proposed API reference loads", Boolean(apiFrame));
await page.screenshot({ path: join(here, "tab-proposed-api.png"), fullPage: true });

// 6. Both themes and a phone viewport, for the design review.
for (const scheme of ["light", "dark"]) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.click("#tab-live");
  await page.screenshot({ path: join(here, `theme-${scheme}.png`), fullPage: false });
}
await page.emulateMedia({ colorScheme: "light" });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(here, "mobile-live-demo.png"), fullPage: false });

await browser.close();

say(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
