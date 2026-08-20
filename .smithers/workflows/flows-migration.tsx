// smithers-source: authored
// smithers-display-name: Flows Migration
// smithers-description: Replace the Smithers runtime with the flows library in three staged waves (engine, agent primitive, API), one jj lane per PR, across both the smithers and flows repos.
/** @jsxImportSource smthrs */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentLike,
  Approval,
  ClaudeCodeAgent,
  Loop,
  Parallel,
  Sequence,
  UI,
  approvalDecisionSchema,
  createSmithers,
  fallbackAgents,
} from "smthrs";
import { z } from "zod/v4";
import {
  ALL_STAGES,
  type Lane,
  type LanePhase,
  type Ledger,
  type StageEntry,
  type StageReportRow,
  artifactFileName,
  bookmarkFor,
  laneDirFor,
  lanePhase,
  migrationKeyFromRunId,
  parseCheck,
  parseLedger,
  parseStageSelection,
  renderLaneReportHtml,
  renderStageReportHtml,
  reportsDirFor,
  rowOk,
  sanitizeSlug,
  stageBookmarkFor,
  summarizeGate,
  unwrapRow,
  workspaceNameFor,
  workspaceRootFor,
} from "../lib/flowsMigration";

/**
 * Flows Migration.
 *
 * Drives the program in .smithers/specs/flows-migration.md: stage 0 unblocks
 * the two trees from depending on each other, stage 1 puts the flows engine
 * underneath Smithers, stage 2 replaces the Vercel AI SDK with the flows agent
 * primitive, stage 3 promotes flows to the public API with an optional
 * flows-react render loop.
 *
 * Shape: one planner produces a stage ledger, a human blesses it, then each
 * stage runs its lanes in parallel jj workspaces (in whichever repo the lane
 * targets), gates them mechanically, reviews them, gets a per-lane human
 * decision, integrates, reports, and gates the next stage on a sign-off.
 *
 * Nothing here touches either shared working copy. Every lane works in its own
 * `jj workspace`, and nothing is pushed unless `push` is true.
 */

const smithersRoot = (() => {
  try {
    return resolve(join(fileURLToPath(import.meta.url), "..", "..", ".."));
  } catch {
    return process.cwd();
  }
})();

// ── Schemas ──────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  specPath: z.string().default(".smithers/specs/flows-migration.md"),
  flowsRoot: z.string().default(resolve(join(smithersRoot, "..", "flows", "flows"))),
  stages: z.string().default("all"),
  ledgerJson: z.string().default(""),
  maxLanesPerStage: z.number().int().min(1).max(12).default(6),
  laneConcurrency: z.number().int().min(1).max(6).default(3),
  baseRev: z.string().default("main"),
  buildIterations: z.number().int().min(1).max(6).default(3),
  reviewRounds: z.number().int().min(1).max(6).default(3),
  push: z.boolean().default(false),
});
type Input = z.infer<typeof inputSchema>;

const preflightSchema = z.object({
  ok: z.boolean(),
  smithersRootPath: z.string(),
  flowsRootPath: z.string(),
  collisionsJson: z.string().default("[]"),
  smithersEffectPin: z.string().default(""),
  flowsEffectPin: z.string().default(""),
  notesJson: z.string().default("[]"),
  summary: z.string().min(2),
});
type Preflight = z.infer<typeof preflightSchema>;

const laneOut = z.object({
  slug: z.string().min(2),
  title: z.string().min(6),
  goal: z.string().min(30),
  repo: z.enum(["smithers", "flows"]),
  scopes: z.array(z.string()).min(1),
  checks: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
});

const ledgerSchema = z.object({
  missionTitle: z.string().min(4),
  stages: z
    .array(
      z.object({
        id: z.enum(["0", "1", "2", "3"]),
        title: z.string().min(4),
        goal: z.string().min(20),
        checks: z.array(z.string()).default([]),
        lanes: z.array(laneOut).min(1),
      }),
    )
    .min(1),
  summary: z.string().min(10),
});

const workspaceSchema = z.object({
  slug: z.string().min(2),
  ready: z.boolean(),
  depsReady: z.boolean().default(false),
  dir: z.string().default(""),
  bookmark: z.string().default(""),
  baseRev: z.string().default(""),
  summary: z.string().min(2),
});
type Workspace = z.infer<typeof workspaceSchema>;

const implementSchema = z.object({
  slug: z.string().min(2),
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChangedJson: z.string().default("[]"),
});
type Implement = z.infer<typeof implementSchema>;

const gateSchema = z.object({
  gateKey: z.string().min(2),
  ok: z.boolean(),
  failuresJson: z.string().default("[]"),
  detail: z.string().default(""),
  diffStat: z.string().default(""),
  commitId: z.string().default(""),
  summary: z.string().min(2),
});
type Gate = z.infer<typeof gateSchema>;

const reviewSchema = z.object({
  slug: z.string().min(2),
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string().min(10),
});
type Review = z.infer<typeof reviewSchema>;

const artifactSchema = z.object({
  slug: z.string().min(2),
  artifactPath: z.string().min(4),
  revision: z.number().int(),
  summary: z.string().min(2),
});
type Artifact = z.infer<typeof artifactSchema>;

const integrateSchema = z.object({
  stage: z.string().min(1),
  ok: z.boolean(),
  detail: z.string().default(""),
  summary: z.string().min(10),
});
type Integrate = z.infer<typeof integrateSchema>;

const stageReportSchema = z.object({
  stage: z.string().min(1),
  reportPath: z.string().min(4),
  lanesTotal: z.number().int(),
  lanesGreen: z.number().int(),
  lanesApproved: z.number().int(),
  summary: z.string().min(2),
});
type StageReport = z.infer<typeof stageReportSchema>;

