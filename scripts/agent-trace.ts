/**
 * Renders one agent run's journal as a self-contained debug page.
 *
 *   bun scripts/agent-trace.ts <workspace-or-engine.db> [-o out.html] [--open]
 *
 * The argument is either a workspace directory (the tool finds
 * `.flows/engine.db` under it) or the database itself. The output is a single
 * HTML file with no external references, so it can be mailed, archived beside a
 * benchmark wave, or opened from a machine that has none of this checked out.
 *
 * What it answers, frame by frame: what the model was shown, what code it
 * wrote, what that code called, what came back, and what each frame cost.
 *
 * One honesty note runs through the page. The journal records a
 * `contextDigest` for each turn, not the context itself, so the context pane is
 * RECONSTRUCTED from the parts that are recorded: the fixed prefix the run was
 * built with, the state roster the harness renders from the previous
 * transition's state, and the transcript entries that transition projected
 * forward. That reconstruction follows `CellTurn.projected`, which keeps only
 * prefix segments and replaces the transcript with exactly what the cell chose.
 * It is faithful in structure and content but is not a byte-for-byte capture,
 * and the page says so wherever it shows one.
 */
import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

interface Call {
  flow: string
  input: unknown
  startedAt: number | undefined
  settledAt: number | undefined
  outcome: string | undefined
  value: unknown
  message: string | undefined
}

interface Frame {
  index: number
  seq: number
  seat: string | undefined
  cell: string | undefined
  calls: Array<Call>
  usage: Record<string, number>
  durationMillis: number | undefined
  intent: string | undefined
  state: unknown
  projected: Array<{ role: string; text: string }>
  notes: Array<{ kind: string; text: string; ok?: boolean }>
}

const args = process.argv.slice(2)
if (args.length === 0 || args.includes("--help")) {
  console.error("usage: bun scripts/agent-trace.ts <workspace-or-engine.db> [-o out.html] [--open]")
  process.exit(args.length === 0 ? 2 : 0)
}
const target = resolve(args[0]!)
const outFlag = args.indexOf("-o")
const shouldOpen = args.includes("--open")

const dbPath = target.endsWith(".db") ? target : join(target, ".flows", "engine.db")
if (!existsSync(dbPath)) {
  console.error(`no journal at ${dbPath}`)
  process.exit(1)
}

// A live run keeps its journal in WAL mode, which a read-only open cannot
// attach to, and opening it writable would checkpoint someone else's database.
// Copy the three files instead: the debug tool must never mutate the evidence.
const scratch = mkdtempSync(join(tmpdir(), "agent-trace-"))
const copy = join(scratch, "engine.db")
copyFileSync(dbPath, copy)
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix)
}

const db = new Database(copy)
const rows = db.query(
  "select seq, event_type as type, payload_json as payload from flows_journal_events order by seq"
).all() as Array<{ seq: number; type: string; payload: string }>

const parse = (raw: string): any => {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

const frames: Array<Frame> = []
let current: Frame | undefined
const runNotes: Array<{ kind: string; text: string; ok?: boolean }> = []

for (const row of rows) {
  const p = parse(row.payload)
  switch (row.type) {
    case "control.agent.discipline-armed":
      runNotes.push({ kind: "discipline armed", text: JSON.stringify(p, null, 2) })
      break
    case "control.agent.turn-opened":
      current = {
        index: frames.length + 1,
        seq: row.seq,
        seat: p.seat,
        cell: undefined,
        calls: [],
        usage: {},
        durationMillis: undefined,
        intent: undefined,
        state: undefined,
        projected: [],
        notes: []
      }
      frames.push(current)
      break
    case "control.agent.model-settled":
      if (current) {
        current.usage = p.usage ?? {}
        current.durationMillis = p.durationMillis
      }
      break
    case "control.agent.cell-produced":
      if (current) current.cell = p.text
      break
    case "control.agent.cell-call-started":
      current?.calls.push({
        flow: p.flowName,
        input: p.input,
        startedAt: p.at,
        settledAt: undefined,
        outcome: undefined,
        value: undefined,
        message: undefined
      })
      break
    case "control.agent.cell-call-settled": {
      const open = current?.calls.find((c) => c.outcome === undefined)
      if (open) {
        open.outcome = p.outcome
        open.value = p.value
        open.message = p.message
        open.settledAt = p.at
      }
      break
    }
    case "control.agent.transition-applied":
      if (current) {
        current.intent = p.transition?._tag
        current.state = p.transition?.state
        current.projected = p.transition?.context ?? []
      }
      break
    default:
      if (row.type.startsWith("control.agent.") && row.type.includes("read-only")) {
        current?.notes.push({ kind: row.type.replace("control.agent.", ""), text: JSON.stringify(p) })
      }
  }
}

// The fixed prefix: the task the run was launched with, if the workspace is
// still on disk next to the journal.
const workspace = target.endsWith(".db") ? dirname(dirname(dbPath)) : target
let taskPrompt: string | undefined
for (const candidate of ["flows/fix/flow.mdx"]) {
  const path = join(workspace, candidate)
  if (existsSync(path)) taskPrompt = readFileSync(path, "utf8")
}

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]!))

