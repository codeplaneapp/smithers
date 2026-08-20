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
  .seat.ok { border-color: var(--ok); box-shadow: inset 0 0 0 1px var(--ok); }
  .seat.degraded { border-color: var(--warn); box-shadow: inset 0 0 0 1px var(--warn); }
  .seat.blocked { border-color: var(--hot); box-shadow: inset 0 0 0 1px var(--hot); }
  .seat.err { border-color: var(--dead); }
  .status { font-size: 10.5px; margin-top: 7px; }
  .status.degraded { color: var(--warn); }
  .status.blocked { color: var(--hot); }
  .legend { color: var(--muted); font-size: 10.5px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin: 0 3px 0 8px; }
  h2 { display: flex; align-items: center; gap: 8px; }
  h2 button { font-size: 10.5px; padding: 2px 8px; text-transform: none; letter-spacing: normal; }
  .seat-top .spacer { flex: 1; }
  .seat-top .act {
    font-size: 10px; padding: 1px 6px; border-radius: 5px; cursor: pointer;
    color: var(--muted); background: transparent; border: 1px solid var(--line);
  }
  .seat-top .act:hover { color: var(--hot); border-color: var(--hot); }
  .seat-top .act.login:hover { color: var(--accent); border-color: var(--accent); }
  .job {
    background: color-mix(in srgb, var(--accent) 10%, var(--panel));
    border: 1px solid var(--accent); border-radius: 8px;
    padding: 8px 11px; margin-bottom: 9px; font-size: 12px;
  }
  .job code { font-size: 11px; }
  .job .tail { color: var(--muted); font-size: 10.5px; margin-top: 3px; }
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
  <span class="legend"><span class="dot" style="background:var(--ok)"></span>usable
    <span class="dot" style="background:var(--warn)"></span>degraded
    <span class="dot" style="background:var(--hot)"></span>rate-limited</span>
  <button id="refresh">Refresh</button>
