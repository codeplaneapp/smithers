#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Generate the self-contained benchmarks.smithers.sh leaderboard from
 * benchmarks/results.json. No network, no external assets, theme-aware
 * (light/dark). Commit both results.json and the generated index.html so the
 * build is deterministic and reviewable, like the other *.smithers.sh sites.
 *
 *   bun benchmarks/site/make-site.ts
 *
 * To deploy at benchmarks.smithers.sh, drop this site/ dir into an
 * apps/benchmarks-site copied from apps/ui-site (worker.ts + alchemy.run.ts +
 * wrangler.jsonc) and run its deploy — the hosting shell is unchanged boilerplate.
 */
type Row = {
  model: string;
  scaffold: string;
  value: number | null;
  n: number;
  subset: string;
  status: "pending" | "reference" | "result";
  caveat?: string;
};
type Benchmark = {
  id: string;
  name: string;
  dataset: string;
  metric: string;
  url: string;
  headline: string;
  leaderboard: Row[];
};
type Results = { scaffold: string; benchmarks: Benchmark[] };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function rowHtml(r: Row, metric: string): string {
  const value = r.value === null ? "—" : `${r.value}`;
  const cls = `row row--${r.status}${r.model.startsWith("smithers") ? " row--ours" : ""}`;
  const badge =
    r.status === "pending"
      ? `<span class="badge badge--pending">pending</span>`
      : r.status === "reference"
        ? `<span class="badge badge--ref">public</span>`
        : `<span class="badge badge--ours">smithers</span>`;
  return `<tr class="${cls}">
  <td class="model">${esc(r.model)} ${badge}</td>
  <td class="scaffold">${esc(r.scaffold)}</td>
  <td class="value">${value}</td>
  <td class="n">${r.n || "—"}</td>
  <td class="subset">${esc(r.subset)}${r.caveat ? `<span class="caveat">${esc(r.caveat)}</span>` : ""}</td>
</tr>`;
}

function benchHtml(b: Benchmark): string {
  return `<section class="card" id="${esc(b.id)}">
  <div class="card__head">
    <h2><a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.name)}</a></h2>
    <div class="dataset">${esc(b.dataset)}</div>
  </div>
  <p class="headline">${esc(b.headline)}</p>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Model</th><th>Scaffold</th><th>${esc(b.metric)}</th><th>n</th><th>Subset / caveat</th></tr></thead>
      <tbody>${b.leaderboard.map((r) => rowHtml(r, b.metric)).join("\n")}</tbody>
    </table>
  </div>
</section>`;
}

function page(results: Results): string {
  return `<main>
  <header class="hero">
    <h1>Smithers Benchmarks</h1>
    <p class="sub">Frontier coding benchmarks run through a Claude-only delegation fleet.<br>
      <code>${esc(results.scaffold)}</code></p>
    <p class="disclaimer">Rows marked <strong>pending</strong> await the first full cloud pass. Public rows are each benchmark's own leaderboard. Small subsets are never comparable to full-benchmark numbers.</p>
  </header>
  ${results.benchmarks.map(benchHtml).join("\n")}
  <footer>Generated from <code>benchmarks/results.json</code>. Design in <code>.smithers/specs/cloud-benchmark-fleet.md</code>.</footer>
</main>
<style>
  :root { --bg:#0b0d12; --panel:#12151d; --line:#232838; --fg:#e7ebf3; --muted:#8b94a7; --accent:#6ea8fe; --ours:#7ee0a6; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f8fc; --panel:#fff; --line:#e3e8f2; --fg:#161a22; --muted:#5b6472; --accent:#2f6bd6; --ours:#137a45; } }
  :root[data-theme="dark"] { --bg:#0b0d12; --panel:#12151d; --line:#232838; --fg:#e7ebf3; --muted:#8b94a7; --accent:#6ea8fe; --ours:#7ee0a6; }
  :root[data-theme="light"] { --bg:#f6f8fc; --panel:#fff; --line:#e3e8f2; --fg:#161a22; --muted:#5b6472; --accent:#2f6bd6; --ours:#137a45; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width:960px; margin:0 auto; padding:32px 20px 64px; }
  .hero { padding:28px 0 8px; }
  .hero h1 { margin:0 0 8px; font-size:32px; letter-spacing:-0.02em; }
  .sub { margin:0 0 12px; color:var(--muted); }
  .sub code { color:var(--accent); }
  .disclaimer { font-size:13px; color:var(--muted); border-left:3px solid var(--line); padding-left:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:20px; margin:18px 0; }
  .card__head { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .card h2 { margin:0; font-size:20px; }
  .card h2 a { color:var(--fg); text-decoration:none; }
  .card h2 a:hover { color:var(--accent); }
  .dataset { color:var(--muted); font-size:12px; }
  .headline { color:var(--muted); margin:8px 0 14px; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14px; min-width:560px; }
  th { text-align:left; color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; padding:6px 10px; border-bottom:1px solid var(--line); }
  td { padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  .value { font-variant-numeric:tabular-nums; font-weight:700; }
  .n, .subset { color:var(--muted); }
  .caveat { display:block; font-size:11px; color:var(--muted); margin-top:2px; }
  .row--ours { background:color-mix(in srgb, var(--ours) 8%, transparent); }
  .row--ours .value, .row--ours .model { color:var(--ours); }
  .row--pending { opacity:0.72; }
  .badge { display:inline-block; font-size:10px; padding:1px 6px; border-radius:6px; margin-left:6px; vertical-align:middle; border:1px solid var(--line); color:var(--muted); }
  .badge--pending { border-color:var(--accent); color:var(--accent); }
  .badge--ours { border-color:var(--ours); color:var(--ours); }
  footer { color:var(--muted); font-size:12px; margin-top:28px; }
  footer code, .disclaimer code { background:var(--panel); border:1px solid var(--line); padding:1px 5px; border-radius:5px; }
</style>`;
}

const dir = import.meta.dir;
const results = JSON.parse(readFileSync(join(dir, "..", "results.json"), "utf8")) as Results;
const html = page(results);
writeFileSync(join(dir, "index.html"), html);
console.log(`make-site: wrote index.html (${html.length} bytes, ${results.benchmarks.length} benchmarks)`);
