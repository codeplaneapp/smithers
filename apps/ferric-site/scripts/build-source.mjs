/**
 * Builds site/source.html — the complete Ferric campaign source, browsable as a
 * file tree with syntax highlighting.
 *
 * Highlighting is done at BUILD TIME by the small TSX lexer below: no runtime
 * library, no external stylesheet, nothing to fetch. The page ships as static
 * markup so it renders identically under a strict CSP.
 *
 * Usage: node scripts/build-source.mjs [--out <path>]
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const args = process.argv.slice(2);
const argVal = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const OUT = argVal("--out", join(here, "..", "site", "source.html"));

/** Hand-written notes for the files worth introducing; others get a default. */
const BLURBS = {
  ".smithers/workflows/react-rust-port.tsx":
    "The graph. Which milestone runs, the token budget, the error boundary, and the hand-off to the next run — and nothing else. The single-workflow contract is about one launchable graph, not one physical file.",
  ".smithers/ui/react-rust-port.tsx":
    "The campaign dashboard: milestone rail, spend and lineage KPIs, the approval queue where every human gate lands, and live agent chat. Presentation only — it cannot schedule work.",
  ".smithers/ui/react-rust-port-review.tsx":
    "The slice-review surface. Pick a slice node and get the implementer's report, both adversarial reviews, the deterministic verdict, and the patch rendered as diff hunks.",
  ".smithers/components/ferric/Slice.tsx":
    "One vertical slice: implement in an isolated worktree, two diff-only adversarial reviews from different model families, then the deterministic verifier — looping on one convergence predicate that also gates the right to land.",
  ".smithers/components/ferric/PortCampaign.tsx":
    "Queue backfill. Leaves fan out across the lane budget; cohorts land strictly one at a time and only after every leaf, which is the D5 rule enforced by graph shape rather than by prompt text.",
  ".smithers/components/ferric/FoundationAndBudget.tsx":
    "Everything that must be true before a token is spent: the launch root IS the campaign repo, the deterministic scripts exist, the workflow's own source contains exactly one approval site — plus the budget admission decision.",
  ".smithers/components/ferric/QueueParse.tsx":
    "Parses MODULE_QUEUE.tsv and throws unless it finds exactly 22 leaf modules plus one 59-module import cycle grouped into six cohorts. The D5 contract as a machine check.",
  ".smithers/components/ferric/CampaignGate.tsx":
    "The only Approval mount in the campaign. Every human decision routes through here, which is what makes “no gate auto-approves” checkable at runtime.",
  ".smithers/components/ferric/ferricGates.ts":
    "Every human gate in the campaign as data: title and denial policy per gate, plus the approval SLA.",
  ".smithers/components/ferric/PublishPipeline.tsx":
    "Decide, gate, then act exactly once. The agent that decides never publishes; the act is idempotency-keyed and mounts last.",
  ".smithers/components/ferric/ferricShell.ts":
    "The deterministic layer's shell helpers, including the infra-vs-red rule: an out-of-memory kill or timeout throws for a retry with headroom rather than minting a false red.",
  ".smithers/components/ferric/ferricLedger.ts":
    "The durable landing ledger — the campaign's source of truth for what landed and whether the queue is halted — plus the frontier that milestone gates read.",
  ".smithers/components/ferric/ferricSchemas.ts":
    "Every persisted shape. Keys are frc-prefixed because output tables are shared by name across a workspace, and agent-written fields carry constraints so an empty repaired object cannot validate.",
  ".smithers/components/ferric/ferricSmithers.ts":
    "The campaign's single Smithers binding, so every reader and writer resolves to the same registered output targets.",
  ".smithers/components/ferric/ferricAgents.ts":
    "The sandwich: Fable plans and gates, Terra and Sol implement, Opus reviews, Luna does mechanical work — all with autonomous-run flags, without which a detached run stalls at the first file edit.",
  ".smithers/components/accounts/accountPool.ts":
    "The selection policy. Given a role, order the registered accounts best-first — conserving the scarce model tier for the work only it can do, keeping session-exhausted accounts in the chain in case their window resets, and rotating per lane so concurrent lanes never stack on one account.",
  ".smithers/components/accounts/accountAgents.ts":
    "Turns that ordering into agent fallback chains bound to each account's config directory. Selection returns an order, not a winner, so quota death costs one hop instead of parking the run.",
  ".smithers/components/accounts/RefreshAccountUsage.tsx":
    "Probes every account's live quota into a snapshot. Render is synchronous and must never hit the network, so the probe is a task and selection reads its file.",
  ".smithers/scripts/accounts-login.mjs":
    "Provisions the fleet's isolated config directories and drives each vendor's browser OAuth for the ones missing credentials. Idempotent: re-running only touches what is missing.",
  ".smithers/components/ferric/ferricConfig.ts":
    "Run configuration, milestone ladder, budget envelopes, and the symlink-resolved worktree root.",
};

