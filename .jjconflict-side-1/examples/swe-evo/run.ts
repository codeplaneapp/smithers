/**
 * SWE-EVO benchmark runner.
 *
 * Runs the SWE-EVO workflow over a set of instances and aggregates the two
 * paper metrics — Resolved Rate and Fix Rate — exactly as defined in
 * arXiv:2512.18470. By default it drives runs through a real Smithers Gateway
 * (the same server the studio/CLI use); pass --direct to run in-process via
 * runWorkflow for quick iteration.
 *
 * Usage:
 *   bun run.ts <instance_id|repo>...        # specific instances / repos
 *   bun run.ts --subset subset.txt          # ids from a file (one per line)
 *   bun run.ts --all                        # all 48 instances
 *   bun run.ts ... --direct                 # in-process instead of gateway
 *   bun run.ts ... --concurrency 2          # parallel instances
 *   bun run.ts ... --report report.json     # where to write the report
 */

import { Effect } from "effect";
import { runWorkflow } from "@smithers-orchestrator/engine";
import { loadOutputs } from "@smithers-orchestrator/db/snapshot";
import { Gateway } from "@smithers-orchestrator/server/gateway";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSweEvo, schemas } from "./workflow/swe-evo.tsx";
import { createSweEvoPanel } from "./workflow/swe-evo-panel.tsx";
import type { Instance } from "./workflow/harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "dataset", "data");
const INSTANCES_DIR = join(DATA, "instances");

type Args = {
  ids: string[];
  all: boolean;
  subset?: string;
  direct: boolean;
  concurrency: number;
  report?: string;
  port: number;
  workflow: "baseline" | "panel";
};

function parseArgs(argv: string[]): Args {
  const a: Args = { ids: [], all: false, direct: false, concurrency: 1, port: 7411, workflow: "baseline" };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--all") a.all = true;
    else if (t === "--direct") a.direct = true;
    else if (t === "--subset") a.subset = argv[++i];
    else if (t === "--concurrency" || t === "-j") a.concurrency = Number(argv[++i]);
    else if (t === "--report" || t === "-r") a.report = argv[++i];
    else if (t === "--port") a.port = Number(argv[++i]);
    else if (t === "--workflow" || t === "-w") a.workflow = argv[++i] as Args["workflow"];
    else a.ids.push(t);
  }
  if (a.workflow !== "baseline" && a.workflow !== "panel") {
    throw new Error(`--workflow must be "baseline" or "panel", got: ${a.workflow}`);
  }
  return a;
}

/**
 * Strip the gold answer + hidden-test metadata from the engine run input.
 *
 * Four fields must never reach the agents and routinely violate the engine's input
 * bounds, failing the whole run with INVALID_INPUT before any agent starts:
 *   - `patch`      (reference solution) and `test_patch` (hidden tests): single
 *     strings that exceed the 64KB-per-string cap (e.g. dvc 1.0.0a1: 227KB/194KB).
 *   - `FAIL_TO_PASS` / `PASS_TO_PASS`: test-name arrays that exceed the 512-item
 *     array cap (e.g. dask 2023.3.2: 6246 PASS_TO_PASS entries).
 *
 * The only consumer of all four is the deterministic `score` node, which reloads
 * the full row from disk via harness.loadInstance() — so none of them need to ride
 * the run input. Keeping them out also stops the gold data from being persisted
 * into the run DB.
 */
function toRunInput(instance: Instance): Instance {
  const {
    patch: _patch,
    test_patch: _testPatch,
    FAIL_TO_PASS: _f2p,
    PASS_TO_PASS: _p2p,
    ...rest
  } = instance as Instance & {
    patch?: string;
    test_patch?: string;
    FAIL_TO_PASS?: unknown;
    PASS_TO_PASS?: unknown;
  };
  return rest as Instance;
}

/** Build the workflow api for the selected variant, with a per-variant DB so
 *  baseline and panel runs never share output tables. */
function createApi(args: Args) {
  const dbPath = join(HERE, ".data", `swe-evo-${args.workflow}.db`);
  return args.workflow === "panel" ? createSweEvoPanel({ dbPath }) : createSweEvo({ dbPath });
}

function allInstances(): Instance[] {
  if (!existsSync(INSTANCES_DIR)) {
    throw new Error(`No dataset at ${INSTANCES_DIR}. Run: bun dataset/load.ts`);
  }
  return readdirSync(INSTANCES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(INSTANCES_DIR, f), "utf8")) as Instance);
}

