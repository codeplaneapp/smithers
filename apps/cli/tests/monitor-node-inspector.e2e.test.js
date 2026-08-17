import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createExecutableDir,
  createTempRepo,
  pinSqliteBackend,
  runSmithers,
  writeExecutable,
  writeFakeAntigravityBinary,
  writeFakeCodexBinary,
} from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * Real-browser e2e for the Monitor's node inspector:
 *
 *   1. The inspector shows the task's INITIAL PROMPT (from the attempt's
 *      persisted metadata, surfaced on the devtools snapshot).
 *   2. The Output section recovers from the stale "No output recorded for
 *      this node." fallback: the page is opened while the node is still
 *      RUNNING (the fake agent sleeps first), so the first output fetch comes
 *      back pending — the panel must refetch when the node finishes and render
 *      the real row without a reload.
 *   3. Every inspector section (Details, Prompt, Transcript, Output, …) is a
 *      collapsible <details> that starts open.
 *
 * No mocking: a real gateway serves the real /monitor bundle, a real run
 * executes a ClaudeCodeAgent task against the standard fake `claude` binary,
 * and headless Chromium drives the page.
 */

const require = createRequire(import.meta.url);
const CLI_ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));

function resolveChromium() {
  try {
    const chromium = require("playwright").chromium;
    const executablePath = chromium?.executablePath?.();
    if (typeof executablePath === "string" && existsSync(executablePath)) return chromium;
  } catch {}
  return null;
}

const CHROMIUM = resolveChromium();
const browserTest = CHROMIUM ? test : test.skip;

const PROMPT = "Freeze the scope for the inspector-probe token on Avalanche C-Chain.";
const AGENT_SUMMARY = "inspector probe output";

const WORKFLOW = `
/** @jsxImportSource smthrs */
import { ClaudeCodeAgent, createSmithers } from "smthrs";
import { z } from "zod";

const { Workflow, Task, smithers, outputs } = createSmithers({
  probe: z.object({ summary: z.string() }),
});

export default smithers(() => (
  <Workflow name="inspector-probe">
    <Task
      id="probe"
      output={outputs.probe}
      agent={new ClaudeCodeAgent({ model: "claude-haiku-4-5" })}
      retries={0}
    >
      {${JSON.stringify(PROMPT)}}
    </Task>
  </Workflow>
));
`;

/**
 * The standard fake claude with one twist: it waits before answering, so the
 * browser opens on a node that is still running — the exact interleaving that
 * used to strand the Output panel on "No output recorded for this node.".
 */
function writeSlowFakeClaudeBinary(dir, delayMs = 5_000) {
  return writeExecutable(
    dir,
    "claude",
    [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      "if (args.join(' ') === 'auth status') {",
      "  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) + '\\n');",
      "  process.exit(0);",
      "}",
      "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE;",
      `setTimeout(() => {`,
      "  process.stdout.write(JSON.stringify({",
      '    type: "turn_end",',
      "    message: {",
      '      role: "assistant",',
      '      content: [{ type: "text", text: "```json\\n" + payload + "\\n```\\n" }],',
      "    },",
      '  }) + "\\n");',
      `}, ${delayMs});`,
      "",
    ].join("\n"),
  );
}

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

