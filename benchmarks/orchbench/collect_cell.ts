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
const terminal = [...events].reverse().find((e) =>
  ["RunFinished", "RunFailed", "RunCancelled"].includes(e.type),
);
const status = terminal?.type ?? "unknown";
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
const stages: Record<string, { startMs: number; endMs: number; attempts: number }> = {};
for (const e of events) {
  const nodeId = (e.payload as { nodeId?: string }).nodeId;
  if (!nodeId) continue;
  if (e.type === "NodeStarted") {
    stages[nodeId] ??= { startMs: e.timestampMs, endMs: e.timestampMs, attempts: 0 };
    stages[nodeId].startMs = Math.min(stages[nodeId].startMs, e.timestampMs);
    stages[nodeId].attempts += 1;
  }
  if (["NodeFinished", "NodeFailed", "NodeCancelled"].includes(e.type) && stages[nodeId]) {
    stages[nodeId].endMs = Math.max(stages[nodeId].endMs, e.timestampMs);
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
  const rawInput = Number(p.inputTokens ?? 0);
  const cacheRead = Number(p.cacheReadTokens ?? 0);
  const cacheWrite = Number(p.cacheWriteTokens ?? 0);
  const inclusive = cacheRead > 0 && rawInput >= cacheRead;
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
const scoreJson = join(workDir, "score.json");
if (existsSync(scoreJson)) {
  const s = JSON.parse(readFileSync(scoreJson, "utf8"));
  reward = Number(s.reward ?? 0);
  rewardMeta = s;
} else {
  // scorer never ran (run failed/cancelled before the terminal task) — score
  // the workspace directly through the identical official path.
  try {
    const out = execFileSync(
      "bash",
      [join(HARNESS, "score.sh"), manifest.image, manifest.repoDir, manifest.testsDir, join(workDir, "score")],
      { encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    reward = Number.parseFloat(out.trim().split("\n").pop() ?? "0") || 0;
    try {
      rewardMeta = JSON.parse(readFileSync(join(workDir, "score", "reward.json"), "utf8"));
    } catch {
      /* keep {} */
    }
  } catch {
    reward = 0;
  }
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
try {
  execFileSync(
    "python3",
    [join(HARNESS, "audit_run.py"), eventsDir, manifest.repoDir, resolve(manifest.testsDir, ".."), join(workDir, "audit.json")],
    { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  audit = JSON.parse(readFileSync(join(workDir, "audit.json"), "utf8"));
} catch (err) {
  audit = { tainted: null, error: String(err).slice(0, 500) };
}

// ---- result --------------------------------------------------------------
const result = {
  runId,
  slug,
  pattern,
  status,
  reward,
  resolved: Math.abs(reward - 1.0) < 1e-9,
  wallS: Math.max(0, Math.round((endMs - startMs - quotaStallMs) / 1000)),
  wallRawS: Math.max(0, Math.round((endMs - startMs) / 1000)),
  quotaStallS: Math.round(quotaStallMs / 1000),
  quotaPoisoned: quotaStallMs > 0,
  costUsd: Math.round(costUsd * 10000) / 10000,
  usageByModel,
  stages: Object.fromEntries(
    Object.entries(stages).map(([id, s]) => [
      id,
      { durS: Math.round((s.endMs - s.startMs) / 1000), attempts: s.attempts },
    ]),
  ),
  tainted: (audit as { tainted?: boolean | null }).tainted ?? null,
  auditSignals: (audit as { signals?: unknown[] }).signals ?? [],
  rewardMeta,
  collectedAt: new Date().toISOString(),
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
