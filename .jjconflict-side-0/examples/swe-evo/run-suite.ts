/**
 * SWE-EVO suite supervisor — runs the benchmark to completion across the Claude
 * 5-hour usage window by PAUSING on rate-limit and RESUMING when capacity returns.
 *
 * Why this exists: the panel workflow is Opus-heavy, so a full-suite run will
 * exhaust the Claude 5h subscription window. The Panel/ReviewLoop components don't
 * expose per-task retry config, and a 5h-limit 429 hard-fails the node. So instead
 * of in-run retries, we supervise at the INSTANCE level:
 *
 *   round:
 *     remaining = targets that have no score row yet      (idempotent: reads the DB)
 *     run.ts (panel) over `remaining`
 *     if all scored -> done
 *     if NO new scores this round -> treat as a global block (rate limit):
 *         wait (escalating, capped at 5h) then retry the same set
 *     if SOME progress but an instance is still unscored after being attempted ->
 *         count it against that instance; drop it after maxInstanceRetries (genuine failure)
 *
 * Because "remaining" is recomputed from the DB each round, the supervisor is
 * crash-safe: kill it and re-run, it picks up exactly where it left off. It never
 * re-runs an instance that already produced a score (resolved or not).
 *
 * Usage:
 *   bun run-suite.ts --subset subset-dvc.txt           # the dvc gold-verified suite
 *   bun run-suite.ts --all                             # every instance (non-dvc may not score on Apple Silicon)
 *   flags: --concurrency N (default 1), --wait-min M (base pause, default 45),
 *          --max-wait-min M (cap, default 300 = 5h), --max-instance-retries N (default 3),
 *          --workflow panel|baseline (default panel)
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCandidate, type Instance } from "./workflow/harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, ".data");
const INSTANCES_DIR = join(HERE, "dataset", "data", "instances");

type Args = {
  subset?: string;
  all: boolean;
  concurrency: number;
  workflow: "panel" | "baseline";
  waitMin: number;
  maxWaitMin: number;
  maxInstanceRetries: number;
  goldVerify: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    all: false,
    concurrency: 1,
    workflow: "panel",
    waitMin: 45,
    maxWaitMin: 300,
    maxInstanceRetries: 3,
    goldVerify: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--all") a.all = true;
    else if (t === "--subset") a.subset = argv[++i];
    else if (t === "--concurrency" || t === "-j") a.concurrency = Number(argv[++i]);
    else if (t === "--workflow" || t === "-w") a.workflow = argv[++i] as Args["workflow"];
    else if (t === "--wait-min") a.waitMin = Number(argv[++i]);
    else if (t === "--max-wait-min") a.maxWaitMin = Number(argv[++i]);
    else if (t === "--max-instance-retries") a.maxInstanceRetries = Number(argv[++i]);
    else if (t === "--gold-verify") a.goldVerify = true;
  }
  return a;
}

const INSTANCE_JSON = (id: string) => join(INSTANCES_DIR, `${id}.json`);
const GOLD_PATCH = (id: string) => join(HERE, "dataset", "data", "gold", `${id}.patch`);

/** Zero-token validity gate: apply each gold patch in Docker; keep only instances
 *  where gold reproduces resolved=1 here (others are env-incompatible under x86
 *  emulation and would produce meaningless agent scores). */
function goldVerifiedTargets(targets: string[]): string[] {
  const timeoutS = Number(process.env.SWEEVO_SCORE_TIMEOUT_S ?? 1800);
  const ok: string[] = [];
  const bad: string[] = [];
  for (const id of targets) {
    let inst: Instance;
    let gold: string;
    try {
      inst = JSON.parse(readFileSync(INSTANCE_JSON(id), "utf8"));
      gold = readFileSync(GOLD_PATCH(id), "utf8");
    } catch {
      console.log(`[${ts()}] gold-verify SKIP ${id} (missing instance/gold file)`);
      bad.push(id);
      continue;
    }
    process.stdout.write(`[${ts()}] gold-verify ${id} ... `);
    try {
      const s = scoreCandidate(inst, gold, timeoutS);
      const pass = s.resolved === 1 && s.fix_rate === 1;
      console.log(`${pass ? "OK" : "ENV-INCOMPATIBLE"} (resolved=${s.resolved} F2P=${s.f2p_passed}/${s.f2p_total} P2P=${s.p2p_passed}/${s.p2p_total})`);
      (pass ? ok : bad).push(id);
    } catch (e) {
      console.log(`ERROR ${(e as Error)?.message?.slice(0, 80)}`);
      bad.push(id);
    }
  }
  console.log(`[${ts()}] gold-verify: ${ok.length}/${targets.length} reproduce; excluded ${bad.length}: ${bad.join(", ") || "(none)"}`);
  return ok;
}