const json = (v: unknown, limit = 4000): string => {
  if (v === undefined) return ""
  const text = typeof v === "string" ? v : JSON.stringify(v, null, 2)
  return text.length > limit ? `${text.slice(0, limit)}\n… ${text.length - limit} more characters` : text
}

const secs = (from: number | undefined, to: number | undefined): string =>
  from !== undefined && to !== undefined ? `${((to - from) / 1000).toFixed(1)}s` : "—"

const stateRoster = (state: unknown): string => {
  if (state === undefined || state === null) return "(no state)"
  const rendered = JSON.stringify(state)
  if (rendered.length <= 600) return `state (${rendered.length} B), shown in full to the model:\n${json(state, 1200)}`
  const entries = Object.entries(state as Record<string, unknown>)
    .map(([k, v]) => `- ${k} (${JSON.stringify(v)?.length ?? 0} bytes)`)
    .join("\n")
  return `state is ${rendered.length} B, so the model sees a key roster only:\n${entries}`
}

const totals = frames.reduce(
  (acc, f) => ({
    input: acc.input + (f.usage.inputTokens ?? 0),
    cached: acc.cached + (f.usage.cachedInputTokens ?? 0),
    output: acc.output + (f.usage.outputTokens ?? 0),
    model: acc.model + (f.durationMillis ?? 0),
    calls: acc.calls + f.calls.length
  }),
  { input: 0, cached: 0, output: 0, model: 0, calls: 0 }
)

const byFlow = new Map<string, { n: number; ms: number; worst: number }>()
for (const f of frames) {
  for (const c of f.calls) {
    const ms = c.startedAt !== undefined && c.settledAt !== undefined ? c.settledAt - c.startedAt : 0
    const e = byFlow.get(c.flow) ?? { n: 0, ms: 0, worst: 0 }
    byFlow.set(c.flow, { n: e.n + 1, ms: e.ms + ms, worst: Math.max(e.worst, ms) })
  }
}
const flowRows = [...byFlow.entries()].sort((a, b) => b[1].ms - a[1].ms)
  .map(([flow, s]) =>
    `<tr><td class=mono>${esc(flow)}</td><td class=num>${s.n}</td><td class=num>${
      (s.ms / 1000).toFixed(1)
    }s</td><td class=num>${(s.worst / 1000).toFixed(1)}s</td></tr>`
  ).join("")

const maxTok = Math.max(1, ...frames.map((f) => (f.usage.inputTokens ?? 0) + (f.usage.outputTokens ?? 0)))

const frameNav = frames.map((f) =>
  `<button class=navbtn data-i="${f.index}"><span class=ni>${f.index}</span><span class=nt>${
    esc(f.intent ?? "—")
  }</span><span class=nb style="width:${
    Math.round(((f.usage.inputTokens ?? 0) + (f.usage.outputTokens ?? 0)) / maxTok * 100)
  }%"></span></button>`
).join("")