const summarySchema = z.object({
  stagesDone: z.number().int(),
  lanesTotal: z.number().int(),
  lanesApproved: z.number().int(),
  detailsJson: z.string().default("[]"),
  summary: z.string().min(2),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  fmPreflight: preflightSchema,
  fmLedger: ledgerSchema,
  fmWorkspace: workspaceSchema,
  fmImplement: implementSchema,
  fmGate: gateSchema,
  fmReview: reviewSchema,
  fmDecision: approvalDecisionSchema,
  fmArtifact: artifactSchema,
  fmIntegrate: integrateSchema,
  fmStageReport: stageReportSchema,
  fmSummary: summarySchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────

const AGENT_RETRIES = 2;
const HEARTBEAT_MS = 12 * 60_000;
const PLAN_TIMEOUT_MS = 45 * 60_000;
const IMPLEMENT_TIMEOUT_MS = 90 * 60_000;
const REVIEW_TIMEOUT_MS = 40 * 60_000;
const GATE_TIMEOUT_MS = 60 * 60_000;
const INTEGRATE_TIMEOUT_MS = 120 * 60_000;
const SETUP_TIMEOUT_MS = 45 * 60_000;
const REPORT_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;

/**
 * Every agent task runs on the whole registered subscription pool, seeded by
 * the run id so the chain is stable across renders and retries of one run.
 * `cwd` is pinned per provider because a lane always works in its own jj
 * workspace, which may live in either repo.
 */
function pool(seed: string, cwd: string, models: { claude: string; codex: string }): AgentLike[] {
  return fallbackAgents({
    seed,
    providers: ["claude-code", "codex"],
    models: { "claude-code": models.claude, codex: models.codex },
    agentOptions: {
      "claude-code": { cwd },
      codex: {
        cwd,
        sandbox: "danger-full-access",
        dangerouslyBypassApprovalsAndSandbox: true,
        skipGitRepoCheck: true,
      },
    },
    fallback: [new ClaudeCodeAgent({ model: models.claude, cwd })],
  });
}

const plannerModels = { claude: "claude-fable-5", codex: "gpt-5.6-sol" };
const implementerModels = { claude: "claude-opus-5", codex: "gpt-5.6-sol" };
const reviewerModels = { claude: "claude-fable-5", codex: "gpt-5.6-sol" };
const integratorModels = { claude: "claude-opus-5", codex: "gpt-5.6-sol" };

// ── Process helpers ──────────────────────────────────────────────────────────

type ProcessResult = { exitCode: number; stdout: string; stderr: string };

function resolveJj(): string {
  try {
    const localRequire = createRequire(import.meta.url);
    const vcs = localRequire("@smthrs/vcs") as { resolveJjBinary: () => { path: string } | null };
    return vcs.resolveJjBinary()?.path ?? "jj";
  } catch {
    return "jj";
  }
}
const JJ_BIN = resolveJj();

function jj(args: string[], cwd: string): string {
  return execFileSync(JJ_BIN, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function jjSafe(args: string[], cwd: string): string {
  try {
    return jj(args, cwd);
  } catch (error) {
    return "ERROR: " + String((error as Error)?.message ?? error).slice(0, 400);
  }
}

function runProcess(binary: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, stdout: stdout.slice(-20_000), stderr: stderr.slice(-20_000) });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      stderr += "\n[timed out after " + String(Math.round(timeoutMs / 1000)) + "s]";
      finish(124);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += "\n" + String(error?.message ?? error);
      finish(127);
    });
    child.on("close", (code) => finish(typeof code === "number" ? code : 1));
  });
}

