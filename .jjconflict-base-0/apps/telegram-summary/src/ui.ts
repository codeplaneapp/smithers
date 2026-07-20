import { workflowUiThemeCss } from "@smithers-orchestrator/gateway-ui/styleguide-css";
import type { DigestRow } from "./service.ts";
import { digestJsonFromRow } from "./service.ts";

export function digestPayload(row: DigestRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    periodStartMs: row.period_start_ms,
    periodEndMs: row.period_end_ms,
    messageCount: row.message_count,
    model: row.model,
    createdAtMs: row.created_at_ms,
    postedAtMs: row.posted_at_ms,
    postError: row.post_error,
    telegramText: row.telegram_text,
    summary: digestJsonFromRow(row),
  };
}

export function renderDashboard(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Telegram Summary</title>
  <style>
    ${workflowUiThemeCss}
    :root {
      --ink: var(--text);
      --green: var(--success);
      --green-soft: color-mix(in srgb, var(--success) 12%, var(--surface));
      --amber: var(--warning);
      --amber-soft: color-mix(in srgb, var(--warning) 12%, var(--surface));
      --shadow: 0 10px 30px rgb(var(--shadow-rgb) / 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      letter-spacing: 0;
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 40px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    h1 {
      font-size: 24px;
      line-height: 1.1;
      margin: 0;
      font-weight: 700;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 14px;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 700;
    }
    button, input {
      font: inherit;
      letter-spacing: 0;
    }
    button {
      min-height: 36px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      border-radius: 6px;
      padding: 0 12px;
      cursor: pointer;
    }
    button.primary {
      border-color: var(--green);
      background: var(--green);
      color: #fff;
    }
    button:disabled { opacity: 0.55; cursor: default; }
    input {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      min-width: 210px;
      background: var(--surface);
      color: var(--ink);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 16px;
      align-items: start;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 16px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .stat {
      min-height: 76px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: var(--hover-subtle);
    }
    .stat strong {
      display: block;
      font-size: 22px;
      line-height: 1.1;
      margin-bottom: 6px;
      font-variant-numeric: tabular-nums;
    }
    .label, .meta {
      color: var(--muted);
      font-size: 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 0 8px;
      border-radius: 999px;
      background: var(--green-soft);
      color: var(--green);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .badge.warn {
      background: var(--amber-soft);
      color: var(--amber);
    }
    .digest-title {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .digest-title h3 {
      margin: 0;
      font-size: 20px;
      line-height: 1.25;
    }
    .summary {
      font-size: 15px;
      line-height: 1.55;
      margin: 0 0 18px;
    }
    .topics {
      display: grid;
      gap: 12px;
    }
    .topic {
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    .topic h4 {
      margin: 0 0 6px;
      font-size: 15px;
    }
    .topic p {
      margin: 0 0 8px;
      color: var(--text);
      line-height: 1.45;
    }
    ul {
      margin: 0;
      padding-left: 18px;
    }
    li {
      margin: 4px 0;
      line-height: 1.4;
    }
    .history {
      display: grid;
      gap: 8px;
    }
    .history button {
      width: 100%;
      min-height: 56px;
      text-align: left;
      background: var(--hover-subtle);
      display: grid;
      gap: 3px;
    }
    .empty {
      min-height: 260px;
      display: grid;
      place-items: center;
      text-align: center;
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      background: var(--hover-subtle);
    }
    .text-block {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      background: var(--hover-subtle);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      max-height: 360px;
      overflow: auto;
    }
    .toast {
      min-height: 22px;
      color: var(--brand);
      font-size: 12px;
      margin-top: 10px;
    }
    @media (max-width: 860px) {
      main { width: min(100vw - 20px, 720px); padding-top: 14px; }
      header { align-items: flex-start; flex-direction: column; }
      .toolbar { width: 100%; justify-content: stretch; }
      .toolbar button, .toolbar input { flex: 1 1 150px; }
      .grid { grid-template-columns: 1fr; }
      .stats { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Telegram Summary</h1>
        <div class="meta" id="updated">Loading</div>
      </div>
      <div class="toolbar">
        <input id="token" type="password" autocomplete="off" placeholder="Admin token">
        <button id="ingest">Ingest</button>
        <button id="run" class="primary">Run Digest</button>
        <button id="refresh">Refresh</button>
      </div>
    </header>
    <section class="stats">
      <div class="stat"><strong id="stat-messages">-</strong><span class="label">Messages stored</span></div>
      <div class="stat"><strong id="stat-digests">-</strong><span class="label">Digests created</span></div>
      <div class="stat"><strong id="stat-model">-</strong><span class="label">Model</span></div>
    </section>
    <section class="grid">
      <div class="panel" id="latest-panel"></div>
      <aside class="panel">
        <h2>History</h2>
        <div class="history" id="history"></div>
        <div class="toast" id="toast"></div>
      </aside>
    </section>
  </main>
  <script type="module">
    const state = { latest: null, digests: [], status: null };
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    const fmt = (ms) => ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Never";
    const tokenInput = $("token");
    tokenInput.value = localStorage.getItem("telegram-summary-token") || "";
    tokenInput.addEventListener("input", () => localStorage.setItem("telegram-summary-token", tokenInput.value));

    function renderLatest(digest) {
      const panel = $("latest-panel");
      if (!digest) {
        panel.innerHTML = '<h2>Latest Summary</h2><div class="empty">No digest has been created yet.</div>';
        return;
      }
      const summary = digest.summary || {};
      const topics = Array.isArray(summary.topics) ? summary.topics : [];
      const topicHtml = topics.map((topic) => \`
        <article class="topic">
          <h4>\${esc(topic.title || "Topic")}</h4>
          <p>\${esc(topic.summary || "")}</p>
          \${Array.isArray(topic.keyPoints) && topic.keyPoints.length ? '<ul>' + topic.keyPoints.slice(0, 5).map((point) => '<li>' + esc(point) + '</li>').join("") + '</ul>' : ""}
        </article>\`).join("");
      panel.innerHTML = \`
        <h2>Latest Summary</h2>
        <div class="digest-title">
          <div>
            <h3>\${esc(summary.headline || "Telegram Daily Summary")}</h3>
            <div class="meta">\${fmt(digest.periodStartMs)} to \${fmt(digest.periodEndMs)} · \${digest.messageCount} messages</div>
          </div>
          <span class="badge \${digest.postError ? "warn" : ""}">\${digest.postError ? "Not posted" : digest.postedAtMs ? "Posted" : "Ready"}</span>
        </div>
        <p class="summary">\${esc(summary.summary || "")}</p>
        <div class="topics">\${topicHtml}</div>
        <h2 style="margin-top:18px">Telegram Text</h2>
        <div class="text-block">\${esc(digest.telegramText || "")}</div>\`;
    }

    function renderHistory() {
      const history = $("history");
      if (!state.digests.length) {
        history.innerHTML = '<div class="empty" style="min-height:160px">No history.</div>';
        return;
      }
      history.innerHTML = state.digests.map((digest) => \`
        <button data-id="\${esc(digest.id)}">
          <strong>\${esc((digest.summary && digest.summary.headline) || digest.id)}</strong>
          <span class="meta">\${fmt(digest.createdAtMs)} · \${digest.messageCount} messages</span>
        </button>\`).join("");
      for (const button of history.querySelectorAll("button[data-id]")) {
        button.addEventListener("click", () => {
          const selected = state.digests.find((digest) => digest.id === button.dataset.id);
          if (selected) renderLatest(selected);
        });
      }
    }

    function renderStatus() {
      $("stat-messages").textContent = state.status?.messages ?? "-";
      $("stat-digests").textContent = state.status?.digests ?? "-";
      $("stat-model").textContent = state.status?.model ?? "-";
      $("updated").textContent = "Updated " + new Date().toLocaleTimeString([], { timeStyle: "short" });
    }

    async function load() {
      const [status, latest, digests] = await Promise.all([
        fetch("/api/status").then((r) => r.json()),
        fetch("/api/latest").then((r) => r.json()),
        fetch("/api/digests").then((r) => r.json()),
      ]);
      state.status = status;
      state.latest = latest.digest;
      state.digests = digests.digests || [];
      renderStatus();
      renderLatest(state.latest);
      renderHistory();
    }

    async function mutate(path) {
      const token = tokenInput.value.trim();
      const response = await fetch(path, {
        method: "POST",
        headers: token ? { authorization: "Bearer " + token } : {},
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || response.statusText);
      $("toast").textContent = path === "/api/ingest" ? "Ingest complete." : "Digest run complete.";
      await load();
    }

    $("refresh").addEventListener("click", () => void load());
    $("ingest").addEventListener("click", () => void mutate("/api/ingest").catch((error) => $("toast").textContent = error.message));
    $("run").addEventListener("click", () => void mutate("/api/run-digest").catch((error) => $("toast").textContent = error.message));
    void load().catch((error) => {
      $("latest-panel").innerHTML = '<h2>Latest Summary</h2><div class="empty">' + esc(error.message) + '</div>';
    });
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

export function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}