function selectInstances(args: Args): Instance[] {
  const all = allInstances();
  if (args.all) return all;
  let ids = [...args.ids];
  if (args.subset) {
    ids.push(
      ...readFileSync(args.subset, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    );
  }
  if (ids.length === 0) {
    throw new Error("Select instances: <id|repo>..., --subset <file>, or --all");
  }
  const picked = all.filter((i) => ids.includes(i.instance_id) || ids.includes(i.repo));
  if (picked.length === 0) throw new Error(`No instances matched: ${ids.join(", ")}`);
  return picked;
}

type ScoreRow = Record<string, unknown> & {
  instance_id: string;
  resolved: number;
  fix_rate_pct: number;
  f2p_passed: number;
  f2p_total: number;
  p2p_passed: number;
  p2p_total: number;
  all_p2p_pass: boolean;
};

/** Exact SWE-EVO Fix Rate for one instance, from integer components. */
function exactFixRate(s: ScoreRow): number {
  if (!s.all_p2p_pass) return 0;
  return s.f2p_total > 0 ? s.f2p_passed / s.f2p_total : 1;
}

// loadOutputs reads from the drizzle TABLES (createSmithers().tables), not the
// raw zod schemas — passing schemas yields no columns and silently reads nothing.
async function readScore(db: unknown, tables: unknown, runId: string): Promise<ScoreRow | null> {
  try {
    const out = (await loadOutputs(db as never, tables as never, runId)) as Record<
      string,
      Record<string, unknown>[]
    >;
    const rows = out?.score ?? [];
    return (rows[rows.length - 1] as ScoreRow) ?? null;
  } catch (e: unknown) {
    // A swallowed read error is indistinguishable from a 0-score run, which would
    // silently drive the whole benchmark toward 0%. Surface it on stderr so a
    // systemic DB read failure is visible rather than masquerading as results.
    process.stderr.write(`[score] read failed for ${runId}: ${(e as Error)?.message ?? String(e)}\n`);
    return null;
  }
}

// The engine's terminal run status lives in the internal `_smithers_runs` table,
// not in the user output tables loadOutputs reads. Query it via the raw bun:sqlite
// client so we can tell a genuinely failed/cancelled run from a 0-score run.
function readRunStatus(db: unknown, runId: string): string | null {
  try {
    const client = (db as { $client?: unknown; session?: { client?: unknown } });
    const sqlite = (client.session?.client ?? client.$client ?? db) as {
      query: (sql: string) => { get: (...params: unknown[]) => { status?: string } | null };
    };
    const row = sqlite.query("SELECT status FROM _smithers_runs WHERE run_id = ? LIMIT 1").get(runId);
    return row?.status ?? null;
  } catch (e: unknown) {
    process.stderr.write(`[status] read failed for ${runId}: ${(e as Error)?.message ?? String(e)}\n`);
    return null;
  }
}

async function poolRun<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

type RunOutcome = {
  instance_id: string;
  repo: string;
  status: string;
  score: ScoreRow | null;
  error?: string;
};

async function runDirect(instances: Instance[], args: Args): Promise<RunOutcome[]> {
  const api = createApi(args);
  return poolRun(instances, args.concurrency, async (instance) => {
    const runId = `sweevo-${instance.instance_id}-${Date.now()}`;
    process.stderr.write(`[run] ${instance.instance_id} -> ${runId}\n`);
    try {
      const result: { status: string } = await Effect.runPromise(
        runWorkflow(api.workflow as never, { input: toRunInput(instance), runId, allowNetwork: true }) as never,
      );
      const score = await readScore((api as { db: unknown }).db, (api as { tables: unknown }).tables, runId);
      return { instance_id: instance.instance_id, repo: instance.repo, status: result.status, score };
    } catch (e: unknown) {
      return {
        instance_id: instance.instance_id,
        repo: instance.repo,
        status: "error",
        score: null,
        error: (e as Error)?.message ?? String(e),
      };
    }
  });
}

async function runViaGateway(instances: Instance[], args: Args): Promise<RunOutcome[]> {
  const api = createApi(args);
  const gateway = new Gateway({ heartbeatMs: 15_000 });
  gateway.register("swe-evo", api.workflow as never);
  await gateway.listen({ port: args.port, host: "127.0.0.1" });
  process.stderr.write(`[gateway] listening on http://127.0.0.1:${args.port}\n`);
  const auth = { triggeredBy: "api", scopes: ["*"], role: "operator", tokenId: null };
  try {
    return await poolRun(instances, args.concurrency, async (instance) => {
      const runId = `sweevo-${instance.instance_id}-${Date.now()}`;
      process.stderr.write(`[gateway] launch ${instance.instance_id} -> ${runId}\n`);
      try {
        await (gateway as never as {
          startRun: (k: string, i: unknown, a: unknown, r: string, o: unknown) => Promise<unknown>;
        }).startRun("swe-evo", toRunInput(instance), auth, runId, { resume: false });
        // The inflight promise reliably resolves only after the run completes, but
        // the gateway deliberately erases its status/error (it stores
        // runPromise.then(() => undefined, () => undefined)), so we cannot read the
        // outcome from it. Await it purely as a completion barrier, then read the
        // terminal status from the DB.
        const inflight = (gateway as never as { inflightRuns: Map<string, Promise<unknown>> })
          .inflightRuns.get(runId);
        if (inflight) await inflight;
        const runStatus = readRunStatus((api as { db: unknown }).db, runId);
        const score = await readScore((api as { db: unknown }).db, (api as { tables: unknown }).tables, runId);
        // A failed/cancelled run must not be counted as a legitimate 0-score: surface
        // it as an explicit error with a null score so aggregate() doesn't conflate it.
        if (runStatus === "failed" || runStatus === "cancelled") {
          return {
            instance_id: instance.instance_id,
            repo: instance.repo,
            status: runStatus,
            score: null,
            error: `gateway run ${runStatus}`,
          };
        }
        return {
          instance_id: instance.instance_id,
          repo: instance.repo,
          status: runStatus ?? (score ? "finished" : "unknown"),
          score,
        };
      } catch (e: unknown) {
        return {
          instance_id: instance.instance_id,
          repo: instance.repo,
          status: "error",
          score: null,
          error: (e as Error)?.message ?? String(e),
        };
      }
    });
  } finally {
    try {
      await (gateway as never as { close?: () => Promise<void> }).close?.();
    } catch {
      /* ignore */
    }
  }
}

function aggregate(outcomes: RunOutcome[]) {
  const scored = outcomes.filter((o) => o.score);
  const n = outcomes.length;
  const resolved = scored.reduce((s, o) => s + (o.score!.resolved ? 1 : 0), 0);
  const fixSum = scored.reduce((s, o) => s + exactFixRate(o.score!), 0);
  // Metrics are averaged over ALL selected instances (a run that errored or
  // produced no score counts as 0) — never silently dropped.
  return {
    instances: n,
    scored: scored.length,
    resolved_count: resolved,
    resolved_rate_pct: n ? Number(((100 * resolved) / n).toFixed(2)) : 0,
    fix_rate_pct: n ? Number(((100 * fixSum) / n).toFixed(2)) : 0,
  };
}

function printTable(outcomes: RunOutcome[]) {
  console.log("\n" + "=".repeat(92));
  console.log(
    `${"instance".padEnd(42)} ${"resolved".padEnd(9)} ${"fix".padEnd(7)} ${"F2P".padEnd(9)} ${"P2P".padEnd(11)} status`,
  );
  console.log("-".repeat(92));
  for (const o of outcomes) {
    const s = o.score;
    const resolved = s ? (s.resolved ? "✓" : "✗") : "—";
    const fix = s ? `${Math.round(exactFixRate(s) * 100)}%` : "—";
    const f2p = s ? `${s.f2p_passed}/${s.f2p_total}` : "—";
    const p2p = s ? `${s.p2p_passed}/${s.p2p_total}` : "—";
    console.log(
      `${o.instance_id.padEnd(42)} ${resolved.padEnd(9)} ${fix.padEnd(7)} ${String(f2p).padEnd(9)} ${String(p2p).padEnd(11)} ${o.status}${o.error ? " " + o.error.slice(0, 30) : ""}`,
    );
  }
  console.log("=".repeat(92));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const instances = selectInstances(args);
  process.stderr.write(
    `[swe-evo] workflow=${args.workflow}, ${instances.length} instance(s), mode=${args.direct ? "direct" : "gateway"}, concurrency=${args.concurrency}\n`,
  );

  const outcomes = args.direct ? await runDirect(instances, args) : await runViaGateway(instances, args);

  printTable(outcomes);
  const summary = aggregate(outcomes);
  console.log("\nSUMMARY (SWE-EVO metrics):");
  console.log(`  Instances run : ${summary.instances}`);
  console.log(`  Resolved      : ${summary.resolved_count}/${summary.instances}  (Resolved Rate ${summary.resolved_rate_pct}%)`);
  console.log(`  Fix Rate      : ${summary.fix_rate_pct}%`);

  const report = {
    generatedAt: new Date().toISOString(),
    workflow: args.workflow,
    mode: args.direct ? "direct" : "gateway",
    models:
      args.workflow === "panel"
        ? {
            orchestration: "Panel(plan) + ReviewLoop(implement/review)",
            planners: `Opus + Codex${process.env.SWEEVO_GEMINI !== "0" ? " + Gemini" : ""} (moderator: Opus)`,
            implement: `${process.env.SWEEVO_CODEX_MODEL ?? "gpt-5.5"} (Codex 5.5)`,
            review: `Opus${process.env.SWEEVO_GEMINI !== "0" ? " + Gemini" : ""}`,
          }
        : {
            implement: process.env.SWEEVO_CLAUDE_MODEL ?? "opus (Claude Opus 4.8, claude-code)",
            refine: process.env.SWEEVO_CODEX_MODEL ?? "gpt-5.5 (Codex)",
          },
    summary,
    results: outcomes,
  };
  const reportPath = args.report ?? join(HERE, ".data", `swe-evo-${args.workflow}.report.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${reportPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