function repoRootFor(lane: Lane, input: Input): string {
  return lane.repo === "flows" ? input.flowsRoot : smithersRoot;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Compute steps ────────────────────────────────────────────────────────────

/**
 * Prove both trees are present and usable, and record the three facts every
 * stage-0 lane needs: the published-name collisions, the two Effect pins, and
 * whether each tree is a jj repo we can add a workspace to.
 */
function runPreflight(input: Input): Preflight {
  const notes: string[] = [];
  const flowsRoot = input.flowsRoot;
  const flowsOk = existsSync(join(flowsRoot, "package.json"));
  if (!flowsOk) notes.push("flows repo not found at " + flowsRoot);

  const namesFor = (root: string): Map<string, string> => {
    const map = new Map<string, string>();
    const packagesDir = join(root, "packages");
    if (!existsSync(packagesDir)) return map;
    for (const entry of readdirSafe(packagesDir)) {
      const manifest = readJson(join(packagesDir, entry, "package.json"));
      const name = typeof manifest.name === "string" ? manifest.name : "";
      if (name) map.set(name, typeof manifest.version === "string" ? manifest.version : "");
    }
    return map;
  };

  const ours = namesFor(smithersRoot);
  const theirs = flowsOk ? namesFor(flowsRoot) : new Map<string, string>();
  const collisions = [...theirs.keys()].filter((name) => ours.has(name)).sort();
  if (collisions.length > 0) {
    notes.push(collisions.length + " package names collide; stage 0.1 must rename before any publish");
  }

  const pinOf = (root: string): string => {
    const packagesDir = join(root, "packages");
    for (const entry of readdirSafe(packagesDir)) {
      const manifest = readJson(join(packagesDir, entry, "package.json"));
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        const deps = manifest[field];
        if (deps && typeof deps === "object" && typeof (deps as Record<string, unknown>).effect === "string") {
          return String((deps as Record<string, unknown>).effect);
        }
      }
    }
    return "";
  };
  const smithersPin = pinOf(smithersRoot);
  const flowsPin = flowsOk ? pinOf(flowsRoot) : "";
  if (smithersPin && flowsPin && smithersPin !== flowsPin) {
    notes.push("effect pins differ: smithers " + smithersPin + " vs flows " + flowsPin + " (stage 0.3)");
  }

  const jjOk = (root: string): boolean => !jjSafe(["root"], root).startsWith("ERROR:");
  if (!jjOk(smithersRoot)) notes.push("smithers tree is not a jj repo; lanes cannot get workspaces");
  if (flowsOk && !jjOk(flowsRoot)) notes.push("flows tree is not a jj repo; flows lanes cannot get workspaces");

  if (existsSync(join(smithersRoot, "smithers.db"))) {
    notes.push(
      "workspace db looks like SQLite, which stage 1 supports; a PGlite/Postgres workspace is blocked on flows gap 4",
    );
  }

  const ok = flowsOk && jjOk(smithersRoot) && (!flowsOk || jjOk(flowsRoot));
  return {
    ok,
    smithersRootPath: smithersRoot,
    flowsRootPath: flowsRoot,
    collisionsJson: JSON.stringify(collisions),
    smithersEffectPin: smithersPin,
    flowsEffectPin: flowsPin,
    notesJson: JSON.stringify(notes),
    summary: ok
      ? "Both trees ready. " + collisions.length + " name collisions, effect " + smithersPin + " vs " + flowsPin + "."
      : "Preflight failed: " + notes.join("; "),
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The revision a lane starts from.
 *
 * A stage-N lane must branch from stage N-1's integration bookmark in its own
 * repo, not from trunk: the integrator leaves each finished stage on
 * `flows-migration/<key>/stage-<id>` and never moves trunk, so a lane that
 * branches from trunk cannot see any earlier stage's work. Probes backwards
 * through the stage order so a skipped or not-yet-integrated stage falls
 * through to the one before it, and finally to the configured trunk.
 */
function revisionExists(revision: string, root: string): boolean {
  const probe = jjSafe(["log", "-r", revision, "--no-graph", "-T", "commit_id.short()"], root);
  return !probe.startsWith("ERROR:") && probe.trim().length > 0;
}

function resolveLaneBase(lane: Lane, input: Input, key: string, root: string): string {
  // A declared dependency is not just an ordering constraint: the lane needs
  // that dependency's CODE. Its commit lives on the dependency's lane
  // bookmark, so base this lane there. With several dependencies the base is a
  // merge of them, created without moving any working copy.
  const deps = lane.dependsOn.map((dep) => bookmarkFor(key, dep)).filter((bm) => revisionExists(bm, root));
  if (deps.length === 1) return deps[0];
  if (deps.length > 1) {
    const merged = "flows-migration/" + key + "/base-" + sanitizeSlug(lane.slug);
    if (!revisionExists(merged, root)) {
      // `--no-edit` keeps the shared checkout's working copy where it is. The
      // merge is then identified by parentage, which is exact: it is the only
      // commit that is a child of every dependency.
      jjSafe(["new", "--no-edit", "-m", "chore(base): merge dependencies for " + lane.slug, ...deps], root);
      const revset = deps.map((dep) => "children(" + dep + ")").join(" & ");
      const found = jjSafe(["log", "-r", revset, "--no-graph", "-T", 'commit_id.short() ++ "\n"'], root);
      const id = found.split("\n")[0].trim();
      if (id && !id.startsWith("ERROR:")) {
        jjSafe(["bookmark", "set", merged, "-r", id, "--allow-backwards"], root);
      }
    }
    if (revisionExists(merged, root)) return merged;
    return deps[deps.length - 1];
  }

  const index = ALL_STAGES.indexOf(lane.stage);
  for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
    const bookmark = stageBookmarkFor(key, ALL_STAGES[earlier]);
    if (revisionExists(bookmark, root)) return bookmark;
  }
  return input.baseRev;
}

/**
 * Create the lane's own jj workspace in whichever repo the lane targets, then
 * install dependencies in it. A fresh jj workspace has no node_modules, so a
 * lane check would fail for a reason that has nothing to do with the lane.
 */
async function createLaneWorkspace(lane: Lane, input: Input, key: string): Promise<Workspace> {
  const root = repoRootFor(lane, input);
  const dir = laneDirFor(root, key, lane.slug);
  const name = workspaceNameFor(key, lane.slug);
  const bookmark = bookmarkFor(key, lane.slug);
  const base = resolveLaneBase(lane, input, key, root);
  try {
    mkdirSync(workspaceRootFor(root, key), { recursive: true });
    if (!existsSync(join(dir, ".jj"))) {
      // `workspace add` leaves the new workspace on a fresh empty change whose
      // parent is `base`, which is exactly the lane's starting point.
      jj(["workspace", "add", "--name", name, "--revision", base, dir], root);
    }
    const ready = existsSync(join(dir, ".jj"));
    if (!ready) {
      return {
        slug: lane.slug,
        ready: false,
        depsReady: false,
        dir,
        bookmark,
        baseRev: base,
        summary: "Workspace directory was not created",
      };
    }
    jjSafe(["bookmark", "set", bookmark, "-r", "@", "--allow-backwards"], dir);
    const baseRev = jjSafe(["log", "-r", "@-", "--no-graph", "-T", "commit_id.short()"], dir);
    const install = await runProcess("pnpm", ["install", "--frozen-lockfile"], dir, INSTALL_TIMEOUT_MS);
    return {
      slug: lane.slug,
      ready: true,
      depsReady: install.exitCode === 0,
      dir,
      bookmark,
      baseRev: baseRev.startsWith("ERROR:") ? base : baseRev,
      summary:
        "Workspace " +
        name +
        " at " +
        dir +
        " on " +
        base +
        (install.exitCode === 0
          ? " (dependencies installed)"
          : " (pnpm install exited " + install.exitCode + ", the lane must install before it can run checks)"),
    };
  } catch (error) {
    return {
      slug: lane.slug,
      ready: false,
      depsReady: false,
      dir,
      bookmark,
      baseRev: "",
      summary: "Workspace setup failed: " + String((error as Error)?.message ?? error).slice(0, 300),
    };
  }
}

/**
 * Mechanical lane gate. Runs the lane's declared checks in its workspace and
 * refuses an empty diff, which is how a lane silently reports success without
 * having changed anything.
 */
async function runLaneGate(lane: Lane, dir: string, gateKey: string): Promise<Gate> {
  const failures: Array<{ check: string; exitCode: number }> = [];
  const chunks: string[] = [];

  const diffStat = jjSafe(["diff", "--stat"], dir);
  const commitId = jjSafe(["log", "-r", "@", "--no-graph", "-T", "commit_id.short()"], dir);
  const empty = !diffStat || diffStat.startsWith("ERROR:") || /0 files changed/.test(diffStat);
  if (empty) {
    failures.push({ check: "non-empty-diff", exitCode: 1 });
    chunks.push("non-empty-diff: the lane workspace has no changes");
  }

  for (const check of lane.checks) {
    const parsed = parseCheck(check);
    if (!parsed) {
      failures.push({ check, exitCode: 126 });
      chunks.push(check + ": rejected, not on the check allowlist");
      continue;
    }
    const result = await runProcess(parsed.binary, parsed.args, dir, GATE_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      failures.push({ check, exitCode: result.exitCode });
      chunks.push("$ " + check + "\nexit " + result.exitCode + "\n" + (result.stderr || result.stdout).slice(-4000));
    } else {
      chunks.push("$ " + check + "\nexit 0");
    }
  }

  const ok = failures.length === 0;
  return {
    gateKey,
    ok,
    failuresJson: JSON.stringify(failures),
    detail: chunks.join("\n\n").slice(-16_000),
    diffStat: diffStat.slice(0, 6000),
    commitId: commitId.startsWith("ERROR:") ? "" : commitId,
    summary: ok
      ? "Gate green (" + lane.checks.length + " checks)"
      : "Gate failing: " + failures.map((f) => f.check).join(", "),
  };
}

/** Write one lane revision's self-contained HTML report. */
function writeLaneReport(args: {
  lane: Lane;
  key: string;
  missionTitle: string;
  revision: number;
  phase: LanePhase;
  gate: Gate | undefined;
  implement: Implement | undefined;
  review: Review | undefined;
}): Artifact {
  const dir = reportsDirFor(smithersRoot, args.key);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, artifactFileName(args.lane.slug, args.revision));
  const html = renderLaneReportHtml({
    lane: args.lane,
    missionTitle: args.missionTitle,
    revision: args.revision,
    phase: args.phase,
    gateOk: rowOk(args.gate),
    gateDetail: args.gate?.detail ?? "",
    implementSummary: args.implement?.summary ?? "",
    reviewVerdict: args.review?.verdict ?? "",
    reviewFeedback: args.review?.feedback ?? "",
    diffStat: args.gate?.diffStat ?? "",
    commitId: args.gate?.commitId ?? "",
  });
  writeFileSync(path, html, "utf8");
  return {
    slug: args.lane.slug,
    artifactPath: path,
    revision: args.revision,
    summary: "Report r" + args.revision + " for " + args.lane.slug,
  };
}