const DEFAULT_BLURBS = {
  component: "A campaign component: one export, composed into the graph by the workflow.",
  prompt:
    "An MDX prompt. Props interpolate in flow text, and the task's output schema is injected automatically so the prompt and its validator cannot drift apart.",
};

function collect() {
  const files = [
    ".smithers/workflows/react-rust-port.tsx",
    ".smithers/ui/react-rust-port.tsx",
    ".smithers/ui/react-rust-port-review.tsx",
    ...readdirSync(join(repo, ".smithers/components/ferric"))
      .sort()
      .map((f) => `.smithers/components/ferric/${f}`),
    ...readdirSync(join(repo, ".smithers/components/accounts"))
      .sort()
      .map((f) => `.smithers/components/accounts/${f}`),
    ".smithers/scripts/accounts-login.mjs",
    ...readdirSync(join(repo, ".smithers/prompts"))
      .filter((f) => f.startsWith("ferric-") && f.endsWith(".mdx"))
      .sort()
      .map((f) => `.smithers/prompts/${f}`),
  ];
  return files.map((path) => ({
    path,
    abs: join(repo, path),
    blurb: BLURBS[path] ?? (path.includes("/prompts/") ? DEFAULT_BLURBS.prompt : DEFAULT_BLURBS.component),
  }));
}

const FILES = collect();

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const KEYWORDS = new Set(
  (
    "const let var function return if else for while do switch case break continue new typeof instanceof " +
    "in of class extends implements interface type enum import from export default async await try catch " +
    "finally throw yield delete void this super static readonly public private protected as satisfies " +
    "keyof infer declare namespace abstract"
  ).split(" "),
);
const LITERALS = new Set(["null", "undefined", "true", "false"]);
const TYPES = new Set([
  "string",
  "number",
  "boolean",
  "object",
  "symbol",
  "bigint",
  "any",
  "unknown",
  "never",
  "void",
  "Record",
  "Array",
  "Promise",
  "Set",
  "Map",
  "ReturnType",
  "Partial",
]);

/**
 * Tokenize TypeScript/TSX into {t, v} pairs.
 *
 * Handles line and block comments, all three string forms with `${}` nesting
 * inside template literals, and the classic regex-vs-division ambiguity via the
 * previous-significant-token heuristic (the source contains `/PASSING=(\d+)\/(\d+)/`,
 * which naive lexers shred).
 */
function tokenize(src) {
  const out = [];
  const push = (t, v) => v && out.push({ t, v });
  let i = 0;
  let prev = ""; // previous significant token text
  const templateStack = []; // brace depth per open template literal

  const regexAllowed = () => (!/^[)\]}]$/.test(prev) && !/^[A-Za-z0-9_$]+$/.test(prev)) || KEYWORDS.has(prev);

  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);

    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      push("c", src.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      push("c", src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j = src[j] === "\\" ? j + 2 : j + 1;
      push("s", src.slice(i, Math.min(j + 1, src.length)));
      i = j + 1;
      prev = "str";
      continue;
    }
    if (c === "`") {
      templateStack.push(0);
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "`") {
          j += 1;
          break;
        }
        if (src[j] === "$" && src[j + 1] === "{") break;
        j += 1;
      }
      push("s", src.slice(i, j));
      i = j;
      if (src[i] === "$" && src[i + 1] === "{") {
        push("si", "${");
        i += 2;
      } else {
        templateStack.pop();
      }
      prev = "str";
      continue;
    }
    if (c === "}" && templateStack.length > 0 && templateStack[templateStack.length - 1] === 0) {
      // Closing a ${...} — resume the surrounding template literal.
      push("si", "}");
      i += 1;
      let j = i;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "`") {
          j += 1;
          break;
        }
        if (src[j] === "$" && src[j + 1] === "{") break;
        j += 1;
      }
      push("s", src.slice(i, j));
      i = j;
      if (src[i] === "$" && src[i + 1] === "{") {
        push("si", "${");
        i += 2;
      } else templateStack.pop();
      prev = "str";
      continue;
    }
    if (templateStack.length > 0) {
      if (c === "{") templateStack[templateStack.length - 1] += 1;
      if (c === "}") templateStack[templateStack.length - 1] -= 1;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let ok = false;
      let cls = false;
      while (j < src.length) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") cls = true;
        else if (d === "]") cls = false;
        else if (d === "/" && !cls) {
          ok = true;
          break;
        } else if (d === "\n") break;
        j += 1;
      }
      if (ok) {
        let k = j + 1;
        while (k < src.length && /[gimsuyd]/.test(src[k])) k += 1;
        push("re", src.slice(i, k));
        i = k;
        prev = "re";
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k += 1;
      const next = src[k];
      let cls = "id";
      if (KEYWORDS.has(word)) cls = "k";
      else if (LITERALS.has(word)) cls = "l";
      else if (TYPES.has(word)) cls = "ty";
      else if (/^[A-Z]/.test(word))
        cls = "ty"; // components & types
      else if (next === "(") cls = "fn";
      else if (next === ":") cls = "pr";
      push(cls, word);
      i = j;
      prev = word;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9a-fA-FxX._]/.test(src[j])) j += 1;
      push("n", src.slice(i, j));
      i = j;
      prev = "num";
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      push("w", src.slice(i, j));
      i = j;
      continue;
    }
    push("p", c);
    i += 1;
    prev = c;
  }
  return out;
}

