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

function enterFixtureExecutionEnv(): () => void {
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  const previousCodex = process.env.SMITHERS_FAKE_CODEX_RESPONSE;
  const previousClaude = process.env.SMITHERS_FAKE_CLAUDE_RESPONSE;
  const previousTestAgentPath = process.env.SMITHERS_TEST_AGENT_PATH;
  process.chdir(repo!.root);
  process.env.PATH = `${repo!.binDir}:${process.env.PATH ?? ""}`;
  process.env.SMITHERS_TEST_AGENT_PATH = process.env.PATH;
  process.env.SMITHERS_FAKE_CODEX_RESPONSE = fakeAgentResponse("codex fake output");
  process.env.SMITHERS_FAKE_CLAUDE_RESPONSE = fakeAgentResponse("claude fake output");
  return () => {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCodex === undefined) delete process.env.SMITHERS_FAKE_CODEX_RESPONSE;
    else process.env.SMITHERS_FAKE_CODEX_RESPONSE = previousCodex;
    if (previousClaude === undefined) delete process.env.SMITHERS_FAKE_CLAUDE_RESPONSE;
    else process.env.SMITHERS_FAKE_CLAUDE_RESPONSE = previousClaude;
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
      } finally {
        restoreEnv();
      }
    });

    await page.click('[data-testid="ddd-tab-specs"]');
    await page.waitForSelector('[data-testid="ddd-specs-tab"]', { timeout: 20_000 });
    await page.click('[data-testid="ddd-technical-docs"] summary');
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
    const backlogTitle = ticketsBacklog[0]?.content.match(/^#\s+(.+)$/m)?.[1] ?? "";
    await page.waitForFunction(
      (expected: string[]) => {
        const text = document.body.textContent ?? "";
        return expected.every((item) => item && text.includes(item));
      },
      ["Gateway Ticket", "Prove DDD workflow execution", backlogTitle],
      { timeout: 20_000 },
    );

    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 180_000);
