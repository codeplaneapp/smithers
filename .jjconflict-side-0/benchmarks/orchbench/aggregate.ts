// Aggregate OrchBench cell results into per-pattern tradeoff tables.
// Usage: bun benchmarks/orchbench/aggregate.ts [round]   (default r1)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESULTS = join(ROOT, ".context", "orchbench", "results");
const round = process.argv[2] ?? "r1";

type Cell = {
  runId: string;
  slug: string;
  pattern: string;
  status: string;
  reward: number;
  resolved: boolean;
  wallS: number;
  quotaStallS: number;
  quotaPoisoned: boolean;
  costUsd: number;
  usageByModel: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number }>;
  stages: Record<string, { durS: number; attempts: number }>;
  tainted: boolean | null;
};

const cells: Cell[] = readdirSync(RESULTS)
  .filter((f) => f.startsWith(`${round}-`) && f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(RESULTS, f), "utf8")) as Cell);

if (cells.length === 0) {
  console.log(`no ${round} results yet in ${RESULTS}`);
  process.exit(0);
}

const patterns = [...new Set(cells.map((c) => c.pattern))].sort();
const slugs = [...new Set(cells.map((c) => c.slug))].sort();

const fmt = (n: number, d = 2) => n.toFixed(d);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const lines: string[] = [];
lines.push(`# OrchBench ${round} — ${cells.length} cells (${patterns.length} patterns x ${slugs.length} tasks)`);
lines.push("");
lines.push("## Per-pattern aggregate (untainted, unpoisoned cells)");
lines.push("");
lines.push("| pattern | n | mean reward | resolved | mean cost $ | mean wall min | $ per reward pt | flagged |");
lines.push("|---|---|---|---|---|---|---|---|");
for (const p of patterns) {
  const all = cells.filter((c) => c.pattern === p);
  const clean = all.filter((c) => c.tainted !== true && !c.quotaPoisoned);
  const flagged = all.length - clean.length;
  const r = mean(clean.map((c) => c.reward));
  const cost = mean(clean.map((c) => c.costUsd));
  lines.push(
    `| ${p} | ${clean.length} | ${fmt(r, 3)} | ${clean.filter((c) => c.resolved).length}/${clean.length} | ${fmt(cost)} | ${fmt(mean(clean.map((c) => c.wallS)) / 60, 1)} | ${r > 0 ? fmt(cost / r) : "—"} | ${flagged || ""} |`,
  );
}
lines.push("");
lines.push("## Matrix (reward / cost $ / wall min)");
lines.push("");
lines.push(`| pattern | ${slugs.join(" | ")} |`);
lines.push(`|---|${slugs.map(() => "---").join("|")}|`);
for (const p of patterns) {
  const row = slugs.map((s) => {
    const c = cells.find((x) => x.pattern === p && x.slug === s);
    if (!c) return "·";
    const flags = `${c.tainted === true ? " T!" : ""}${c.quotaPoisoned ? " Q!" : ""}${c.status !== "RunFinished" ? ` ${c.status}` : ""}`;
    return `${fmt(c.reward, 3)} / $${fmt(c.costUsd)} / ${fmt(c.wallS / 60, 0)}m${flags}`;
  });
  lines.push(`| ${p} | ${row.join(" | ")} |`);
}
lines.push("");
lines.push("## Stage timing (mean minutes per stage, by pattern)");
lines.push("");
for (const p of patterns) {
  const all = cells.filter((c) => c.pattern === p);
  const stageIds = [...new Set(all.flatMap((c) => Object.keys(c.stages)))];
  const parts = stageIds.map((id) => {
    const durs = all.filter((c) => c.stages[id]).map((c) => c.stages[id].durS / 60);
    return `${id}=${fmt(mean(durs), 0)}m`;
  });
  lines.push(`- **${p}**: ${parts.join(", ")}`);
}

const md = lines.join("\n");
writeFileSync(join(RESULTS, `${round}-summary.md`), md);
console.log(md);
