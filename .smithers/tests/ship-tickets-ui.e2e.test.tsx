/** @jsxImportSource smithers-orchestrator */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSmithers, Gateway, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";

/**
 * Real-browser e2e for the `ship-tickets` monitoring UI. No route mocking, no
 * fabricated RPC: a REAL Smithers Gateway serves the REAL `.smithers/ui/
 * ship-tickets.tsx` (bundled on demand by the gateway's Bun build), driven by a
 * REAL run whose node output + event frames the UI reads over the live RPC/WS.
 *
 * The run is produced by a deterministic `createSmithers` workflow that
 * reproduces ship-tickets' EXACT node-id + output-schema contract
 * (`manifest`, then per-ticket `<slug>:research|plan|implement|validate|
 * review:0|merge`). The real ship-tickets workflow drives agents, git worktrees,
 * and a `pnpm typecheck` merge gate — none of which complete deterministically
 * headless — so, exactly like the studio-2 gateway fixture, the workflow is the
 * seeded-deterministic part and EVERYTHING the UI touches (gateway, RPC, schema-
 * bound node-output tables, the event window) is real.
 *
 * This is the check that caught the event-frame bug: the gateway emits frames
 * shaped `{ event, payload: { nodeId, state }, seq }`, so the UI's pipeline /
 * ledger (which derive per-ticket state from the event stream) only light up
 * when nodeId is read from `payload` — a "serves 200" smoke can never catch that.
 *
 * Runs under bun (the orchestrator's SQLite layer uses bun:sqlite); Chromium is
 * resolved from the studio-2 Playwright install.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const uiEntry = resolve(here, "../ui/ship-tickets.tsx");
const RUN_ID = "ship-tickets-e2e-run";

// The two tickets the fixture run "ships". Titles + per-stage summary tokens are
// deliberately unique so the assertions prove the UI rendered THIS run's output.
const TICKETS = [
  { slug: "0001-voice-capture", title: "Voice capture pipeline", id: ".smithers/tickets/ultragrill/0001-voice-capture.md" },
  { slug: "0002-question-pool", title: "Rolling question pool", id: ".smithers/tickets/ultragrill/0002-question-pool.md" },
];

// EXACT schemas the ship-tickets UI extractors read (mirrors the real workflow +
// ValidationLoop/Review component outputs).
const researchSchema = z.object({ summary: z.string(), keyFindings: z.array(z.string()).default([]) });
const planSchema = z.object({ summary: z.string(), steps: z.array(z.string()).default([]) });
const implementSchema = z.object({ summary: z.string(), filesChanged: z.array(z.string()).default([]), allTestsPassing: z.boolean().default(true) });
const validateSchema = z.object({ summary: z.string(), allPassed: z.boolean().default(true), failingSummary: z.string().nullable().default(null) });
const reviewSchema = z.object({ reviewer: z.string(), approved: z.boolean(), feedback: z.string(), issues: z.array(z.any()).default([]) });
const shipResultSchema = z.object({ ticketId: z.string(), branch: z.string(), status: z.enum(["merged", "skipped", "failed"]), summary: z.string() });
const manifestSchema = z.object({
  ticketsDir: z.string(),
  tickets: z.array(z.object({ slug: z.string(), title: z.string(), id: z.string() })).default([]),
});

const tmpDir = mkdtempSync(join(tmpdir(), "ship-tickets-e2e-"));
const dbPath = join(tmpDir, "runs.db");

const { smithers, Workflow, Task, outputs } = createSmithers(
  {
    research: researchSchema,
    plan: planSchema,
    implement: implementSchema,
    validate: validateSchema,
    review: reviewSchema,
    shipResult: shipResultSchema,
    manifest: manifestSchema,
  },
  { dbPath },
);

function ticketNodes(t: (typeof TICKETS)[number]) {
  return (
    <Sequence key={t.slug}>
      <Task id={`${t.slug}:research`} output={outputs.research}>
        {{ summary: `RESEARCH-${t.slug}: grounded in the gateway + dev-server seams.`, keyFindings: [`finding-a-${t.slug}`, `finding-b-${t.slug}`] }}
      </Task>
      <Task id={`${t.slug}:plan`} output={outputs.plan}>
        {{ summary: `PLAN-${t.slug}`, steps: [`step-one-${t.slug}`, `step-two-${t.slug}`] }}
      </Task>
      <Task id={`${t.slug}:implement`} output={outputs.implement}>
        {{ summary: `IMPLEMENT-${t.slug}`, filesChanged: [`src/${t.slug}.ts`], allTestsPassing: true }}
      </Task>
      <Task id={`${t.slug}:validate`} output={outputs.validate}>
        {{ summary: `VALIDATE-${t.slug}`, allPassed: true, failingSummary: null }}
      </Task>
      <Task id={`${t.slug}:review:0`} output={outputs.review}>
        {{ reviewer: `reviewer-${t.slug}`, approved: true, feedback: `LGTM-${t.slug}`, issues: [] }}
      </Task>
      <Task id={`${t.slug}:merge`} output={outputs.shipResult}>
        {{ ticketId: t.id, branch: `ship/${t.slug}`, status: "merged", summary: `MERGED-${t.slug} onto main` }}
      </Task>
    </Sequence>
  );
}

const workflow = smithers(() => (
  <Workflow name="ship-tickets">
    <Sequence>
      <Task id="manifest" output={outputs.manifest}>
        {{ ticketsDir: ".smithers/tickets/ultragrill", tickets: TICKETS }}
      </Task>
      {TICKETS.map(ticketNodes)}
    </Sequence>
  </Workflow>
));

const gateway = new Gateway({ heartbeatMs: 250 });
// The workflow's inferred schema generic is narrower than register's `SmithersWorkflow`
// param (build's ctx is contravariant) — a fixture-only cast, exactly the shape the
// gateway runs at runtime.
gateway.register("ship-tickets", workflow as Parameters<typeof gateway.register>[1], {
  ui: { entry: uiEntry, title: "Ship Tickets" },
});

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

async function waitForHealth(timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function loadChromium() {
  // `playwright` isn't a dependency of the workflow pack; resolve it dynamically
  // (a non-literal specifier so tsc doesn't try to resolve it here), falling back
  // to the studio-2 install where the browsers are downloaded.
  const playwrightPkg = "playwright";
  try {
    return (await import(playwrightPkg)).chromium;
  } catch {
    return (await import(resolve(repoRoot, "apps/smithers-studio-2/node_modules/playwright/index.js"))).chromium;
  }
}

beforeAll(async () => {
  const auth = { triggeredBy: "e2e", scopes: ["*"], role: "operator", tokenId: null };
  // Execute the run to completion BEFORE listening, so node output + the full
  // event window exist the instant the browser connects (no spec/run race).
  await gateway.startRun("ship-tickets", {}, auth, RUN_ID, { resume: false });
  const inflight = gateway.inflightRuns.get(RUN_ID);
  if (inflight) await inflight;

  port = await findOpenPort();
  base = `http://127.0.0.1:${port}`;
  await gateway.listen({ port, host: "127.0.0.1" });
});

afterAll(async () => {
  try {
    await gateway.close();
  } catch {}
  rmSync(tmpDir, { recursive: true, force: true });
});

test("ship-tickets UI renders a real completed run end-to-end", async () => {
  expect(await waitForHealth()).toBe(true);

  const browser = await (await loadChromium()).launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (err: Error) => errors.push(err.message));

    await page.goto(`${base}/workflows/ship-tickets?runId=${RUN_ID}`, { waitUntil: "networkidle" });

    // 1) The real bundle built + the app mounted to its root.
    await page.waitForSelector('[data-testid="ship-tickets-ui"]', { timeout: 20_000 });

    // 2) The pipeline lists both tickets from the manifest node output.
    await page.waitForSelector('[data-testid="ship-pipeline"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ship-ticket-0001-voice-capture"]', { timeout: 20_000 });
    await page.waitForSelector('[data-testid="ship-ticket-0002-question-pool"]', { timeout: 20_000 });

    // 3) EVENT-derived state: both tickets land (progress pill + ledger). This is
    //    the assertion that fails unless nodeId is read from frame.payload.
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="ship-progress"]')?.textContent ?? "").includes("2/2 landed"),
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForSelector('[data-testid="ship-ledger"]', { timeout: 20_000 });

    // 4) The default-selected ticket's detail renders THIS run's real node output
    //    across every stage (research → merge), read over the live node-output RPC.
    await page.waitForFunction(
      (expected: string[]) => {
        const text = document.body.textContent ?? "";
        return expected.every((t) => text.includes(t));
      },
      [
        "RESEARCH-0001-voice-capture",
        "finding-a-0001-voice-capture",
        "PLAN-0001-voice-capture",
        "step-one-0001-voice-capture",
        "IMPLEMENT-0001-voice-capture",
        "src/0001-voice-capture.ts",
        "VALIDATE-0001-voice-capture",
        "reviewer-0001-voice-capture",
        "MERGED-0001-voice-capture onto main",
      ],
      { timeout: 20_000 },
    );

    // 5) The per-ticket live-activity feed (also event-derived) shows node frames.
    await page.waitForSelector('[data-testid="ticket-activity"]', { timeout: 20_000 });

    // 6) Selecting the second ticket swaps the detail to ITS output.
    await page.click('[data-testid="ship-ticket-0002-question-pool"]');
    await page.waitForFunction(
      () => (document.body.textContent ?? "").includes("MERGED-0002-question-pool onto main"),
      undefined,
      { timeout: 20_000 },
    );

    expect(errors).toEqual([]);

    const ledgerText = await page.evaluate(
      () => document.querySelector('[data-testid="ship-ledger"]')?.textContent ?? "",
    );
    expect(ledgerText).toContain("Voice capture pipeline");
    expect(ledgerText).toContain("Rolling question pool");
  } finally {
    await browser.close();
  }
}, 120_000);
