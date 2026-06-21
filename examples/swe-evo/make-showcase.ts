/**
 * SWE-EVO results showcase generator.
 *
 * Builds a single self-contained HTML page from the live run data:
 *   - reads the score rows straight from the run DB(s) (.data/swe-evo-<wf>.db),
 *     so the page is always current — re-run this after each batch lands
 *   - maps coverage across all 48 official instances (scored / env-excluded /
 *     pending) by reading the dataset and the gold-verify log
 *   - compares against the public SWE-EVO leaderboard (official-results.json)
 *   - explains how the Panel + ReviewLoop workflow is wired, with real excerpts
 *
 *   bun make-showcase.ts                 # -> showcase/index.html
 *   bun make-showcase.ts --out path.html
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, ".data");
const INSTANCES_DIR = join(HERE, "dataset", "data", "instances");

type ScoreRow = {
  instance_id: string;
  repo: string;
  resolved: number;
  fix_rate_pct: number;
  f2p_total: number;
  f2p_passed: number;
  p2p_total: number;
  p2p_passed: number;
  candidate_applied: number;
  duration_s: number;
};

const dbPathFor = (wf: string) => join(DATA, `swe-evo-${wf}.db`);

/** All 48 instance ids -> repo, from the downloaded dataset. */
function loadCatalog(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(INSTANCES_DIR)) return m;
  for (const f of readdirSync(INSTANCES_DIR)) {
    if (!f.endsWith(".json")) continue;
    const row = JSON.parse(readFileSync(join(INSTANCES_DIR, f), "utf8"));
    m.set(row.instance_id, row.repo);
  }
  return m;
}