function writeStageReport(args: {
  key: string;
  missionTitle: string;
  stage: StageEntry;
  rows: StageReportRow[];
  integrate: Integrate | undefined;
}): StageReport {
  const dir = reportsDirFor(smithersRoot, args.key);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "stage-" + args.stage.id + ".html");
  writeFileSync(
    path,
    renderStageReportHtml({
      missionTitle: args.missionTitle,
      stage: args.stage,
      rows: args.rows,
      integrateSummary: args.integrate?.detail || args.integrate?.summary || "",
      integrateOk: rowOk(args.integrate),
    }),
    "utf8",
  );
  return {
    stage: args.stage.id,
    reportPath: path,
    lanesTotal: args.rows.length,
    lanesGreen: args.rows.filter((row) => row.gateOk).length,
    lanesApproved: args.rows.filter((row) => row.phase === "approved").length,
    summary: "Stage " + args.stage.id + ": " + args.rows.length + " lanes, report at " + path,
  };
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const REPO_RULES = [
  "Rules that hold in every lane:",
  "- Work only inside the workspace directory you are given. Never touch either shared checkout.",
  "- Stay inside your declared scopes. If the work needs another path, report partial and say why.",
  "- One jj change per lane. Describe it as `<emoji> <type>(<scope>): <subject>`.",
  "- Dependency or manifest changes refresh both pnpm-lock.yaml and bun.lock.",
  "- Product code and E2E tests use real backends, never mocks.",
  "- Internal scripts run the working tree: `bun apps/cli/src/index.js <cmd>`, never `bunx smthrs`.",
  "- The workspace already ran `pnpm install --frozen-lockfile`. Re-run it yourself after any manifest or lockfile change, and refresh bun.lock too.",
].join("\n");