function allInstanceIds(): string[] {
  if (!existsSync(INSTANCES_DIR)) throw new Error(`No dataset at ${INSTANCES_DIR}. Run: bun dataset/load.ts`);
  return readdirSync(INSTANCES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function targetIds(args: Args): string[] {
  const all = allInstanceIds();
  if (args.all) return all;
  if (args.subset) {
    const wanted = readFileSync(args.subset, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    return all.filter((id) => wanted.includes(id));
  }
  throw new Error("Pass --subset <file> or --all");
}

const dbPath = (wf: string) => join(DATA, `swe-evo-${wf}.db`);

/** instance_ids that already have a score row (completed — resolved or not). */
function scoredIds(wf: string): Set<string> {
  const p = dbPath(wf);
  if (!existsSync(p)) return new Set();
  const db = new Database(p, { readonly: true });
  try {
    const rows = db.query("SELECT DISTINCT instance_id FROM score").all() as { instance_id: string }[];
    return new Set(rows.map((r) => r.instance_id));
  } catch {
    return new Set();
  } finally {
    db.close();
  }
}

/** Best-effort: did the last activity look like a Claude usage/rate-limit block? */
function looksRateLimited(wf: string): boolean {
  const p = dbPath(wf);
  if (!existsSync(p)) return false;
  const db = new Database(p, { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT payload_json FROM _smithers_events WHERE timestamp_ms > ? ORDER BY timestamp_ms DESC LIMIT 4000",
      )
      .all(Date.now() - 30 * 60_000) as { payload_json: string }[];
    const re = /rate.?limit|usage limit|5.?hour|limit (will )?reset|too many requests|\b429\b|quota|overloaded/i;
    return rows.some((r) => re.test(r.payload_json ?? ""));
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * Deterministic, non-retryable failures from the last round's report. An input
 * that violates the engine's bounds (INVALID_INPUT) fails identically on every
 * retry, so it must be dropped as a genuine failure rather than mistaken for a
 * throttle: ambient "overloaded"/"429"/"quota" noise in concurrent agent traces
 * can make looksRateLimited() true, which would otherwise pause-and-retry such an
 * instance forever (this is exactly what stalled the 1.0.0a1 / 0.52.1 instances).
 */
const NON_RETRYABLE_RE =
  /INVALID_INPUT|exceeding \d+ characters|must be JSON-serializable|must not contain circular|Run input must be|contains an array exceeding|maximum JSON depth|exceeds the maximum size/i;
function nonRetryableFailures(wf: string): Map<string, string> {
  const out = new Map<string, string>();
  const p = join(DATA, `_round.${wf}.report.json`);
  if (!existsSync(p)) return out;
  try {
    const report = JSON.parse(readFileSync(p, "utf8")) as {
      results?: { instance_id: string; error?: string }[];
    };
    for (const r of report.results ?? []) {
      if (r.error && NON_RETRYABLE_RE.test(r.error)) out.set(r.instance_id, r.error);
    }
  } catch {
    /* best-effort: a missing/garbled round report just means "nothing fatal" */
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/** Build the consolidated full-suite report from the DB: latest score per target,
 *  with un-scored targets recorded as errors (count as 0, per SWE-EVO averaging). */
function buildFullReport(targets: string[], dropped: Set<string>, args: Args) {
  const p = dbPath(args.workflow);
  const byId = new Map<string, any>();
  if (existsSync(p)) {
    const db = new Database(p, { readonly: true });
    try {
      const rows = db
        .query("SELECT * FROM score WHERE rowid IN (SELECT MAX(rowid) FROM score GROUP BY instance_id)")
        .all() as any[];
      for (const r of rows) byId.set(r.instance_id, r);
    } catch {
      /* no score table */
    } finally {
      db.close();
    }
  }
  const results = targets.map((id) => {
    const s = byId.get(id);
    if (s) {
      return {
        instance_id: id,
        repo: s.repo ?? "",
        status: "finished",
        score: {
          resolved: s.resolved,
          fix_rate_pct: s.fix_rate_pct,
          f2p_passed: s.f2p_passed,
          f2p_total: s.f2p_total,
          p2p_passed: s.p2p_passed,
          p2p_total: s.p2p_total,
          all_p2p_pass: !!s.all_p2p_pass,
        },
      };
    }
    return {
      instance_id: id,
      repo: "",
      status: dropped.has(id) ? "error" : "incomplete",
      score: null,
      error: dropped.has(id) ? "dropped after max retries" : "did not complete",
    };
  });
  const resolved = results.filter((r) => r.score?.resolved).length;
  const report = {
    generatedAt: new Date().toISOString(),
    workflow: args.workflow,
    suite: true,
    summary: { instances: targets.length, scored: byId.size, resolved_count: resolved },
    results,
  };
  const out = join(DATA, `swe-evo-${args.workflow}.report.json`);
  Bun.write(out, JSON.stringify(report, null, 2));
  return out;
}

async function runRound(remaining: string[], args: Args): Promise<number> {
  const cmd = [
    "bun",
    "run.ts",
    ...remaining,
    "--workflow",
    args.workflow,
    "--direct",
    "--concurrency",
    String(args.concurrency),
    "--report",
    join(DATA, `_round.${args.workflow}.report.json`), // throwaway; full report built from DB at the end
  ];
  console.log(`[${ts()}] round: launching ${remaining.length} instance(s) @ concurrency ${args.concurrency}`);
  const proc = Bun.spawn(cmd, { cwd: HERE, stdout: "inherit", stderr: "inherit", env: { ...process.env } });
  return await proc.exited;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let targets = targetIds(args);
  if (args.goldVerify) {
    console.log(`[${ts()}] gold-verify pre-pass over ${targets.length} target(s) (zero model tokens)...`);
    targets = goldVerifiedTargets(targets);
    if (targets.length === 0) {
      console.error(`[${ts()}] no instances reproduce gold in this environment — aborting before spending tokens.`);
      process.exit(1);
    }
  }
  console.log(`[${ts()}] SWE-EVO suite supervisor: workflow=${args.workflow}, targets=${targets.length}, concurrency=${args.concurrency}`);
  console.log(`[${ts()}] pause-on-ratelimit: base ${args.waitMin}min, cap ${args.maxWaitMin}min; instance give-up after ${args.maxInstanceRetries} attempts`);

  const failCount = new Map<string, number>();
  const dropped = new Set<string>();
  let waitMin = args.waitMin;
  let round = 0;
  let noProgressStreak = 0;

  while (true) {
    const scored = scoredIds(args.workflow);
    const remaining = targets.filter((id) => !scored.has(id) && !dropped.has(id));
    console.log(`[${ts()}] progress: ${scored.size}/${targets.length} scored, ${remaining.length} remaining, ${dropped.size} dropped`);
    if (remaining.length === 0) break;

    round++;
    const beforeScored = scored.size;
    await runRound(remaining, args);

    const afterScored = scoredIds(args.workflow);
    const progressed = afterScored.size - beforeScored;

    // Drop deterministic, non-retryable failures up front so they never get
    // mistaken for a throttle and retried forever.
    const fatal = nonRetryableFailures(args.workflow);
    for (const id of targets) {
      if (fatal.has(id) && !afterScored.has(id) && !dropped.has(id)) {
        dropped.add(id);
        console.error(`[${ts()}] dropping ${id}: non-retryable error — ${fatal.get(id)}`);
      }
    }
    const stillRemaining = targets.filter((id) => !afterScored.has(id) && !dropped.has(id));

    if (stillRemaining.length === 0) break;

    const rl = looksRateLimited(args.workflow);
    if (rl || progressed === 0) {
      // Rate-limit block, or a stalled round. Either way pause + resume the same
      // set with NO per-instance penalty (a round can make partial progress and
      // THEN hit the 5h window mid-way — those instances aren't failures).
      noProgressStreak = progressed === 0 ? noProgressStreak + 1 : 0;
      if (!rl && noProgressStreak >= 4) {
        console.error(`[${ts()}] ABORT: 4 rounds with no progress and no rate-limit signature — something is broken, not throttled.`);
        break;
      }
      console.log(`[${ts()}] ${rl ? "rate-limit detected" : "no progress"}; pausing ${waitMin} min then resuming ${stillRemaining.length} remaining.`);
      await sleep(waitMin * 60_000);
      waitMin = Math.min(Math.round(waitMin * 1.6), args.maxWaitMin); // escalate toward the 5h cap
    } else {
      // Real progress AND no rate-limit signature -> the attempted-but-unfinished
      // instances are genuine failures. Penalize; drop after maxInstanceRetries.
      noProgressStreak = 0;
      waitMin = args.waitMin; // reset backoff
      for (const id of stillRemaining) {
        const n = (failCount.get(id) ?? 0) + 1;
        failCount.set(id, n);
        if (n >= args.maxInstanceRetries) {
          dropped.add(id);
          console.log(`[${ts()}] dropping ${id} after ${n} failed attempts (genuine failure, not rate-limit).`);
        }
      }
    }
  }

  const finalScored = scoredIds(args.workflow);
  const reportPath = buildFullReport(targets, dropped, args);
  console.log(`[${ts()}] DONE. ${finalScored.size}/${targets.length} instances scored; ${dropped.size} dropped as failures.`);
  if (dropped.size) console.log(`[${ts()}] dropped: ${[...dropped].join(", ")}`);
  console.log(`[${ts()}] full-suite report -> ${reportPath}`);
  console.log(`[${ts()}] generate the scorecard with:  bun report.ts ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