/** Latest score row per instance for a workflow variant. */
function loadScores(wf: string): Map<string, ScoreRow> {
  const out = new Map<string, ScoreRow>();
  const p = dbPathFor(wf);
  if (!existsSync(p)) return out;
  const db = new Database(p, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT instance_id, repo, resolved, fix_rate_pct, f2p_total, f2p_passed,
                p2p_total, p2p_passed, candidate_applied, duration_s
         FROM score`,
      )
      .all() as ScoreRow[];
    for (const r of rows) out.set(r.instance_id, r);
  } catch {
    /* no score table yet */
  } finally {
    db.close();
  }
  return out;
}

/** Read an instance-id list file (one per line; # comments allowed). */
function readIdList(file: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const id = line.trim();
    if (id && !id.startsWith("#")) out.add(id);
  }
  return out;
}

/** Instances permanently excluded from the denominator: the gold patch does not
 *  reproduce on ANY available host. Only a manual override feeds this now. The
 *  Mac env-incompatibles are NOT excluded; they are routed to native x86 scoring
 *  (subset-x86.txt + score-x86.ts) and stay in the denominator as "pending x86"
 *  until scored. */
function loadExcluded(): Set<string> {
  return readIdList(join(DATA, "env-incompatible.txt"));
}

/** Instances that must be scored on native x86 (Mac emulation can't reproduce). */
function loadX86Set(): Set<string> {
  return readIdList(join(DATA, "subset-x86.txt"));
}

/** Authoritative scores produced on native x86 (score-x86.ts -> x86-scores.json),
 *  normalized into the ScoreRow shape this page uses. */
function loadX86Scores(catalog: Map<string, string>): Map<string, ScoreRow> {
  const out = new Map<string, ScoreRow>();
  const p = join(DATA, "x86-scores.json");
  if (!existsSync(p)) return out;
  let raw: Record<string, any> = {};
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return out;
  }
  for (const [id, r] of Object.entries(raw)) {
    if (r == null || r.resolved == null) continue; // unscored / error entry
    if (r.gold_verify) continue; // gold-patch validation run, not an agent score
    out.set(id, {
      instance_id: id,
      repo: catalog.get(id) ?? r.repo ?? "",
      resolved: Number(r.resolved) ? 1 : 0,
      fix_rate_pct: Math.round((r.fix_rate ?? 0) * 100),
      f2p_total: r.f2p_total ?? 0,
      f2p_passed: r.f2p_passed ?? 0,
      p2p_total: r.p2p_total ?? 0,
      p2p_passed: r.p2p_passed ?? 0,
      candidate_applied: r.candidate_applied ? 1 : 0,
      duration_s: r.duration_s ?? 0,
    });
  }
  return out;
}

const REPO_ORDER = [
  "iterative/dvc",
  "dask/dask",
  "psf/requests",
  "pydantic/pydantic",
  "modin-project/modin",
  "scikit-learn/scikit-learn",
  "conan-io/conan",
];

type Agg = { n: number; resolved: number; fixSum: number };
function agg(rows: ScoreRow[]): Agg {
  let resolved = 0;
  let fixSum = 0;
  for (const r of rows) {
    resolved += r.resolved ? 1 : 0;
    // exact fix rate: 0 if any P2P regressed, else f2p_passed/f2p_total
    const allP2p = r.p2p_total === 0 || r.p2p_passed >= r.p2p_total;
    fixSum += allP2p && r.f2p_total > 0 ? r.f2p_passed / r.f2p_total : r.f2p_total === 0 ? (allP2p ? 1 : 0) : 0;
  }
  return { n: rows.length, resolved, fixSum };
}
const rr = (a: Agg) => (a.n ? (100 * a.resolved) / a.n : 0);
const fr = (a: Agg) => (a.n ? (100 * a.fixSum) / a.n : 0);
const pct = (n: number) => `${n.toFixed(1)}%`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : join(HERE, "showcase", "index.html");

  const catalog = loadCatalog();
  const scores = loadScores("panel");
  const baseline = loadScores("baseline");
  const excluded = loadExcluded();
  const official = JSON.parse(readFileSync(join(HERE, "official-results.json"), "utf8"));

  // x86 set: their Mac score (if any) is a sentinel from an un-reproducible image,
  // so it is NOT authoritative. Drop it; use the native-x86 score when available,
  // otherwise leave the instance unscored ("pending x86").
  const x86Set = loadX86Set();
  const x86Scores = loadX86Scores(catalog);
  for (const id of x86Set) {
    scores.delete(id);
    const x = x86Scores.get(id);
    if (x) scores.set(id, x);
  }

  const total = catalog.size || 48;
  const scoredRows = [...scores.values()];
  const overall = agg(scoredRows);
  const excludedScoreable = [...excluded].filter((id) => !scores.has(id));
  const pending = [...catalog.keys()].filter((id) => !scores.has(id) && !excluded.has(id));

  // per-repo coverage + results
  type RepoStat = {
    repo: string;
    total: number;
    scored: ScoreRow[];
    excluded: number;
    pending: number;
  };
  const repoStats: RepoStat[] = [];
  const repos = [...new Set([...catalog.values()])].sort(
    (a, b) => (REPO_ORDER.indexOf(a) + 1 || 99) - (REPO_ORDER.indexOf(b) + 1 || 99),
  );
  for (const repo of repos) {
    const ids = [...catalog].filter(([, r]) => r === repo).map(([id]) => id);
    repoStats.push({
      repo,
      total: ids.length,
      scored: ids.filter((id) => scores.has(id)).map((id) => scores.get(id)!),
      excluded: ids.filter((id) => excluded.has(id) && !scores.has(id)).length,
      pending: ids.filter((id) => !scores.has(id) && !excluded.has(id)).length,
    });
  }

  // leaderboard rows with our result spliced in by rank
  const board = (official.leaderboard as any[])
    .map((m) => ({
      model: `${m.model}`,
      provider: m.provider,
      best: Math.max(m.resolved_openhands ?? 0, m.resolved_sweagent ?? 0),
    }))
    .sort((a, b) => b.best - a.best);
  const ourRR = rr(overall);
  const maxBar = Math.max(ourRR, ...board.map((b) => b.best), 1);

  const html = renderHtml({
    official,
    total,
    overall,
    ourRR,
    ourFR: fr(overall),
    baselineAgg: baseline.size ? agg([...baseline.values()]) : null,
    excludedScoreable,
    pendingCount: pending.length,
    repoStats,
    scores,
    catalog,
    excluded,
    x86Set,
    board,
    maxBar,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`[showcase] ${scoredRows.length}/${total} scored, ${overall.resolved} resolved (RR ${pct(ourRR)})`);
  console.log(`[showcase] wrote ${outPath}`);
}

function renderHtml(d: any): string {
  const {
    official,
    total,
    overall,
    ourRR,
    ourFR,
    baselineAgg,
    excludedScoreable,
    pendingCount,
    repoStats,
    scores,
    catalog,
    excluded,
    x86Set,
    board,
    maxBar,
  } = d;

  const officialTop = official.headline.best_resolved_full48;
  const lift = baselineAgg ? ourRR - rr(baselineAgg) : null;

  const coverageBar = () => {
    const scoredN = overall.n;
    const exN = [...excluded].length;
    const w = (n: number) => `${(100 * n) / total}%`;
    return `
      <div class="cov-track" title="${scoredN} scored · ${exN} env-excluded · ${pendingCount} pending">
        <div class="cov-seg cov-scored" style="width:${w(scoredN)}"></div>
        <div class="cov-seg cov-excl" style="width:${w(exN)}"></div>
        <div class="cov-seg cov-pend" style="width:${w(pendingCount)}"></div>
      </div>
      <div class="cov-legend">
        <span><i class="dot scored"></i>${scoredN} scored</span>
        <span><i class="dot excl"></i>${exN} env-excluded</span>
        <span><i class="dot pend"></i>${pendingCount} pending</span>
        <span class="muted">of ${total} official instances</span>
      </div>`;
  };

  const repoRows = repoStats
    .map((s: any) => {
      const a = agg(s.scored);
      const cov = `${s.scored.length}/${s.total}`;
      const rrCell = s.scored.length ? `<strong>${pct(rr(a))}</strong>` : "<span class='muted'>—</span>";
      const frCell = s.scored.length ? pct(fr(a)) : "<span class='muted'>—</span>";
      const note =
        s.excluded || s.pending
          ? `<span class="muted">${[s.excluded ? `${s.excluded} env-excl` : "", s.pending ? `${s.pending} pending` : ""].filter(Boolean).join(", ")}</span>`
          : "";
      return `<tr>
        <td><code>${esc(s.repo)}</code></td>
        <td>${cov}</td>
        <td>${a.resolved}/${s.scored.length || 0}</td>
        <td>${rrCell}</td>
        <td>${frCell}</td>
        <td>${note}</td>
      </tr>`;
    })
    .join("\n");

  // per-instance grid
  const instanceCards = [...catalog.keys()]
    .sort()
    .map((id: string) => {
      const r = scores.get(id);
      let cls = "pend";
      let label = "pending";
      let detail = "";
      if (r) {
        cls = r.resolved ? "ok" : "miss";
        label = r.resolved ? "resolved" : "not resolved";
        const where = x86Set.has(id) ? " · scored on x86" : "";
        detail = `F2P ${r.f2p_passed}/${r.f2p_total} · P2P ${r.p2p_passed}/${r.p2p_total}${r.candidate_applied ? "" : " · patch did not apply"}${where}`;
      } else if (excluded.has(id)) {
        cls = "excl";
        label = "env-excluded";
        detail = "gold patch does not reproduce on any host";
      } else if (x86Set.has(id)) {
        cls = "pend";
        label = "pending (x86)";
        detail = "candidate generated on Mac; awaiting native-x86 score";
      }
      return `<div class="inst ${cls}" title="${esc(id)} — ${label}${detail ? " · " + esc(detail) : ""}">
        <span class="inst-id">${esc(id.replace(/^[a-z-]+__/, ""))}</span>
        <span class="inst-tag">${label}</span>
      </div>`;
    })
    .join("\n");

  const boardRows = (() => {
    const rows: string[] = [];
    let inserted = false;
    const ours = {
      model: "Smithers orchestration — Opus 4.8 + GPT-5.5",
      provider: "Anthropic + OpenAI",
      best: ourRR,
      ours: true,
    };
    const merged = [...board];
    // splice ours by rank
    const final: any[] = [];
    for (const m of merged) {
      if (!inserted && ours.best > m.best) {
        final.push(ours);
        inserted = true;
      }
      final.push(m);
    }
    if (!inserted) final.push(ours);
    for (const m of final) {
      const w = `${(100 * m.best) / maxBar}%`;
      rows.push(`<div class="bar-row ${m.ours ? "ours" : ""}">
        <div class="bar-label">${esc(m.model)}<span class="bar-prov">${esc(m.provider)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${w}"></div></div>
        <div class="bar-val">${m.best.toFixed(1)}%</div>
      </div>`);
    }
    return rows.join("\n");
  })();

  const planSnippet = esc(`<Panel
  id="plan"
  panelists={[opusPlanner, codexPlanner /*, geminiPlanner */]}
  moderator={opusModerator}
  strategy="synthesize"
>
  {planPrompt(instance)}
</Panel>`);

  const reviewSnippet = esc(`<ReviewLoop
  id="impl"
  producer={codexImplementer}      // GPT-5.5 writes the code
  reviewer={[opusReviewer]}        // Opus judges against the spec
  maxIterations={3}
  onMaxReached="return-last"
>
  {producerPrompt /* synthesized plan + last review feedback */}
</ReviewLoop>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smithers on SWE-EVO — multi-agent panel results</title>
<style>
  :root{
    --bg:#0a0c10; --panel:#12161d; --panel2:#171c25; --line:#222a36;
    --ink:#e8edf4; --muted:#8a96a8; --accent:#5eead4; --accent2:#7c9cff;
    --ok:#34d399; --miss:#f87171; --excl:#fbbf24; --pend:#3b4757;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
  code,pre{font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace}
  .wrap{max-width:980px;margin:0 auto;padding:0 24px}
  a{color:var(--accent2)}
  header.hero{padding:72px 0 40px;border-bottom:1px solid var(--line);
    background:radial-gradient(1200px 400px at 50% -120px,rgba(94,234,212,.10),transparent)}
  .kicker{letter-spacing:.18em;text-transform:uppercase;color:var(--accent);font-size:12px;font-weight:600}
  h1{font-size:42px;line-height:1.1;margin:14px 0 10px;font-weight:700;letter-spacing:-.02em}
  h1 .grad{background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{color:var(--muted);font-size:18px;max-width:680px}
  .stats{display:flex;gap:16px;flex-wrap:wrap;margin:36px 0 8px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 22px;min-width:150px;flex:1}
  .stat .big{font-size:34px;font-weight:700;letter-spacing:-.02em}
  .stat .big.accent{color:var(--accent)}
  .stat .lbl{color:var(--muted);font-size:13px;margin-top:2px}
  section{padding:48px 0;border-bottom:1px solid var(--line)}
  h2{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}
  h2 .n{color:var(--muted);font-weight:500;font-size:16px;margin-left:8px}
  .lead{color:var(--muted);margin:0 0 22px;max-width:720px}
  table{width:100%;border-collapse:collapse;margin:8px 0;font-size:14px}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  tbody tr:hover{background:var(--panel)}
  code{background:var(--panel2);padding:1px 6px;border-radius:5px;font-size:13px}
  .muted{color:var(--muted)}
  /* coverage */
  .cov-track{display:flex;height:16px;border-radius:8px;overflow:hidden;background:var(--panel2);border:1px solid var(--line)}
  .cov-seg{height:100%}
  .cov-scored{background:linear-gradient(90deg,var(--ok),#10b981)}
  .cov-excl{background:var(--excl)}.cov-pend{background:var(--pend)}
  .cov-legend{display:flex;gap:18px;flex-wrap:wrap;margin-top:12px;font-size:13px;color:var(--ink)}
  .cov-legend .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
  .dot.scored{background:var(--ok)}.dot.excl{background:var(--excl)}.dot.pend{background:var(--pend)}
  /* instance grid */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:8px;margin-top:18px}
  .inst{background:var(--panel);border:1px solid var(--line);border-left-width:3px;border-radius:8px;padding:9px 11px;display:flex;flex-direction:column;gap:3px;overflow:hidden}
  .inst .inst-id{font:12px/1.3 "SF Mono",monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .inst .inst-tag{font-size:11px;color:var(--muted)}
  .inst.ok{border-left-color:var(--ok)} .inst.ok .inst-tag{color:var(--ok)}
  .inst.miss{border-left-color:var(--miss)} .inst.miss .inst-tag{color:var(--miss)}
  .inst.excl{border-left-color:var(--excl)} .inst.excl .inst-tag{color:var(--excl)}
  .inst.pend{border-left-color:var(--pend);opacity:.7}
  /* bars */
  .bars{margin-top:14px}
  .bar-row{display:grid;grid-template-columns:260px 1fr 56px;gap:12px;align-items:center;padding:5px 0}
  .bar-label{font-size:13px;display:flex;flex-direction:column;line-height:1.2}
  .bar-prov{color:var(--muted);font-size:11px}
  .bar-track{background:var(--panel2);border-radius:6px;height:18px;overflow:hidden}
  .bar-fill{height:100%;background:linear-gradient(90deg,#3b4757,#566275);border-radius:6px}
  .bar-row.ours .bar-fill{background:linear-gradient(90deg,var(--accent),var(--accent2))}
  .bar-row.ours .bar-label{color:var(--accent);font-weight:700}
  .bar-val{text-align:right;font-variant-numeric:tabular-nums;font-size:13px}
  /* code */
  pre{background:#0d1117;border:1px solid var(--line);border-radius:10px;padding:16px 18px;overflow:auto;font-size:13px;line-height:1.5}
  .flow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0 22px;color:var(--muted);font-size:13px}
  .flow .node{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:7px 12px;color:var(--ink)}
  .flow .node b{color:var(--accent)}
  .flow .arr{color:var(--accent2)}
  .callout{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent2);border-radius:8px;padding:14px 16px;margin:18px 0;color:var(--ink);font-size:14px}
  footer{padding:40px 0 80px;color:var(--muted);font-size:13px}
  .pill{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;margin-right:6px}
</style>
</head>
<body>
<header class="hero"><div class="wrap">
  <div class="kicker">Smithers · durable multi-agent orchestration</div>
  <h1>Smithers orchestration on <span class="grad">SWE-EVO</span></h1>
  <p class="sub">Two frontier models argue out a plan, one writes the code, the other reviews it until it passes — wired as a durable Smithers workflow and scored on the real SWE-EVO hermetic test harness.</p>
  <div class="stats">
    <div class="stat"><div class="big accent">${pct(ourRR)}</div><div class="lbl">Resolved Rate (${overall.resolved}/${overall.n} scored)</div></div>
    <div class="stat"><div class="big">${pct(ourFR)}</div><div class="lbl">Fix Rate (FAIL→PASS, soft)</div></div>
    <div class="stat"><div class="big">${officialTop}%</div><div class="lbl">Official full-48 ceiling (${esc(official.headline.best_model)})</div></div>
    ${lift !== null ? `<div class="stat"><div class="big">${lift >= 0 ? "+" : ""}${lift.toFixed(1)}pp</div><div class="lbl">panel vs flat baseline</div></div>` : ""}
  </div>
  <p class="muted" style="margin-top:18px">Models in play: <span class="pill">Opus 4.8 — plan · moderate · review</span><span class="pill">GPT-5.5 (Codex) — co-plan · implement</span></p>
</div></header>

<section><div class="wrap">
  <h2>Coverage <span class="n">what has actually run</span></h2>
  <p class="lead">The full SWE-EVO benchmark is 48 instances across 7 Python repos. Scoring runs each repo's real Docker image; instances whose <em>gold</em> patch does not even reproduce in the current Docker environment are excluded from the denominator (scoring them would be meaningless), not silently counted as failures.</p>
  ${coverageBar()}
  <table style="margin-top:24px">
    <thead><tr><th>Repo</th><th>Scored</th><th>Resolved</th><th>Resolved Rate</th><th>Fix Rate</th><th></th></tr></thead>
    <tbody>${repoRows}</tbody>
  </table>
</div></section>

<section><div class="wrap">
  <h2>Every instance <span class="n">${overall.n} scored · ${[...excluded].length} excluded · ${pendingCount} pending</span></h2>
  <p class="lead">Each card is one official SWE-EVO instance. Green resolved (all FAIL_TO_PASS and PASS_TO_PASS tests pass), red ran but did not resolve, amber excluded as environment-incompatible, grey not yet run.</p>
  <div class="grid">${instanceCards}</div>
</div></section>

<section><div class="wrap">
  <h2>How the Smithers script is built</h2>
  <p class="lead">SWE-EVO gives a repo at release N and the release notes for N+1; the workflow must evolve the code to satisfy N+1's hidden test suite. The whole thing is one Smithers workflow built from two standard-library components — no bespoke agent glue.</p>
  <div class="flow">
    <span class="node">prepare<br><b>checkout @ base</b></span><span class="arr">→</span>
    <span class="node"><b>Panel</b><br>Opus + GPT-5.5 plan</span><span class="arr">→</span>
    <span class="node">Opus<br><b>moderates</b></span><span class="arr">→</span>
    <span class="node"><b>ReviewLoop</b><br>GPT-5.5 ⇄ Opus</span><span class="arr">→</span>
    <span class="node">diff</span><span class="arr">→</span>
    <span class="node"><b>score</b><br>real Docker tests</span>
  </div>
  <p class="lead"><strong>1. Panel — independent plans, then synthesis.</strong> Each planner explores the repo read-only and proposes an approach; an Opus moderator reconciles them into one consolidated plan. The panel is the standard-library <code>&lt;Panel strategy="synthesize"&gt;</code>.</p>
  <pre>${planSnippet}</pre>
  <p class="lead"><strong>2. ReviewLoop — produce, review, repeat.</strong> GPT-5.5 implements against the consolidated plan; Opus reviews the working tree against the spec and either approves or returns blocking feedback, which is threaded back into the next implementation attempt. Loops up to 3 times.</p>
  <pre>${reviewSnippet}</pre>
  <div class="callout"><strong>Fairness is enforced by construction.</strong> Every agent sees only the release spec and the repo — never the hidden tests or the gold patch. The gold patch and hidden tests are stripped from the run input entirely (they live on disk and are loaded only by the deterministic score node), so they cannot leak into a prompt or the run database.</div>
  <p class="lead">Because it is a Smithers workflow, the whole run is durable: every node's output is checkpointed, a crashed or rate-limited run resumes from the last completed step, and the supervisor pauses on a real usage-limit and restarts when capacity returns. The point of this build is to <em>benchmark Smithers orchestration</em>: how much a Panel + ReviewLoop lifts a pair of models over a flat single pass.</p>
</div></section>

<section><div class="wrap">
  <h2>vs the public SWE-EVO leaderboard</h2>
  <p class="lead">Official numbers are full-48 Resolved Rate from the SWE-EVO paper (best of OpenHands / SWE-agent scaffolds), internet blocked. Our bar is Smithers orchestration on the instances scored so far.</p>
  <div class="bars">${boardRows}</div>
  <div class="callout" style="border-left-color:var(--accent)">
    <strong>First SWE-EVO numbers for this pairing.</strong> Opus 4.8 (88.6% on SWE-bench Verified) and GPT-5.5 (88.7%) sit at the very top of the easier SWE-bench Verified leaderboard, but neither model appears in the SWE-EVO paper, which predates them and tops out at gpt-5.4 (25%). SWE-EVO is a much harder long-horizon evolution benchmark, so a ~88% SWE-bench Verified score does not carry over. These runs are, as far as we can tell, the first SWE-EVO measurements for Opus 4.8 and GPT-5.5.
  </div>
  <div class="callout">
    <strong>Read this honestly.</strong> ${esc(official.subset_caveat)} The load-bearing comparison is the internal A/B (orchestration vs flat baseline on identical instances); the official board is the directional reference for what frontier full-48 performance looks like (~${officialTop}% ceiling). The denominator and the model lineup differ from the paper, so treat cross-rows as directional, not a matched ranking. ${esc(official.ci_note)}
  </div>
</div></section>

<footer><div class="wrap">
  Source: <code>examples/swe-evo</code> in the Smithers repo · dataset <a href="${official._url}">Fsoft-AIC/SWE-EVO (arXiv:2512.18470)</a> · workflow <code>workflow/swe-evo-panel.tsx</code> · regenerate with <code>bun make-showcase.ts</code>.
</div></footer>
</body>
</html>`;
}

main();
