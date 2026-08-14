// End-to-end check against the deployed site.
//
// Everything asserted here is real: the Live demo tab starts a workflow on the
// demo host, the run parks at its approval gate, the Approve button inside the
// embedded run UI resolves it, and the engine reports `finished`. The check also
// asserts the tutorial tab set and its default tab, the tasks-and-sandboxes
// diagram, the recorded evidence, that the Implementation tree opens a file
// whose text matches the repository, and that the old stereos.smithers.sh
// hostname no longer serves this site.
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
const url = process.argv[2] ?? "https://custom-sandbox.smithers.sh/";
const RETIRED_URL = "https://stereos.smithers.sh/";
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

// 1. The tutorial's tab set, in order, with Tasks & sandboxes selected first.
const tabNames = await page.$$eval('[role="tab"]', (nodes) => nodes.map((node) => node.textContent.trim()));
check(
  "five tabs in tutorial order",
  JSON.stringify(tabNames) ===
    JSON.stringify(["Tasks & sandboxes", "Build your own", "Live demo", "Implementation", "Documenting your API"]),
  tabNames.join(" · "),
);
const selected = await page.$eval('[role="tab"][aria-selected="true"]', (node) => node.textContent.trim());
check("Tasks & sandboxes is the default tab", selected === "Tasks & sandboxes", selected);
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
check("the page is framed as @stereos/smithers", /@stereos\/smithers/.test(await page.content()));

// 2. Tasks & sandboxes: both explanatory diagrams render.
const taskLabel = (await page.getAttribute("#panel-tasks figure:nth-of-type(1) svg", "aria-label")) ?? "";
check(
  "the tasks-and-sandboxes diagram is present",
  /host process/.test(taskLabel) && /provider seam/.test(taskLabel),
  taskLabel.slice(0, 70),
);
const diagrams = await page.$$eval("#panel-tasks svg", (nodes) => nodes.length);
check("both diagrams render as inline SVG", diagrams === 2, String(diagrams));
const shipped = await page.$$eval("#panel-tasks .row .card h3", (nodes) => nodes.map((node) => node.textContent.trim()));
check(
  "the shipped providers are named",
  ["Microsandbox", "Daytona", "Vercel", "AWS", "GCP", "Cloudflare"].every((name) => shipped.includes(name)),
  shipped.join(" · "),
);
await page.screenshot({ path: join(here, "tab-tasks-and-sandboxes.png"), fullPage: true });

// 3. Build your own: the tutorial panes are real, highlighted source.
await page.click("#tab-build");
const steps = await page.$$eval("#panel-build section:first-of-type ol.walk > li", (nodes) => nodes.length);
check("the tutorial has 8 steps", steps === 8, String(steps));
const paneFiles = await page.$$eval("#panel-build .pane .cap span:first-child", (nodes) =>
  nodes.map((node) => node.textContent.trim()),
);
check(
  "panes are labelled with the file they came from",
  paneFiles.includes("real/stereos-provider.ts") && paneFiles.includes("real/guest-runner.sh"),
  paneFiles.join(" · "),
);
const providerPane = (await page.locator("#panel-build .pane pre").nth(1).textContent()) ?? "";
check(
  "the provider pane is the real source",
  providerPane.includes("createCommandSandboxProvider("),
  providerPane.slice(0, 60).replace(/\n/g, " "),
);
const paneTokens = await page.$$eval('#panel-build .pane pre span[style*="color"]', (nodes) => nodes.length);
check("tutorial panes are syntax highlighted", paneTokens > 100, `${paneTokens} colored tokens`);
const evidenceSummaries = await page.$$eval("#panel-build section > details > summary", (nodes) =>
  nodes.map((node) => node.textContent.trim()),
);
check(
  "the evidence stays available behind disclosures",
  evidenceSummaries.length === 3 && evidenceSummaries.some((label) => /raw captures/i.test(label)),
  evidenceSummaries.join(" · "),
);
await page.screenshot({ path: join(here, "tab-build-your-own.png"), fullPage: true });

// 4. Live demo against the real backend.
await page.click("#tab-live");
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
  // The Live demo is no longer the landing tab, so the frame can still be
  // mounting. live.js repeats its adopt message until the UI owns the run;
  // waiting here keeps a failure legible instead of blaming the Approve button.
  if (frame) await frame.locator('[data-testid="stereos-demo-app"]').waitFor({ state: "visible", timeout: 60_000 });

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

  const tiles =
    (await waitFor(
      "the guest evidence",
      async () => {
        const values = await page.$$eval("#live-tiles .tile dd", (nodes) => nodes.map((node) => node.textContent.trim()));
        return values.length > 0 ? values : null;
      },
      30_000,
    )) ?? [];
  check("guest evidence is shown for the run", tiles.some((value) => value.includes("coder-dev")), tiles.join(" | "));
  const runId = (await page.locator("#live-runid").textContent()) ?? "";
  check("the run id is reported", /^[0-9a-f-]{36}$/.test(runId.trim()), runId);
}
await page.screenshot({ path: join(here, "tab-live-demo.png"), fullPage: true });