function ledgerPrompt(input: Input, preflight: Preflight | undefined): string {
  const collisions = preflight?.collisionsJson ?? "[]";
  const notes = preflight?.notesJson ?? "[]";
  return [
    "Plan the flows migration as a ledger of PR-sized lanes.",
    "",
    "Read, in order:",
    "1. " +
      input.specPath +
      " in the smithers repo (" +
      smithersRoot +
      "). It is the program spec and it is authoritative.",
    "2. " + join(input.flowsRoot, "docs/architecture/smithers-replacement-gaps.md") + " and implementation-status.md.",
    "3. The two trees themselves. smithers: packages/{engine,graph,scheduler,driver,agents,db}. flows: packages/{flow,engine,engine-store,plan,journal,run-store,harness,model,core,std,patterns,flows}.",
    "",
    "Preflight facts from this run:",
    "- Colliding published package names: " + collisions,
    "- Notes: " + notes,
    "- smithers effect pin: " +
      (preflight?.smithersEffectPin || "unknown") +
      ", flows effect pin: " +
      (preflight?.flowsEffectPin || "unknown"),
    "",
    "Produce one entry per stage the spec defines (0, 1, 2, 3), each with at most " +
      input.maxLanesPerStage +
      " lanes. A lane is one PR: one reviewable change, one jj commit, testable on its own.",
    "",
    "For every lane give:",
    "- slug: short, lowercase, dash separated, unique across all stages.",
    "- repo: `smithers` or `flows`, whichever tree the change lands in.",
    "- title and goal: the goal is the full instruction the implementer receives, including the files to touch and the acceptance condition.",
    "- scopes: the path prefixes the lane may modify, relative to its repo root.",
    "- checks: shell commands that prove the lane, run from the lane workspace root. Allowed binaries: pnpm, bun, bunx, npm, npx, node, jj, git, cargo, tsc, biome, vitest, make. No pipes, no `&&`, no redirection. Prefer scoped commands like `pnpm -C packages/db test` over the whole suite.",
    "- dependsOn: slugs of lanes in the same stage that must be green first. Leave empty when the lane is independent.",
    "",
    "Rules for the plan itself:",
    "- Stage 0 lanes are the prerequisites. The name-collision rename and the effect substrate bump block everything else.",
    "- Order the lanes so the first ones de-risk the rest.",
    "- Never plan a lane that needs a decision only the maintainer can make. Those are already in the spec as decisions; plan the work that follows each one.",
    "- Do not invent work outside the spec. If the spec is wrong or incomplete, say so in summary and plan what is correct.",
    "",
    "Return the ledger as structured output. No prose outside the schema.",
  ].join("\n");
}

function implementPrompt(args: {
  lane: Lane;
  stage: StageEntry;
  input: Input;
  workspace: Workspace;
  gateFeedback: string;
  reviewFeedback: string;
}): string {
  const { lane, workspace } = args;
  return [
    "Implement one lane of the flows migration.",
    "",
    "Lane: " + lane.slug + " (" + lane.title + ")",
    "Stage " + lane.stage + ": " + args.stage.title,
    "Repo: " + lane.repo + " (root " + repoRootFor(lane, args.input) + ")",
    "Workspace: " + workspace.dir + " (jj workspace, bookmark " + workspace.bookmark + ")",
    "Scopes: " + lane.scopes.join(", "),
    "Checks that must pass: " +
      (lane.checks.length > 0 ? lane.checks.join(" | ") : "none declared, run the obvious scoped tests"),
    "",
    "Goal:",
    lane.goal,
    "",
    "Program spec: " + join(smithersRoot, args.input.specPath),
    "flows gap analysis: " + join(args.input.flowsRoot, "docs/architecture/smithers-replacement-gaps.md"),
    "",
    REPO_RULES,
    "",
    args.gateFeedback ? "The previous attempt failed its gate:\n" + args.gateFeedback + "\n" : "",
    args.reviewFeedback ? "The previous attempt was rejected in review:\n" + args.reviewFeedback + "\n" : "",
    "When the code is done, run the lane checks yourself, then commit in the workspace:",
    "  jj describe -m '<emoji> <type>(<scope>): <subject>'",
    "  jj bookmark set " + workspace.bookmark + " -r @",
    "",
    "Report status `implemented` only when every declared check passes locally. Report `partial` when the code is real but a check still fails, and `blocked` when the lane cannot be done as specified. Never widen the scope to make a check pass.",
  ]
    .filter(Boolean)
    .join("\n");
}

function reviewPrompt(args: {
  lane: Lane;
  workspace: Workspace;
  implement: Implement | undefined;
  gate: Gate | undefined;
}): string {
  return [
    "Review one lane of the flows migration as a senior reviewer. Be adversarial about correctness, not about style.",
    "",
    "Lane: " + args.lane.slug + " (" + args.lane.title + ")",
    "Repo: " + args.lane.repo,
    "Workspace: " + args.workspace.dir,
    "Read the change with `jj diff -r @` in that workspace.",
    "",
    "Goal the lane was given:",
    args.lane.goal,
    "",
    "Implementer reported: " + (args.implement?.status ?? "unknown") + " - " + (args.implement?.summary ?? ""),
    "Mechanical gate: " + summarizeGate(args.gate),
    "",
    "Reject when any of these is true:",
    "- The change does not accomplish the stated goal.",
    "- It edits files outside " + args.lane.scopes.join(", ") + ".",
    "- It weakens a test, deletes an assertion, or mocks a real backend to get green.",
    "- It changes public exports, types, or docs without the matching generated bundles.",
    "- It leaves the other engine, the other agent path, or an existing workflow broken.",
    "",
    "Approve only when you would merge it. Feedback must be specific enough to act on without re-reading the diff.",
  ].join("\n");
}