</header>
<main><div id="jobs"></div><div id="root"><p class="none">Reading <code>smithers usage</code>…</p></div></main>
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
  if (!w) {
    return \`<div class="row">
      <div class="row-head"><span class="name">\${name}</span><span class="free" style="color:var(--muted)">not reported</span></div>
      <div class="bar"></div>
    </div>\`;
  }
  const used = pct(w.usedPercent);
  const free = 100 - used;
  const reset = until(w.resetsAt);
  return \`<div class="row">
    <div class="row-head">
      <span class="name">\${name}</span>
      <span class="free" style="color:\${tone(used)}">\${free}% free</span>
    </div>
    <div class="bar"><div class="fill" style="width:\${used}%;background:\${tone(used)}"></div></div>
    <div class="reset">\${used}% used\${reset ? " · " + reset : ""}</div>
  </div>\`;
}

// Mirrors LOGIN_PROVIDERS on the server: only subscription providers have a
// browser login the dashboard can drive.
const CAN_LOGIN = new Set(["claude-code", "codex", "kimi", "antigravity"]);

// A lapsed token recovers without a browser, so offer that first; the server
// also starts it automatically when it sees one.
const canRefresh = (seat) => seat.provider === "claude-code" && /expired/i.test(seat.error ?? "");

const seatActions = (seat) => \`<span class="spacer"></span>
    \${canRefresh(seat) ? \`<button class="act login" data-refresh="\${seat.label}" title="Refresh this token without a browser">refresh</button>\` : ""}
    \${CAN_LOGIN.has(seat.provider) ? \`<button class="act login" data-login="\${seat.label}">log in</button>\` : ""}
    <button class="act" data-remove="\${seat.label}" title="Remove this account">✕</button>\`;

function seatCard(seat) {
  if (seat.error) {
    return \`<div class="seat err">
      <div class="seat-top"><span class="label">\${seat.label}</span>\${seatActions(seat)}</div>
      <div class="who">\${seat.account ?? "unknown subscription"}</div>
      <div class="err-msg">\${seat.error}</div>
    </div>\`;
  }
  const status = seat.availability?.status ?? "unknown";
  const reasons = seat.availability?.reasons ?? [];
  return \`<div class="seat \${status === "unknown" ? "" : status}">
    <div class="seat-top">
      <span class="label">\${seat.label}</span>
      \${seat.planType ? \`<span class="plan">\${seat.planType}</span>\` : ""}
      \${seatActions(seat)}
    </div>
    <div class="who">\${seat.account ?? "—"}</div>
    \${windowRow("weekly", seat.weekly)}
    \${windowRow("5-hour", seat.session)}
    \${(seat.scoped ?? []).map((w) => windowRow(w.label, w)).join("")}
    \${(seat.extra ?? []).map((w) => windowRow(w.label, w)).join("")}
    \${reasons.length ? \`<div class="status \${status}">\${reasons.join(" · ")}</div>\` : ""}
  </div>\`;
}

function poolTotal(seats) {
  const live = seats.filter((s) => !s.error && s.weekly);
  if (!live.length) return { free: 0, live: 0, total: seats.length };
  const free = live.reduce((sum, s) => sum + (100 - pct(s.weekly.usedPercent)), 0) / live.length;
  return { free: Math.round(free), live: live.length, total: seats.length };
}

/** A KPI tile per provider that reports weekly windows, plus a seats-reporting tile. */
function totalsFor(groups) {
  const charted = groups.filter((g) => g.seats.some((s) => s.weekly));
  const tiles = charted.map((g) => {
    const t = poolTotal(g.seats);
    return \`<div class="tot"><div class="k">\${g.title} weekly free</div>
      <div class="v" style="color:\${tone(100 - t.free)}">\${t.free}%</div>
      <div class="n">mean across \${t.live} of \${t.total} seats</div></div>\`;
  });
  const allSeats = groups.flatMap((g) => g.seats);
  const reporting = allSeats.filter((s) => !s.error && (s.weekly || s.session)).length;
  tiles.push(\`<div class="tot"><div class="k">Seats reporting</div><div class="v">\${reporting}</div>
    <div class="n">of \${allSeats.length} registered</div></div>\`);
  return \`<div class="totals">\${tiles.join("")}</div>\`;
}

function render(snap) {
  const root = document.getElementById("root");
  const groups = snap.groups ?? [];
  const allSeats = groups.flatMap((g) => g.seats);
  document.getElementById("stamp").textContent =
    new Date(snap.fetchedAt).toLocaleTimeString() + " · " + allSeats.length + " seats";

  if (snap.error) {
    root.innerHTML = \`<div class="banner">\${snap.error}</div>\`;
    return;
  }

  const broken = allSeats.filter((s) => s.error);

  root.innerHTML =
    (broken.length
      ? \`<div class="banner">\${broken.length} seat\${broken.length > 1 ? "s" : ""} cannot report quota: \${broken.map((s) => s.label).join(", ")}. Log in again to put \${broken.length > 1 ? "them" : "it"} back in the pool.</div>\`
      : "") +
    totalsFor(groups) +
    groups
      .map(
        (g) =>
          \`<h2>\${g.title} — \${g.seats.length} \${g.seats.length === 1 ? "account" : "accounts"}
            \${g.canLogin ? \`<button data-add="\${g.provider}">＋ add seat</button>\` : ""}</h2>\` +
          \`<div class="grid">\${g.seats.map(seatCard).join("")}</div>\`,
      )
      .join("");
}

async function load() {
  try {
    const res = await fetch("/api/usage", { cache: "no-store" });
    render(await res.json());
    // The snapshot request is also what starts an automatic token refresh, so
    // look for jobs the server just created rather than only ones we asked for.
    pollJobs();
  } catch (err) {
    document.getElementById("root").innerHTML = '<div class="banner">' + err.message + "</div>";
  }
}

function renderJobs(jobs) {
  const el = document.getElementById("jobs");
  // A finished job stays up briefly. A login that exits without needing a
  // browser used to disappear the instant it completed, which read as the
  // button doing nothing at all.
  const visible = jobs.filter((j) => !j.done || j.ok === false || Date.now() - (j.finishedAt ?? 0) < 90000);
  el.innerHTML = visible
    .map((j) => {
      const verb = j.kind === "add" ? "Adding" : j.kind === "refresh" ? "Refreshing the token for" : "Re-login for";
      const state = !j.done
        ? j.kind === "refresh"
          ? "refreshing…"
          : "waiting for the browser login to complete…"
        : j.ok === false
          ? "failed"
          : (j.note ?? "done");
      const tail = j.lines.slice(-2).join(" · ");
      return \`<div class="job">\${verb} <b>\${j.label}</b> (\${j.provider}): \${state}
        \${j.loginUrl ? \`<div>Opened in your browser: <a href="\${j.loginUrl}" target="_blank">\${j.loginUrl}</a></div>\` : ""}
        \${j.attachCmd ? \`<div>Drive the login from a terminal: <code>\${j.attachCmd}</code></div>\` : ""}
        \${tail ? \`<div class="tail">\${tail}</div>\` : ""}
      </div>\`;
    })
    .join("");
}

let jobTimer = null;
const settledJobs = new Set();
async function pollJobs() {
  if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
  try {
    const res = await fetch("/api/jobs", { cache: "no-store" });
    const { jobs } = await res.json();
    renderJobs(jobs);
    for (const j of jobs) {
      if (j.done && j.ok && !settledJobs.has(j.id)) {
        settledJobs.add(j.id);
        load();
      }
    }
    // Keep polling while anything is pending or still on screen, so a finished
    // job clears itself instead of sticking until the next manual refresh.
    if (jobs.some((j) => !j.done || Date.now() - (j.finishedAt ?? 0) < 90000)) {
      jobTimer = setTimeout(pollJobs, 3000);
    }
  } catch {
    jobTimer = setTimeout(pollJobs, 3000);
  }
}

// A click that fails must never look like a click that did nothing: report the
// reason in the job strip instead of dropping it.
function reportActionError(message) {
  const el = document.getElementById("jobs");
  el.innerHTML = '<div class="job">' + message + "</div>" + el.innerHTML;
}

async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      reportActionError("Request failed (" + res.status + ").");
    } else if (payload && payload.error) {
      reportActionError(payload.error);
    }
    return payload;
  } catch (err) {
    reportActionError("Could not reach the dashboard backend: " + err.message + ". The app may have been restarted; reopen it.");
    return {};
  }
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-add],[data-remove],[data-login],[data-refresh]");
  if (!target) return;
  if (target.dataset.add) {
    await post("/api/accounts/add", { provider: target.dataset.add });
    pollJobs();
  } else if (target.dataset.refresh) {
    await post("/api/accounts/refresh", { label: target.dataset.refresh });
    pollJobs();
  } else if (target.dataset.login) {
    await post("/api/accounts/login", { label: target.dataset.login });
    pollJobs();
  } else if (target.dataset.remove) {
    if (!confirm("Remove " + target.dataset.remove + " from the pool?")) return;
    await post("/api/accounts/remove", { label: target.dataset.remove });
    load();
  }
});

document.getElementById("refresh").addEventListener("click", load);
load();
pollJobs();
// Provider windows move on the order of minutes; a 60s poll keeps the view
// current without hammering each provider's usage endpoint.
setInterval(load, 60000);
</script>
</body>
</html>`;