// 5. The evidence, subordinated to the tutorial but intact.
await page.click("#tab-build");
const hostCards = await page.$$eval("#panel-build .row .card .cap span:first-child", (nodes) =>
  nodes.map((node) => node.textContent.trim()),
);
check("both recorded hosts have a result card", hostCards.length >= 2, hostCards.join(" · "));
for (const summary of await page.$$("#panel-build section > details > summary")) await summary.click();
const walkSteps = await page.$$eval("#panel-build section:last-of-type ol.walk > li", (nodes) => nodes.length);
check("the recorded walkthrough has 5-7 steps", walkSteps >= 5 && walkSteps <= 7, String(walkSteps));
const excerpt = await page.locator("#panel-build pre.excerpt").first().textContent();
check("walkthrough excerpts are verbatim capture text", (excerpt ?? "").includes("== guest =="), (excerpt ?? "").slice(0, 40));
const captures = await page.$$eval("#captures details summary", (nodes) => nodes.map((node) => node.textContent.trim()));
check("full captures are collapsed disclosures", captures.length === 2 && captures.every((label) => label.startsWith("Full capture (unedited)")), captures.join(" · "));
await page.screenshot({ path: join(here, "tab-build-evidence.png"), fullPage: true });

// 6. Implementation tree and viewer.
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

// 7. Documenting your API is the secondary reference.
await page.click("#tab-api");
const apiFrame = await waitFor(
  "the reference document",
  // Workers Assets serves the document at the extensionless path and redirects
  // to it, so match the stem rather than the exact href.
  async () => page.frames().find((candidate) => /\/provider-api(\.html)?$/.test(candidate.url())) ?? null,
  30_000,
);
check("the provider API reference loads", Boolean(apiFrame));
if (apiFrame) {
  const heading = (await apiFrame.locator("h1").first().textContent()) ?? "";
  check("the reference is titled @stereos/smithers", heading.trim() === "@stereos/smithers", heading.trim());
}
await page.screenshot({ path: join(here, "tab-documenting-your-api.png"), fullPage: true });

// 8. Both themes and a phone viewport, for the design review.
for (const scheme of ["light", "dark"]) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.click("#tab-tasks");
  await page.screenshot({ path: join(here, `theme-${scheme}.png`), fullPage: false });
}
await page.emulateMedia({ colorScheme: "light" });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: join(here, "mobile-tasks-and-sandboxes.png"), fullPage: false });
// A wide code pane must scroll inside its own card. If one widens its grid
// track instead, the whole document scrolls sideways on a phone.
for (const id of ["tasks", "build", "live", "impl", "api"]) {
  await page.click(`#tab-${id}`);
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  check(
    `no horizontal overflow at 390px on the ${id} tab`,
    overflow.document <= overflow.viewport + 1,
    `${overflow.document}px in a ${overflow.viewport}px viewport`,
  );
}
await page.click("#tab-live");
await page.screenshot({ path: join(here, "mobile-live-demo.png"), fullPage: false });

// 9. The retired hostname must not serve this site any more.
const retired = await page.request.get(RETIRED_URL, { failOnStatusCode: false }).catch((error) => error);
if (retired instanceof Error) {
  check("the old hostname no longer resolves", true, retired.message.split("\n")[0]);
} else {
  const body = await retired.text().catch(() => "");
  check(
    "the old hostname no longer serves this site",
    retired.status() >= 400 || !/custom sandbox|stereOS/i.test(body),
    `${retired.status()} · ${body.slice(0, 60).replace(/\s+/g, " ")}`,
  );
}

// 10. A deep link opens the Implementation tab on one file. Loaded fresh, in a
// second page, so it measures a cold landing rather than tab state left behind.
const deepPath = "real/stereos-provider.ts";
const deep = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await deep.goto(`${new URL(url).origin}/#impl/${deepPath}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
const deepTab = await deep.$eval('[role="tab"][aria-selected="true"]', (node) => node.textContent.trim());
check("a deep link lands on Implementation", deepTab === "Implementation", deepTab);
const opened = await waitFor(
  "the deep-linked file",
  async () => {
    const node = deep.locator('[data-testid="impl-code"]');
    if ((await node.count()) === 0) return null;
    return (await node.getAttribute("data-path")) === deepPath ? deepPath : null;
  },
  30_000,
);
check("a deep link opens the file it names", Boolean(opened), (await deep.evaluate(() => location.hash)) || "no hash");
await deep.close();

await browser.close();

say(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
