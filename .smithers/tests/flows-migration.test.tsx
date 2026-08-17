import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { renderWorkflow } from "smthrs/testing";

import {
  ALL_STAGES,
  artifactFileName,
  bookmarkFor,
  isAllowedCheck,
  laneDirFor,
  lanePhase,
  migrationKeyFromRunId,
  parseCheck,
  parseLedger,
  parseStageSelection,
  renderLaneReportHtml,
  renderStageReportHtml,
  sanitizeSlug,
  summarizeGate,
} from "../lib/flowsMigration";
import { laneBadge, parseLedgerStages } from "../ui/flows-migration";

const workflowPath = join(import.meta.dir, "..", "workflows", "flows-migration.tsx");
const cliSrc = pathToFileURL(resolve(import.meta.dir, "../../apps/cli/src")).href;

const ledger = {
  missionTitle: "Flows migration",
  summary: "Four stages, smallest risk first.",
  stages: [
    {
      id: "0",
      title: "Prerequisites",
      goal: "Unblock the two trees from depending on each other.",
      checks: ["pnpm typecheck"],
      lanes: [
        {
          slug: "rename-flows-scope",
          title: "Rename the colliding flows packages",
          goal: "Rename the seven colliding package names before the first publish.",
          repo: "flows",
          scopes: ["packages"],
          checks: ["pnpm install --frozen-lockfile", "rm -rf /"],
          dependsOn: [],
        },
        {
          slug: "effect-rc108",
          title: "Bump smithers to effect rc.108",
          goal: "Move every smithers manifest onto the flows effect pin and fix the bridge fallout.",
          repo: "smithers",
          scopes: ["packages/engine"],
          checks: ["pnpm typecheck"],
          dependsOn: ["rename-flows-scope"],
        },
      ],
    },
    {
      id: "1",
      title: "Engine",
      goal: "Put the flows engine underneath smithers behind a flag.",
      checks: [],
      lanes: [
        {
          slug: "storage-swap",
          title: "Swap the journal and run store",
          goal: "Replace the adapter event and claim paths with the flows stores behind a compat module.",
          repo: "smithers",
          scopes: ["packages/db"],
          checks: ["pnpm -C packages/db test"],
          dependsOn: [],
        },
      ],
    },
  ],
};

describe("flows-migration ledger parsing", () => {
  test("normalizes stages, drops unsafe checks, and keeps lane order", () => {
    const parsed = parseLedger(ledger, { maxLanesPerStage: 6 });
    expect(parsed).not.toBeNull();
    expect(parsed?.stages.map((stage) => stage.id)).toEqual(["0", "1"]);
    const first = parsed?.stages[0].lanes[0];
    expect(first?.repo).toBe("flows");
    // `rm -rf /` is not on the allowlist, so it never reaches the gate.
    expect(first?.checks).toEqual(["pnpm install --frozen-lockfile"]);
    expect(parsed?.stages[0].lanes[1].dependsOn).toEqual(["rename-flows-scope"]);
    expect(parsed?.stages[0].checks).toEqual(["pnpm typecheck"]);
  });

  test("accepts JSON-string arrays as persisted rows deliver them", () => {
    const row = {
      row: {
        missionTitle: "Flows migration",
        summary: "stringified",
        stages: JSON.stringify(ledger.stages),
      },
    };
    const parsed = parseLedger(row, { maxLanesPerStage: 6 });
    expect(parsed?.stages.length).toBe(2);
    expect(parsed?.stages[1].lanes[0].slug).toBe("storage-swap");
  });

  test("filters stages down to the selection and dedupes slugs", () => {
    const parsed = parseLedger(ledger, { stages: ["1"] });
    expect(parsed?.stages.map((stage) => stage.id)).toEqual(["1"]);

    const dupes = parseLedger({
      missionTitle: "dupes",
      summary: "two lanes with one slug",
      stages: [
        {
          id: "0",
          title: "Stage",
          goal: "goal",
          lanes: [
            { slug: "same", title: "a", goal: "a", repo: "smithers", scopes: ["x"] },
            { slug: "same", title: "b", goal: "b", repo: "smithers", scopes: ["y"] },
          ],
        },
      ],
    });
    expect(dupes?.stages[0].lanes.length).toBe(1);
  });

  test("returns null when there is nothing usable", () => {
    expect(parseLedger({})).toBeNull();
    expect(parseLedger({ stages: [] })).toBeNull();
    expect(parseLedger({ stages: [{ id: "9", lanes: [{ slug: "x" }] }] })).toBeNull();
  });
});

