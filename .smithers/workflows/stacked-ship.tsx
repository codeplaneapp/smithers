// smithers-source: authored
// smithers-display-name: Stacked Ship
/** @jsxImportSource smithers-orchestrator */
import { Approval, ClaudeCodeAgent, Loop, Parallel, Sequence, UI, approvalDecisionSchema, createSmithers } from "smithers-orchestrator";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";
import {
  type CheckResult,
  type PrPlanEntry,
  type StackPlan,
  artifactFileName,
  baseBookmarkFor,
  bookmarkFor,
  classifyDecision,
  cloneCommands,
  countLogLines,
  decisionNote,
  hygieneVerdict,
  lanePhase,
  laneWorkspaceCommands,
  parentRevFor,
  parseStackPlan,
  parseSummaryPaths,
  planFromRow,
  reportsDirFor,
  stackKeyFromRunId,
  workspaceNameFor,
} from "../lib/stackedShip";
import {
  type StackIndexRow,
  fallbackStory,
  normalizeStory,
  renderPrArtifactHtml,
  renderStackIndexHtml,
  splitUnifiedDiff,
} from "../lib/stackArtifact";

/**
 * Stacked Ship: build a large mission as a linear jj stack of clean PRs with
 * non-blocking human review. One jj change per PR, amended in place; async
 * approvals; denials trigger rework rebases; every revision ships a
 * story-form HTML artifact. Spec: .smithers/specs/stacked-ship-workflow.md
 *
 * First mission: build Smithers Studio (the open-source local electrobun app)
 * per .smithers/specs/smithers-studio-local-app.md.
 *
 * VCS: all stack state lives in a private clone under
 * .smithers/workflows/.worktrees/stacked-ship-<key>/repo with one jj
 * workspace per PR lane. Nothing here ever touches the shared checkout's
 * index, and origin is only touched by the explicitly gated push step.
 */

const repoRoot = (() => {
  try {
    return join(fileURLToPath(import.meta.url), "..", "..", "..");
  } catch {
    return process.cwd();
  }
})();

// ── Schemas ──────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  specPath: z.string().default(".smithers/specs/smithers-studio-local-app.md"),
  planJson: z.string().default(""),
  maxPrs: z.number().int().min(1).max(16).default(10),
  buildIterations: z.number().int().min(1).max(6).default(3),
  reviewRounds: z.number().int().min(1).max(8).default(4),
  laneConcurrency: z.number().int().min(1).max(4).default(2),
  push: z.boolean().default(false),
  createPrs: z.boolean().default(false),
});
type Input = z.infer<typeof inputSchema>;

const setupSchema = z.object({
  ready: z.boolean(),
  stackRoot: z.string().min(2),
  baseSha: z.string().default(""),
  originUrl: z.string().default(""),
  summary: z.string().min(2),
});
type Setup = z.infer<typeof setupSchema>;

const planEntryOut = z.object({
  slug: z.string().min(2),
  title: z.string().min(8),
  goal: z.string().min(20),
  scopes: z.array(z.string()).min(1),
  checks: z.array(z.string()).default([]),
  storyHint: z.string().default(""),
});

const planSchema = z.object({
  missionTitle: z.string().min(4),
  assembleChecks: z.array(z.string()).default([]),
  entries: z.array(planEntryOut).min(1),
  summary: z.string().min(10),
});

const laneSchema = z.object({
  laneSlug: z.string().min(2),
  ready: z.boolean(),
  workspaceDir: z.string().min(2),
  bookmark: z.string().min(2),
  summary: z.string().min(2),
});
type Lane = z.infer<typeof laneSchema>;

const implementSchema = z.object({
  laneSlug: z.string().min(2),
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).default([]),
});
type Implement = z.infer<typeof implementSchema>;

const gateSchema = z.object({
  gateKey: z.string().min(2),
  ok: z.boolean(),
  reasonsJson: z.string().default("[]"),
  feedback: z.string().default(""),
  description: z.string().default(""),
  changedPathsJson: z.string().default("[]"),
  summary: z.string().min(2),
});
type Gate = z.infer<typeof gateSchema>;

const reviewSchema = z.object({
  laneSlug: z.string().min(2),
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string().min(10),
});
type Review = z.infer<typeof reviewSchema>;

const storySchema = z.object({
  laneSlug: z.string().min(2),
  headline: z.string().min(8),
  synopsis: z.string().min(20),
  chapters: z
    .array(z.object({ title: z.string().min(3), prose: z.string().min(10), diffPaths: z.array(z.string()).default([]) }))
    .min(1),
});
type Story = z.infer<typeof storySchema>;

const artifactSchema = z.object({
  laneSlug: z.string().min(2),
  artifactPath: z.string().min(4),
  revision: z.number().int(),
  headline: z.string().default(""),
  summary: z.string().min(2),
});
type Artifact = z.infer<typeof artifactSchema>;

const reworkSchema = z.object({
  laneSlug: z.string().min(2),
  status: z.enum(["reworked", "partial", "blocked"]),
  summary: z.string().min(20),
});

const finalSchema = z.object({
  status: z.enum(["clean", "polished", "blocked"]),
  summary: z.string().min(20),
});

const pushSchema = z.object({
  pushed: z.boolean(),
  branchesJson: z.string().default("[]"),
  prUrlsJson: z.string().default("[]"),
  summary: z.string().min(2),
});
type Push = z.infer<typeof pushSchema>;

