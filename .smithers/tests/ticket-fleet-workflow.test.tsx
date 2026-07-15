/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { renderWorkflow, runTask, type RenderedWorkflow } from "smithers-orchestrator/testing";

setDefaultTimeout(60_000);
const source = join(import.meta.dir, "..", "workflows", "ticket-fleet.tsx");
type FleetModule = typeof import("../workflows/ticket-fleet.tsx");
type Outputs = Record<string, unknown[]>;
let importId = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function task(frame: RenderedWorkflow<any>, id: string) {
  const found = frame.tasks.find((item) => item.nodeId === id);
  expect(found, `mounted task ${id}`).toBeDefined();
  return found!;
}
function add(frame: RenderedWorkflow<any>, outputs: Outputs, id: string, value: Record<string, unknown>): Outputs {
  const mounted = task(frame, id);
  const parsed = mounted.outputSchema?.safeParse(value);
  expect(parsed?.success, `schema for ${id}`).toBe(true);
  return {
    ...outputs,
    [mounted.outputTableName]: [...(outputs[mounted.outputTableName] ?? []), {
      nodeId: id, iteration: mounted.iteration, iterationCount: mounted.iteration, ...(parsed?.data ?? value),
    }],
  };
}
const issue = (number: number) => ({ number, title: `Issue ${number}`, body: `Body for issue ${number}`, url: `https://example.test/issues/${number}`, labels: [], author: "tester" });
const triage = (number: number, needsHumanApproval = false) => ({
  issueNumber: number, difficulty: "easy", needsHumanApproval, approvalReason: needsHumanApproval ? "manual risk review" : "",
  needsResearch: false, researchKind: "none", rationale: "A focused implementation with bounded risk.",
});
const approval = () => ({ approved: true, note: null, decidedBy: "tester", decidedAt: "2026-07-14T12:00:00.000Z" });