const framePanes = frames.map((f) => {
  const prev = frames[f.index - 2]
  const callHtml = f.calls.map((c) => {
    const ms = c.startedAt !== undefined && c.settledAt !== undefined ? c.settledAt - c.startedAt : undefined
    const cls = c.outcome === "success" ? "ok" : "bad"
    return `<div class="call ${cls}">
<div class=chead><span class="mono strong">${esc(c.flow)}</span><span class=dim>${
      secs(c.startedAt, c.settledAt)
    }</span><span class=dim>${esc(c.outcome ?? "pending")}</span>${
      ms !== undefined && ms > 20000 ? `<span class=warn>slow</span>` : ""
    }</div>
<details><summary class=dim>input</summary><pre>${esc(json(c.input, 2500))}</pre></details>
<details><summary class=dim>result</summary><pre>${esc(json(c.message ?? c.value, 3000))}</pre></details>
</div>`
  }).join("") || `<p class=dim>no host calls in this frame</p>`

  const noteHtml = f.notes.map((n) =>
    `<div class="note ${n.ok === undefined ? "" : n.ok ? "nok" : "nbad"}"><b>${esc(n.kind)}</b><pre>${
      esc(n.text)
    }</pre></div>`
  ).join("")

  const transcript = (prev?.projected ?? []).length > 0
    ? prev!.projected.map((m) => `<div class=msg><span class=role>${esc(m.role)}</span><pre>${esc(m.text)}</pre></div>`)
      .join("")
    : f.index === 1
    ? `<p class=dim>First frame: the transcript is the task itself.</p>`
    : `<p class=warn>The previous frame projected NO transcript entries. This frame saw the fixed prefix and the state roster only.</p>`

  return `<section class=pane id=pane-${f.index}>
  <div class=panehead>
    <h2>frame ${f.index}</h2>
    <span class=pill>${esc(f.intent ?? "—")}</span>
    <span class=dim>${esc(f.seat ?? "")}</span>
    <span class=dim>${(f.usage.inputTokens ?? 0).toLocaleString()} in · ${
    (f.usage.cachedInputTokens ?? 0).toLocaleString()
  } cached · ${(f.usage.outputTokens ?? 0).toLocaleString()} out</span>
    <span class=dim>${f.durationMillis !== undefined ? (f.durationMillis / 1000).toFixed(1) + "s model" : ""}</span>
    <span class=dim>${f.calls.length} calls</span>
  </div>
  ${noteHtml}
  <div class=cols>
    <div>
      <h3>context window <span class=recon>reconstructed</span></h3>
      <details class=box><summary>fixed prefix — identical every frame</summary><pre>${
    esc(taskPrompt ? taskPrompt : "(task prompt not found next to the journal)")
  }</pre><p class=dim>Plus the cell-protocol teaching and the flow catalog, which the harness holds as prefix segments.</p></details>
      <div class=box><h4>state the harness rendered</h4><pre>${esc(stateRoster(prev?.state))}</pre></div>
      <div class=box><h4>transcript the previous frame projected</h4>${transcript}</div>
    </div>
    <div>
      <h3>the cell the model wrote</h3>
      <pre class=code>${esc(f.cell ?? "(no cell produced)")}</pre>
      <h3>what it called</h3>
      ${callHtml}
    </div>
  </div>
</section>`
}).join("")

