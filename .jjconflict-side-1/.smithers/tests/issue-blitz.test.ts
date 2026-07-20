import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { renderWorkflow } from "smithers-orchestrator/testing";

import { buildIssueBlitzNodeState } from "../lib/buildIssueBlitzNodeState";

const workflowSource = readFileSync(join(import.meta.dir, "../workflows/issue-blitz.tsx"), "utf8");
const issueTrainSource = readFileSync(join(import.meta.dir, "../workflows/issue-train.tsx"), "utf8");
const uiSource = readFileSync(join(import.meta.dir, "../ui/issue-blitz.tsx"), "utf8");
const workflowPath = join(import.meta.dir, "../workflows/issue-blitz.tsx");
const itemKeys = [
  "ci-postgres", "e2e-orphans", "dual-react", "url-schemes", "pack-home", "pack-scan",
  "workflow-dirs", "dead-code", "mcp-confirm", "coerce-props", "audit-atomic",
];

describe("issue-blitz event parsing", () => {
  test("unwraps gateway lifecycle frames from payload.event and payload.payload", () => {
    const state = buildIssueBlitzNodeState([
      { payload: { event: "node.started", payload: { nodeId: "item:implement", iteration: 0 } } },
      { payload: { event: "node.finished", payload: { nodeId: "item:implement", iteration: 0 } } },
      { payload: { event: "node.waiting_approval", payload: { nodeId: "approve-push", iteration: 0 } } },
    ]);

    expect(state.status.get("item:implement")).toBe("done");
    expect(state.iteration.get("item:implement")).toBe(0);
    expect(state.status.get("approve-push")).toBe("waiting");
  });

  test("accepts legacy shallow events and does not let a stale heartbeat reopen a terminal node", () => {
    const state = buildIssueBlitzNodeState([
      { type: "NodeStarted", nodeId: "item:review", iteration: 1 },
      { event: { type: "NodeFinished", nodeId: "item:review", iteration: 1 } },
      { type: "TaskHeartbeat", nodeId: "item:review", iteration: 1 },
      { type: "NodeStarted", nodeId: "item:review", iteration: 2 },
    ]);

    expect(state.status.get("item:review")).toBe("running");
    expect(state.iteration.get("item:review")).toBe(2);
  });
});