function integratePrompt(args: { stage: StageEntry; lanes: Lane[]; input: Input; key: string }): string {
  const bySlug = args.lanes.map(
    (lane) =>
      "- " + lane.slug + " (" + lane.repo + ") at " + laneDirFor(repoRootFor(lane, args.input), args.key, lane.slug),
  );
  return [
    "Integrate the approved lanes of stage " + args.stage.id + " and prove the stage.",
    "",
    "Stage goal: " + args.stage.goal,
    "",
    "Lanes and their workspaces:",
    ...bySlug,
    "",
    "Do this:",
    "1. In each repo, rebase the approved lane changes onto the current main and resolve conflicts. Keep one change per lane. Do not squash lanes together.",
    "2. Leave the result on the bookmark `flows-migration/" +
      args.key +
      "/stage-" +
      args.stage.id +
      "` in each repo that has lanes.",
    "3. Run the stage checks: " +
      (args.stage.checks.length > 0 ? args.stage.checks.join(" | ") : "pnpm typecheck in each repo that changed"),
    "4. Fix integration breakage only. A lane's own defect goes back to that lane as feedback, it does not get patched here.",
    "",
    args.input.push
      ? "5. Push each stage bookmark to origin. Never push to main."
      : "5. Do not push anything. `push` is false for this run.",
    "",
    "Report ok only when every stage check passes on the integrated result.",
  ].join("\n");
}

// ── Row helpers ──────────────────────────────────────────────────────────────

function latest<T>(ctx: any, table: unknown, nodeId: string): T | undefined {
  return ctx.latest(table, nodeId) as T | undefined;
}

function decisionOf(row: unknown): "approved" | "denied" | "pending" {
  const record = unwrapRow(row);
  if (record.decision === "approved" || record.approved === true) return "approved";
  if (record.decision === "denied" || record.approved === false) return "denied";
  return "pending";
}

function decisionNote(row: unknown): string {
  const record = unwrapRow(row);
  const note = record.notes ?? record.note ?? record.reason;
  return typeof note === "string" ? note : "";
}

