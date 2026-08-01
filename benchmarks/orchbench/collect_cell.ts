// Collect one OrchBench cell (run) into a result JSON: reward, wall-clock,
// per-stage timings, token usage -> API-equivalent USD, quota stalls, audit.
// Usage: bun benchmarks/orchbench/collect_cell.ts <runId> <slug> <pattern> <manifest.json> <out.json>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateCostUsd } from "../../packages/scorers/src/estimateCostUsd.js";

const [runId, slug, pattern, manifestPath, outPath] = process.argv.slice(2);
if (!outPath) {
  console.error("usage: collect_cell.ts <runId> <slug> <pattern> <manifest.json> <out.json>");
  process.exit(2);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HARNESS = join(ROOT, "benchmarks", "roadmapbench", "harness");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const workDir: string = manifest.workDir;

const cli = (args: string[], timeoutMs = 120_000): string => {
  try {
    return execFileSync("bun", ["run", join(ROOT, "apps/cli/src/index.js"), ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    return e.stdout ?? "";
  }
};

// ---- events dump (also feeds the auditor) --------------------------------
const eventsDir = join(workDir, "events");
mkdirSync(eventsDir, { recursive: true });
const eventsRaw = cli(["events", runId, "--raw", "--json", "--limit", "100000"], 300_000);
writeFileSync(join(eventsDir, "events.jsonl"), eventsRaw);
const eventLineCount = eventsRaw.split("\n").filter((line) => line.trim().startsWith("{")).length;
const eventsTruncated = eventLineCount >= 100_000;

type Ev = { seq: number; timestampMs: number; type: string; payload: Record<string, unknown> };
const events: Ev[] = eventsRaw
  .split("\n")
  .filter((l) => l.trim().startsWith("{"))
  .map((l) => {
    try {
      return JSON.parse(l) as Ev;
    } catch {
      return null;
    }
  })
  .filter((e): e is Ev => e !== null);

// ---- status + wall clock -------------------------------------------------
const started = events.find((e) => e.type === "RunStarted");
const terminal = [...events].reverse().find((e) => ["RunFinished", "RunFailed", "RunCancelled"].includes(e.type));
const status = eventsTruncated ? "events-truncated" : (terminal?.type ?? "unknown");
const startMs = started?.timestampMs ?? 0;
const endMs = terminal?.timestampMs ?? events.at(-1)?.timestampMs ?? startMs;

// quota stalls: intervals where the run state left "running" for a quota wait
let quotaStallMs = 0;
{
  let stallStart: number | null = null;
  for (const e of events) {
    if (e.type !== "RunStateChanged" && e.type !== "RunStatusChanged") continue;
    const to = String(
      (e.payload as { to?: string; status?: string; state?: string }).to ??
        (e.payload as { status?: string }).status ??
        (e.payload as { state?: string }).state ??
        "",
    );
    if (to.includes("quota")) {
      stallStart ??= e.timestampMs;
    } else if (stallStart !== null) {
      quotaStallMs += e.timestampMs - stallStart;
      stallStart = null;
    }
  }
  if (stallStart !== null) quotaStallMs += endMs - stallStart;
}

// ---- per-stage timings ---------------------------------------------------
const stages: Record<string, { startMs: number; endMs: number; attempts: number; terminal: string | null }> = {};
for (const e of events) {
  const nodeId = (e.payload as { nodeId?: string }).nodeId;
  if (!nodeId) continue;
  if (e.type === "NodeStarted") {
    stages[nodeId] ??= { startMs: e.timestampMs, endMs: e.timestampMs, attempts: 0, terminal: null };
    stages[nodeId].startMs = Math.min(stages[nodeId].startMs, e.timestampMs);
    stages[nodeId].attempts += 1;
  }
  if (["NodeFinished", "NodeFailed", "NodeCancelled"].includes(e.type) && stages[nodeId]) {
    stages[nodeId].endMs = Math.max(stages[nodeId].endMs, e.timestampMs);
    stages[nodeId].terminal = e.type;
  }
}

// ---- token usage -> USD --------------------------------------------------
// Codex CLI reports inputTokens INCLUSIVE of cacheReadTokens; estimateCostUsd
// expects UNCACHED input + cache categories separately. Normalize: when the
// reported input already covers the cache reads, subtract them; otherwise
// (Anthropic-style exclusive reporting) pass through unchanged.
const usageByModel: Record<
  string,
  { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; events: number }
> = {};
const stageExecution: Record<string, { models: Set<string>; agents: Set<string> }> = {};
let costUsd = 0;
for (const e of events) {
  if (e.type !== "TokenUsageReported") continue;
  const p = e.payload as {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  const model = String(p.model ?? "unknown");
  const nodeId = String((e.payload as { nodeId?: string }).nodeId ?? "unknown");
  const agent = String((e.payload as { agent?: string }).agent ?? "unknown");
  const execution = (stageExecution[nodeId] ??= { models: new Set(), agents: new Set() });
  execution.models.add(model);
  execution.agents.add(agent);
  const rawInput = Number(p.inputTokens ?? 0);
  const cacheRead = Number(p.cacheReadTokens ?? 0);
  const cacheWrite = Number(p.cacheWriteTokens ?? 0);
  // Codex reports input inclusive of cache reads; Claude reports uncached
  // input separately. A magnitude heuristic misclassifies large Claude turns.
  const inclusive = model.startsWith("gpt-5.6-") && cacheRead > 0 && rawInput >= cacheRead;
  const uncachedInput = inclusive ? rawInput - cacheRead - Math.min(cacheWrite, rawInput - cacheRead) : rawInput;
  const outputTokens = Number(p.outputTokens ?? 0);
  const m = (usageByModel[model] ??= {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    events: 0,
  });
  m.inputTokens += uncachedInput;
  m.outputTokens += outputTokens;
  m.cacheReadTokens += cacheRead;
  m.cacheWriteTokens += cacheWrite;
  m.events += 1;
  costUsd += estimateCostUsd({
    model,
    inputTokens: uncachedInput,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  });
}

// ---- reward --------------------------------------------------------------
let reward = 0;
let rewardMeta: Record<string, unknown> = {};
let rewardError: string | null = null;
let checkpointError: string | null = null;
let implementationReward: number | null = null;
let implementationRewardMeta: Record<string, unknown> | null = null;
const parseReward = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} is not a finite reward in [0,1]: ${String(value)}`);
  }
  return value;
};
const implementationScoreJson = join(workDir, "score-implementation.json");
if (existsSync(implementationScoreJson)) {
  try {
    const s = JSON.parse(readFileSync(implementationScoreJson, "utf8"));
    implementationReward = parseReward(s.reward, "implementation reward");
    implementationRewardMeta = s;
  } catch (err) {
    checkpointError = String(err).slice(0, 2000);
  }
}
const scoreJson = join(workDir, "score.json");
if (existsSync(scoreJson)) {
  try {
    const s = JSON.parse(readFileSync(scoreJson, "utf8"));
    reward = parseReward(s.reward, "final reward");
    rewardMeta = s;
  } catch (err) {
    rewardError = String(err).slice(0, 2000);
  }
} else {
  // scorer never ran (run failed/cancelled before the terminal task) — score
  // the workspace directly through the identical official path.
  try {
    const out = execFileSync(
      "bash",
      [join(HARNESS, "score.sh"), manifest.image, manifest.repoDir, manifest.testsDir, join(workDir, "score")],
      { encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const parsedReward = Number.parseFloat(out.trim().split("\n").pop() ?? "");
    reward = parseReward(parsedReward, "grader stdout reward");
    rewardMeta = JSON.parse(readFileSync(join(workDir, "score", "reward.json"), "utf8"));
    const metadataReward = parseReward(rewardMeta.reward, "grader metadata reward");
    if (Math.abs(metadataReward - reward) > 1e-12) {
      throw new Error(`grader stdout/metadata mismatch: ${reward} != ${metadataReward}`);
    }
  } catch (err) {
    rewardError = String(err).slice(0, 2000);
  }
}

const pipelinePatterns = new Set([
  "sol-sol-sol",
  "sol-terra-sol",
  "plan-impl-review",
  "plan-impl-review-blind",
  "sol-work-sol-review",
  "sol-work-fable-review",
  "fable-fable-fable",
  "fable-plan-impl-review",
]);
if (status === "RunFinished" && pipelinePatterns.has(pattern) && implementationReward === null) {
  checkpointError ??= "finished pipeline has no valid implementation checkpoint reward";
}

const expectedStages = pattern.startsWith("solo-")
  ? ["solo"]
  : pattern.startsWith("sol-work-")
    ? ["work", "implementation-score", "review"]
    : pipelinePatterns.has(pattern)
      ? ["plan", "implement", "implementation-score", "review"]
      : [];
let protocolError: string | null = null;
if (status === "RunFinished") {
  const invalidStages = expectedStages.filter((id) => !stages[id] || stages[id].attempts !== 1);
  if (invalidStages.length > 0) protocolError = `missing or repeated stages: ${invalidStages.join(", ")}`;
}

// ---- diff + audit --------------------------------------------------------
try {
  const diff = execFileSync("git", ["-C", manifest.repoDir, "diff", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  writeFileSync(join(workDir, "agent.diff"), diff);
} catch {
  /* best effort */
}
let audit: Record<string, unknown> = { tainted: null, error: "audit not run" };
let auditError: string | null = null;
try {
  execFileSync(
    "python3",
    [
      join(HARNESS, "audit_run.py"),
      eventsDir,
      manifest.repoDir,
      resolve(manifest.testsDir, ".."),
      join(workDir, "audit.json"),
    ],
    { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  audit = JSON.parse(readFileSync(join(workDir, "audit.json"), "utf8"));
} catch (err) {
  auditError = String(err).slice(0, 500);
  try {
    audit = JSON.parse(readFileSync(join(workDir, "audit.json"), "utf8"));
  } catch {
    audit = { tainted: null, error: auditError };
  }
}

// ---- foreign contention flag ---------------------------------------------
// The driver records foreign workflows/provider clients and host-pressure
// violations into workDir at launch and during execution.
let foreignContention: string[] = [];
try {
  foreignContention = readFileSync(join(workDir, "foreign-at-launch.txt"), "utf8").split("\n").filter(Boolean);
} catch {
  /* none recorded */
}
try {
  foreignContention.push(...readFileSync(join(workDir, "foreign-during-run.txt"), "utf8").split("\n").filter(Boolean));
  foreignContention = [...new Set(foreignContention)];
} catch {
  /* none recorded */
}

// ---- result --------------------------------------------------------------
const result = {
  runId,
  slug,
  pattern,
  status: rewardError
    ? "scorer-failed"
    : checkpointError
      ? "checkpoint-failed"
      : protocolError
        ? "protocol-invalid"
        : status,
  reward,
  implementationReward,
  reviewDelta: implementationReward === null ? null : reward - implementationReward,
  resolved: Math.abs(reward - 1.0) < 1e-9,
  wallS: Math.max(0, Math.round((endMs - startMs - quotaStallMs) / 1000)),
  modelWallS: Math.max(
    0,
    Math.round(
      (endMs -
        startMs -
        quotaStallMs -
        ((stages["implementation-score"]?.endMs ?? 0) - (stages["implementation-score"]?.startMs ?? 0))) /
        1000,
    ),
  ),
  wallRawS: Math.max(0, Math.round((endMs - startMs) / 1000)),
  quotaStallS: Math.round(quotaStallMs / 1000),
  quotaPoisoned: quotaStallMs > 0,
  costUsd: Math.round(costUsd * 10000) / 10000,
  foreignContention,
  timingClean: foreignContention.length === 0,
  usageByModel,
  stageExecution: Object.fromEntries(
    Object.entries(stageExecution).map(([id, execution]) => [
      id,
      { models: [...execution.models].sort(), agents: [...execution.agents].sort() },
    ]),
  ),
  stages: Object.fromEntries(
    Object.entries(stages).map(([id, s]) => [
      id,
      { durS: Math.round((s.endMs - s.startMs) / 1000), attempts: s.attempts, terminal: s.terminal },
    ]),
  ),
  tainted: (audit as { tainted?: boolean | null }).tainted ?? null,
  auditSignals: (audit as { signals?: unknown[] }).signals ?? [],
  auditError,
  smoke: manifest.smoke === true,
  panelThird: manifest.panelThird ?? null,
  balancedOrder: manifest.balancedOrder === true,
  eventsTruncated,
  eventLineCount,
  rewardMeta,
  rewardError,
  checkpointError,
  protocolError,
  implementationRewardMeta,
  resultSchemaVersion: 2,
  workflowHash: manifest.workflowHash ?? null,
  protocolHash: manifest.protocolHash ?? null,
  taskOrdinal: manifest.taskOrdinal ?? null,
  plannedPatternOrder: manifest.plannedPatternOrder ?? null,
  patternPosition: manifest.patternPosition ?? null,
  launchStartedAt: manifest.launchStartedAt ?? null,
  validationReceiptSha256: manifest.validationReceiptSha256 ?? null,
  selectedSampleSha256: manifest.selectedSampleSha256 ?? null,
  collectedAt: new Date().toISOString(),
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