describe("issue-blitz safety contract", () => {
  test("keeps the same-branch issue train behind deterministic gates", () => {
    expect(issueTrainSource).toContain("const GATE_COMMAND = \"pnpm typecheck && pnpm test\"");
    expect(issueTrainSource).toContain("git([\"merge-base\", remoteSha, headSha]");
    expect(issueTrainSource).toContain("[\"push\", \"origin\", \"HEAD:refs/heads/main\"]");
    expect(issueTrainSource).toContain("pushed: after === headSha");
    expect(issueTrainSource).not.toContain("--force");
  });

  test("isolates public-issue agents and lands only an approved exact head", () => {
    expect(workflowSource).toContain("buildPublicIssueAgentPolicy");
    expect(workflowSource).toContain("subscriptionCodexFirst");
    expect(workflowSource).toContain("<Worktree");
    expect(workflowSource).toContain("<Approval");
    expect(workflowSource).toContain(":refs/heads/main");
    expect(workflowSource).toContain("remoteBefore !== integration.baseSha");
    expect(workflowSource).toContain("review.headSha !== integration.headSha");
    expect(workflowSource).not.toContain("danger-full-access");
    expect(workflowSource).not.toContain("dangerouslyBypassApprovalsAndSandbox");
    expect(workflowSource).not.toContain("--autostash");
    expect(workflowSource).not.toMatch(/\bcodexFirst\(/);
    expect(workflowSource).not.toMatch(/git\(\["push",\s*"origin",\s*"main"\]\)/);
  });

  test("composes terminal output cards with the shared gateway and UI libraries", () => {
    expect(uiSource).toContain("terminal(\"commit-all\")");
    expect(uiSource).toContain("buildIssueBlitzNodeState");
    expect(uiSource).toContain("NodeOutputView");
    expect(uiSource).toContain('iteration={iteration.get("commit-all") ?? 0}');
    expect(uiSource).toContain("iteration={selectedNodeId ? iteration.get(selectedNodeId) : undefined}");
    expect(uiSource).toContain("SmithersUiStyles");
    expect(uiSource).toContain("statusClass");
    expect(uiSource).toContain("isTerminalRunStatus");
    expect(uiSource).not.toContain("function statusForNode");
    expect(uiSource).toContain('typeof document !== "undefined" && document.getElementById("root")');
    expect(uiSource).not.toContain("<style");
    expect(uiSource).not.toContain("style={{");
    expect(uiSource).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    const imports = [...uiSource.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual([
      "react",
      "smithers-orchestrator/gateway-react",
      "smithers-orchestrator/gateway-ui",
      "smithers-orchestrator/ui",
      "../lib/buildIssueBlitzNodeState",
    ]);
    expect(uiSource).toContain('aria-label="Issue Blitz workflow dashboard"');
  });

  test("renders isolated lanes, exact-head gates, approval, and publication in causal order", async () => {
    const workflow = (await import(`${workflowPath}?safety=${Date.now()}-${Math.random()}`)).default;
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const outputs: Record<string, unknown[]> = {
      discovery: [{ nodeId: "discover", iteration: 0, baseCommit: baseSha, summary: "ready", issues: [{ number: 1331, title: "Public title", body: "Public body", url: "https://example.invalid/1331" }] }],
    };
    const render = () => renderWorkflow(workflow, {
      runId: "issue-blitz-test",
      workflowPath,
      input: { perItemIterations: 2, planConcurrency: 3, implementConcurrency: 2 },
      outputs,
    });

    let frame = await render();
    const bootstrap = frame.tasks.find((task) => task.nodeId === "ci-postgres:bootstrap");
    expect(bootstrap).toBeDefined();
    expect(isAbsolute(bootstrap!.worktreePath!)).toBe(true);
    expect(bootstrap!.worktreeBaseBranch).toBe(baseSha);

    outputs.setup = itemKeys.map((itemKey) => ({
      nodeId: `${itemKey}:bootstrap`, iteration: 0, itemKey,
      cwd: `/tmp/${itemKey}`, baseSha, ready: true, summary: "ready",
    }));
    frame = await render();
    expect(frame.tasks.filter((task) => task.nodeId.endsWith(":plan"))).toHaveLength(itemKeys.length);

    outputs.plan = itemKeys.map((itemKey) => ({
      nodeId: `${itemKey}:plan`, iteration: 0, itemKey,
      summary: "plan", fixPlan: "fix", filesToTouch: [], testPlan: "test", risks: "none",
    }));
    frame = await render();
    expect(frame.tasks.filter((task) => task.nodeId.endsWith(":implement"))).toHaveLength(itemKeys.length);

    outputs.readiness = itemKeys.map((itemKey) => ({
      nodeId: `${itemKey}:ready`, iteration: 0, itemKey, ready: true, headSha, summary: "approved",
    }));
    frame = await render();
    expect(frame.tasks.some((task) => task.nodeId === "integration-bootstrap")).toBe(true);

    outputs.setup.push({
      nodeId: "integration-bootstrap", iteration: 0, itemKey: "__integration",
      cwd: "/tmp/integration", baseSha, ready: true, summary: "ready",
    });
    frame = await render();
    const integration = frame.tasks.find((task) => task.nodeId === "commit-all");
    expect(integration?.agent).toBeUndefined();
    expect(integration?.computeFn).toBeDefined();

    outputs.commits = [{
      nodeId: "commit-all", iteration: 0, committed: true, ready: true,
      baseSha, headSha, changedPaths: ["safe.ts"], reviewDiff: "diff --git a/safe.ts b/safe.ts",
      commits: [{ itemKey: "ci-postgres", subject: "fix", sha: headSha }], skipped: [], summary: "integrated",
    }];
    frame = await render();
    expect(frame.tasks.some((task) => task.nodeId === "local-gate")).toBe(true);

    outputs.gate = [{ nodeId: "local-gate", iteration: 0, headSha, passed: true, exitCode: 0, durationMs: 1, command: "pnpm typecheck && pnpm test", log: "", summary: "green" }];
    frame = await render();
    expect(frame.tasks.some((task) => task.nodeId === "fable-review")).toBe(true);

    outputs.finalReview = [{ nodeId: "fable-review", iteration: 0, headSha, approved: true, verdict: "safe", blockers: [], summary: "approved" }];
    frame = await render();
    const approval = frame.tasks.find((task) => task.nodeId === "approve-push");
    expect(approval?.needsApproval).toBe(true);
    expect(frame.tasks.some((task) => task.nodeId === "push")).toBe(false);

    outputs.approval = [{ nodeId: "approve-push", iteration: 0, approved: false, note: "manual", decidedBy: "test", decidedAt: new Date().toISOString() }];
    frame = await render();
    expect(frame.tasks.some((task) => task.nodeId === "push")).toBe(true);
  }, 30_000);
});