type Fixture = { outer: string; repo: string; remote: string; runtime: string; mod: FleetModule };
function executable(path: string, sourceText: string): string {
  if (process.platform === "win32") {
    writeFileSync(`${path}.js`, `${sourceText}\n`);
    writeFileSync(`${path}.cmd`, `@echo off\r\n"${process.execPath}" "${path}.js" %*\r\n`);
    return `${path}.js`;
  }
  writeFileSync(path, `#!${process.execPath}\n${sourceText}\n`);
  chmodSync(path, 0o755);
  return path;
}
async function isolated<T>(body: (fixture: Fixture) => Promise<T>): Promise<T> {
  const outer = mkdtempSync(join(tmpdir(), "ticket-fleet-test-"));
  const repo = join(outer, "repo");
  const remote = join(outer, "remote.git");
  const runtime = join(outer, "runtime");
  const home = join(outer, "smithers-home");
  const oldCwd = process.cwd();
  const oldEnv = Object.fromEntries(["GIT_CONFIG_GLOBAL", "TMPDIR", "TMP", "TEMP", "SMITHERS_HOME", "PATH", "FAKE_GH_EXIT"].map((key) => [key, process.env[key]]));
  try {
    process.env.GIT_CONFIG_GLOBAL = devNull;
    process.env.TMPDIR = runtime;
    process.env.TMP = runtime;
    process.env.TEMP = runtime;
    process.env.SMITHERS_HOME = home;
    mkdirSync(runtime, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "accounts.json"), JSON.stringify({ accounts: [{ provider: "codex", configDir: join(home, "codex") }] }));
    const bin = join(outer, "bin");
    mkdirSync(bin, { recursive: true });
    const fakeGh = executable(join(bin, "gh"), "if (process.argv.includes('--probe')) process.stdout.write(process.argv[1]); else process.exit(Number(process.env.FAKE_GH_EXIT || 0));");
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    process.env.FAKE_GH_EXIT = "0";
    expect(realpathSync(execFileSync("gh", ["--probe"], { encoding: "utf8", env: process.env }).trim())).toBe(realpathSync(fakeGh));
    mkdirSync(repo, { recursive: true });
    git(outer, "init", "--bare", remote);
    git(repo, "init", "--initial-branch=main");
    git(repo, "config", "user.name", "Ticket Fleet Test");
    git(repo, "config", "user.email", "test@example.com");
    mkdirSync(join(repo, ".smithers", "tickets", "smithers"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "fixture\n");
    writeFileSync(join(repo, ".smithers", "tickets", "open.md"), "# Open ticket\n");
    writeFileSync(join(repo, ".smithers", "tickets", "smithers", "gh-8-test.md"), "GitHub: https://example.test/issues/8\n");
    git(repo, "add", "README.md", ".smithers/tickets");
    git(repo, "commit", "-m", "fixture");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    process.chdir(repo);
    const mod = await import(`${source}?ticket-fleet-test=${++importId}`) as FleetModule;
    return await body({ outer, repo, remote, runtime, mod });
  } finally {
    process.chdir(oldCwd);
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(outer, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function installGh(exitCode: number): void {
  process.env.FAKE_GH_EXIT = String(exitCode);
}
function agentSeat(frame: RenderedWorkflow<any>, id: string): { engine?: string; model?: string } {
  const configured = task(frame, id).agent;
  const first = (Array.isArray(configured) ? configured[0] : configured) as { cliEngine?: string; opts?: { model?: string } } | undefined;
  return { engine: first?.cliEngine, model: first?.opts?.model };
}

describe("ticket-fleet workflow", () => {
  test("import is lazy and schemas, explicit assignment, and exact-SHA CI verdicts are bounded", async () => isolated(async ({ mod, runtime }) => {
    expect(readdirSync(runtime)).toEqual([]);
    expect(mod.inputSchema.parse({})).toMatchObject({ repo: "smithersai/smithers", maxImplement: 50, maxTriage: 500, laneConcurrency: 24, reviewIterations: 4, dryRun: false });
    for (const raw of [{ maxImplement: 0 }, { maxTriage: 1001 }, { laneConcurrency: 65 }, { reviewIterations: 9 }]) {
      expect(mod.inputSchema.safeParse(raw).success).toBe(false);
    }
    expect(mod.parseInput({ solNumbers: "[7,3]", fableNumbers: "[5]", lunaNumbers: "[9]", skipSync: 1 })).toMatchObject({ issueNumbers: [7, 3, 5, 9], skipSync: true });
    const stale = mod.evaluateRemoteCiRows([
      { workflowName: "CI", headSha: "old", status: "completed", conclusion: "failure", url: "old" },
      { workflowName: "CI", headSha: "head", status: "completed", conclusion: "success", url: "new" },
    ], "head");
    expect(stale).toMatchObject({ healthy: true, checkedSha: "head", failing: [] });
    const current = mod.evaluateRemoteCiRows([{ workflowName: "CI", headSha: "head", status: "completed", conclusion: "failure", url: "current" }], "head");
    expect(current.healthy).toBe(false);
    expect(current.failing).toEqual([{ name: "CI", url: "current", conclusion: "failure" }]);
  }));

  test("dry-run sync and triage preserve refs, tickets, done state, and the triage ledger", async () => isolated(async ({ mod, repo }) => {
    const input = { repo: "owner/repo", dryRun: true, skipCiLane: true, issueNumbers: [2, 1], maxImplement: 2 };
    const before = git(repo, "rev-parse", "refs/heads/main");
    let frame = await renderWorkflow(mod.default, { input, workflowPath: source });
    let outputs = add(frame, {}, "local-scan", { tickets: [{ ticketPath: "open.md", slug: "open", title: "Open", linkedIssue: 0, isEpicDir: false, body: "open body" }], summary: "one" });
    outputs = add(frame, outputs, "gh-scan", { issues: [], summary: "none" });
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    outputs = add(frame, outputs, "t:open:verdict", { ticketPath: "open.md", completed: true, evidence: "Implemented and verified on main.", isMeta: false, subTickets: [], mirrorTitle: "", mirrorBody: "" });
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    const synced = await runTask(task(frame, "sync-apply")) as Record<string, unknown>;
    expect(synced).toMatchObject({ closedLocal: 1, commitSha: "", pushed: false });
    outputs = add(frame, outputs, "sync-apply", synced);
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    outputs = add(frame, outputs, "triage-scan", { issues: [issue(1), issue(2)], summary: "two" });
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    outputs = add(frame, outputs, "i1:triage", triage(1));
    outputs = add(frame, outputs, "i2:triage", triage(2));
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    const applied = await runTask(task(frame, "triage-apply")) as { selectedNumbers: number[] };
    expect(applied.selectedNumbers).toEqual([2, 1]);
    expect(git(repo, "rev-parse", "refs/heads/main")).toBe(before);
    expect(existsSync(join(repo, ".smithers/tickets/open.md"))).toBe(true);
    expect(existsSync(join(repo, ".smithers/tickets/.done"))).toBe(false);
    expect(existsSync(join(repo, ".smithers/executions/ticket-fleet/triage-ledger.json"))).toBe(false);
  }));

  test("unlanded merges never close issues", async () => isolated(async ({ mod, repo }) => {
    const headSha = git(repo, "rev-parse", "refs/heads/main");
    const input = mod.parseInput({ repo: "owner/repo" });
    const unpushed = { issueNumber: 7, merged: true, pushed: false, baseSha: headSha, headSha, remoteSha: "", summary: "not pushed" };
    const skipped = await mod.closeAfterLanding(input, issue(7), unpushed, []);
    expect(skipped).toMatchObject({ closed: false, ticketMoved: false });
    expect(skipped.summary).toContain("landing or push incomplete");
    expect(git(repo, "rev-parse", "refs/heads/main")).toBe(headSha);
  }));

  test("GitHub-close failures stay truthful: only a verified CLOSED state counts", async () => isolated(async (fixture) => {
    const { mod, repo } = fixture;
    const headSha = git(repo, "rev-parse", "refs/heads/main");
    const input = mod.parseInput({ repo: "owner/repo" });
    const merge = { issueNumber: 9, merged: true, pushed: true, baseSha: headSha, headSha, remoteSha: headSha, summary: "landed" };
    installGh(1);
    const closeFailed = await mod.closeAfterLanding(input, issue(9), merge, []);
    expect(closeFailed).toMatchObject({ closed: false, ticketMoved: false });
    expect(closeFailed.summary).toContain("Issue remains open");
  }));

  test("routing is cross-reviewed and approvals feed the merge train", async () => isolated(async ({ mod, repo }) => {
    const splitInput = { repo: "owner/repo", dryRun: true, skipSync: true, skipCiLane: true, solNumbers: [31], fableNumbers: [32], lunaNumbers: [33], reviewIterations: 1 };
    let frame = await renderWorkflow(mod.default, { input: splitInput, workflowPath: source });
    let outputs = add(frame, {}, "triage-scan", { issues: [issue(31), issue(32), issue(33)], summary: "assigned" });
    frame = await renderWorkflow(mod.default, { input: splitInput, outputs, workflowPath: source });
    for (const n of [31, 32, 33]) outputs = add(frame, outputs, `i${n}:bootstrap`, { issueNumber: n, cwd: `/tmp/i${n}`, baseSha: "base", ready: true, summary: "ready" });
    frame = await renderWorkflow(mod.default, { input: splitInput, outputs, workflowPath: source });
    expect(agentSeat(frame, "i31:implement")).toEqual({ engine: "codex", model: "gpt-5.6-sol" });
    expect(agentSeat(frame, "i32:implement")).toEqual({ engine: "claude-code", model: "claude-fable-5" });
    expect(agentSeat(frame, "i33:implement")).toEqual({ engine: "codex", model: "gpt-5.6-luna" });
    for (const n of [31, 32, 33]) {
      outputs = add(frame, outputs, `i${n}:implement`, { issueNumber: n, status: "implemented", summary: "Implementation completed successfully.", filesChanged: ["feature.ts"], testsChanged: ["feature.test.ts"] });
      outputs = add(frame, outputs, `i${n}:candidate`, { issueNumber: n, baseSha: "base", headSha: `head-${n}`, patchId: `patch-${n}`, changedPaths: ["feature.ts"], reviewDiff: "diff", ready: true, summary: "ready" });
    }
    frame = await renderWorkflow(mod.default, { input: splitInput, outputs, workflowPath: source });
    expect(agentSeat(frame, "i31:review")).toEqual({ engine: "claude-code", model: "claude-fable-5" });
    expect(agentSeat(frame, "i32:review")).toEqual({ engine: "codex", model: "gpt-5.6-sol" });
    expect(agentSeat(frame, "i33:review")).toEqual({ engine: "codex", model: "gpt-5.6-sol" });

    const input = { repo: "owner/repo", dryRun: true, skipSync: true, skipCiLane: true, issueNumbers: [42, 41], maxImplement: 2, reviewIterations: 1 };
    frame = await renderWorkflow(mod.default, { input, workflowPath: source });
    outputs = add(frame, {}, "triage-scan", { issues: [issue(41), issue(42)], summary: "two" });
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    outputs = add(frame, outputs, "i41:triage", triage(41, true));
    outputs = add(frame, outputs, "i42:triage", triage(42, true));
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    outputs = add(frame, outputs, "triage-apply", await runTask(task(frame, "triage-apply")) as Record<string, unknown>);
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    for (const n of [42, 41]) outputs = add(frame, outputs, `i${n}:bootstrap`, { issueNumber: n, cwd: `/tmp/i${n}`, baseSha: "base", ready: true, summary: "ready" });
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    for (const n of [42, 41]) {
      expect(task(frame, `i${n}:plan-approval`).needsApproval).toBe(true);
      outputs = add(frame, outputs, `i${n}:plan-approval`, approval());
      outputs = add(frame, outputs, `i${n}:ready`, { issueNumber: n, ready: true, headSha: `candidate-${n}`, summary: "ready" });
    }
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    for (const n of [42, 41]) {
      expect(task(frame, `i${n}:merge-approval`).needsApproval).toBe(true);
      outputs = add(frame, outputs, `i${n}:merge-approval`, approval());
    }
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    expect(frame.tasks.some((item) => item.nodeId.startsWith("i42:queue-"))).toBe(false);
    expect(task(frame, "train:snapshot").nodeId).toBe("train:snapshot");
    outputs = add(frame, outputs, "train:snapshot", { round: 0, entries: [{ issueNumber: 42, fixSha: "candidate-42" }, { issueNumber: 41, fixSha: "candidate-41" }], skipped: [], adopted: [], strikes: [], summary: "boarded 2" });
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    expect(task(frame, "train:stack").nodeId).toBe("train:stack");
    outputs = add(frame, outputs, "train:stack", { round: 0, baseSha: "base", stacked: [{ issueNumber: 42, fixSha: "candidate-42", stackedSha: "stack-42" }, { issueNumber: 41, fixSha: "candidate-41", stackedSha: "stack-41" }], evicted: [], summary: "stacked 2" });
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    expect(frame.tasks.filter((item) => item.nodeId.startsWith("train:gate:")).map((item) => item.nodeId).sort()).toEqual(["train:gate:41", "train:gate:42"]);
    outputs = add(frame, outputs, "train:gate:42", { issueNumber: 42, phase: "train", headSha: "stack-42", passed: true, exitCode: 0, durationMs: 1, command: "true", log: "", summary: "green" });
    outputs = add(frame, outputs, "train:gate:41", { issueNumber: 41, phase: "train", headSha: "stack-41", passed: true, exitCode: 0, durationMs: 1, command: "true", log: "", summary: "green" });
    frame = await renderWorkflow(mod.default, { input, outputs, workflowPath: source });
    const before = git(repo, "rev-parse", "refs/heads/main");
    const land = await runTask(task(frame, "train:land")) as Record<string, unknown>;
    expect(land).toMatchObject({ pushed: false, landedIssues: [42, 41] });
    expect(git(repo, "rev-parse", "refs/heads/main")).toBe(before);
  }));
});
