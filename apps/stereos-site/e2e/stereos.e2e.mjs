// End-to-end check against the deployed site.
//
// Asserts that the WebContainer simulation tab is gone, that the Live demo tab
// starts a REAL run on a real stereOS VM and carries it to the engine-reported
// `finished` state (including the approval click inside the embedded UI), that
// the Implementation file tree opens a file and shows its real source, and that
// the recorded-evidence and Proposed API tabs still hold their claims.
//
// Timeouts allow for a cold VM boot on the demo host.
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
const repoRoot = join(here, "..", "..", "..");
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
async function waitFor(label, predicate, timeoutMs, intervalMs = 2000) {
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

const response = await page.goto(url, { waitUntil: "load" });

// ── 1. Page identity and the removed simulation tab ──────────────────────────
check(
  "inline favicon",
  (await page.locator('link[rel="icon"]').getAttribute("href"))?.startsWith("data:image/svg+xml") === true,
);
check(
  "meta description",
  ((await page.locator('meta[name="description"]').getAttribute("content")) ?? "").includes("real Smithers Sandbox"),
);
// site/_headers is applied by the Cloudflare deployment, not by a local
// static server, so this only asserts against a deployed origin.
if (url.startsWith("https://")) {
  check("security headers applied", response.headers()["x-content-type-options"] === "nosniff");
} else {
  say("SKIP  security headers — local static server does not apply site/_headers");
}

check("Live demo is the default tab", (await page.locator("#tab-live").getAttribute("aria-selected")) === "true");
const tabNames = await page.locator('[role="tab"]').allTextContents();
check("four named tabs", tabNames.join(" | ") === "Live demo | How it works | Implementation | Proposed API", tabNames.join(" | "));

// The WebContainer simulation tab and everything that drove it must be gone.
check("simulation tab removed", (await page.locator("#tab-demo").count()) === 0);
check("simulation panel removed", (await page.locator("#panel-demo").count()) === 0);
const bodyText = (await page.locator("body").textContent()) ?? "";
check("no simulation copy remains", !bodyText.includes("simulates the seam") && !bodyText.includes("simulated VM"));
// The removed work is named once, in the footer pointer, and nowhere else.
const footerText = (await page.locator("footer.bottom").textContent()) ?? "";
check(
  "WebContainer is mentioned only in the footer pointer",
  bodyText.split("WebContainer").length - 1 === footerText.split("WebContainer").length - 1,
);
for (const stale of ["demo.js", "webcontainer-api.js", "project-files.js"]) {
  const stalePresent = await page.evaluate(
    async (name) => (await fetch(new URL(name, location.href)).catch(() => ({ ok: false }))).ok,
    stale,
  );
  check(`stale asset ${stale} is gone`, stalePresent === false);
}
// The removed work is preserved with a pointer, not deleted silently.
check(
  "footer preserves the WebContainer work",
  bodyText.includes("plain Node") && (await page.locator('a[href*="/pull/1506"]').count()) > 0,
);

// ── 2. Live demo: a real run on a real stereOS VM ────────────────────────────
const reachable = await waitFor(
  "demo host",
  async () => {
    const status = await page.locator("#live-status").textContent();
    if (status === "ready") return "ready";
    if (status === "demo host unreachable") return "offline";
    return null;
  },
  60_000,
  1000,
);

if (reachable === "offline") {
  // The tab must degrade honestly rather than fake a run.
  check("offline banner is shown", await page.locator("#offline-banner").isVisible());
  check("start buttons are disabled when offline", await page.locator("#run-hello").isDisabled());
  failures.push("demo host unreachable (live-run checks skipped)");
  say("demo host unreachable: the live-run checks did not execute");
} else {
  check("demo host reachable", reachable === "ready");
  check("offline banner is hidden", (await page.locator("#offline-banner").getAttribute("hidden")) !== null);

  const frame = page.frameLocator("#demo-frame");
  check("embedded run UI mounts", (await waitFor("app", async () => ((await frame.locator('[data-testid="stereos-demo-app"]').count()) > 0 ? true : null), 60_000)) === true);

  // hello: start from the page, finish on a real VM.
  await page.click("#run-hello");
  const helloDone = await waitFor(
    "hello finish",
    async () => {
      const status = await page.locator("#live-status").textContent();
      return status === "finished" ? status : status === "failed" ? "failed" : null;
    },
    6 * 60 * 1000,
  );
  check("hello reaches engine-reported finished", helloDone === "finished", String(helloDone));

  const guestHost = await page.locator("#kpi-host").textContent();
  const guestKernel = await page.locator("#kpi-kernel").textContent();
  const guestRestrict = await page.locator("#kpi-restrict").textContent();
  check("run reports the guest hostname", guestHost === "coder-dev", String(guestHost));
  check("guest kernel differs from the Debian host", /^Linux 6\.\d+/.test(guestKernel ?? ""), String(guestKernel));
  check("guest restriction model holds", guestRestrict === "denied", String(guestRestrict));
  await page.screenshot({ path: join(here, "tab1-live-demo.png"), fullPage: false });

  // approval-demo: park at the gate, click Approve inside the embedded UI.
  await page.click("#run-approval");
  const parked = await waitFor(
    "approval gate",
    async () => {
      const status = (await page.locator("#live-status").textContent()) ?? "";
      // "starting approval-demo" also contains the word, so match the parked copy.
      return status.startsWith("waiting for your approval") ? status : null;
    },
    6 * 60 * 1000,
  );
  check("approval-demo parks at the gate", Boolean(parked), String(parked));

  const approve = frame.locator('[data-testid="approve"]');
  const approveReady = await waitFor("approve button", async () => ((await approve.count()) > 0 ? true : null), 3 * 60 * 1000);
  check("embedded UI offers the approval", Boolean(approveReady));
  await page.screenshot({ path: join(here, "tab1-live-approval.png"), fullPage: false });

  if (approveReady) {
    await approve.click();
    const approvedDone = await waitFor(
      "approval-demo finish",
      async () => {
        const status = await page.locator("#live-status").textContent();
        return status === "finished" ? status : status === "failed" ? "failed" : null;
      },
      6 * 60 * 1000,
    );
    check("approval-demo finishes after the click", approvedDone === "finished", String(approvedDone));
    const finishedInFrame = await waitFor(
      "engine-finished run in the frame",
      async () => ((await frame.locator('[data-run-status="finished"]').count()) > 0 ? true : null),
      2 * 60 * 1000,
    );
    check("embedded UI shows an engine-finished run", Boolean(finishedInFrame));
  }
  await page.screenshot({ path: join(here, "tab1-live-demo-final.png"), fullPage: false });

  // The guard must not expose the gateway RPC surface.
  const base = await page.evaluate(() => document.getElementById("demo-frame")?.src ?? "");
  if (base) {
    const leak = await page.evaluate(async (origin) => {
      const results = {};
      for (const path of ["/v1/rpc/listWorkflows", "/api/runs/../../etc/passwd", "/v1/rpc/hijackRun"]) {
        try {
          const response = await fetch(new URL(path, origin), { method: "POST", body: "{}" });
          results[path] = response.status;
        } catch {
          results[path] = "blocked";
        }
      }
      return results;
    }, base);
    check(
      "gateway RPC is not reachable through the guard",
      Object.values(leak).every((status) => status === 404 || status === "blocked"),
      JSON.stringify(leak),
    );
  }
}

// ── 3. How it works: the recorded evidence ───────────────────────────────────
await page.click("#tab-real");
const realText = (await page.locator("#panel-real").textContent()) ?? "";
check("evidence tab headline", realText.includes("Two hosts, one provider"));
check(
  "registry defect is documented",
  realText.includes("d335283a5c0c9fde") && realText.includes("bf212e026f722ccc") && realText.includes("Data corruption detected"),
);

const walkthroughSteps = await page.locator("#walkthrough li").count();
check("stepped walkthrough is present", walkthroughSteps >= 5, `${walkthroughSteps} steps`);
const stepText = (await page.locator("#walkthrough").textContent()) ?? "";
check("walkthrough excerpts come from the capture", stepText.includes("SandboxCreated") && stepText.includes("coder-dev"));
check("no excerpt marker went missing", !stepText.includes("marker not present"));

const captures = await page.locator("details.raw").count();
check("both full captures are collapsed by default", captures === 2, `${captures} captures`);
check("captures start closed", (await page.locator("details.raw[open]").count()) === 0);

await page.locator("details.raw").first().click();
const linuxCapture = (await page.locator("#capture-linux").textContent()) ?? "";
check(
  "x86_64 capture proves guest execution",
  linuxCapture.includes("agent@coder-dev on Linux 6.18.33 x86_64") &&
    linuxCapture.includes("Bun 1.2.21 x64") &&
    linuxCapture.includes("SandboxCompleted") &&
    linuxCapture.includes('"writeOutsideWorkspace": "denied"'),
  `${linuxCapture.length} chars`,
);
const macCapture = (await page.locator("#capture-macos").textContent()) ?? "";
check(
  "aarch64 capture is the second host",
  macCapture.includes("Linux 6.12.74 aarch64") && macCapture.includes("Bun 1.2.21 arm64"),
  `${macCapture.length} chars`,
);
await page.screenshot({ path: join(here, "tab2-how-it-works.png"), fullPage: false });

// ── 4. Implementation file tree ──────────────────────────────────────────────
await page.click("#tab-impl");
check("file tree renders", (await waitFor("tree", async () => ((await page.locator('[data-testid="impl-tree"]').count()) > 0 ? true : null), 30_000)) === true);
const treeFiles = await page.locator('[data-slot="file-tree-file"]').count();
check("tree lists the implementation sources", treeFiles >= 20, `${treeFiles} files`);

// Open a specific file and compare it against the repository.
const guardEntry = page.locator('[data-slot="file-tree-file"][title="service/guard.ts"]');
check("tree contains the guard source", (await guardEntry.count()) > 0);
await guardEntry.click();
await page.waitForTimeout(400);
check("viewer shows the opened path", (await page.locator('[data-testid="impl-path"]').textContent()) === "apps/stereos-site/service/guard.ts");
const shown = (await page.locator('[data-testid="impl-source"]').textContent()) ?? "";
const onDisk = readFileSync(join(repoRoot, "apps/stereos-site/service/guard.ts"), "utf8");
check("viewer source matches the repository", shown.trim() === onDisk.trim(), `${shown.length} vs ${onDisk.length} chars`);
check("source is syntax highlighted", (await page.locator('[data-testid="impl-source"] span[style*="color"]').count()) > 5);
const githubHref = await page.locator('[data-testid="impl-github"]').getAttribute("href");
check(
  "per-file GitHub link",
  githubHref === "https://github.com/smithersai/smithers/blob/main/apps/stereos-site/service/guard.ts",
  String(githubHref),
);
await page.screenshot({ path: join(here, "tab3-implementation.png"), fullPage: false });

// ── 5. Proposed API stays a reference ────────────────────────────────────────
await page.click("#tab-api");
const apiTitle = await page.locator("#panel-api h1").first().textContent();
const shikiBlocks = await page.locator("#panel-api pre.shiki").count();
check("Proposed API h1", apiTitle?.includes("stereOS Sandbox Provider"), apiTitle ?? "");
check("Proposed API keeps its highlighted code", shikiBlocks > 0, `${shikiBlocks} blocks`);
await page.screenshot({ path: join(here, "tab4-proposed-api.png"), fullPage: false });

await browser.close();

say(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures.join(", ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);