const summarySchema = z.object({
  lanesTotal: z.number().int(),
  lanesGreen: z.number().int(),
  lanesApproved: z.number().int(),
  assembleOk: z.boolean(),
  pushed: z.boolean(),
  detailsJson: z.string().min(2),
  summary: z.string().min(2),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  stshipSetup: setupSchema,
  stshipPlan: planSchema,
  stshipLane: laneSchema,
  stshipImplement: implementSchema,
  stshipGate: gateSchema,
  stshipReview: reviewSchema,
  stshipStory: storySchema,
  stshipArtifact: artifactSchema,
  stshipDecision: approvalDecisionSchema,
  stshipRework: reworkSchema,
  stshipFinal: finalSchema,
  stshipPush: pushSchema,
  stshipSummary: summarySchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────

function solChain(cwd: string) {
  return codexFirst(
    {
      model: "gpt-5.6-sol",
      config: { model_reasoning_effort: "high" },
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      cwd,
    },
    [new ClaudeCodeAgent({ model: "claude-fable-5", cwd })],
  );
}

function opusChain(cwd: string) {
  return [new ClaudeCodeAgent({ model: "claude-opus-5", cwd }), new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd })];
}

function fableChain(cwd: string) {
  return [
    new ClaudeCodeAgent({ model: "claude-fable-5", cwd }),
    ...codexFirst({
      model: "gpt-5.6-sol",
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      cwd,
    }),
  ];
}

function storyChain(cwd: string) {
  return [new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd }), new ClaudeCodeAgent({ model: "claude-haiku-4-5", cwd })];
}

const AGENT_RETRIES = 2;
const HEARTBEAT_MS = 10 * 60_000;
const SETUP_TIMEOUT_MS = 60 * 60_000;
const LANE_SETUP_TIMEOUT_MS = 60 * 60_000;
const IMPLEMENT_TIMEOUT_MS = 60 * 60_000;
const HYGIENE_TIMEOUT_MS = 45 * 60_000;
const REVIEW_TIMEOUT_MS = 35 * 60_000;
const STORY_TIMEOUT_MS = 20 * 60_000;
const ARTIFACT_TIMEOUT_MS = 10 * 60_000;
const ASSEMBLE_TIMEOUT_MS = 90 * 60_000;
const PUSH_TIMEOUT_MS = 20 * 60_000;

// ── Process helpers ──────────────────────────────────────────────────────────

type ProcessResult = { exitCode: number; stdout: string; stderr: string };

function resolveJj(): string {
  try {
    // Bundled binary via @smithers-orchestrator/vcs when PATH has no jj.
    const localRequire = createRequire(import.meta.url);
    const vcs = localRequire("@smithers-orchestrator/vcs") as {
      resolveJjBinary: () => { path: string } | null;
    };
    return vcs.resolveJjBinary()?.path ?? "jj";
  } catch {
    return "jj";
  }
}
const JJ_BIN = resolveJj();

function execTool(command: string, args: string[], cwd: string): string {
  return execFileSync(command === "jj" ? JJ_BIN : command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function jj(args: string[], cwd: string): string {
  return execTool("jj", args, cwd);
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += String(error);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      stderr += "\nTimed out after " + timeoutMs + "ms";
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      finish(124);
    }, timeoutMs);
    timer.unref();
  });
}

function stackRootFor(key: string): string {
  return join(repoRoot, ".smithers", "workflows", ".worktrees", "stacked-ship-" + key, "repo");
}

function laneDirFor(key: string, slug: string): string {
  return join(repoRoot, ".smithers", "workflows", ".worktrees", "stacked-ship-" + key, workspaceNameFor(slug));
}

// ── Compute implementations (exported for tests) ─────────────────────────────

export async function setupStack(key: string): Promise<Setup> {
  const stackRoot = stackRootFor(key);
  let originUrl = "";
  try {
    originUrl = execTool("git", ["remote", "get-url", "origin"], repoRoot);
  } catch {}
  try {
    if (!existsSync(stackRoot)) {
      mkdirSync(join(stackRoot, ".."), { recursive: true });
      for (const argv of cloneCommands({ sourceRoot: repoRoot, originUrl, destDir: stackRoot })) {
        execTool(argv[0], argv.slice(1), repoRoot);
      }
    }
    if (!existsSync(join(stackRoot, ".jj"))) {
      jj(["git", "init", "--colocate"], stackRoot);
    }
    const baseSha = execTool("git", ["rev-parse", "HEAD"], stackRoot);
    jj(["bookmark", "set", baseBookmarkFor(key), "-r", baseSha, "--allow-backwards"], stackRoot);
    return {
      ready: true,
      stackRoot,
      baseSha,
      originUrl,
      summary: "stack clone ready at " + stackRoot + " (base " + baseSha.slice(0, 12) + ")",
    };
  } catch (error) {
    return { ready: false, stackRoot, baseSha: "", originUrl, summary: "setup failed: " + String(error).slice(0, 2_000) };
  }
}

export async function createLane(key: string, entry: PrPlanEntry, parentRev: string): Promise<Lane> {
  const stackRoot = stackRootFor(key);
  const workspaceDir = laneDirFor(key, entry.slug);
  const bookmark = bookmarkFor(key, entry.slug);
  try {
    if (!existsSync(workspaceDir)) {
      const steps = laneWorkspaceCommands({ slug: entry.slug, parentRev, bookmark, workspaceDir });
      for (const step of steps) {
        const cwd = step.cwd === "root" ? stackRoot : workspaceDir;
        let attempt = 0;
        for (;;) {
          try {
            execTool(step.argv[0], step.argv.slice(1), cwd);
            break;
          } catch (error) {
            attempt += 1;
            const text = String(error);
            const lockRace = /index\.lock|packed-refs\.lock|lock/i.test(text);
            if (!lockRace || attempt >= 4) throw error;
            await new Promise((tick) => setTimeout(tick, 250 * attempt));
          }
        }
      }
    }
    const install = await runProcess("pnpm", ["install", "--no-frozen-lockfile"], workspaceDir, 45 * 60_000);
    const installNote = install.exitCode === 0 ? "install ok" : "install exit " + install.exitCode + " (agent may need to install)";
    return { laneSlug: entry.slug, ready: true, workspaceDir, bookmark, summary: "workspace ready (" + installNote + ")" };
  } catch (error) {
    return {
      laneSlug: entry.slug,
      ready: false,
      workspaceDir,
      bookmark,
      summary: "workspace failed: " + String(error).slice(0, 2_000),
    };
  }
}

