// Aggregate every eval report under .report/ into a scorecard: pass rate and
// one-shot rate sliced by area/model/tier, plus a ranked list of friction
// themes — the prioritized "docs/APIs to fix" list that is the point of all this.
//
//   bun evals/harness/scorecard.ts            # build SCORECARD.md + print summary
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../lib/paths.js";

const ROOT = repoRoot();
const REPORT_DIR = join(ROOT, "evals", "harness", ".report");

type Friction = { kind?: string; detail?: string; docPointer?: string | null };
type CaseResult = {
  caseId: string;
  passed: boolean;
  status?: string;
  input?: { area?: string; feature?: string; model?: string; taskId?: string };
  metadata?: { area?: string; feature?: string; tier?: string; source?: string };
  output?: {
    candidate?: Array<{ oneShot?: boolean; confidence?: number; friction?: Friction[]; summary?: string }>;
    verdict?: Array<{ score?: number; reason?: string }>;
    quality?: Array<{ score?: number; reason?: string }>;
  };
};
type Report = { suiteId: string; results: CaseResult[] };

type Bucket = { n: number; passed: number; oneShot: number; scoreSum: number; scoreN: number };
const empty = (): Bucket => ({ n: 0, passed: 0, oneShot: 0, scoreSum: 0, scoreN: 0 });

function add(b: Record<string, Bucket>, key: string, r: CaseResult) {
  const bk = (b[key] ??= empty());
  bk.n += 1;
  if (r.passed) bk.passed += 1;
  const cand = r.output?.candidate?.[0];
  if (cand?.oneShot) bk.oneShot += 1;
  const score = r.output?.verdict?.[0]?.score;
  if (typeof score === "number") {
    bk.scoreSum += score;
    bk.scoreN += 1;
  }
}

function pct(num: number, den: number): string {
  return den === 0 ? "—" : `${Math.round((100 * num) / den)}%`;
}

function table(title: string, b: Record<string, Bucket>): string[] {
  const rows = Object.entries(b).sort((a, c) => c[1].n - a[1].n);
  const out = [`### ${title}`, "", "| Key | n | pass | one-shot | mean score |", "| --- | --- | --- | --- | --- |"];
  for (const [k, v] of rows) {
    out.push(`| ${k} | ${v.n} | ${pct(v.passed, v.n)} | ${pct(v.oneShot, v.n)} | ${v.scoreN ? (v.scoreSum / v.scoreN).toFixed(2) : "—"} |`);
  }
  out.push("");
  return out;
}

function main() {
  if (!existsSync(REPORT_DIR)) {
    console.error(`No reports at ${REPORT_DIR}. Run a suite first (bun evals/harness/run-all.ts).`);
    process.exit(1);
  }
  const files = readdirSync(REPORT_DIR).filter((f) => f.endsWith(".json"));
  const reports: Report[] = [];
  for (const f of files) {
    try {
      reports.push(JSON.parse(readFileSync(join(REPORT_DIR, f), "utf8")));
    } catch {
      /* skip unreadable */
    }
  }
  const all: CaseResult[] = reports.flatMap((r) => r.results ?? []);
  if (all.length === 0) {
    console.error("No case results found in reports.");
    process.exit(1);
  }

  const byArea: Record<string, Bucket> = {};
  const byModel: Record<string, Bucket> = {};
  const byTier: Record<string, Bucket> = {};
  const byFeature: Record<string, Bucket> = {};
  const overall = empty();
  const friction: Record<string, { count: number; sample: string; kind: string }> = {};
  const uiQuality: number[] = [];

  for (const r of all) {
    const area = r.metadata?.area ?? r.input?.area ?? "unknown";
    const model = r.input?.model ?? "unknown";
    const tier = r.metadata?.tier ?? "unknown";
    const feature = r.metadata?.feature ?? r.input?.feature ?? "unknown";
    add({ overall }, "overall", r);
    add(byArea, area, r);
    add(byModel, model, r);
    add(byTier, tier, r);
    add(byFeature, feature, r);
    const ui = r.output?.quality?.[0]?.score;
    if (typeof ui === "number") uiQuality.push(ui);
    for (const fr of r.output?.candidate?.[0]?.friction ?? []) {
      const key = `${fr.kind ?? "other"} :: ${(fr.docPointer ?? "?").slice(0, 60)}`;
      const slot = (friction[key] ??= { count: 0, sample: fr.detail ?? "", kind: fr.kind ?? "other" });
      slot.count += 1;
      if (!slot.sample && fr.detail) slot.sample = fr.detail;
    }
  }

  const md: string[] = [];
  md.push("# Fluency Scorecard", "");
  md.push(`> ${all.length} case results across ${reports.length} report(s). Lower one-shot rate = docs that need work.`, "");
  md.push("## Overall", "");
  md.push(`- **Pass rate:** ${pct(overall.passed, overall.n)} (${overall.passed}/${overall.n})`);
  md.push(`- **One-shot rate:** ${pct(overall.oneShot, overall.n)}`);
  md.push(`- **Mean correctness score:** ${overall.scoreN ? (overall.scoreSum / overall.scoreN).toFixed(2) : "—"}`, "");
  if (uiQuality.length > 0) {
    const mean = uiQuality.reduce((a, b) => a + b, 0) / uiQuality.length;
    md.push(`- **UI quality (AI-judged):** ${mean.toFixed(2)} mean over ${uiQuality.length} UI bundle(s)`, "");
  }
  md.push(...table("By model", byModel));
  md.push(...table("By tier", byTier));
  md.push(...table("By area", byArea));

  // Worst features (lowest pass rate, n>=1), ranked.
  const worst = Object.entries(byFeature)
    .filter(([, v]) => v.n >= 1)
    .map(([k, v]) => ({ k, rate: v.passed / v.n, n: v.n }))
    .sort((a, b) => a.rate - b.rate || b.n - a.n)
    .slice(0, 25);
  md.push("## Worst features (fix these first)", "");
  md.push("| Feature | pass | n |", "| --- | --- | --- |");
  for (const w of worst) md.push(`| ${w.k} | ${Math.round(w.rate * 100)}% | ${w.n} |`);
  md.push("");

  // Friction themes → docs to fix.
  const themes = Object.entries(friction).sort((a, b) => b[1].count - a[1].count).slice(0, 30);
  md.push("## Friction themes → docs/APIs to fix (ranked)", "");
  md.push("| × | kind :: doc pointer | sample |", "| --- | --- | --- |");
  for (const [key, v] of themes) md.push(`| ${v.count} | ${key} | ${v.sample.slice(0, 90).replace(/\|/g, "/")} |`);
  md.push("");

  const out = join(REPORT_DIR, "SCORECARD.md");
  writeFileSync(out, md.join("\n") + "\n");
  console.log(`Pass ${pct(overall.passed, overall.n)} · one-shot ${pct(overall.oneShot, overall.n)} · n=${overall.n}`);
  console.log(`Scorecard → ${out}`);
}

if (import.meta.main) main();