describe("flows-migration stage selection and checks", () => {
  test("parses the stage input", () => {
    expect(parseStageSelection("all")).toEqual([...ALL_STAGES]);
    expect(parseStageSelection("")).toEqual([...ALL_STAGES]);
    expect(parseStageSelection("1")).toEqual(["1"]);
    expect(parseStageSelection("stage-0, 1")).toEqual(["0", "1"]);
    expect(parseStageSelection("nonsense")).toEqual([...ALL_STAGES]);
  });

  test("only allowlisted, metacharacter-free commands run in a lane gate", () => {
    expect(isAllowedCheck("pnpm -C packages/db test")).toBe(true);
    expect(isAllowedCheck("bun test")).toBe(true);
    expect(isAllowedCheck("curl https://example.com")).toBe(false);
    expect(isAllowedCheck("pnpm test && rm -rf /")).toBe(false);
    expect(isAllowedCheck("pnpm test > out.txt")).toBe(false);
    expect(isAllowedCheck("pnpm test $(whoami)")).toBe(false);
    expect(parseCheck("pnpm -C packages/db test")).toEqual({ binary: "pnpm", args: ["-C", "packages/db", "test"] });
    expect(parseCheck("curl example.com")).toBeNull();
  });
});

describe("flows-migration paths and phases", () => {
  test("keys, paths, and bookmarks are stable and safe", () => {
    expect(migrationKeyFromRunId("run-1785811783554")).toBe("5811783554");
    expect(migrationKeyFromRunId("")).toBe("local");
    expect(sanitizeSlug("Storage Swap!!")).toBe("storage-swap");
    expect(laneDirFor("/repo", "abc", "Storage Swap")).toBe(
      "/repo/.smithers/workflows/.worktrees/flows-migration-abc/storage-swap",
    );
    expect(bookmarkFor("abc", "storage swap")).toBe("flows-migration/abc/storage-swap");
    expect(artifactFileName("storage-swap", 2)).toBe("storage-swap-r2.html");
    expect(artifactFileName("storage-swap", 0)).toBe("storage-swap-r1.html");
  });

  test("lane phase reflects the lane's furthest settled state", () => {
    const base = {
      hasWorkspace: true,
      implemented: true,
      blocked: false,
      gateOk: true,
      reviewApproved: true,
      decision: "pending" as const,
      buildExhausted: false,
      reviewExhausted: false,
    };
    expect(lanePhase({ ...base, hasWorkspace: false })).toBe("pending");
    expect(lanePhase({ ...base, blocked: true })).toBe("blocked");
    expect(lanePhase({ ...base, implemented: false, gateOk: false, buildExhausted: true })).toBe("exhausted");
    expect(lanePhase({ ...base, implemented: false })).toBe("workspace");
    expect(lanePhase({ ...base, gateOk: false })).toBe("gate-red");
    expect(lanePhase({ ...base, reviewApproved: false })).toBe("reviewing");
    expect(lanePhase(base)).toBe("awaiting-approval");
    expect(lanePhase({ ...base, decision: "denied" })).toBe("denied");
    expect(lanePhase({ ...base, decision: "denied", reviewExhausted: true })).toBe("exhausted");
    expect(lanePhase({ ...base, decision: "approved" })).toBe("approved");
  });

  test("gate summaries name the failing checks", () => {
    expect(summarizeGate(undefined)).toBe("not run");
    expect(summarizeGate({ ok: true })).toBe("green");
    expect(summarizeGate({ ok: false, failuresJson: JSON.stringify([{ check: "pnpm typecheck" }]) })).toBe(
      "FAILING: pnpm typecheck",
    );
  });
});