/** Render tokens to line-numbered, anchored HTML rows. */
function renderSource(src, slug) {
  const tokens = tokenize(src);
  let html = "";
  for (const { t, v } of tokens) {
    const parts = v.split("\n");
    parts.forEach((part, idx) => {
      if (idx > 0) html += "\n";
      if (part) html += t === "w" ? esc(part) : `<span class="t-${t}">${esc(part)}</span>`;
    });
  }
  return html
    .split("\n")
    .map(
      (line, idx) =>
        `<div class="src-line" id="${slug}-L${idx + 1}"><a class="src-ln" href="#${slug}-L${idx + 1}">${idx + 1}</a><span class="src-code">${line || " "}</span></div>`,
    )
    .join("");
}

const slugOf = (p) => p.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");

const loaded = FILES.map((f) => {
  const text = readFileSync(f.abs, "utf8");
  return {
    ...f,
    slug: slugOf(f.path),
    text,
    lines: text.split("\n").length,
    bytes: statSync(f.abs).size,
    dir: f.path.slice(0, f.path.lastIndexOf("/")),
    name: f.path.slice(f.path.lastIndexOf("/") + 1),
  };
});

// Group into the sui-file-tree shape: .smithers/ → workflows/ , ui/
const dirs = [...new Set(loaded.map((f) => f.dir))].sort();
const tree = dirs
  .map((dir) => {
    const files = loaded.filter((f) => f.dir === dir);
    const segs = dir.split("/");
    return `
      <div class="sui-file-tree-dir">
        <div class="sui-file-tree-dir-toggle" aria-expanded="true">
          <span class="sui-file-tree-caret"></span>
          <span class="sui-file-tree-dir-name">${esc(segs.join(" / "))}</span>
        </div>
        <div class="sui-file-tree-children">
          ${files
            .map(
              (f) => `<div class="sui-file-tree-row">
            <button class="sui-file-tree-file" data-target="${f.slug}" data-active="${f === loaded[0] ? "true" : "false"}" type="button">
              <span class="sui-file-tree-file-name">${esc(f.name)}</span>
            </button>
            <span class="sui-file-tree-affordance"><span class="sui-badge sui-badge-muted">${f.lines}</span></span>
          </div>`,
            )
            .join("")}
        </div>
      </div>`;
  })
  .join("");

const panes = loaded
  .map(
    (f) => `
  <section class="pane" id="pane-${f.slug}" data-pane="${f.slug}"${f === loaded[0] ? "" : " hidden"}>
    <header class="pane-head">
      <div>
        <h2 class="pane-title">${esc(f.name)}</h2>
        <p class="pane-path">${esc(f.path)}</p>
      </div>
      <div class="pane-meta">
        <span class="sui-badge sui-badge-default">${f.lines} lines</span>
        <span class="sui-badge sui-badge-muted">${(f.bytes / 1024).toFixed(1)} KB</span>
      </div>
    </header>
    <p class="pane-blurb">${esc(f.blurb)}</p>
    <div class="src">${renderSource(f.text, f.slug)}</div>
  </section>`,
  )
  .join("");

