/** The dashboard document. Self-contained: no external fonts, CDNs, or assets. */
export const PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Smithers Quota</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #ffffff; --ink: #10131a; --muted: #6b7280;
    --line: #e4e7ec; --track: #eceff3;
    --ok: #129a6b; --warn: #d68309; --hot: #d64545; --dead: #8b5cf6;
    --accent: #3b6fd4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1116; --panel: #161b22; --ink: #e7edf5; --muted: #9aa4b2;
      --line: #262d38; --track: #222933;
      --ok: #2ecc8f; --warn: #e0a33e; --hot: #f2685f; --dead: #a78bfa;
      --accent: #6f9dff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.45 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    position: sticky; top: 0; z-index: 5; backdrop-filter: blur(12px);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    border-bottom: 1px solid var(--line);
    padding: 8px 14px; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  }
  h1 { font-size: 13px; margin: 0; letter-spacing: .2px; }
  .sub { color: var(--muted); font-size: 12px; }
  .spacer { flex: 1; }
  button {
    font: inherit; font-size: 12px; color: var(--ink); background: var(--panel);
    border: 1px solid var(--line); border-radius: 7px; padding: 5px 11px; cursor: pointer;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  main { padding: 10px 14px 16px; max-width: 1240px; margin: 0 auto; }
  .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .tot {
    background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 8px 11px;
  }
  .tot .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
  .tot .v { font-size: 19px; font-variant-numeric: tabular-nums; margin-top: 1px; font-weight: 600; }
  .tot .n { color: var(--muted); font-size: 10.5px; margin-top: 1px; }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .09em; color: var(--muted);
    margin: 12px 0 7px; font-weight: 600;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 8px; }
  .seat {
    background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 9px 11px;
  }
  .seat.err { border-color: var(--dead); }
  .seat-top { display: flex; align-items: baseline; gap: 7px; margin-bottom: 1px; }
  .label { font-weight: 600; font-size: 12.5px; }
  .plan {
    font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
    border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px;
  }
  .who { color: var(--muted); font-size: 10.5px; margin-bottom: 7px; word-break: break-all; }
  .row { margin-top: 6px; }
  .row-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 10.5px; margin-bottom: 3px; }
  .row-head .name { color: var(--muted); text-transform: uppercase; letter-spacing: .05em; font-size: 9.5px; }
  .row-head .free { font-variant-numeric: tabular-nums; font-weight: 600; }
  .bar { height: 5px; border-radius: 3px; background: var(--track); overflow: hidden; }
  .fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
  .reset { color: var(--muted); font-size: 10px; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .err-msg { color: var(--dead); font-size: 12px; margin-top: 8px; }
  .none { color: var(--muted); font-size: 12px; }
  .others { margin-top: 12px; color: var(--muted); font-size: 10.5px; }
  .others code { color: var(--ink); }
  .banner {
    background: color-mix(in srgb, var(--hot) 12%, var(--panel));
    border: 1px solid var(--hot); color: var(--hot);
    border-radius: 8px; padding: 8px 11px; margin-bottom: 9px; font-size: 12px;
  }
</style>
</head>
<body>
<header>
  <h1>Smithers Quota</h1>
  <span class="sub" id="stamp">loading…</span>
  <span class="spacer"></span>
  <button id="refresh">Refresh</button>
</header>
<main id="root"><p class="none">Reading <code>smithers usage</code>…</p></main>
<script>
const pct = (n) => Math.max(0, Math.min(100, Number(n) || 0));
const tone = (used) => used >= 85 ? "var(--hot)" : used >= 60 ? "var(--warn)" : "var(--ok)";

function until(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms)) return "";
  if (ms <= 0) return "resets now";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return \`resets in \${d}d \${h % 24}h\`;
  if (h > 0) return \`resets in \${h}h \${m % 60}m\`;
  return \`resets in \${m}m\`;
}

function windowRow(name, w) {
  if (!w) return "";
  const used = pct(w.usedPercent);
  const free = 100 - used;
  const est = w.unit === "estimated" || w.estimate ? " · estimated" : "";
  return \`<div class="row">
    <div class="row-head">
      <span class="name">\${name}</span>
      <span class="free" style="color:\${tone(used)}">\${free}% free</span>
    </div>
    <div class="bar"><div class="fill" style="width:\${used}%;background:\${tone(used)}"></div></div>
    <div class="reset">\${used}% used · \${until(w.resetsAt)}\${est}</div>
  </div>\`;
}

function seatCard(seat) {
  if (seat.error) {
    return \`<div class="seat err">
      <div class="seat-top"><span class="label">\${seat.label}</span></div>
      <div class="who">\${seat.account ?? "unknown subscription"}</div>
      <div class="err-msg">\${seat.error}</div>
    </div>\`;
  }
  return \`<div class="seat">
    <div class="seat-top">
      <span class="label">\${seat.label}</span>
      \${seat.planType ? \`<span class="plan">\${seat.planType}</span>\` : ""}
    </div>
    <div class="who">\${seat.account ?? "—"}</div>
    \${windowRow("weekly", seat.weekly)}
    \${windowRow("5-hour", seat.session)}
    \${windowRow("Fable (50% cap)", seat.fable)}
    \${!seat.weekly && !seat.session && !seat.fable ? '<div class="none">no usage windows reported</div>' : ""}
  </div>\`;
}

function poolTotal(seats) {
  const live = seats.filter((s) => !s.error && s.weekly);
  if (!live.length) return { free: 0, live: 0, total: seats.length };
  const free = live.reduce((sum, s) => sum + (100 - pct(s.weekly.usedPercent)), 0) / live.length;
  return { free: Math.round(free), live: live.length, total: seats.length };
}

function render(snap) {
  const root = document.getElementById("root");
  document.getElementById("stamp").textContent =
    new Date(snap.fetchedAt).toLocaleTimeString() + " · " +
    (snap.claude.length + snap.codex.length) + " seats";

  if (snap.error) {
    root.innerHTML = \`<div class="banner">\${snap.error}</div>\`;
    return;
  }

  const c = poolTotal(snap.claude), x = poolTotal(snap.codex);
  const broken = [...snap.claude, ...snap.codex].filter((s) => s.error);

  root.innerHTML =
    (broken.length
      ? \`<div class="banner">\${broken.length} seat\${broken.length > 1 ? "s" : ""} cannot report quota — \${broken.map((s) => s.label).join(", ")}. Re-authenticate to put \${broken.length > 1 ? "them" : "it"} back in the pool.</div>\`
      : "") +
    \`<div class="totals">
      <div class="tot"><div class="k">Claude weekly free</div><div class="v" style="color:\${tone(100 - c.free)}">\${c.free}%</div><div class="n">mean across \${c.live} of \${c.total} seats</div></div>
      <div class="tot"><div class="k">Codex weekly free</div><div class="v" style="color:\${tone(100 - x.free)}">\${x.free}%</div><div class="n">mean across \${x.live} of \${x.total} seats</div></div>
      <div class="tot"><div class="k">Seats reporting</div><div class="v">\${c.live + x.live}</div><div class="n">of \${c.total + x.total} registered</div></div>
    </div>\` +
    \`<h2>Claude Code — \${snap.claude.length} subscriptions</h2>\` +
    (snap.claude.length ? \`<div class="grid">\${snap.claude.map(seatCard).join("")}</div>\` : '<p class="none">none registered</p>') +
    \`<h2>Codex — \${snap.codex.length} subscriptions</h2>\` +
    (snap.codex.length ? \`<div class="grid">\${snap.codex.map(seatCard).join("")}</div>\` : '<p class="none">none registered</p>') +
    (snap.otherProviders.length
      ? \`<div class="others">Not charted: \${snap.otherProviders.map((o) => \`<code>\${o.label}</code> (\${o.provider})\`).join(", ")} — no subscription quota windows.</div>\`
      : "");
}

async function load() {
  try {
    const res = await fetch("/api/usage", { cache: "no-store" });
    render(await res.json());
  } catch (err) {
    document.getElementById("root").innerHTML = '<div class="banner">' + err.message + "</div>";
  }
}

document.getElementById("refresh").addEventListener("click", load);
load();
// Provider windows move on the order of minutes; a 60s poll keeps the view
// current without hammering each provider's usage endpoint.
setInterval(load, 60000);
</script>
</body>
</html>`;
