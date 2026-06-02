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
};

function parseArgs(argv: string[]): Args {
  const a: Args = { ids: [], all: false, direct: false, concurrency: 1, port: 7411 };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--all") a.all = true;
    else if (t === "--direct") a.direct = true;
    else if (t === "--subset") a.subset = argv[++i];
    else if (t === "--concurrency" || t === "-j") a.concurrency = Number(argv[++i]);
    else if (t === "--report" || t === "-r") a.report = argv[++i];
    else if (t === "--port") a.port = Number(argv[++i]);
    else a.ids.push(t);
  }
  return a;
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
  } catch {
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
  const api = createSweEvo({ dbPath: join(HERE, ".data", "swe-evo.db") });
  return poolRun(instances, args.concurrency, async (instance) => {
    const runId = `sweevo-${instance.instance_id}-${Date.now()}`;
    process.stderr.write(`[run] ${instance.instance_id} -> ${runId}\n`);
    try {
      const result: { status: string } = await Effect.runPromise(
        runWorkflow(api.workflow as never, { input: instance, runId, allowNetwork: true }) as never,
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
  const api = createSweEvo({ dbPath: join(HERE, ".data", "swe-evo.db") });
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
        }).startRun("swe-evo", instance, auth, runId, { resume: false });
        const inflight = (gateway as never as { inflightRuns: Map<string, Promise<unknown>> })
          .inflightRuns.get(runId);
        const result = (inflight ? await inflight : undefined) as { status?: string } | undefined;
        const score = await readScore((api as { db: unknown }).db, (api as { tables: unknown }).tables, runId);
        return {
          instance_id: instance.instance_id,
          repo: instance.repo,
          status: result?.status ?? (score ? "finished" : "unknown"),
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
    `[swe-evo] ${instances.length} instance(s), mode=${args.direct ? "direct" : "gateway"}, concurrency=${args.concurrency}\n`,
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
    mode: args.direct ? "direct" : "gateway",
    models: {
      implement: process.env.SWEEVO_CLAUDE_MODEL ?? "opus (Claude Opus 4.8, claude-code)",
      refine: process.env.SWEEVO_CODEX_MODEL ?? "gpt-5.5 (Codex)",
    },
    summary,
    results: outcomes,
  };
  const reportPath = args.report ?? join(HERE, ".data", `report-${Date.now()}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${reportPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