const totalLines = loaded.reduce((n, f) => n + f.lines, 0);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ferric — the complete campaign source</title>
<meta name="description" content="Every line of the Operation Ferric Smithers campaign: the single durable workflow and both UI surfaces, browsable with syntax highlighting." />
<style>
:root {
  color-scheme: light dark;
  --bg:#fafafa; --text:#18181b; --text-muted:#52525b; --text-faint:#71717a;
  --surface:#ffffff; --surface-2:#f4f4f5; --hover:#f4f4f5;
  --border:rgba(24,24,27,0.09); --placeholder:#a1a1aa;
  --brand:#6d56d8; --success:#087461; --warning:#916000; --danger:#c5343f; --info:#2a63c9;
  --rust:#b7410e;
  --radius:12px; --radius-control:8px;
  --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:"SF Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --t-comment:#6b7280; --t-string:#0a7d5e; --t-key:#7c3aed; --t-num:#b45309;
  --t-type:#b7410e; --t-fn:#2a63c9; --t-prop:#0f766e; --t-punct:#71717a; --t-re:#be185d;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#131316; --text:#ececf1; --text-muted:#a1a1aa; --text-faint:#8b8b93;
    --surface:#1c1c21; --surface-2:#232329; --hover:#26262d;
    --border:rgba(255,255,255,0.10); --placeholder:#71717a;
    --brand:#a08fff; --success:#2fbf9a; --warning:#d9a514; --danger:#ef6a6a; --info:#6ea8fe;
    --rust:#e2703a;
    --t-comment:#7c8494; --t-string:#4ec9a0; --t-key:#c58fff; --t-num:#e3a857;
    --t-type:#e2703a; --t-fn:#6ea8fe; --t-prop:#4dd4c0; --t-punct:#8b8b93; --t-re:#f472b6;
  }
}
* { box-sizing:border-box; }
html { scroll-behavior:smooth; scroll-padding-top:80px; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 var(--font-sans); -webkit-font-smoothing:antialiased; }
a { color:var(--info); }
.topbar { position:sticky; top:0; z-index:20; backdrop-filter:blur(12px); background:color-mix(in srgb,var(--bg) 86%,transparent); border-bottom:1px solid var(--border); }
.topbar-inner { max-width:1280px; margin:0 auto; padding:10px 20px; display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
.mark { font-weight:800; letter-spacing:-.02em; display:flex; align-items:center; gap:8px; text-decoration:none; color:var(--text); }
.mark .dot { width:11px; height:11px; border-radius:3px; background:linear-gradient(135deg,var(--rust),var(--brand)); }
.topnav { display:flex; gap:14px; font-size:.85rem; }
.topnav a { color:var(--text-muted); text-decoration:none; }
.topnav a:hover { color:var(--text); }
.wrap { max-width:1280px; margin:0 auto; padding:20px; display:grid; grid-template-columns:280px minmax(0,1fr); gap:20px; align-items:start; }
@media (max-width:880px){ .wrap { grid-template-columns:1fr; } .sidebar { position:static !important; } }
.sidebar { position:sticky; top:76px; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); padding:14px; }
.sidebar h1 { font-size:.95rem; margin:0 0 2px; letter-spacing:-.01em; }
.sidebar .sub { color:var(--text-muted); font-size:.8rem; margin:0 0 12px; }

/* smithers ui: FileTree anatomy */
.sui-file-tree { min-width:0; display:flex; flex-direction:column; gap:1px; font-size:13px; color:var(--text); }
.sui-file-tree-children { display:flex; flex-direction:column; gap:1px; margin-left:10px; padding-left:8px; border-left:1px solid var(--border); }
.sui-file-tree-dir { min-width:0; display:flex; flex-direction:column; gap:1px; }
.sui-file-tree-dir-toggle { min-width:0; display:flex; align-items:center; gap:6px; width:100%; padding:4px 6px; border:none; border-radius:var(--radius-control); background:transparent; color:var(--text-muted); font:inherit; font-size:12px; font-weight:650; text-align:left; }
.sui-file-tree-caret { flex:none; width:0; height:0; border-top:4px solid transparent; border-bottom:4px solid transparent; border-left:5px solid currentColor; transform:rotate(90deg); }
.sui-file-tree-dir-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-file-tree-row { min-width:0; display:flex; align-items:center; gap:4px; }
.sui-file-tree-file { min-width:0; flex:1 1 auto; display:flex; align-items:center; gap:6px; padding:5px 6px; border:none; border-radius:var(--radius-control); background:transparent; color:var(--text); font:inherit; font-size:13px; text-align:left; cursor:pointer; }
.sui-file-tree-file:hover { background:var(--hover); }
.sui-file-tree-file[data-active='true'] { background:color-mix(in srgb,var(--brand) 12%,transparent); color:var(--brand); font-weight:650; }
.sui-file-tree-file-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-file-tree-affordance { flex:none; display:inline-flex; align-items:center; }
.sui-badge { display:inline-flex; align-items:center; gap:6px; min-height:20px; padding:0 8px; border:1px solid var(--border); border-radius:999px; color:var(--text-muted); font-size:10px; font-weight:650; letter-spacing:.02em; white-space:nowrap; }
.sui-badge-default { border-color:color-mix(in srgb,var(--brand) 40%,transparent); background:color-mix(in srgb,var(--brand) 10%,var(--surface)); color:var(--brand); }
.sui-badge-muted { border-color:var(--border); background:color-mix(in srgb,var(--text-muted) 12%,transparent); color:var(--text-muted); }