describe("flows-migration reports", () => {
  test("lane report is a self-contained page and escapes untrusted text", () => {
    const lane = parseLedger(ledger)!.stages[0].lanes[0];
    const html = renderLaneReportHtml({
      lane,
      missionTitle: "Flows migration",
      revision: 1,
      phase: "awaiting-approval",
      gateOk: false,
      gateDetail: "exit 1",
      implementSummary: "<script>alert(1)</script>",
      reviewVerdict: "reject",
      reviewFeedback: "needs work",
      diffStat: "3 files changed",
      commitId: "abc123",
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("http://");
    expect(html).toContain("gate failing");
  });

  test("stage report counts lanes and links every report", () => {
    const stage = parseLedger(ledger)!.stages[0];
    const html = renderStageReportHtml({
      missionTitle: "Flows migration",
      stage,
      rows: stage.lanes.map((lane, index) => ({
        slug: lane.slug,
        title: lane.title,
        repo: lane.repo,
        phase: index === 0 ? "approved" : "reviewing",
        gateOk: index === 0,
        revision: 1,
        reportPath: artifactFileName(lane.slug, 1),
      })),
      integrateSummary: "rebased both lanes",
      integrateOk: true,
    });
    expect(html).toContain("1 green");
    expect(html).toContain("1 approved");
    expect(html).toContain("rename-flows-scope-r1.html");
  });
});

describe("flows-migration UI helpers", () => {
  test("reads the ledger row into stages and lanes", () => {
    const stages = parseLedgerStages({ row: { stages: JSON.stringify(ledger.stages) } });
    expect(stages.map((stage) => stage.id)).toEqual(["0", "1"]);
    expect(stages[0].lanes[0]).toEqual({
      slug: "rename-flows-scope",
      title: "Rename the colliding flows packages",
      repo: "flows",
    });
  });

  test("lane badge prefers the human decision over the machine state", () => {
    expect(laneBadge({ ok: true }, { verdict: "approve" }, { approved: true }).label).toBe("approved");
    expect(laneBadge({ ok: true }, { verdict: "approve" }, { approved: false }).label).toBe("denied");
    expect(laneBadge({ ok: false }, {}, {}).status).toBe("failed");
    expect(laneBadge({ ok: true }, { verdict: "approve" }, {}).label).toBe("awaiting approval");
    expect(laneBadge(undefined, undefined, undefined).label).toBe("building");
  });
});

describe("flows-migration workflow render", () => {
  async function render(options: { input?: Record<string, unknown>; outputs?: Record<string, unknown[]> } = {}) {
    process.env.SMITHERS_CLI_SRC_DIR = cliSrc;
    const workflow = (await import(workflowPath)).default;
    return (await renderWorkflow(workflow, {
      workflowPath,
      input: workflow.inputSchema.parse(options.input ?? {}),
      runId: "flows-migration-test",
      outputs: options.outputs ?? {},
    })) as any;
  }

  const ids = (frame: any): string[] => frame.tasks.map((task: { nodeId: string }) => task.nodeId);

  test("starts with preflight alone", async () => {
    const frame = await render();
    expect(ids(frame)).toContain("preflight");
    expect(ids(frame)).not.toContain("ledger");
  });

  test("plans once preflight is green, and skips planning when a ledger is supplied", async () => {
    const preflightRow = {
      nodeId: "preflight",
      iteration: 0,
      ok: true,
      smithersRootPath: "/repo",
      flowsRootPath: "/flows",
      collisionsJson: "[]",
      smithersEffectPin: "4.0.0-beta.105",
      flowsEffectPin: "4.0.0-rc.108",
      notesJson: "[]",
      summary: "ready",
    };
    const planned = await render({ outputs: { fmPreflight: [preflightRow] } });
    const ledgerTask = planned.tasks.find((task: { nodeId: string }) => task.nodeId === "ledger");
    expect(ledgerTask, "missing ledger task").toBeDefined();
    expect(Array.isArray(ledgerTask.agent) ? ledgerTask.agent.length : 1).toBeGreaterThan(0);

    const supplied = await render({
      input: { ledgerJson: JSON.stringify(ledger) },
      outputs: { fmPreflight: [preflightRow] },
    });
    expect(ids(supplied)).not.toContain("ledger");
    expect(ids(supplied)).not.toContain("rename-flows-scope:workspace");
  });

  test("stage 0 lanes mount only after the plan approval, and stage 1 waits for the sign-off", async () => {
    const frame = await render({
      input: { ledgerJson: JSON.stringify(ledger) },
      outputs: {
        fmPreflight: [{ nodeId: "preflight", iteration: 0, ok: true, summary: "ready" }],
        fmDecision: [{ nodeId: "plan-approval", iteration: 0, approved: true, decidedBy: "will", decidedAt: "now" }],
      },
    });
    const nodeIds = ids(frame);
    // The first lane has no dependency, so it mounts; the second depends on it.
    expect(nodeIds).toContain("rename-flows-scope:workspace");
    expect(nodeIds).not.toContain("effect-rc108:workspace");
    // Stage 1 stays locked until stage 0 is signed off.
    expect(nodeIds).not.toContain("storage-swap:workspace");
  });
});