function tryConflictCount(stackRoot: string, bookmark: string): number {
  for (const fn of ["conflicts()", "conflict()"]) {
    try {
      const out = jj(
        ["log", "-r", "descendants(" + bookmark + ") & " + fn, "--no-graph", "-T", 'change_id ++ "\\n"'],
        stackRoot,
      );
      return countLogLines(out);
    } catch {}
  }
  return 0;
}

export async function runHygiene(options: {
  key: string;
  entry: PrPlanEntry;
  parentRev: string;
  gateKey: string;
}): Promise<Gate> {
  const stackRoot = stackRootFor(options.key);
  const workspaceDir = laneDirFor(options.key, options.entry.slug);
  const bookmark = bookmarkFor(options.key, options.entry.slug);
  try {
    const changeCount = countLogLines(
      jj(["log", "-r", options.parentRev + ".." + bookmark, "--no-graph", "-T", 'change_id ++ "\\n"'], stackRoot),
    );
    let description = "";
    try {
      description = jj(["log", "-r", bookmark, "--no-graph", "-T", "description"], stackRoot);
    } catch {}
    const changedPaths = parseSummaryPaths(
      jj(["diff", "--from", options.parentRev, "--to", bookmark, "--summary"], stackRoot),
    );
    const conflictedCount = tryConflictCount(stackRoot, bookmark);
    const checks: CheckResult[] = [];
    for (const command of options.entry.checks) {
      const result = await runProcess("bash", ["-lc", command], workspaceDir, 30 * 60_000);
      checks.push({
        command,
        exitCode: result.exitCode,
        tail: (result.stderr + "\n" + result.stdout).slice(-4_000),
      });
    }
    const verdict = hygieneVerdict({
      changeCount,
      description,
      changedPaths,
      scopes: options.entry.scopes,
      conflictedCount,
      checks,
    });
    return {
      gateKey: options.gateKey,
      ok: verdict.ok,
      reasonsJson: JSON.stringify(verdict.reasons),
      feedback: verdict.feedback,
      description,
      changedPathsJson: JSON.stringify(changedPaths),
      summary: verdict.ok
        ? "clean: 1 change, " + changedPaths.length + " file(s), checks green"
        : "failing: " + verdict.reasons.length + " issue(s): " + verdict.reasons[0]?.slice(0, 160),
    };
  } catch (error) {
    return {
      gateKey: options.gateKey,
      ok: false,
      reasonsJson: JSON.stringify(["hygiene crashed: " + String(error).slice(0, 500)]),
      feedback: "HYGIENE FAILURES:\n- hygiene crashed: " + String(error).slice(0, 500),
      description: "",
      changedPathsJson: "[]",
      summary: "hygiene crashed: " + String(error).slice(0, 200),
    };
  }
}