const html = `<title>agent trace — ${esc(basename(workspace))}</title>
<style>
:root{--bg:#fbfaf8;--fg:#1b1a18;--mut:#6d6862;--line:#e3dfd8;--card:#fff;--ok:#1d7a4c;--bad:#a3341f;--acc:#8a5a2b;--warn:#9a6b12}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161513;--fg:#eae7e1;--mut:#a19b93;--line:#302d29;--card:#1e1d1a;--ok:#6cc48f;--bad:#e08a72;--acc:#d8a76a;--warn:#d8b45e}}
:root[data-theme=dark]{--bg:#161513;--fg:#eae7e1;--mut:#a19b93;--line:#302d29;--card:#1e1d1a;--ok:#6cc48f;--bad:#e08a72;--acc:#d8a76a;--warn:#d8b45e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14.5px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:20px 22px;border-bottom:1px solid var(--line)}
h1{margin:0 0 3px;font-size:20px}
h2{margin:0;font-size:17px}h3{margin:16px 0 7px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
h4{margin:0 0 5px;font-size:12px;color:var(--mut)}
.sub{color:var(--mut);margin:0}
.kpis{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:8px 12px}
.kpi b{display:block;font-size:17px}.kpi span{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
table{border-collapse:collapse;margin-top:10px;font-size:13px}
td,th{border-bottom:1px solid var(--line);padding:4px 12px 4px 0;text-align:left}
.num{text-align:right}
main{display:grid;grid-template-columns:170px 1fr;min-height:70vh}
nav{border-right:1px solid var(--line);padding:10px;overflow-y:auto;max-height:88vh}
.navbtn{display:block;width:100%;text-align:left;background:none;border:0;border-radius:7px;padding:5px 8px;color:var(--fg);cursor:pointer;font:inherit;font-size:12.5px;position:relative}
.navbtn:hover{background:var(--card)}
.navbtn.on{background:var(--card);outline:1px solid var(--acc)}
.ni{font-weight:700;margin-right:7px}.nt{color:var(--mut);font-size:11px}
.nb{display:block;height:2px;background:var(--acc);opacity:.5;margin-top:3px;border-radius:2px}
.pane{display:none;padding:18px 22px 60px}.pane.on{display:block}
.panehead{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;padding-bottom:10px;border-bottom:1px solid var(--line)}
.pill{font-size:11px;border:1px solid var(--line);border-radius:99px;padding:1px 9px;color:var(--acc)}
.dim{color:var(--mut);font-size:12px}
.warn{color:var(--warn);font-size:12px}
.recon{font-size:10px;border:1px solid var(--warn);color:var(--warn);border-radius:99px;padding:1px 7px;letter-spacing:0;text-transform:none}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:22px}
@media(max-width:1000px){.cols{grid-template-columns:1fr}main{grid-template-columns:1fr}nav{max-height:150px;border-right:0;border-bottom:1px solid var(--line)}}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:9px 11px;overflow-x:auto;font:12px/1.5 ui-monospace,Menlo,monospace;margin:0;white-space:pre-wrap;word-break:break-word}
pre.code{font-size:12.5px}
.box{margin-bottom:10px}
.box>summary{cursor:pointer;color:var(--mut);font-size:12px;margin-bottom:5px}
.msg{margin-bottom:6px}.role{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--acc)}
.call{border-left:3px solid var(--line);padding:5px 0 5px 9px;margin:7px 0}
.call.ok{border-color:var(--ok)}.call.bad{border-color:var(--bad)}
.chead{display:flex;gap:10px;align-items:baseline}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}.strong{font-weight:650}
.note{border-radius:8px;padding:8px 10px;margin:9px 0;border:1px solid var(--line)}
.nok{border-color:var(--ok)}.nbad{border-color:var(--bad)}
details summary{cursor:pointer}
</style>
<header>
<h1>agent trace — ${esc(basename(workspace))}</h1>
<p class=sub>${frames.length} frames · seat ${esc(frames[0]?.seat ?? "?")} · journal ${esc(dbPath)}</p>
<div class=kpis>
<div class=kpi><span>frames</span><b>${frames.length}</b></div>
<div class=kpi><span>host calls</span><b>${totals.calls}</b></div>
<div class=kpi><span>input tokens</span><b>${totals.input.toLocaleString()}</b></div>
<div class=kpi><span>cached</span><b>${totals.cached.toLocaleString()}</b></div>
<div class=kpi><span>output tokens</span><b>${totals.output.toLocaleString()}</b></div>
<div class=kpi><span>model time</span><b>${(totals.model / 1000).toFixed(0)}s</b></div>
</div>
<table><tr><th>flow</th><th class=num>calls</th><th class=num>total</th><th class=num>worst</th></tr>${flowRows}</table>
${
  runNotes.map((n) => `<details class=box><summary>${esc(n.kind)}</summary><pre>${esc(n.text)}</pre></details>`).join(
    ""
  )
}
<p class=dim>Context panes are reconstructed from the journal: it stores a context digest, not the text. The parts shown — fixed prefix, state roster, projected transcript — are what <code>CellTurn.projected</code> assembles. Use ← → or j/k to move between frames.</p>
</header>
<main>
<nav>${frameNav}</nav>
<div>${framePanes}</div>
</main>
<script>
const panes=[...document.querySelectorAll('.pane')],btns=[...document.querySelectorAll('.navbtn')];
let at=1;
function show(i){at=Math.min(Math.max(i,1),panes.length);
panes.forEach(p=>p.classList.toggle('on',p.id==='pane-'+at));
btns.forEach(b=>b.classList.toggle('on',b.dataset.i==String(at)));
const b=btns[at-1]; if(b) b.scrollIntoView({block:'nearest'});}
btns.forEach(b=>b.onclick=()=>show(Number(b.dataset.i)));
addEventListener('keydown',e=>{
 if(e.target.tagName==='INPUT')return;
 if(e.key==='ArrowRight'||e.key==='j')show(at+1);
 if(e.key==='ArrowLeft'||e.key==='k')show(at-1);});
show(1);
</script>`

const out = outFlag >= 0 ? resolve(args[outFlag + 1]!) : join(workspace, "agent-trace.html")
writeFileSync(out, html)
db.close()
rmSync(scratch, { recursive: true, force: true })
console.log(`${out}  (${frames.length} frames, ${(html.length / 1024).toFixed(0)} KB)`)
if (shouldOpen) Bun.spawn(["open", out])
