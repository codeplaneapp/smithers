/**
 * SWE-EVO results + official-comparison generator.
 *
 * Reads one or more run reports written by run.ts (`--report <path>`), computes
 * Resolved Rate (RR) and Fix Rate (FR) overall and per repo, diffs runs against
 * each other (e.g. baseline vs panel), and compares against the official
 * SWE-EVO leaderboard (official-results.json, from arXiv:2512.18470 Table 2).
 *
 * Usage:
 *   bun report.ts .data/swe-evo-baseline.report.json .data/swe-evo-panel.report.json
 *   bun report.ts .data/*.report.json --out .data/RESULTS.md
 *
 * With no report args it auto-discovers *.report.json under .data/.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, ".data");

type ScoreRow = {
  resolved: number;
  fix_rate_pct: number;
  f2p_passed: number;
  f2p_total: number;
  p2p_passed: number;
  p2p_total: number;
  all_p2p_pass: boolean;
};
type Outcome = {
  instance_id: string;
  repo: string;
  status: string;
  score: ScoreRow | null;
  error?: string;
};
type Report = {
  generatedAt?: string;
  workflow?: string;
  mode?: string;
  models?: Record<string, unknown>;
  summary?: unknown;
  results: Outcome[];
};

/** Exact SWE-EVO Fix Rate for one instance (paper Eq. 1): 0 if any P2P regressed. */
function exactFixRate(s: ScoreRow): number {
  if (!s.all_p2p_pass) return 0;
  return s.f2p_total > 0 ? s.f2p_passed / s.f2p_total : 1;
}

function repoOf(o: Outcome): string {
  // SWE-EVO instance ids look like `iterative__dvc_1.6.3_1.6.4`; the repo short
  // name is the segment after `__` up to the first version-ish token.
  if (o.repo) return o.repo.includes("/") ? o.repo.split("/")[1] : o.repo;
  const m = /__([a-zA-Z0-9-]+)_/.exec(o.instance_id);
  return m ? m[1] : "unknown";
}

type Agg = { n: number; resolved: number; fixSum: number };
function aggregate(outcomes: Outcome[]): Agg {
  let resolved = 0;
  let fixSum = 0;
  for (const o of outcomes) {
    if (o.score) {
      resolved += o.score.resolved ? 1 : 0;
      fixSum += exactFixRate(o.score);
    }
  }
  return { n: outcomes.length, resolved, fixSum };
}
const rr = (a: Agg) => (a.n ? (100 * a.resolved) / a.n : 0);
const fr = (a: Agg) => (a.n ? (100 * a.fixSum) / a.n : 0);
const pct = (x: number) => `${x.toFixed(1)}%`;

function perRepo(outcomes: Outcome[]): Map<string, Agg> {
  const m = new Map<string, Outcome[]>();
  for (const o of outcomes) {
    const k = repoOf(o);
    (m.get(k) ?? m.set(k, []).get(k)!).push(o);
  }
  const out = new Map<string, Agg>();
  for (const [k, v] of m) out.set(k, aggregate(v));
  return out;
}

function loadReport(path: string): Report {
  const r = JSON.parse(readFileSync(path, "utf8")) as Report;
  if (!Array.isArray(r.results)) throw new Error(`${path}: not a run report (no results[])`);
  return r;
}

function discoverReports(): string[] {
  if (!existsSync(DATA)) return [];
  return readdirSync(DATA)
    .filter((f) => f.endsWith(".report.json") || f.endsWith("-measure.json") || /report-\d+\.json$/.test(f))
    .map((f) => join(DATA, f));
}