// ── Workflow ─────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const input = inputSchema.parse(ctx.input ?? {});
  const key = migrationKeyFromRunId(ctx.runId);
  const selectedStages = parseStageSelection(input.stages);

  const preflight = latest<Preflight>(ctx, outputs.fmPreflight, "preflight");
  const ledgerRow = latest<Record<string, unknown>>(ctx, outputs.fmLedger, "ledger");
  const ledger: Ledger | null =
    (input.ledgerJson ? safeLedger(input.ledgerJson, input, selectedStages) : null) ??
    parseLedger(ledgerRow, { maxLanesPerStage: input.maxLanesPerStage, stages: selectedStages });
  const planDecision = decisionOf(ctx.latest(outputs.fmDecision, "plan-approval"));

  const stages: StageEntry[] = (ledger?.stages ?? []).filter((stage) => selectedStages.includes(stage.id));
  const missionTitle = ledger?.missionTitle ?? "Flows migration";

  const workspaceOf = (slug: string) => latest<Workspace>(ctx, outputs.fmWorkspace, slug + ":workspace");
  const implementOf = (slug: string) => latest<Implement>(ctx, outputs.fmImplement, slug + ":implement");
  const buildGateOf = (slug: string) => latest<Gate>(ctx, outputs.fmGate, slug + ":gate");
  const reworkGateOf = (slug: string) => latest<Gate>(ctx, outputs.fmGate, slug + ":rework-gate");
  const reviewOf = (slug: string) => latest<Review>(ctx, outputs.fmReview, slug + ":review");
  const artifactOf = (slug: string) => latest<Artifact>(ctx, outputs.fmArtifact, slug + ":artifact");
  const decisionRowOf = (slug: string) => ctx.latest(outputs.fmDecision, slug + ":approval");
  const decisionOfLane = (slug: string) => decisionOf(decisionRowOf(slug));
  const integrateOf = (stageId: string) =>
    latest<Integrate>(ctx, outputs.fmIntegrate, "stage-" + stageId + ":integrate");
  const stageReportOf = (stageId: string) =>
    latest<StageReport>(ctx, outputs.fmStageReport, "stage-" + stageId + ":report");
  const signoffOf = (stageId: string) => decisionOf(ctx.latest(outputs.fmDecision, "stage-" + stageId + ":signoff"));

  const buildRounds = (slug: string) => ctx.iterationCount(outputs.fmGate, slug + ":gate");
  const reviewRounds = (slug: string) => ctx.iterationCount(outputs.fmArtifact, slug + ":artifact");

  const gateGreen = (slug: string) => rowOk(reworkGateOf(slug) ?? buildGateOf(slug));
  const buildDone = (slug: string) => gateGreen(slug) && reviewOf(slug)?.verdict === "approve";
  const blocked = (slug: string) => implementOf(slug)?.status === "blocked";
  const buildSettled = (slug: string) => buildDone(slug) || blocked(slug) || buildRounds(slug) >= input.buildIterations;
  const reviewSettled = (slug: string) =>
    decisionOfLane(slug) === "approved" || blocked(slug) || reviewRounds(slug) >= input.reviewRounds;

  const depsGreen = (lane: Lane) => lane.dependsOn.every((dep) => gateGreen(dep));
  const laneSettled = (lane: Lane) => (depsGreen(lane) ? buildSettled(lane.slug) && reviewSettled(lane.slug) : true);

  const phaseOf = (lane: Lane): LanePhase =>
    lanePhase({
      hasWorkspace: workspaceOf(lane.slug)?.ready === true,
      implemented: implementOf(lane.slug)?.status === "implemented",
      blocked: blocked(lane.slug),
      gateOk: gateGreen(lane.slug),
      reviewApproved: reviewOf(lane.slug)?.verdict === "approve",
      decision: decisionOfLane(lane.slug),
      buildExhausted: !buildDone(lane.slug) && buildRounds(lane.slug) >= input.buildIterations,
      reviewExhausted: decisionOfLane(lane.slug) !== "approved" && reviewRounds(lane.slug) >= input.reviewRounds,
    });

  const stageLanesSettled = (stage: StageEntry) => stage.lanes.every((lane) => laneSettled(lane));
  const stageDone = (stage: StageEntry) => signoffOf(stage.id) === "approved";

  const stageUnlocked = (index: number): boolean => {
    if (planDecision !== "approved") return false;
    if (index === 0) return true;
    return stageDone(stages[index - 1]);
  };

  const rowsFor = (stage: StageEntry): StageReportRow[] =>
    stage.lanes.map((lane) => ({
      slug: lane.slug,
      title: lane.title,
      repo: lane.repo,
      phase: phaseOf(lane),
      gateOk: gateGreen(lane.slug),
      revision: artifactOf(lane.slug)?.revision ?? 1,
      reportPath: artifactFileName(lane.slug, artifactOf(lane.slug)?.revision ?? 1),
    }));

  const everyStageDone = stages.length > 0 && stages.every((stage) => stageDone(stage));
  const summaryReady =
    everyStageDone ||
    (stages.length > 0 &&
      stages.every((stage) => stageLanesSettled(stage) && stageReportOf(stage.id) !== undefined) &&
      stages.some((stage) => signoffOf(stage.id) === "denied"));

  return (
    <Workflow name="flows-migration">
      <UI entry="../ui/flows-migration.tsx" title="Flows Migration" />
      <Sequence>
        <Task id="preflight" output={outputs.fmPreflight} timeoutMs={SETUP_TIMEOUT_MS}>
          {() => runPreflight(input)}
        </Task>

        {preflight?.ok && !input.ledgerJson ? (
          <Task
            id="ledger"
            output={outputs.fmLedger}
            agent={pool(ctx.runId, smithersRoot, plannerModels)}
            retries={AGENT_RETRIES}
            timeoutMs={PLAN_TIMEOUT_MS}
            heartbeatTimeoutMs={HEARTBEAT_MS}
          >
            {ledgerPrompt(input, preflight)}
          </Task>
        ) : null}

        {ledger ? (
          <Approval
            id="plan-approval"
            output={outputs.fmDecision}
            request={{
              title: "Flows migration plan: " + ledger.missionTitle,
              summary:
                ledger.summary +
                "\n\n" +
                ledger.stages
                  .map((stage) => "Stage " + stage.id + " (" + stage.lanes.length + " lanes): " + stage.title)
                  .join("\n") +
                "\n\nApprove to start stage " +
                (ledger.stages[0]?.id ?? "0") +
                ". Deny with a note to stop and re-plan.",
            }}
          />
        ) : null}

        {stages.map((stage, stageIndex) => {
          if (!stageUnlocked(stageIndex)) return null;
          return (
            <Sequence key={"stage-" + stage.id}>
              <Parallel maxConcurrency={input.laneConcurrency}>
                {stage.lanes.map((lane) => {
                  if (!depsGreen(lane)) return null;
                  const slug = lane.slug;
                  const workspace = workspaceOf(slug);
                  const laneCwd = workspace?.dir || laneDirFor(repoRootFor(lane, input), key, slug);
                  return (
                    <Sequence key={"lane-" + slug}>
                      <Task id={slug + ":workspace"} output={outputs.fmWorkspace} timeoutMs={SETUP_TIMEOUT_MS}>
                        {() => createLaneWorkspace(lane, input, key)}
                      </Task>

                      {workspace?.ready ? (
                        <Sequence>
                          <Loop
                            id={slug + ":build"}
                            until={buildDone(slug) || blocked(slug)}
                            maxIterations={input.buildIterations}
                            onMaxReached="return-last"
                          >
                            <Sequence>
                              <Task
                                id={slug + ":implement"}
                                output={outputs.fmImplement}
                                agent={pool(ctx.runId, laneCwd, implementerModels)}
                                retries={AGENT_RETRIES}
                                timeoutMs={IMPLEMENT_TIMEOUT_MS}
                                heartbeatTimeoutMs={HEARTBEAT_MS}
                                continueOnFail
                              >
                                {implementPrompt({
                                  lane,
                                  stage,
                                  input,
                                  workspace,
                                  gateFeedback: gateGreen(slug) ? "" : (buildGateOf(slug)?.detail ?? ""),
                                  reviewFeedback:
                                    reviewOf(slug)?.verdict === "reject" ? (reviewOf(slug)?.feedback ?? "") : "",
                                })}
                              </Task>
                              <Task
                                id={slug + ":gate"}
                                output={outputs.fmGate}
                                timeoutMs={GATE_TIMEOUT_MS}
                                continueOnFail
                              >
                                {() => runLaneGate(lane, laneCwd, slug + ":build")}
                              </Task>
                              <Task
                                id={slug + ":review"}
                                output={outputs.fmReview}
                                agent={pool(ctx.runId, laneCwd, reviewerModels)}
                                retries={AGENT_RETRIES}
                                timeoutMs={REVIEW_TIMEOUT_MS}
                                heartbeatTimeoutMs={HEARTBEAT_MS}
                                continueOnFail
                              >
                                {reviewPrompt({
                                  lane,
                                  workspace,
                                  implement: implementOf(slug),
                                  gate: buildGateOf(slug),
                                })}
                              </Task>
                            </Sequence>
                          </Loop>

                          {buildSettled(slug) ? (
                            <Loop
                              id={slug + ":approve"}
                              until={decisionOfLane(slug) === "approved" || blocked(slug)}
                              maxIterations={input.reviewRounds}
                              onMaxReached="return-last"
                            >
                              <Sequence>
                                {decisionOfLane(slug) === "denied" ? (
                                  <Task
                                    id={slug + ":rework"}
                                    output={outputs.fmImplement}
                                    agent={pool(ctx.runId, laneCwd, implementerModels)}
                                    retries={AGENT_RETRIES}
                                    timeoutMs={IMPLEMENT_TIMEOUT_MS}
                                    heartbeatTimeoutMs={HEARTBEAT_MS}
                                    continueOnFail
                                  >
                                    {implementPrompt({
                                      lane,
                                      stage,
                                      input,
                                      workspace,
                                      gateFeedback: rowOk(reworkGateOf(slug)) ? "" : (reworkGateOf(slug)?.detail ?? ""),
                                      reviewFeedback:
                                        "The human reviewer denied this lane. Their note:\n" +
                                        (decisionNote(decisionRowOf(slug)) || "(no note given)"),
                                    })}
                                  </Task>
                                ) : null}
                                {decisionOfLane(slug) === "denied" ? (
                                  <Task
                                    id={slug + ":rework-gate"}
                                    output={outputs.fmGate}
                                    timeoutMs={GATE_TIMEOUT_MS}
                                    continueOnFail
                                  >
                                    {() => runLaneGate(lane, laneCwd, slug + ":rework")}
                                  </Task>
                                ) : null}
                                <Task
                                  id={slug + ":artifact"}
                                  output={outputs.fmArtifact}
                                  timeoutMs={REPORT_TIMEOUT_MS}
                                  continueOnFail
                                >
                                  {() =>
                                    writeLaneReport({
                                      lane,
                                      key,
                                      missionTitle,
                                      revision: reviewRounds(slug) + 1,
                                      phase: phaseOf(lane),
                                      gate: reworkGateOf(slug) ?? buildGateOf(slug),
                                      implement: implementOf(slug),
                                      review: reviewOf(slug),
                                    })
                                  }
                                </Task>
                                <Approval
                                  id={slug + ":approval"}
                                  output={outputs.fmDecision}
                                  onDeny="continue"
                                  request={{
                                    title:
                                      "Stage " +
                                      stage.id +
                                      " lane " +
                                      slug +
                                      " r" +
                                      (artifactOf(slug)?.revision ?? reviewRounds(slug) + 1),
                                    summary:
                                      lane.title +
                                      " (" +
                                      lane.repo +
                                      ")\nGate: " +
                                      summarizeGate(reworkGateOf(slug) ?? buildGateOf(slug)) +
                                      "\nReview: " +
                                      (reviewOf(slug)?.verdict ?? "none") +
                                      "\nReport: " +
                                      (artifactOf(slug)?.artifactPath ?? "pending") +
                                      "\nWorkspace: " +
                                      laneCwd +
                                      "\n\nApprove to accept this lane. Deny WITH A NOTE to trigger a rework.",
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

              {stageLanesSettled(stage) ? (
                <Task
                  id={"stage-" + stage.id + ":integrate"}
                  output={outputs.fmIntegrate}
                  agent={pool(ctx.runId, smithersRoot, integratorModels)}
                  retries={AGENT_RETRIES}
                  timeoutMs={INTEGRATE_TIMEOUT_MS}
                  heartbeatTimeoutMs={HEARTBEAT_MS}
                  continueOnFail
                >
                  {integratePrompt({
                    stage,
                    lanes: stage.lanes.filter((lane) => decisionOfLane(lane.slug) === "approved"),
                    input,
                    key,
                  })}
                </Task>
              ) : null}

              {integrateOf(stage.id) !== undefined ? (
                <Task
                  id={"stage-" + stage.id + ":report"}
                  output={outputs.fmStageReport}
                  timeoutMs={REPORT_TIMEOUT_MS}
                  continueOnFail
                >
                  {() =>
                    writeStageReport({
                      key,
                      missionTitle,
                      stage,
                      rows: rowsFor(stage),
                      integrate: integrateOf(stage.id),
                    })
                  }
                </Task>
              ) : null}

              {stageReportOf(stage.id) !== undefined ? (
                <Approval
                  id={"stage-" + stage.id + ":signoff"}
                  output={outputs.fmDecision}
                  onDeny="continue"
                  request={{
                    title: "Stage " + stage.id + " sign-off: " + stage.title,
                    summary:
                      (integrateOf(stage.id)?.summary ?? "") +
                      "\nIntegration: " +
                      (rowOk(integrateOf(stage.id)) ? "green" : "FAILING") +
                      "\nLanes approved: " +
                      String(stageReportOf(stage.id)?.lanesApproved ?? 0) +
                      "/" +
                      String(stageReportOf(stage.id)?.lanesTotal ?? stage.lanes.length) +
                      "\nReport: " +
                      (stageReportOf(stage.id)?.reportPath ?? "") +
                      "\n\nApprove to unlock the next stage. Deny to stop here.",
                  }}
                />
              ) : null}
            </Sequence>
          );
        })}

        {summaryReady ? (
          <Task id="summary" output={outputs.fmSummary} timeoutMs={REPORT_TIMEOUT_MS}>
            {() => {
              const lanes = stages.flatMap((stage) => stage.lanes);
              const details = stages.map((stage) => ({
                stage: stage.id,
                title: stage.title,
                signoff: signoffOf(stage.id),
                lanes: stage.lanes.map((lane) => ({ slug: lane.slug, phase: phaseOf(lane) })),
                report: stageReportOf(stage.id)?.reportPath ?? "",
              }));
              const approved = lanes.filter((lane) => decisionOfLane(lane.slug) === "approved").length;
              return {
                stagesDone: stages.filter((stage) => stageDone(stage)).length,
                lanesTotal: lanes.length,
                lanesApproved: approved,
                detailsJson: JSON.stringify(details),
                summary:
                  approved +
                  "/" +
                  lanes.length +
                  " lanes approved across " +
                  stages.length +
                  " stages. Reports in " +
                  reportsDirFor(smithersRoot, key),
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});

/** Parse a hand-supplied ledger, returning null when it is unusable. */
function safeLedger(json: string, input: Input, selected: readonly string[]): Ledger | null {
  try {
    return parseLedger(JSON.parse(json), { maxLanesPerStage: input.maxLanesPerStage, stages: selected });
  } catch {
    return null;
  }
}
