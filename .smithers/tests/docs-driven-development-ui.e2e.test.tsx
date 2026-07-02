/** @jsxImportSource smithers-orchestrator */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmithers, type Gateway } from "smithers-orchestrator";
import { z } from "zod/v4";
import { ticketsBacklog } from "../ui/ddd-ticketsBacklog.generated";
import {
  createConnectionContext,
  createDddFixtureRepo,
  fakeAgentResponse,
  gatewayRequest,
  nodeOutput,
  runDddWorkflow,
  withDddProcessEnvLock,
  type DddFixtureRepo,
} from "./docsDrivenDevelopmentRunFixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const RUN_ID = "ddd-ui-seeded-run";
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
const BROWSER_SKIP_REASON = CHROMIUM
  ? ""
  : "Chromium executable not available; browser-only DDD UI test skipped while no-browser Gateway smoke still runs.";
const browserTest = CHROMIUM ? test : test.skip;

let repo: DddFixtureRepo | undefined;
let gateway: Gateway | undefined;
let port = 0;
let base = "";

function findOpenPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolvePort(p));
    });
  });
}

async function waitForHealth(timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await healthOk()) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function healthOk(): Promise<boolean> {
  return new Promise((resolveOk) => {
    const req = request(`${base}/health`, { method: "GET", timeout: 2_000 }, (res) => {
      res.resume();
      resolveOk((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
    });
    req.on("error", () => resolveOk(false));
    req.on("timeout", () => {
      req.destroy();
      resolveOk(false);
    });
    req.end();
  });
}

function makeCreateWorkflow(dbPath: string) {
  const doneSchema = z.object({ summary: z.string().default("") });
  const { smithers, Workflow: W, Task: T, outputs } = createSmithers({ done: doneSchema }, { dbPath });
  return smithers(() => (
    <W name="create-workflow">
      <T id="done" output={outputs.done}>
        {{ summary: "create-workflow launched from the DDD Start pane" }}
      </T>
    </W>
  ));
}

function makeGenerateDocsWorkflow(dbPath: string) {
  const kickoffSchema = z.object({
    launched: z.boolean().default(true),
    bugScanRunId: z.string().default(""),
    summary: z.string().default(""),
  });
  const { smithers, Workflow: W, Task: T, outputs } = createSmithers({ kickoff: kickoffSchema }, { dbPath });
  return smithers(() => (
    <W name="ddd-generate-docs">
      <T id="kickoff-bug-scan" output={outputs.kickoff}>
        {{ launched: true, bugScanRunId: "bug-scan-ui-run", summary: "Detached bug scan launched: bug-scan-ui-run." }}
      </T>
    </W>
  ));
}

function makeBugScanWorkflow(dbPath: string) {
  const doneSchema = z.object({ summary: z.string().default("") });
  const { smithers, Workflow: W, Task: T, outputs } = createSmithers({ done: doneSchema }, { dbPath });
  return smithers(() => (
    <W name="ddd-bug-scan">
      <T id="file-tickets" output={outputs.done}>
        {{ summary: "bug scan smoke" }}
      </T>
    </W>
  ));
}

async function waitForNewDddRun(before: Set<string>, timeoutMs = 60_000): Promise<string> {
  const started = Date.now();
  const connection = createConnectionContext();
  while (Date.now() - started < timeoutMs) {
    const response = await gatewayRequest(gateway!, connection, "runs.list", { limit: 50 });
    if (response.ok) {
      const rows = Array.isArray(response.payload) ? response.payload as Array<Record<string, unknown>> : [];
      const found = rows.find((row) => row.workflowKey === "docs-driven-development" && typeof row.runId === "string" && !before.has(row.runId));
      if (found?.runId) return String(found.runId);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out waiting for launched docs-driven-development run");
}

async function waitForNode(runId: string, nodeId: string, timeoutMs = 60_000) {
  const started = Date.now();
  const connection = createConnectionContext();
  while (Date.now() - started < timeoutMs) {
    try {
      const output = await nodeOutput(gateway!, connection, runId, nodeId);
      if (output && typeof output === "object" && (output as { row?: unknown }).row) return output;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${nodeId}`);
}

async function expectNoLayoutOverflow(page: any, label: string) {
  const issues = await page.evaluate(() => {
    const selectors = [
      ".top",
      ".tabbar",
      ".content",
      ".card",
      ".modal",
      ".button",
      ".badge",
      ".pill",
      ".feature-card",
      ".ticket-row",
      ".run-row",
      ".specs-tree",
      ".runlist",
    ].join(",");
    const viewportWidth = window.innerWidth;
    return [...document.querySelectorAll<HTMLElement>(selectors)]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      })
      .flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const name = element.getAttribute("data-testid") || element.className || element.tagName;
        const next: string[] = [];
        if (rect.left < -2 || rect.right > viewportWidth + 2) next.push(`${name} horizontal ${Math.round(rect.left)}..${Math.round(rect.right)} of ${viewportWidth}`);
        return next;
      })
      .slice(0, 8);
  });
  expect(issues).toEqual([]);
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (horizontalOverflow > 2) throw new Error(`${label} horizontal overflow ${horizontalOverflow}`);
}

async function expectModalWithinViewport(page: any, testId: string) {
  const box = await page.locator(`[data-testid="${testId}"]`).boundingBox();
  const viewport = page.viewportSize();
  expect(box).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

async function expectFeatureSummariesClamped(page: any, label: string) {
  const result = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".feature-card-summary")];
    const failures: string[] = [];
    let truncated = 0;
    for (const element of rows) {
      const style = window.getComputedStyle(element);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const rect = element.getBoundingClientRect();
      if (style.webkitLineClamp !== "3") failures.push(`missing clamp: ${element.textContent?.slice(0, 40) ?? ""}`);
      if (Number.isFinite(lineHeight) && rect.height > lineHeight * 3 + 6) failures.push(`too tall: ${Math.round(rect.height)} > ${Math.round(lineHeight * 3)}`);
      if (element.scrollHeight > element.clientHeight + 1) truncated += 1;
    }
    return { count: rows.length, failures: failures.slice(0, 5), truncated };
  });
  expect(result.count).toBeGreaterThan(0);
  expect(result.failures).toEqual([]);
  if (result.truncated === 0) throw new Error(`${label} did not exercise a long clamped feature summary`);
}

function enterFixtureExecutionEnv(): () => void {
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  const previousCodex = process.env.SMITHERS_FAKE_CODEX_RESPONSE;
  const previousClaude = process.env.SMITHERS_FAKE_CLAUDE_RESPONSE;
  const previousByNode = process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE;
  const previousTestAgentPath = process.env.SMITHERS_TEST_AGENT_PATH;
  process.chdir(repo!.root);
  process.env.PATH = `${repo!.binDir}:${process.env.PATH ?? ""}`;
  process.env.SMITHERS_TEST_AGENT_PATH = process.env.PATH;
  process.env.SMITHERS_FAKE_CODEX_RESPONSE = fakeAgentResponse("codex fake output");
  process.env.SMITHERS_FAKE_CLAUDE_RESPONSE = fakeAgentResponse("claude fake output");
  process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE = JSON.stringify({
    audit: fakeAgentResponse("browser launched audit", {
      partial: ["docs-driven-development"],
      notes: ["browser launched audit note for docs-driven-development"],
    }),
    triage: fakeAgentResponse("browser launched triage", {
      selected: [
        {
          slot: 1,
          featureId: "docs-driven-development",
          title: "Browser dispatch proof ticket",
          agent: "sonnet",
          taskType: "e2e",
          reason: "browser launched triage selected the docs editor dispatch.",
          files: [".smithers/ui/docs-driven-development.tsx"],
          tests: ["bun test tests/docs-driven-development-ui.e2e.test.tsx"],
          acceptance: ["The Audit and Tickets tabs render the launched run output."],
        },
      ],
      summary: "browser launched triage",
    }),
    "cycle-review": fakeAgentResponse("browser launched review", {
      approved: true,
      blockingFindings: [],
      inefficiencies: [],
    }),
  });
  return () => {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCodex === undefined) delete process.env.SMITHERS_FAKE_CODEX_RESPONSE;
    else process.env.SMITHERS_FAKE_CODEX_RESPONSE = previousCodex;
    if (previousClaude === undefined) delete process.env.SMITHERS_FAKE_CLAUDE_RESPONSE;
    else process.env.SMITHERS_FAKE_CLAUDE_RESPONSE = previousClaude;
    if (previousByNode === undefined) delete process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE;
    else process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE = previousByNode;
    if (previousTestAgentPath === undefined) delete process.env.SMITHERS_TEST_AGENT_PATH;
    else process.env.SMITHERS_TEST_AGENT_PATH = previousTestAgentPath;
  };
}

beforeAll(async () => {
  if (!CHROMIUM) return;
  repo = createDddFixtureRepo();
  gateway = await runDddWorkflow(repo, RUN_ID, {
    maxAgents: 1,
    maxRounds: 1,
    useClaudeForPlanning: false,
    runImplementation: true,
    implementationApproved: true,
  });
  gateway.register("create-workflow", makeCreateWorkflow(join(repo.root, ".smithers/create-workflow.db")) as Parameters<typeof gateway.register>[1]);
  gateway.register("ddd-generate-docs", makeGenerateDocsWorkflow(join(repo.root, ".smithers/ddd-generate-docs.db")) as Parameters<typeof gateway.register>[1]);

  const connection = createConnectionContext();
  const created = await gatewayRequest(gateway, connection, "createTicket", {
    path: "tickets/gateway-ui-live.md",
    kind: "ticket",
    status: "in-progress",
    content: "# Gateway Ticket\n\n## Gap\n\nThis ticket came from the live Gateway ticket store.",
  });
  expect(created.ok).toBe(true);
  const longLayoutTicket = await gatewayRequest(gateway, connection, "createTicket", {
    path: "tickets/browser-layout-long-text.md",
    kind: "e2e",
    status: "todo",
    content: [
      "# Browser layout ticket with a deliberately long title for mobile wrapping",
      "",
      "Feature: Docs driven development (docs-driven-development)",
      "Status: todo · Kind: e2e · Priority: P1 · Severity: major · Feature status: partial",
      "File: .smithers/tests/docs-driven-development-ui.e2e.test.tsx",
      "",
      "## Gap",
      "",
      "This seeded gateway ticket exercises long text, a long path, and compact modal bounds without fabricated RPC.",
      "",
      "## Acceptance",
      "",
      "- A small dark viewport can open every DDD tab without horizontal overflow.",
      "- The ticket detail modal stays inside the viewport even with BrowserLayoutRegressionProofWithoutSpacesBrowserLayoutRegressionProofWithoutSpaces.",
    ].join("\n"),
  });
  expect(longLayoutTicket.ok).toBe(true);

  port = await findOpenPort();
  base = `http://127.0.0.1:${port}`;
  await gateway.listen({ port, host: "127.0.0.1" });
  expect(await waitForHealth()).toBe(true);
}, 120_000);

afterAll(async () => {
  try {
    await gateway?.close();
  } catch {}
  try {
    repo?.cleanup();
  } catch {}
});

test("DDD UI no-browser smoke covers Gateway data contracts and the browser skip branch", async () => {
  const localRepo = createDddFixtureRepo();
  let localGateway: Gateway | undefined;
  try {
    localGateway = await runDddWorkflow(localRepo, "ddd-ui-no-browser-run", {
      maxAgents: 1,
      maxRounds: 1,
      useClaudeForPlanning: false,
      runImplementation: true,
      implementationApproved: true,
    });
    localGateway.register("create-workflow", makeCreateWorkflow(join(localRepo.root, ".smithers/create-workflow.db")) as Parameters<typeof localGateway.register>[1]);
    localGateway.register("ddd-generate-docs", makeGenerateDocsWorkflow(join(localRepo.root, ".smithers/ddd-generate-docs.db")) as Parameters<typeof localGateway.register>[1]);
    localGateway.register("ddd-bug-scan", makeBugScanWorkflow(join(localRepo.root, ".smithers/ddd-bug-scan.db")) as Parameters<typeof localGateway.register>[1]);

    if (!CHROMIUM) expect(BROWSER_SKIP_REASON).toContain("Chromium executable not available");

    const uiModule = await import(`../ui/docs-driven-development.tsx?no-browser-smoke=${Date.now()}-${Math.random()}`);
    expect(typeof uiModule.mergeTickets).toBe("function");
    expect(uiModule.launchResultRunId({ workflow: "docs-driven-development" })).toBe("");

    const connection = createConnectionContext();
    const workflows = await gatewayRequest(localGateway, connection, "listWorkflows", { includeSystem: true });
    expect(workflows.ok).toBe(true);
    const workflowKeys = ((Array.isArray(workflows.payload) ? workflows.payload : []) as Array<{ key?: unknown }>).map((row) => String(row.key ?? ""));
    expect(workflowKeys).toEqual(expect.arrayContaining(["create-workflow", "ddd-bug-scan", "ddd-generate-docs", "docs-driven-development"]));

    const missingLaunch = await gatewayRequest(localGateway, connection, "launchRun", { workflow: "missing-ddd-workflow", input: {} });
    expect(missingLaunch.ok).toBe(false);
    expect(missingLaunch.error?.code).toBe("NOT_FOUND");

    const runs = await gatewayRequest(localGateway, connection, "runs.list", { limit: 20 });
    expect(runs.ok).toBe(true);
    const runRows = (Array.isArray(runs.payload) ? runs.payload : []) as Array<Record<string, unknown>>;
    const run = runRows.find((row) => row.runId === "ddd-ui-no-browser-run");
    expect(run).toMatchObject({ runId: "ddd-ui-no-browser-run", workflowKey: "docs-driven-development" });

    const triage = await nodeOutput(localGateway, connection, "ddd-ui-no-browser-run", "triage");
    expect(triage.row.selected[0]).toMatchObject({
      slot: 1,
      featureId: "docs-driven-development",
      taskType: "e2e",
    });

    const materialized = await nodeOutput(localGateway, connection, "ddd-ui-no-browser-run", "materialize-tickets");
    expect(materialized.row.tickets[0]).toMatchObject({
      path: "docs-driven-development--ddd-ui-no-browser-run--01-docs-driven-development",
      kind: "ticket",
      status: "todo",
      featureId: "docs-driven-development",
    });

    const created = await gatewayRequest(localGateway, connection, "createTicket", {
      path: "tickets/no-browser-live.md",
      kind: "ticket",
      status: "todo",
      content: "# No Browser Live Ticket\n\n## Gap\n\nNo browser smoke verifies ticket payloads.",
    });
    expect(created.ok).toBe(true);
    expect(created.payload).toMatchObject({
      path: "tickets/no-browser-live.md",
      kind: "ticket",
      status: "todo",
    });

    const tickets = await gatewayRequest(localGateway, connection, "listTickets", {});
    expect(tickets.ok).toBe(true);
    expect((tickets.payload as Array<Record<string, unknown>>).find((ticket) => ticket.path === "tickets/no-browser-live.md"))
      .toMatchObject({ content: expect.stringContaining("No Browser Live Ticket") });
  } finally {
    try {
      await localGateway?.close();
    } catch {}
    localRepo.cleanup();
  }
}, 120_000);

browserTest("DDD UI renders and drives a live Gateway without fabricated RPC", async () => {
  const browser = await CHROMIUM.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err: Error) => errors.push(err.message));

    await page.goto(`${base}/workflows/docs-driven-development?runId=${RUN_ID}&tutorial=off`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="docs-driven-development-ui"]', { timeout: 30_000 });
    expect(await page.locator('[data-testid="ddd-tutorial"]').count()).toBe(0);

    await page.click('[data-testid="ddd-open-start"]');
    await page.waitForSelector('[data-testid="ddd-start-pane"]', { timeout: 20_000 });
    const createButton = page.locator('[data-testid="ddd-start-create-launch"]');
    expect(await createButton.evaluate((button: HTMLButtonElement) => button.disabled)).toBe(true);
    await page.fill('[data-testid="ddd-start-description"]', "   Build a browser-tested notes app   ");
    expect(await createButton.evaluate((button: HTMLButtonElement) => button.disabled)).toBe(false);
    await createButton.click();
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="ddd-start-launched"]')?.textContent ?? "").includes("create-workflow"),
      undefined,
      { timeout: 20_000 },
    );

    await page.click('[data-testid="ddd-start-generate-launch"]');
    await page.waitForSelector('[data-testid="ddd-start-bug-scan"]', { timeout: 30_000 });
    expect(await page.locator('[data-testid="ddd-start-bug-scan"]').textContent()).toContain("bug-scan-ui-run");

    await page.click('[data-testid="ddd-start-pane"] button[aria-label="Close"]');
    await page.click('[data-testid="ddd-tab-specs"]');
    await page.waitForSelector('[data-testid="ddd-specs-tab"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ddd-editor"]', { timeout: 20_000 });

    const beforeRunsResponse = await gatewayRequest(gateway!, createConnectionContext(), "runs.list", { limit: 50 });
    const beforeRuns = new Set<string>(
      ((Array.isArray(beforeRunsResponse.payload) ? beforeRunsResponse.payload : []) as Array<{ runId?: unknown }>)
        .map((row) => (typeof row.runId === "string" ? row.runId : ""))
        .filter((runId): runId is string => runId.length > 0),
    );

    const editable = page.locator('[data-testid="ddd-editor"] [contenteditable="true"]').first();
    await editable.waitFor({ timeout: 20_000 });
    await editable.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
    await page.keyboard.type("\nBrowser dispatch proof");
    await page.waitForFunction(
      () => !(document.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement | null)?.disabled,
      undefined,
      { timeout: 20_000 },
    );
    let launchedRunId = "";
    await withDddProcessEnvLock(async () => {
      const restoreEnv = enterFixtureExecutionEnv();
      try {
        await page.click('[data-testid="ddd-dispatch-file"]');
        launchedRunId = await waitForNewDddRun(beforeRuns);
        const metaTicket = await waitForNode(launchedRunId, "metaTicket");
        expect(metaTicket.row.created).toBe(true);
        expect(metaTicket.row.source).toBe("smithers-ui-milkdown-editor");
        expect(metaTicket.row.docPath).toBe("overview.md");
        expect(metaTicket.row.changedFiles[0].path).toBe("overview.md");
        expect(metaTicket.row.changedFiles[0].afterMarkdown).toContain("Browser dispatch proof");
        await waitForNode(launchedRunId, "audit", 30_000);
        await waitForNode(launchedRunId, "spec-update", 30_000);
        await waitForNode(launchedRunId, "triage", 30_000);
        await waitForNode(launchedRunId, "materialize-tickets", 30_000);
        await waitForNode(launchedRunId, "cycle-review", 30_000);
        const roundSummary = await waitForNode(launchedRunId, "round-summary", 30_000);
        expect(roundSummary.row.status).toBe("partial");
        const work = await gatewayRequest(gateway!, createConnectionContext(), "getNodeOutput", { runId: launchedRunId, nodeId: "work:1", iteration: 0 });
        expect(work.ok).toBe(false);
        expect(work.error?.code).toBe("NodeNotFound");
      } finally {
        restoreEnv();
      }
    });

    await page.waitForFunction(
      (runId: string) => (document.body.textContent ?? "").includes(runId),
      launchedRunId,
      { timeout: 20_000 },
    );

    await page.click('[data-testid="ddd-tab-audit"]');
    await page.waitForSelector('[data-testid="ddd-audit-tab"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ddd-output-bootstrap"] >> text=features.json validated', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ddd-output-meta-ticket"] >> text=Editor-created docs change for overview.md', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ddd-finding"] >> text=Docs driven development', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ddd-output-triage"] >> text=Browser dispatch proof ticket', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ddd-output-final-summary"] >> text=Continue the improvement loop', { timeout: 20_000 });
    expect(await page.locator('[data-testid="ddd-output-meta-ticket"]').textContent()).not.toContain("No editor-created docs change");

    await page.click('[data-testid="ddd-tab-tickets"]');
    await page.waitForSelector('[data-testid="ddd-tickets-tab"]', { timeout: 20_000 });
    const materializedTicketRows = page.locator('[data-testid="ddd-ticket"]').filter({ hasText: "Browser dispatch proof ticket" });
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="ddd-ticket"]')]
        .filter((node) => (node.textContent ?? "").includes("Browser dispatch proof ticket")).length === 1,
      undefined,
      { timeout: 20_000 },
    );
    expect(await materializedTicketRows.count()).toBe(1);
    const backlogTitle = ticketsBacklog[0]?.content.match(/^#\s+(.+)$/m)?.[1] ?? "";
    if (backlogTitle) {
      await page.waitForFunction(
        (expected: string) => (document.body.textContent ?? "").includes(expected),
        backlogTitle,
        { timeout: 20_000 },
      );
    }

    await page.click('[data-testid="ddd-tab-specs"]');
    await page.waitForSelector('[data-testid="ddd-specs-tab"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ddd-editor"] [contenteditable="true"]', { timeout: 20_000 });
    await page.evaluate(() => {
      const editor = document.querySelector('[data-testid="ddd-editor"]');
      const host = editor?.querySelector(".crepe-host") ?? editor;
      if (!host) throw new Error("missing editor host");
      const fixture = document.createElement("div");
      fixture.setAttribute("data-testid", "ddd-link-fixture");
      fixture.innerHTML = [
        '<div style="height: 800px"></div>',
        '<h2 id="browser-proof-anchor">Browser proof anchor</h2>',
        '<p><a data-ddd-link="external" href="https://example.com/ddd-external">External proof link</a></p>',
        '<p><a data-ddd-link="anchor" href="#browser-proof-anchor">Anchor proof link</a></p>',
        '<p><a data-ddd-link="relative" href="features/docs-driven-development.md">Relative proof link</a></p>',
      ].join("");
      host.appendChild(fixture);
    });

    const linkUrlBefore = page.url();
    await page.waitForSelector('a[data-ddd-link="external"]', { timeout: 10_000 });
    const externalHref = await page.evaluate(
      () => (document.querySelector('a[data-ddd-link="external"]') as HTMLAnchorElement | null)?.href ?? "",
    );
    expect(externalHref).toBe("https://example.com/ddd-external");
    expect(page.url()).toBe(linkUrlBefore);

    await page.click('a[data-ddd-link="anchor"]');
    await page.waitForFunction(
      () => {
        const anchor = document.querySelector("#browser-proof-anchor");
        if (!anchor) return false;
        const rect = anchor.getBoundingClientRect();
        return rect.top >= 0 && rect.top < window.innerHeight;
      },
      undefined,
      { timeout: 10_000 },
    );
    expect(page.url()).toBe(linkUrlBefore);

    await page.click('a[data-ddd-link="relative"]');
    await page.waitForSelector('[data-testid="ddd-technical-doc-view"]', { timeout: 20_000 });
    expect(await page.locator(".editor-title .path").textContent()).toContain("features/docs-driven-development.md");
    expect(page.url()).toBe(linkUrlBefore);

    const technicalDocsOpen = await page.locator('[data-testid="ddd-technical-docs"]').evaluate((node: HTMLDetailsElement) => node.open);
    if (!technicalDocsOpen) await page.click('[data-testid="ddd-technical-docs"] summary');
    await page.locator('[data-testid="ddd-technical-docs"] [data-testid="ddd-tree-file"]').first().click();
    await page.waitForSelector('[data-testid="ddd-technical-doc-view"]', { timeout: 20_000 });
    expect(await page.locator('[data-testid="ddd-doc-generated-badge"]').textContent()).toContain("read-only");
    expect(await page.locator('[data-testid="ddd-dispatch-file"]').evaluate((button: HTMLButtonElement) => button.disabled)).toBe(true);

    await page.click('[data-testid="ddd-tab-live"]');
    await page.waitForSelector('[data-testid="ddd-live-tab"]', { timeout: 20_000 });
    await page.waitForSelector(`[data-testid="ddd-run-list"] >> text=${RUN_ID}`, { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ddd-run-tree"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ddd-live-log"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ddd-chat-log"]', { timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const tree = document.querySelector('[data-testid="ddd-run-tree"]')?.textContent ?? "";
        const liveLines = document.querySelectorAll('[data-testid="ddd-live-log"] .livelog-line').length;
        const chatLines = document.querySelectorAll('[data-testid="ddd-chat-log"] .chat-line').length;
        return tree.includes("bootstrap") && liveLines > 0 && chatLines > 0;
      },
      undefined,
      { timeout: 30_000 },
    );

    await page.locator(".run-row").filter({ hasText: RUN_ID }).click();
    await page.waitForFunction(
      (runId: string) => (document.querySelector(".run-row.is-active")?.textContent ?? "").includes(runId),
      RUN_ID,
      { timeout: 20_000 },
    );

    await page.click('[data-testid="ddd-tab-tickets"]');
    await page.waitForSelector('[data-testid="ddd-tickets-tab"]', { timeout: 20_000 });
    await page.waitForFunction(
      (expected: string[]) => {
        const text = document.body.textContent ?? "";
        return expected.every((item) => item && text.includes(item));
      },
      ["Gateway Ticket", "Browser dispatch proof ticket", backlogTitle],
      { timeout: 20_000 },
    );

    const lightContext = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    const lightMobile = await lightContext.newPage();
    lightMobile.on("pageerror", (err: Error) => errors.push(`light mobile: ${err.message}`));
    try {
      await lightMobile.goto(`${base}/workflows/docs-driven-development?runId=${RUN_ID}&tutorial=off`, { waitUntil: "networkidle" });
      await lightMobile.waitForSelector('[data-testid="docs-driven-development-ui"]', { timeout: 30_000 });
      await lightMobile.click('[data-testid="ddd-tab-features"]');
      await lightMobile.waitForSelector('[data-testid="ddd-features-tab"]', { timeout: 20_000 });
      await expectFeatureSummariesClamped(lightMobile, "light mobile features");
      await expectNoLayoutOverflow(lightMobile, "light mobile features");
    } finally {
      await lightContext.close();
    }

    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    const mobile = await mobileContext.newPage();
    mobile.on("pageerror", (err: Error) => errors.push(`mobile: ${err.message}`));
    try {
      await mobile.goto(`${base}/workflows/docs-driven-development?runId=${RUN_ID}&tutorial=off`, { waitUntil: "networkidle" });
      await mobile.waitForSelector('[data-testid="docs-driven-development-ui"]', { timeout: 30_000 });
      const darkTokens = await mobile.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return { colorScheme: style.colorScheme, bg: style.getPropertyValue("--bg").trim() };
      });
      expect(darkTokens.colorScheme).toContain("dark");
      expect(darkTokens.bg).toBe("#0b0b0d");

      for (const [tab, selector] of [
        ["features", '[data-testid="ddd-features-tab"]'],
        ["specs", '[data-testid="ddd-specs-tab"]'],
        ["audit", '[data-testid="ddd-output-bootstrap"]'],
        ["live", '[data-testid="ddd-live-tab"]'],
        ["tickets", '[data-testid="ddd-tickets-tab"]'],
      ] as const) {
        await mobile.click(`[data-testid="ddd-tab-${tab}"]`);
        await mobile.waitForSelector(selector, { timeout: 20_000 });
        await expectNoLayoutOverflow(mobile, `mobile ${tab}`);
      }

      await mobile.click('[data-testid="ddd-tab-features"]');
      await expectFeatureSummariesClamped(mobile, "dark mobile features");
      await mobile.locator('[data-testid="ddd-feature-card"]').first().click();
      await mobile.waitForSelector('[data-testid="ddd-feature-detail"]', { timeout: 20_000 });
      await expectModalWithinViewport(mobile, "ddd-feature-detail");
      await expectNoLayoutOverflow(mobile, "mobile feature modal");
      await mobile.click('[data-testid="ddd-feature-detail"] button[aria-label="Close"]');

      await mobile.click('[data-testid="ddd-tab-tickets"]');
      await mobile.fill('[data-testid="ddd-tickets-tab"] input[type="search"]', "Browser layout ticket");
      await mobile.locator('[data-testid="ddd-ticket"]').first().click();
      await mobile.waitForSelector('[data-testid="ddd-ticket-detail"]', { timeout: 20_000 });
      await expectModalWithinViewport(mobile, "ddd-ticket-detail");
      await expectNoLayoutOverflow(mobile, "mobile ticket modal");
    } finally {
      await mobileContext.close();
    }

    const workflowMap = (gateway as unknown as { workflows: Map<string, unknown> }).workflows;
    const savedWorkflows = new Map(
      ["create-workflow", "ddd-generate-docs", "docs-driven-development"].map((key) => [key, workflowMap.get(key)] as const),
    );
    try {
      workflowMap.delete("create-workflow");
      workflowMap.delete("ddd-generate-docs");
      await page.goto(`${base}/workflows/docs-driven-development?runId=${RUN_ID}&tutorial=off`, { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="docs-driven-development-ui"]', { timeout: 30_000 });

      await page.click('[data-testid="ddd-open-start"]');
      await page.waitForSelector('[data-testid="ddd-start-pane"]', { timeout: 20_000 });
      await page.fill('[data-testid="ddd-start-description"]', "Build a failure-path notes app");
      const missingCreateButton = page.locator('[data-testid="ddd-start-create-launch"]');
      await missingCreateButton.click();
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="ddd-start-error"]')?.textContent ?? "").includes("create-workflow"),
        undefined,
        { timeout: 20_000 },
      );
      expect(await missingCreateButton.evaluate((button: HTMLButtonElement) => button.disabled)).toBe(false);

      const missingGenerateButton = page.locator('[data-testid="ddd-start-generate-launch"]');
      await missingGenerateButton.click();
      await page.waitForFunction(
        () => [...document.querySelectorAll('[data-testid="ddd-start-error"]')]
          .some((node) => (node.textContent ?? "").includes("ddd-generate-docs")),
        undefined,
        { timeout: 20_000 },
      );
      expect(await missingGenerateButton.evaluate((button: HTMLButtonElement) => button.disabled)).toBe(false);

      await page.click('[data-testid="ddd-start-pane"] button[aria-label="Close"]');
      await page.click('[data-testid="ddd-tab-specs"]');
      await page.waitForSelector('[data-testid="ddd-specs-tab"]', { timeout: 20_000 });
      await page.waitForSelector('[data-testid="ddd-editor"] [contenteditable="true"]', { timeout: 20_000 });
      const failureEditable = page.locator('[data-testid="ddd-editor"] [contenteditable="true"]').first();
      await failureEditable.click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
      await page.keyboard.type("\nLaunch failure proof");
      await page.waitForFunction(
        () => !(document.querySelector('[data-testid="ddd-dispatch-file"]') as HTMLButtonElement | null)?.disabled,
        undefined,
        { timeout: 20_000 },
      );
      workflowMap.delete("docs-driven-development");
      const missingDispatchButton = page.locator('[data-testid="ddd-dispatch-file"]');
      await missingDispatchButton.click();
      await page.waitForFunction(
        () => {
          const status = document.querySelector('[data-testid="ddd-meta-ticket-status"]')?.textContent ?? "";
          return status.includes("Failed") && status.includes("docs-driven-development");
        },
        undefined,
        { timeout: 20_000 },
      );
      expect(await missingDispatchButton.evaluate((button: HTMLButtonElement) => button.disabled)).toBe(false);
      expect(await page.locator('[data-testid="ddd-tab-specs"]').getAttribute("aria-selected")).toBe("true");
      expect(await page.locator('[data-testid="ddd-specs-tab"]').count()).toBe(1);
    } finally {
      for (const [key, workflow] of savedWorkflows) {
        if (workflow) workflowMap.set(key, workflow);
        else workflowMap.delete(key);
      }
    }

    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 180_000);
