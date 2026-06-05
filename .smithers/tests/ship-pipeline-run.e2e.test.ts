import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * REAL end-to-end execution of the ship-pipeline workflow + its UI.
 *
 * Unlike ship-pipeline-ui.e2e (which drives the UI with a deterministic fixture
 * run), this boots a gateway that EXECUTES the real ship-pipeline workflow to
 * completion: VerifiableGoals decomposes the proposal and writes a ticket,
 * ShipTickets discovers it and runs research → plan → implement → validate →
 * review inside a real git worktree, then the merge task lands it. The only stub
 * is the agent — the repo's standard fake-`claude` binary + a superset
 * SMITHERS_FAKE_AGENT_RESPONSE that satisfies every per-stage output schema —
 * exactly the sanctioned e2e fixture; the gateway, RPC, workflow engine, git
 * worktrees, schema-bound node output, and the UI bundle are all real.
 *
 * The workflow runs in a throwaway git repo (so the worktrees + ticket files
 * land there) via a subprocess whose script lives in the real tree, so bun
 * resolves modules from the real repo. A headless browser then asserts the UI
 * renders the real completed run.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const runnerScript = resolve(here, "shipPipelineRunFixture.ts");
const realNodeModules = resolve(repoRoot, "node_modules");
const RUN_ID = "ship-pipeline-e2e";

// One superset agent response that satisfies goals + every per-ticket schema
// (research/plan/implement/validate/review/shipResult). "stub agent output" is
// the recognizable token asserted in the rendered detail.
const FAKE_RESPONSE = JSON.stringify({
  summary: "stub agent output",
  keyFindings: ["finding one", "finding two"],
  steps: ["step one", "step two"],
  filesChanged: ["src/voice-capture.ts"],
  allTestsPassing: true,
  allPassed: true,
  failingSummary: null,
  reviewer: "reviewer-1",
  approved: true,
  feedback: "looks good",
  issues: [],
  status: "merged",
  branch: "ship/voice-capture",
  ticketId: "voice-capture",
  tickets: [
    {
      slug: "voice-capture",
      title: "Voice capture pipeline",
      goal: "Capture the operator's voice",
      spec: "spec",
      e2eVerification: "an e2e test driving the real backend",
      acceptanceCriteria: ["captures audio"],
      dependsOn: [],
    },
  ],
});

let tempRepo = "";
let binDir = "";
let proc: ChildProcess | undefined;
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

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function loadChromium() {
  const playwrightPkg = "playwright";
  try {
    return (await import(playwrightPkg)).chromium;
  } catch {
    return (await import(resolve(repoRoot, "apps/smithers-studio-2/node_modules/playwright/index.js"))).chromium;
  }
}

beforeAll(async () => {
  // A throwaway git repo with a `main` ref (so Worktree's `git worktree add -B`
  // off main succeeds) and a node_modules pointing at the real repo.
  tempRepo = mkdtempSync(join(tmpdir(), "ship-pipeline-run-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: tempRepo });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: tempRepo });
  execFileSync("git", ["config", "user.name", "e2e"], { cwd: tempRepo });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: tempRepo });
  symlinkSync(realNodeModules, join(tempRepo, "node_modules"), "dir");
  writeFileSync(join(tempRepo, "package.json"), JSON.stringify({ name: "ship-pipeline-run-e2e", type: "module" }) + "\n");

  // The repo's standard fake `claude` binary: echoes the JSON payload back in the
  // turn_end envelope the ClaudeCodeAgent parses.
  binDir = mkdtempSync(join(tmpdir(), "ship-pipeline-bin-"));
  const claudeSrc = [
    `#!${process.execPath}`,
    `const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? "{}";`,
    `process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n" }] } }) + "\\n");`,
    ``,
  ].join("\n");
  writeFileSync(join(binDir, "claude"), claudeSrc);
  chmodSync(join(binDir, "claude"), 0o755);

  port = await findOpenPort();
  base = `http://127.0.0.1:${port}`;

  proc = spawn(process.execPath, [runnerScript], {
    cwd: tempRepo,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      SMITHERS_FAKE_AGENT_RESPONSE: FAKE_RESPONSE,
      ANTHROPIC_API_KEY: "",
      UG_PORT: String(port),
      UG_RUN_ID: RUN_ID,
    },
    stdio: "ignore",
  });

  // The fixture executes the whole pipeline (worktree + per-stage) BEFORE it
  // listens, so health coming up means the real run already completed.
  expect(await waitForHealth(180_000)).toBe(true);
}, 200_000);

afterAll(() => {
  try {
    proc?.kill("SIGTERM");
  } catch {}
  try {
    rmSync(tempRepo, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(binDir, { recursive: true, force: true });
  } catch {}
});

test("the real ship-pipeline run renders end-to-end in the UI", async () => {
  const browser = await (await loadChromium()).launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err: Error) => errors.push(err.message));

    await page.goto(`${base}/workflows/ship-pipeline?runId=${RUN_ID}`, { waitUntil: "networkidle" });

    // The real bundle built + app mounted.
    await page.waitForSelector('[data-testid="ship-pipeline-ui"]', { timeout: 20_000 });

    // The pipeline lists the ticket that VerifiableGoals actually wrote +
    // ShipTickets actually discovered (slug from the written 0001-*.md file).
    await page.waitForSelector('[data-testid="ship-pipeline"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ship-ticket-0001-voice-capture"]', { timeout: 20_000 });

    // Event-derived landed state: the merge task really finished → 1/1 landed.
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="ship-progress"]')?.textContent ?? "").includes("1/1 landed"),
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForSelector('[data-testid="ship-ledger"]', { timeout: 20_000 });

    // The selected ticket's detail renders the real run's node output.
    await page.waitForFunction(
      () => {
        const text = document.body.textContent ?? "";
        return text.includes("stub agent output") && text.includes("Voice capture pipeline");
      },
      undefined,
      { timeout: 20_000 },
    );

    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);