function main() {
  const argv = process.argv.slice(2);
  let out = join(DATA, "RESULTS.md");
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" || argv[i] === "-o") out = argv[++i];
    else paths.push(argv[i]);
  }
  const reportPaths = paths.length ? paths : discoverReports();
  if (reportPaths.length === 0) {
    console.error("No run reports found. Pass report JSON paths or run the benchmark first.");
    process.exit(1);
  }

  const reports = reportPaths.map((p) => ({ path: p, report: loadReport(p) }));
  const official = JSON.parse(readFileSync(join(HERE, "official-results.json"), "utf8"));

  const lines: string[] = [];
  lines.push("# SWE-EVO on Smithers — Results & Official Comparison");
  lines.push("");
  lines.push(`Generated from ${reports.length} run report(s). Metrics: **Resolved Rate (RR)** = strict all-tests-pass; **Fix Rate (FR)** = soft fraction of FAIL_TO_PASS fixed (0 if any PASS_TO_PASS regresses), exactly per the paper.`);
  lines.push("");

  // --- per-run summary + per-repo ---
  lines.push("## Our runs");
  lines.push("");
  lines.push("| Run (workflow) | Instances | Resolved | RR | FR |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const { report } of reports) {
    const a = aggregate(report.results);
    const wf = report.workflow ?? "baseline";
    lines.push(`| ${wf} | ${a.n} | ${a.resolved}/${a.n} | **${pct(rr(a))}** | ${pct(fr(a))} |`);
  }
  lines.push("");

  for (const { report } of reports) {
    const wf = report.workflow ?? "baseline";
    const byRepo = perRepo(report.results);
    lines.push(`### ${wf} — per repo`);
    lines.push("");
    lines.push("| Repo | n | RR | FR |");
    lines.push("| --- | --- | --- | --- |");
    for (const [repo, a] of [...byRepo].sort((x, y) => y[1].n - x[1].n)) {
      lines.push(`| ${repo} | ${a.n} | ${pct(rr(a))} | ${pct(fr(a))} |`);
    }
    lines.push("");
  }

  // --- A/B if exactly the same instance set appears in 2+ runs ---
  if (reports.length >= 2) {
    lines.push("## A/B (instances scored in every run)");
    lines.push("");
    const idSets = reports.map(({ report }) => new Set(report.results.filter((o) => o.score).map((o) => o.instance_id)));
    const common = [...idSets[0]].filter((id) => idSets.every((s) => s.has(id)));
    if (common.length === 0) {
      lines.push("_No instances were scored in all runs yet._");
    } else {
      const header = ["instance", ...reports.map(({ report }) => report.workflow ?? "baseline")];
      lines.push(`| ${header.join(" | ")} |`);
      lines.push(`| ${header.map(() => "---").join(" | ")} |`);
      for (const id of common.sort()) {
        const cells = reports.map(({ report }) => {
          const o = report.results.find((r) => r.instance_id === id)!;
          return o.score?.resolved ? "✓" : "✗";
        });
        lines.push(`| ${id} | ${cells.join(" | ")} |`);
      }
      lines.push("");
      lines.push("| metric | " + reports.map(({ report }) => report.workflow ?? "baseline").join(" | ") + " |");
      lines.push("| --- | " + reports.map(() => "---").join(" | ") + " |");
      const aggs = reports.map(({ report }) => aggregate(report.results.filter((o) => common.includes(o.instance_id))));
      lines.push("| RR | " + aggs.map((a) => `**${pct(rr(a))}**`).join(" | ") + " |");
      lines.push("| FR | " + aggs.map((a) => pct(fr(a))).join(" | ") + " |");
      lines.push("");
    }
  }

  // --- official comparison ---
  lines.push("## vs official SWE-EVO leaderboard");
  lines.push("");
  lines.push(`> ${official.subset_caveat}`);
  lines.push(`>`);
  lines.push(`> Official source: ${official._source} (${official._url}). N=${official.instances}; 1 instance = ${official.pp_per_instance}pp. ${official.ci_note}`);
  lines.push("");
  const best = reports.reduce(
    (acc, { report }) => {
      const a = aggregate(report.results);
      return rr(a) > acc.rr ? { rr: rr(a), wf: report.workflow ?? "baseline", a } : acc;
    },
    { rr: -1, wf: "", a: { n: 0, resolved: 0, fixSum: 0 } as Agg },
  );
  const board = (official.leaderboard as any[])
    .map((m) => ({ ...m, best: Math.max(m.resolved_openhands ?? 0, m.resolved_sweagent ?? 0) }))
    .sort((a, b) => b.best - a.best);
  lines.push(`Official top: **${official.headline.best_model} = ${official.headline.best_resolved_full48}% Resolved** (full 48). ${official.headline.note}`);
  lines.push("");
  lines.push("| Model / scaffold | Resolved (best) | Notes |");
  lines.push("| --- | --- | --- |");
  // insert our best run in rank order against the official board, clearly marked
  let inserted = false;
  for (const m of board) {
    if (!inserted && best.rr > m.best) {
      lines.push(`| **smithers ${best.wf} (Opus 4.8 + gpt-5.5)** | **${pct(best.rr)}** | ⚠️ dvc subset (n=${best.a.n}), NOT full-48 — not comparable as a rank |`);
      inserted = true;
    }
    lines.push(`| ${m.model} (${m.provider}) | ${m.best.toFixed(2)}% | OpenHands ${m.resolved_openhands}% / SWE-agent ${m.resolved_sweagent}% |`);
  }
  if (!inserted) {
    lines.push(`| **smithers ${best.wf} (Opus 4.8 + gpt-5.5)** | **${pct(best.rr)}** | ⚠️ dvc subset (n=${best.a.n}), NOT full-48 |`);
  }
  lines.push("");
  lines.push("**Reading this honestly:** our number is on the dvc gold-verified subset (the easier, deterministic instances), so it sits above the official full-48 numbers by construction. The load-bearing comparison is the internal A/B (panel vs baseline on identical instances) above; the official board is the directional reference for what full-48 frontier performance looks like (~25% ceiling).");
  lines.push("");

  const md = lines.join("\n");
  writeFileSync(out, md);
  console.log(md);
  console.error(`\n[report] written to ${out}`);
}

main();