/* code panes */
.pane { border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); overflow:hidden; }
.pane-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:16px 18px 6px; flex-wrap:wrap; }
.pane-title { margin:0; font-size:1.05rem; letter-spacing:-.01em; }
.pane-path { margin:2px 0 0; font:12px/1.4 var(--font-mono); color:var(--text-faint); }
.pane-meta { display:flex; gap:6px; flex-wrap:wrap; }
.pane-blurb { margin:0; padding:0 18px 14px; color:var(--text-muted); font-size:.9rem; max-width:78ch; }
.src { border-top:1px solid var(--border); overflow-x:auto; font:500 12.5px/1.7 var(--font-mono); padding:10px 0; background:var(--surface); }
.src-line { display:flex; min-width:max-content; padding:0 12px; }
.src-line:target { background:color-mix(in srgb,var(--warning) 16%,var(--surface)); }
.src-line:hover { background:color-mix(in srgb,var(--brand) 5%,transparent); }
.src-ln { flex:none; width:52px; padding-right:14px; text-align:right; color:var(--placeholder); user-select:none; text-decoration:none; font-variant-numeric:tabular-nums; }
.src-ln:hover { color:var(--brand); }
.src-code { white-space:pre; }
.t-c { color:var(--t-comment); font-style:italic; }
.t-s, .t-si { color:var(--t-string); }
.t-si { opacity:.85; }
.t-k { color:var(--t-key); font-weight:600; }
.t-l { color:var(--t-num); font-weight:600; }
.t-n { color:var(--t-num); }
.t-ty { color:var(--t-type); }
.t-fn { color:var(--t-fn); }
.t-pr { color:var(--t-prop); }
.t-re { color:var(--t-re); }
.t-p { color:var(--t-punct); }
.t-id { color:var(--text); }
.note { color:var(--text-muted); font-size:.85rem; margin:14px 0 0; }
</style>
</head>
<body>
<div class="topbar"><div class="topbar-inner">
  <a class="mark" href="/"><span class="dot"></span>Ferric</a>
  <nav class="topnav">
    <a href="/">Overview</a>
    <a href="/#react">How React works</a>
    <a href="/#machine">The conversion</a>
    <a href="/source">Source</a>
  </nav>
</div></div>

<div class="wrap">
  <aside class="sidebar">
    <h1>Campaign source</h1>
    <p class="sub">${loaded.length} files · ${totalLines.toLocaleString("en-US")} lines</p>
    <div class="sui-file-tree">${tree}</div>
    <p class="note">Every line as it exists on disk. Click a line number to deep-link it.</p>
  </aside>
  <div class="panes">${panes}</div>
</div>

<script>
(function () {
  var buttons = document.querySelectorAll(".sui-file-tree-file");
  var panes = document.querySelectorAll(".pane");
  function show(slug) {
    panes.forEach(function (p) { p.hidden = p.dataset.pane !== slug; });
    buttons.forEach(function (b) { b.dataset.active = String(b.dataset.target === slug); });
    if (history.replaceState) history.replaceState(null, "", "#" + slug);
  }
  buttons.forEach(function (b) {
    b.addEventListener("click", function () { show(b.dataset.target); });
  });
  var hash = location.hash.replace(/^#/, "");
  if (hash) {
    var slug = hash.split("-L")[0];
    if (document.querySelector('[data-pane="' + slug + '"]')) {
      panes.forEach(function (p) { p.hidden = p.dataset.pane !== slug; });
      buttons.forEach(function (b) { b.dataset.active = String(b.dataset.target === slug); });
      var line = document.getElementById(hash);
      if (line) setTimeout(function () { line.scrollIntoView({ block: "center" }); }, 0);
    }
  }
})();
</script>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(
  `build-source: wrote ${OUT} (${(html.length / 1024).toFixed(0)}KB) — ${loaded.length} files, ${totalLines} lines`,
);