async function waitForHealth(base, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function rpc(base, method, params) {
  const response = await fetch(`${base}/v1/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.ok).toBe(true);
  return body.payload;
}

async function stopGateway(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise((resolve) => process.once("exit", resolve));
  process.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
    await exited;
  }
}

browserTest(
  "monitor node inspector shows the prompt, recovers stale output, and collapses sections",
  async () => {
    const binDir = createExecutableDir();
    writeSlowFakeClaudeBinary(binDir);
    writeFakeCodexBinary(binDir);
    writeFakeAntigravityBinary(binDir);
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    const env = {
      HOME: repo.dir,
      PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "sk-test-openai-key",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      SMITHERS_FAKE_AGENT_RESPONSE: JSON.stringify({ summary: AGENT_SUMMARY }),
    };
    repo.write(".claude/.credentials.json", "{}\n");
    repo.write(".codex/auth.json", "{}\n");
    repo.write(".gemini/antigravity-cli/settings.json", "{}\n");

    expect(runSmithers(["init"], { cwd: repo.dir, format: "json", env }).exitCode).toBe(0);
    repo.write(".smithers/workflows/inspector-probe.tsx", WORKFLOW);

    const port = await findOpenPort();
    const base = `http://127.0.0.1:${port}`;
    // The real CLI gateway owns the Monitor mount at /monitor.
    const gatewayProc = spawn(process.execPath, ["run", CLI_ENTRY, "gateway", "--port", String(port)], {
      cwd: repo.dir,
      env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
      stdio: "ignore",
    });
    let browser;
    try {
      expect(await waitForHealth(base)).toBe(true);
      const runId = "monitor-inspector-run";
      const launched = await rpc(base, "launchRun", {
        workflow: "inspector-probe",
        input: {},
        runId,
      });
      expect(launched.runId).toBe(runId);

      browser = await CHROMIUM.launch({ headless: true });
      const page = await browser.newPage();
      const scopedTranscriptRequest = page.waitForRequest(
        (request) => {
          const url = new URL(request.url());
          return (
            url.pathname === `/v1/api/runs/${runId}/events` &&
            url.searchParams.get("nodeId") === "probe" &&
            url.searchParams.get("iteration") === "0" &&
            url.searchParams.get("attempt") === "1"
          );
        },
        { timeout: 30_000 },
      );
      const scopedAttemptRequest = page.waitForRequest(
        (request) => {
          const url = new URL(request.url());
          if (url.pathname !== "/v1/rpc/attempts.list") return false;
          try {
            const params = request.postDataJSON();
            return params.runId === runId && params.nodeId === "probe" && params.iteration === 0;
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      );
      const scopedOutputRequest = page.waitForRequest(
        (request) => {
          const url = new URL(request.url());
          return url.pathname === `/v1/api/nodes/${runId}/probe/output` && url.searchParams.get("iteration") === "0";
        },
        { timeout: 30_000 },
      );
      // Deep-link straight into the node inspector while the task is RUNNING.
      await page.goto(`${base}/monitor?runId=${runId}&nodeId=probe`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="monitor-root"]', { timeout: 20_000 });
      await page.waitForSelector('[data-testid="monitor-inspector"]', { timeout: 30_000 });
      await Promise.all([scopedTranscriptRequest, scopedAttemptRequest, scopedOutputRequest]);

      const inspector = page.locator('[data-testid="monitor-inspector"]');
      expect(await page.getByRole("complementary", { name: "probe" }).count()).toBe(1);
      expect(await inspector.getAttribute("aria-labelledby")).not.toBeNull();
      expect(await inspector.getAttribute("tabindex")).toBe("-1");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("monitor-inspector");
      expect(await page.getByRole("navigation", { name: "Runs" }).count()).toBe(1);
      expect(await page.locator('[data-testid="monitor-runs"] ul > li [data-testid="monitor-run-row"]').count()).toBe(
        1,
      );
      expect(await page.getByRole("tree", { name: "Execution tree" }).count()).toBe(1);

      // Radix tabs expose one tab stop and arrow-key activation.
      const treeTab = page.getByRole("tab", { name: "Tree" });
      const timelineTab = page.getByRole("tab", { name: "Timeline" });
      expect(await page.getByRole("tablist", { name: "Execution views" }).count()).toBe(1);
      await treeTab.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="monitor-timeline-chip"]')?.getAttribute("aria-selected") === "true",
      );
      expect(await timelineTab.getAttribute("aria-selected")).toBe("true");
      await timelineTab.focus();
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="monitor-tree-tab"]')?.getAttribute("aria-selected") === "true",
      );
      expect(await treeTab.getAttribute("aria-selected")).toBe("true");

      // Sections are collapsible <details> elements, open by default.
      for (const testId of [
        "monitor-node-details",
        "monitor-node-attempts",
        "monitor-node-output",
        "monitor-node-transcript",
      ]) {
        expect(await page.locator(`[data-testid="${testId}"]`).evaluate((el) => el.tagName)).toBe("DETAILS");
        expect(await page.locator(`[data-testid="${testId}"]`).evaluate((el) => el.open)).toBe(true);
      }
      expect((await page.locator('[data-testid="monitor-node-details"]').textContent()) ?? "").toContain("probe");
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="monitor-node-attempts"]')?.textContent ?? "").includes("Attempt 1"),
        undefined,
        { timeout: 30_000 },
      );
      const attemptsText = (await page.locator('[data-testid="monitor-node-attempts"]').textContent()) ?? "";
      expect(attemptsText).toContain("Iteration 0");
      expect(attemptsText).toContain("no automatic retries");

      // 1 — The task's initial prompt is shown (recorded in attempt metadata the
      // moment the attempt started, so it renders even while the node runs).
      await page.waitForFunction(
        (expected) =>
          (document.querySelector('[data-testid="monitor-node-prompt"]')?.textContent ?? "").includes(expected),
        PROMPT,
        { timeout: 30_000 },
      );

      // 2 — The Output section must NOT strand on the stale fallback: the first
      // fetch landed while the node was running, so without a refetch on the
      // lifecycle change this wait would time out with "No output recorded…".
      await page.waitForFunction(
        (expected) =>
          (document.querySelector('[data-testid="monitor-node-output"]')?.textContent ?? "").includes(expected),
        AGENT_SUMMARY,
        { timeout: 60_000 },
      );
      const outputText = (await page.locator('[data-testid="monitor-node-output"]').textContent()) ?? "";
      expect(outputText).not.toContain("No output recorded for this node.");
      expect(outputText).not.toContain("running — structured output lands here");

      // 3 — Sections collapse and re-expand via their summary rows.
      const promptSection = page.locator('[data-testid="monitor-node-prompt"]');
      await page.waitForSelector('[data-testid="monitor-node-prompt"] .mon-section-body');
      await promptSection.locator("summary").click();
      expect(await promptSection.evaluate((el) => el.open)).toBe(false);
      await page.locator('[data-testid="monitor-node-prompt"] .mon-section-body').waitFor({ state: "detached" });
      await promptSection.locator("summary").click();
      expect(await promptSection.evaluate((el) => el.open)).toBe(true);
      await page.waitForSelector('[data-testid="monitor-node-prompt"] .mon-section-body');

      expect((await page.locator('[data-testid="monitor-run-status-announcer"]').textContent()) ?? "").toContain(
        "Run status:",
      );

      // Escape closes the complementary inspector and restores the composite
      // tree focus; Enter can then reopen it without adding per-node tab stops.
      await inspector.focus();
      await page.keyboard.press("Escape");
      await inspector.waitFor({ state: "detached" });
      expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("tree");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-testid="monitor-inspector"]');
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("monitor-inspector");
    } finally {
      try {
        await browser?.close();
      } catch {}
      try {
        await stopGateway(gatewayProc);
      } catch {}
    }
  },
  180_000,
);