export async function buildLaneArtifact(options: {
  key: string;
  entry: PrPlanEntry;
  parentRev: string;
  missionTitle: string;
  revision: number;
  storyRow: Story | undefined;
  gateRow: Gate | undefined;
  decisionState: string;
  indexRows: StackIndexRow[];
}): Promise<Artifact> {
  const stackRoot = stackRootFor(options.key);
  const bookmark = bookmarkFor(options.key, options.entry.slug);
  const reportsDir = reportsDirFor(repoRoot, options.key);
  try {
    const diffText = jj(["diff", "--from", options.parentRev, "--to", bookmark, "--git"], stackRoot);
    const availablePaths = splitUnifiedDiff(diffText).map((file) => file.path);
    const story =
      normalizeStory(
        options.storyRow
          ? { headline: options.storyRow.headline, synopsis: options.storyRow.synopsis, chapters: options.storyRow.chapters }
          : null,
        availablePaths,
      ) ?? fallbackStory({ slug: options.entry.slug, title: options.entry.title, changedPaths: availablePaths });
    const reasons: string[] = (() => {
      try {
        const parsed = JSON.parse(options.gateRow?.reasonsJson ?? "[]");
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    })();
    const html = await renderPrArtifactHtml({
      missionTitle: options.missionTitle,
      stackKey: options.key,
      slug: options.entry.slug,
      title: options.entry.title,
      revision: options.revision,
      story,
      diffText,
      hygiene: { ok: options.gateRow?.ok === true, reasons },
      checks: [],
      approvalState: options.decisionState,
      generatedAt: new Date().toISOString(),
    });
    mkdirSync(reportsDir, { recursive: true });
    const artifactPath = join(reportsDir, artifactFileName(options.entry.slug, options.revision));
    writeFileSync(artifactPath, html);
    const selfRow: StackIndexRow = {
      slug: options.entry.slug,
      title: options.entry.title,
      revision: options.revision,
      phase: options.decisionState,
      headline: story.headline,
    };
    const rows =
      options.indexRows.length > 0
        ? options.indexRows.map((row) => (row.slug === options.entry.slug ? selfRow : row))
        : [selfRow];
    writeFileSync(
      join(reportsDir, "index.html"),
      renderStackIndexHtml({
        missionTitle: options.missionTitle,
        stackKey: options.key,
        generatedAt: new Date().toISOString(),
        rows,
      }),
    );
    return {
      laneSlug: options.entry.slug,
      artifactPath,
      revision: options.revision,
      headline: story.headline,
      summary: "artifact r" + options.revision + " at " + artifactPath,
    };
  } catch (error) {
    return {
      laneSlug: options.entry.slug,
      artifactPath: join(reportsDir, artifactFileName(options.entry.slug, options.revision)),
      revision: options.revision,
      headline: "",
      summary: "artifact failed: " + String(error).slice(0, 1_000),
    };
  }
}

export async function runAssemble(options: { key: string; plan: StackPlan }): Promise<Gate> {
  const stackRoot = stackRootFor(options.key);
  const entries = options.plan.entries;
  const topSlug = entries[entries.length - 1].slug;
  const topWorkspace = laneDirFor(options.key, topSlug);
  const topBookmark = bookmarkFor(options.key, topSlug);
  const reasons: string[] = [];
  try {
    const changeCount = countLogLines(
      jj(["log", "-r", baseBookmarkFor(options.key) + ".." + topBookmark, "--no-graph", "-T", 'change_id ++ "\\n"'], stackRoot),
    );
    if (changeCount !== entries.length) {
      reasons.push("stack is not linear: expected " + entries.length + " changes base..top, found " + changeCount);
    }
    const checks: CheckResult[] = [];
    for (const command of options.plan.assembleChecks) {
      const result = await runProcess("bash", ["-lc", command], topWorkspace, 45 * 60_000);
      checks.push({ command, exitCode: result.exitCode, tail: (result.stderr + "\n" + result.stdout).slice(-4_000) });
      if (result.exitCode !== 0) {
        reasons.push("assemble check failed (exit " + result.exitCode + "): " + command);
      }
    }
    return {
      gateKey: "assemble",
      ok: reasons.length === 0,
      reasonsJson: JSON.stringify(reasons),
      feedback: reasons.length === 0 ? "" : "ASSEMBLE FAILURES:\n- " + reasons.join("\n- "),
      description: "",
      changedPathsJson: "[]",
      summary: reasons.length === 0 ? "stack linear (" + changeCount + " changes), assemble checks green" : reasons[0],
    };
  } catch (error) {
    return {
      gateKey: "assemble",
      ok: false,
      reasonsJson: JSON.stringify(["assemble crashed: " + String(error).slice(0, 500)]),
      feedback: "assemble crashed",
      description: "",
      changedPathsJson: "[]",
      summary: "assemble crashed: " + String(error).slice(0, 200),
    };
  }
}

export async function runPush(options: {
  key: string;
  plan: StackPlan;
  wantPush: boolean;
  createPrs: boolean;
  assembleOk: boolean;
  approvedSlugs: string[];
}): Promise<Push> {
  const stackRoot = stackRootFor(options.key);
  const entries = options.plan.entries;
  if (!options.wantPush) {
    return { pushed: false, branchesJson: "[]", prUrlsJson: "[]", summary: "push disabled by input; bookmarks stay local." };
  }
  if (!options.assembleOk) {
    return { pushed: false, branchesJson: "[]", prUrlsJson: "[]", summary: "assemble gate not green; refusing to push." };
  }
  const unapproved = entries.filter((entry) => !options.approvedSlugs.includes(entry.slug));
  if (unapproved.length > 0) {
    return {
      pushed: false,
      branchesJson: "[]",
      prUrlsJson: "[]",
      summary: "not all PRs approved (" + unapproved.map((entry) => entry.slug).join(", ") + "); refusing to push.",
    };
  }
  const branches: string[] = [];
  const prUrls: string[] = [];
  try {
    for (const entry of entries) {
      const bookmark = bookmarkFor(options.key, entry.slug);
      jj(["git", "push", "--bookmark", bookmark, "--allow-new", "--remote", "origin"], stackRoot);
      branches.push(bookmark);
    }
    if (options.createPrs) {
      let defaultBranch = "main";
      try {
        const head = execTool("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], stackRoot);
        defaultBranch = head.split("/").pop() || "main";
      } catch {}
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const head = bookmarkFor(options.key, entry.slug);
        const base = index === 0 ? defaultBranch : bookmarkFor(options.key, entries[index - 1].slug);
        try {
          const url = execTool(
            "gh",
            [
              "pr",
              "create",
              "--head",
              head,
              "--base",
              base,
              "--title",
              entry.title,
              "--body",
              "Stacked PR " + (index + 1) + "/" + entries.length + " from stacked-ship run " + options.key +
                ". Review artifact: .smithers/reports/stacked-ship/" + options.key + "/" + artifactFileName(entry.slug, 1) +
                "\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
            ],
            stackRoot,
          );
          prUrls.push(url.split("\n").pop() ?? "");
        } catch (error) {
          prUrls.push("pr-create-failed(" + entry.slug + "): " + String(error).slice(0, 200));
        }
      }
    }
    return {
      pushed: true,
      branchesJson: JSON.stringify(branches),
      prUrlsJson: JSON.stringify(prUrls),
      summary: "pushed " + branches.length + " stack branch(es)" + (prUrls.length ? "; " + prUrls.length + " PR(s)" : "") + ".",
    };
  } catch (error) {
    return {
      pushed: false,
      branchesJson: JSON.stringify(branches),
      prUrlsJson: JSON.stringify(prUrls),
      summary: "push failed: " + String(error).slice(0, 1_000),
    };
  }
}

// ── Input parsing ────────────────────────────────────────────────────────────

export function parseInput(raw: unknown): Input {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const asBool = (value: unknown, fallback: boolean) =>
    typeof value === "boolean" ? value : typeof value === "string" ? !["0", "false", "off", "no", ""].includes(value.toLowerCase()) : fallback;
  const asNum = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const asStr = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  return {
    specPath: asStr(record.specPath, ".smithers/specs/smithers-studio-local-app.md"),
    planJson: typeof record.planJson === "string" ? record.planJson : "",
    maxPrs: asNum(record.maxPrs, 10, 1, 16),
    buildIterations: asNum(record.buildIterations, 3, 1, 6),
    reviewRounds: asNum(record.reviewRounds, 4, 1, 8),
    laneConcurrency: asNum(record.laneConcurrency, 2, 1, 4),
    push: asBool(record.push, false),
    createPrs: asBool(record.createPrs, false),
  };
}

// ── Prompts (exported for needle tests) ──────────────────────────────────────

export function planPrompt(specPath: string, maxPrs: number): string {
  return [
    "You are the PLANNER for a stacked-ship run in the smithers repo (" + repoRoot + ").",
    "Read the mission spec at " + specPath + " (relative to the repo root) in full. It contains a PR stack plan",
    "section; refine it against the CURRENT tree (check what already exists) rather than restating it blindly.",
    "",
    "Produce the build plan as JSON matching your output schema:",
    "- missionTitle: short name of the mission.",
    "- assembleChecks: shell commands that verify the WHOLE stack at its tip (run from the top lane workspace),",
    "  e.g. scoped typecheck/lint/test commands. Keep them fast and deterministic.",
    "- entries: an ordered list (bottom of the stack first) of at most " + maxPrs + " PRs, each with:",
    "  - slug: stable kebab-case id (this names the jj bookmark; never rename between runs)",
    "  - title: the future commit subject (imperative, concrete)",
    "  - goal: 3-10 sentences a strong implementer can execute without asking questions; name files and contracts",
    "  - scopes: path prefixes the PR may touch (e.g. apps/studio, docs). Keep them tight.",
    "  - checks: shell commands that gate THIS PR from its lane workspace (scoped tests/typecheck). They must",
    "    exit zero when the PR is healthy and are run verbatim with bash -lc.",
    "  - storyHint: one sentence steering the artifact narrator.",
    "Order the entries so each PR builds strictly on the previous ones (a linear stack).",
    "Do not invent PRs beyond the mission; merge or drop spec PRs that are already implemented in the tree.",
    "Report a one-paragraph summary of your reasoning in the summary field.",
  ].join("\n");
}

export function implementPrompt(options: {
  entry: PrPlanEntry;
  index: number;
  total: number;
  missionTitle: string;
  specPath: string;
  parentRev: string;
  bookmark: string;
  reviewFeedback: string;
  hygieneFeedback: string;
}): string {
  const { entry } = options;
  return [
    "You are the IMPLEMENTER of PR " + (options.index + 1) + "/" + options.total + " ('" + entry.slug + "') of the",
    "mission '" + options.missionTitle + "' (spec: " + options.specPath + ", read it for context).",
    "Your working directory is a dedicated jj workspace of a private stack clone. THE WORKING COPY IS THE PR.",
    "Lane bookmark: " + options.bookmark + " (parent: " + options.parentRev + ").",
    "",
    "GOAL:",
    entry.goal,
    "",
    "HARD VCS CONTRACT (jj, colocated with git; NEVER use git commands that write):",
    "1. This lane is exactly ONE jj change, forever. jj auto-snapshots your edits into it.",
    "2. Set its message with: jj describe -m '<emoji> <type>(<scope>): <subject>' (repo commit style).",
    "3. NEVER run jj new, jj commit, git commit, git rebase, or git checkout. Amending is automatic.",
    "4. Descendant PRs auto-rebase when you amend; if jj mentions conflicts in descendants, ignore them",
    "   (their owner resolves them). Conflicts in YOUR change must be resolved by you (jj resolve).",
    "5. Only touch paths under: " + entry.scopes.join(", ") + ".",
    "6. Install dependencies fresh in THIS workspace if needed (pnpm install); never symlink from elsewhere.",
    "",
    options.reviewFeedback ? "SELF-REVIEW FEEDBACK ON YOUR PREVIOUS REVISION (address every point):\n" + options.reviewFeedback + "\n" : "",
    options.hygieneFeedback ? "MECHANICAL GATE FAILURES ON YOUR PREVIOUS REVISION (fix all):\n" + options.hygieneFeedback + "\n" : "",
    "QUALITY BAR:",
    "- Real, working code with tests; the gate commands below must pass in this workspace before you finish:",
    entry.checks.length ? entry.checks.map((command) => "  $ " + command).join("\n") : "  (no scoped checks declared; run the tests you add)",
    "- Match the surrounding code style; docs-driven where the spec demands it; no drive-by refactors.",
    "Report status implemented/partial/blocked, a summary of what you built and why, and files changed.",
  ].join("\n");
}

export function selfReviewPrompt(options: {
  entry: PrPlanEntry;
  parentRev: string;
  bookmark: string;
  implement: Implement | undefined;
  gate: Gate | undefined;
}): string {
  return [
    "You are the independent REVIEWER for PR '" + options.entry.slug + "' in this jj workspace.",
    "Implementer's report: " + (options.implement ? options.implement.status + " - " + options.implement.summary : "none") + ".",
    "Mechanical gate: " + (options.gate ? (options.gate.ok ? "GREEN" : "RED:\n" + options.gate.feedback.slice(0, 2_000)) : "not yet run") + ".",
    "",
    "REVIEW CONTRACT:",
    "1. Judge the DIFF, not the report: jj diff --from " + options.parentRev + " --to " + options.bookmark + " --git",
    "2. Verify the PR does exactly its goal (" + options.entry.title + "), nothing more, nothing less.",
    "3. Re-run at least one of the lane's check commands yourself.",
    "4. Reject for: failing checks, scope creep, missing tests, style mismatch, or an unclear commit message.",
    "Verdict 'approve' only if you would ship this as-is; otherwise 'reject' with concrete file:line feedback.",
  ].join("\n");
}

export function storyPrompt(options: { entry: PrPlanEntry; parentRev: string; bookmark: string }): string {
  return [
    "You are the NARRATOR for PR '" + options.entry.slug + "'. Read the diff in this workspace:",
    "jj diff --from " + options.parentRev + " --to " + options.bookmark + " --git",
    options.entry.storyHint ? "Steer: " + options.entry.storyHint : "",
    "",
    "Write the review story for a busy human reviewer:",
    "- headline: one punchy sentence naming what shipped.",
    "- synopsis: one paragraph (markdown) explaining what changed, why, and what to scrutinize.",
    "- chapters: 2-6 sections that walk the reviewer through the change in READING order (not file order).",
    "  Each chapter has a title, markdown prose telling the story of that part, and diffPaths listing the",
    "  exact file paths (as they appear in the diff) that chapter discusses.",
    "Be specific and truthful; the prose sits next to the rendered diffs, so never describe code that is not there.",
  ].join("\n");
}

export function reworkPrompt(options: {
  entry: PrPlanEntry;
  parentRev: string;
  bookmark: string;
  note: string;
  hygieneFeedback: string;
}): string {
  return [
    "You are the IMPLEMENTER doing a REWORK of PR '" + options.entry.slug + "' after human review.",
    "The reviewer DENIED the previous revision with this note (address every point):",
    options.note || "(no note; treat the mechanical gate failures below as the review)",
    "",
    options.hygieneFeedback ? "MECHANICAL GATE FAILURES:\n" + options.hygieneFeedback + "\n" : "",
    "Same VCS contract as before: this lane is ONE jj change; edit files and jj describe to amend it;",
    "never jj new/commit; descendants auto-rebase; only touch " + options.entry.scopes.join(", ") + ".",
    "Re-run the lane checks before finishing:",
    options.entry.checks.map((command) => "  $ " + command).join("\n"),
    "Report status reworked/partial/blocked and a summary of exactly what you changed in response to the note.",
  ].join("\n");
}

export function finalReviewPrompt(options: { plan: StackPlan; assembleGate: Gate | undefined; specPath: string }): string {
  return [
    "You are the FINAL REVIEWER for the whole '" + options.plan.missionTitle + "' stack, working in the TOP lane's",
    "jj workspace (the full stack is visible here).",
    "Assemble gate: " + (options.assembleGate ? (options.assembleGate.ok ? "GREEN" : "RED:\n" + options.assembleGate.feedback.slice(0, 2_000)) : "not run") + ".",
    "",
    "DO, in order:",
    "1. If the gate is red, fix the failures first.",
    "2. Review the ENTIRE stack: jj log -r 'stack base..@' and the cumulative diff. Hunt for cross-PR",
    "   inconsistencies, duplicated helpers, contract drift between lanes, and spec items silently dropped",
    "   (spec: " + options.specPath + ").",
    "3. Small polish edits are welcome BUT must land inside the owning PR's change:",
    "   jj squash --into <change-id> <paths> (never create new commits, never break one-change-per-PR).",
    "4. Re-run the assemble checks after any edit.",
    "Report status clean/polished/blocked with a summary of what you verified and improved.",
  ].join("\n");
}

// ── Render helpers ───────────────────────────────────────────────────────────

function latest<T>(ctx: any, table: any, targetNodeId: string): T | undefined {
  return ctx.latest(table, targetNodeId) as T | undefined;
}

function rowOk(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const record = row as Record<string, unknown>;
  const value = "ok" in record ? record.ok : (record.row as Record<string, unknown> | undefined)?.ok;
  return value === true || value === 1 || value === "1";
}

// ── Workflow ─────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const input = parseInput(ctx.input);
  const key = stackKeyFromRunId(ctx.runId);

  const setup = latest<Setup>(ctx, outputs.stshipSetup, "setup");
  const planRow = latest<Record<string, unknown>>(ctx, outputs.stshipPlan, "plan");
  const inputPlan = (() => {
    if (!input.planJson) return null;
    try {
      return parseStackPlan(input.planJson, input.maxPrs);
    } catch {
      return null;
    }
  })();
  const plan: StackPlan | null = inputPlan ?? (planRow ? planFromRow(planRow, input.maxPrs) : null);

  const laneRow = (slug: string) => latest<Lane>(ctx, outputs.stshipLane, slug + ":workspace");
  const implementRow = (slug: string) => latest<Implement>(ctx, outputs.stshipImplement, slug + ":implement");
  const buildGate = (slug: string) => latest<Gate>(ctx, outputs.stshipGate, slug + ":hygiene");
  const reworkGate = (slug: string) => latest<Gate>(ctx, outputs.stshipGate, slug + ":rework-hygiene");
  const selfReview = (slug: string) => latest<Review>(ctx, outputs.stshipReview, slug + ":self-review");
  const storyRow = (slug: string) => latest<Story>(ctx, outputs.stshipStory, slug + ":story");
  const artifactRow = (slug: string) => latest<Artifact>(ctx, outputs.stshipArtifact, slug + ":artifact");
  const decisionRow = (slug: string) => ctx.latest(outputs.stshipDecision, slug + ":approval");
  const decision = (slug: string) => classifyDecision(decisionRow(slug));

  const buildIterations = (slug: string) => ctx.iterationCount(outputs.stshipGate, slug + ":hygiene");
  const reviewIterations = (slug: string) => ctx.iterationCount(outputs.stshipArtifact, slug + ":artifact");

  const buildDone = (slug: string) => rowOk(buildGate(slug)) && selfReview(slug)?.verdict === "approve";
  const buildSettled = (slug: string) => buildDone(slug) || buildIterations(slug) >= input.buildIterations;
  const greenEver = (slug: string) => rowOk(buildGate(slug)) || rowOk(reworkGate(slug));
  const reviewSettled = (slug: string) =>
    decision(slug) === "approved" || reviewIterations(slug) >= input.reviewRounds;

  const entries = plan?.entries ?? [];
  const reachable = (index: number): boolean => index === 0 || greenEver(entries[index - 1].slug);
  const settled = (index: number): boolean => (reachable(index) ? buildSettled(entries[index].slug) : true);
  const allBuildSettled = plan !== null && entries.every((_, index) => settled(index));
  const allGreen = plan !== null && entries.every((entry) => greenEver(entry.slug));
  const allReviewSettled =
    plan !== null && entries.every((entry, index) => (reachable(index) ? reviewSettled(entry.slug) : true));

  const assembleGate = latest<Gate>(ctx, outputs.stshipGate, "assemble");
  const finalRow = latest<z.infer<typeof finalSchema>>(ctx, outputs.stshipFinal, "final-review");
  const pushRow = latest<Push>(ctx, outputs.stshipPush, "push");

  const indexRows: StackIndexRow[] = entries.map((entry) => {
    const artifact = artifactRow(entry.slug);
    return {
      slug: entry.slug,
      title: entry.title,
      revision: artifact?.revision ?? 1,
      phase: lanePhase({
        hasWorkspace: laneRow(entry.slug)?.ready === true,
        hygieneOk: greenEver(entry.slug),
        selfReviewApproved: selfReview(entry.slug)?.verdict === "approve",
        decision: decision(entry.slug),
        buildExhausted: !buildDone(entry.slug) && buildIterations(entry.slug) >= input.buildIterations,
        reviewExhausted: decision(entry.slug) !== "approved" && reviewIterations(entry.slug) >= input.reviewRounds,
      }),
      headline: artifact?.headline ?? "",
    };
  });

  const pushGateReady = !input.push || (allReviewSettled && finalRow !== undefined);
  const summaryReady = !input.push ? finalRow !== undefined || !allGreen : pushRow !== undefined;

  return (
    <Workflow name="stacked-ship">
      <UI entry="../ui/stacked-ship.tsx" title="Stacked Ship" />
      <Parallel>
        <Sequence>
          <Task id="setup" output={outputs.stshipSetup} timeoutMs={SETUP_TIMEOUT_MS}>
            {() => setupStack(key)}
          </Task>

          {setup?.ready && inputPlan === null ? (
            <Task
              id="plan"
              output={outputs.stshipPlan}
              agent={fableChain(stackRootFor(key))}
              retries={AGENT_RETRIES}
              timeoutMs={REVIEW_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
            >
              {planPrompt(input.specPath, input.maxPrs)}
            </Task>
          ) : null}

          {setup?.ready && plan ? (
            <Parallel maxConcurrency={input.laneConcurrency}>
              {entries.map((entry, index) => {
                if (!reachable(index)) return null;
                const slug = entry.slug;
                const parentRev = parentRevFor(key, entries, index);
                const bookmark = bookmarkFor(key, slug);
                const workspaceDir = laneDirFor(key, slug);
                const lane = laneRow(slug);
                return (
                  <Sequence key={"lane-" + slug}>
                    <Task id={slug + ":workspace"} output={outputs.stshipLane} timeoutMs={LANE_SETUP_TIMEOUT_MS}>
                      {() => createLane(key, entry, parentRev)}
                    </Task>
                    {lane?.ready ? (
                      <Sequence>
                        <Loop
                          id={slug + ":build"}
                          until={buildDone(slug)}
                          maxIterations={input.buildIterations}
                          onMaxReached="return-last"
                        >
                          <Sequence>
                            <Task
                              id={slug + ":implement"}
                              output={outputs.stshipImplement}
                              agent={solChain(workspaceDir)}
                              retries={AGENT_RETRIES}
                              timeoutMs={IMPLEMENT_TIMEOUT_MS}
                              heartbeatTimeoutMs={HEARTBEAT_MS}
                              continueOnFail
                            >
                              {implementPrompt({
                                entry,
                                index,
                                total: entries.length,
                                missionTitle: plan.missionTitle,
                                specPath: input.specPath,
                                parentRev,
                                bookmark,
                                reviewFeedback: selfReview(slug)?.verdict === "reject" ? selfReview(slug)?.feedback ?? "" : "",
                                hygieneFeedback: rowOk(buildGate(slug)) ? "" : buildGate(slug)?.feedback ?? "",
                              })}
                            </Task>
                            <Task id={slug + ":hygiene"} output={outputs.stshipGate} timeoutMs={HYGIENE_TIMEOUT_MS} continueOnFail>
                              {() => runHygiene({ key, entry, parentRev, gateKey: slug + ":build" })}
                            </Task>
                            <Task
                              id={slug + ":self-review"}
                              output={outputs.stshipReview}
                              agent={opusChain(workspaceDir)}
                              retries={AGENT_RETRIES}
                              timeoutMs={REVIEW_TIMEOUT_MS}
                              heartbeatTimeoutMs={HEARTBEAT_MS}
                              continueOnFail
                            >
                              {selfReviewPrompt({ entry, parentRev, bookmark, implement: implementRow(slug), gate: buildGate(slug) })}
                            </Task>
                          </Sequence>
                        </Loop>
                        {buildSettled(slug) ? (
                          <Loop
                            id={slug + ":review"}
                            until={decision(slug) === "approved"}
                            maxIterations={input.reviewRounds}
                            onMaxReached="return-last"
                          >
                            <Sequence>
                              {decision(slug) === "denied" ? (
                                <Task
                                  id={slug + ":rework"}
                                  output={outputs.stshipRework}
                                  agent={solChain(workspaceDir)}
                                  retries={AGENT_RETRIES}
                                  timeoutMs={IMPLEMENT_TIMEOUT_MS}
                                  heartbeatTimeoutMs={HEARTBEAT_MS}
                                  continueOnFail
                                >
                                  {reworkPrompt({
                                    entry,
                                    parentRev,
                                    bookmark,
                                    note: decisionNote(decisionRow(slug)),
                                    hygieneFeedback: rowOk(reworkGate(slug)) ? "" : reworkGate(slug)?.feedback ?? "",
                                  })}
                                </Task>
                              ) : null}
                              {decision(slug) === "denied" ? (
                                <Task
                                  id={slug + ":rework-hygiene"}
                                  output={outputs.stshipGate}
                                  timeoutMs={HYGIENE_TIMEOUT_MS}
                                  continueOnFail
                                >
                                  {() => runHygiene({ key, entry, parentRev, gateKey: slug + ":rework" })}
                                </Task>
                              ) : null}
                              <Task
                                id={slug + ":story"}
                                output={outputs.stshipStory}
                                agent={storyChain(workspaceDir)}
                                retries={AGENT_RETRIES}
                                timeoutMs={STORY_TIMEOUT_MS}
                                heartbeatTimeoutMs={HEARTBEAT_MS}
                                continueOnFail
                              >
                                {storyPrompt({ entry, parentRev, bookmark })}
                              </Task>
                              <Task id={slug + ":artifact"} output={outputs.stshipArtifact} timeoutMs={ARTIFACT_TIMEOUT_MS} continueOnFail>
                                {() =>
                                  buildLaneArtifact({
                                    key,
                                    entry,
                                    parentRev,
                                    missionTitle: plan.missionTitle,
                                    revision: reviewIterations(slug) + 1,
                                    storyRow: storyRow(slug),
                                    gateRow: reworkGate(slug) ?? buildGate(slug),
                                    decisionState: decision(slug),
                                    indexRows,
                                  })
                                }
                              </Task>
                              <Approval
                                id={slug + ":approval"}
                                async
                                output={outputs.stshipDecision}
                                onDeny="continue"
                                request={{
                                  title:
                                    "PR " + (index + 1) + "/" + entries.length + " · " + slug + " · r" + (reviewIterations(slug) + 1),
                                  summary:
                                    (artifactRow(slug)?.headline ? artifactRow(slug)?.headline + "\n" : "") +
                                    "Artifact: " +
                                    (artifactRow(slug)?.artifactPath ??
                                      join(reportsDirFor(repoRoot, key), artifactFileName(slug, reviewIterations(slug) + 1))) +
                                    "\nHygiene: " +
                                    (greenEver(slug) ? "green" : "FAILING") +
                                    " · Self-review: " +
                                    (selfReview(slug)?.verdict ?? "none") +
                                    "\nApprove to accept this PR; deny WITH A NOTE to trigger a rework rebase.",
                                }}
                              />
                            </Sequence>
                          </Loop>
                        ) : null}
                      </Sequence>
                    ) : null}
                  </Sequence>
                );
              })}
            </Parallel>
          ) : null}
        </Sequence>

        {plan && allBuildSettled ? (
          <Sequence>
            {allGreen ? (
              <Task id="assemble" output={outputs.stshipGate} timeoutMs={ASSEMBLE_TIMEOUT_MS} continueOnFail>
                {() => runAssemble({ key, plan })}
              </Task>
            ) : null}
            {assembleGate ? (
              <Task
                id="final-review"
                output={outputs.stshipFinal}
                agent={fableChain(laneDirFor(key, entries[entries.length - 1].slug))}
                retries={AGENT_RETRIES}
                timeoutMs={IMPLEMENT_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {finalReviewPrompt({ plan, assembleGate, specPath: input.specPath })}
              </Task>
            ) : null}
            {input.push && pushGateReady ? (
              <Task id="push" output={outputs.stshipPush} timeoutMs={PUSH_TIMEOUT_MS} continueOnFail>
                {() =>
                  runPush({
                    key,
                    plan,
                    wantPush: input.push,
                    createPrs: input.createPrs,
                    assembleOk: rowOk(assembleGate),
                    approvedSlugs: entries.filter((entry) => decision(entry.slug) === "approved").map((entry) => entry.slug),
                  })
                }
              </Task>
            ) : null}
            {summaryReady ? (
              <Task id="summary" output={outputs.stshipSummary} timeoutMs={5 * 60_000}>
                {() => {
                  const details = entries.map((entry, index) => ({
                    laneSlug: entry.slug,
                    reachable: reachable(index),
                    hygieneGreen: greenEver(entry.slug),
                    selfReview: selfReview(entry.slug)?.verdict ?? "none",
                    decision: decision(entry.slug),
                    artifact: artifactRow(entry.slug)?.artifactPath ?? "",
                    revisions: reviewIterations(entry.slug),
                  }));
                  const green = details.filter((detail) => detail.hygieneGreen).length;
                  const approved = details.filter((detail) => detail.decision === "approved").length;
                  return {
                    lanesTotal: entries.length,
                    lanesGreen: green,
                    lanesApproved: approved,
                    assembleOk: rowOk(assembleGate),
                    pushed: pushRow?.pushed === true,
                    detailsJson: JSON.stringify(details),
                    summary:
                      green + "/" + entries.length + " lanes green, " + approved + " approved; assemble " +
                      (rowOk(assembleGate) ? "GREEN" : "red/skipped") + "; " +
                      (pushRow?.pushed === true ? "pushed." : "not pushed.") +
                      " Artifacts: " + reportsDirFor(repoRoot, key) + "/index.html",
                  };
                }}
              </Task>
            ) : null}
          </Sequence>
        ) : null}
      </Parallel>
    </Workflow>
  );
});
