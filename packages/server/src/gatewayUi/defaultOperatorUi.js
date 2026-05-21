export const DEFAULT_OPERATOR_UI_ENTRY = "smithers:default-operator-ui";

function defaultOperatorUiClient() {
const boot = globalThis.__SMITHERS_GATEWAY_UI__ ?? {};
const root = document.getElementById("root");
const storageKey = "smithers.gateway.console.token";
function readStoredToken() {
  try {
    return sessionStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}
function writeStoredToken(value) {
  try {
    if (value) {
      sessionStorage.setItem(storageKey, value);
    } else {
      sessionStorage.removeItem(storageKey);
    }
  } catch {
    // Some embedded browsers disable Web Storage; the in-memory token remains usable.
  }
}
const state = {
  token: readStoredToken(),
  health: null,
  workflows: [],
  runs: [],
  approvals: [],
  selectedWorkflow: "",
  runInput: "{}",
  status: "Loading",
  error: "",
  busy: false,
};

const css = `
:root {
  color-scheme: light;
  --ink: #161616;
  --muted: #6f6a61;
  --line: #ded8ce;
  --surface: #f7f3ec;
  --panel: #fffaf2;
  --accent: #235c58;
  --accent-strong: #17413e;
  --danger: #9f2e24;
  --ok: #2f6b3f;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--surface);
  color: var(--ink);
}
button, input, textarea, select { font: inherit; }
button {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: white;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 6px;
  cursor: pointer;
}
button.secondary {
  background: transparent;
  color: var(--accent);
}
button.danger {
  background: transparent;
  color: var(--danger);
  border-color: var(--danger);
}
button:disabled { opacity: 0.55; cursor: not-allowed; }
.shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 360px;
}
.nav {
  border-right: 1px solid var(--line);
  padding: 22px 18px;
}
.brand {
  font-size: 24px;
  font-weight: 760;
  letter-spacing: 0;
  margin-bottom: 24px;
}
.nav-section {
  display: grid;
  gap: 10px;
  margin-top: 24px;
}
.label {
  color: var(--muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.token {
  width: 100%;
  border: 1px solid var(--line);
  background: white;
  border-radius: 6px;
  min-height: 34px;
  padding: 0 10px;
}
.main {
  padding: 24px;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 18px;
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.title {
  font-size: 22px;
  font-weight: 720;
}
.meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.pill {
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0 10px;
  color: var(--muted);
  background: rgba(255,255,255,0.5);
  font-size: 13px;
}
.pill.ok { color: var(--ok); border-color: rgba(47,107,63,0.35); }
.pill.warn { color: var(--danger); border-color: rgba(159,46,36,0.35); }
.launch {
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: 16px 0;
  display: grid;
  grid-template-columns: minmax(180px, 260px) minmax(260px, 1fr) auto;
  gap: 12px;
  align-items: end;
}
.field {
  display: grid;
  gap: 6px;
}
.field select, .field textarea {
  border: 1px solid var(--line);
  background: white;
  border-radius: 6px;
  padding: 9px 10px;
}
.field textarea {
  min-height: 72px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.runs {
  overflow: auto;
  display: grid;
  align-content: start;
}
.run-row {
  display: grid;
  grid-template-columns: minmax(160px, 1.2fr) 120px 140px 1fr;
  gap: 12px;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
}
.run-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.muted { color: var(--muted); }
.side {
  border-left: 1px solid var(--line);
  background: var(--panel);
  padding: 22px 18px;
  display: grid;
  align-content: start;
  gap: 18px;
}
.side h2 {
  font-size: 15px;
  margin: 0;
}
.approval {
  border-top: 1px solid var(--line);
  padding-top: 14px;
  display: grid;
  gap: 10px;
}
.approval-title {
  font-weight: 680;
}
.approval-actions {
  display: flex;
  gap: 8px;
}
.empty {
  color: var(--muted);
  padding: 18px 0;
}
.error {
  color: var(--danger);
  min-height: 20px;
}
@media (max-width: 960px) {
  .shell { grid-template-columns: 1fr; }
  .nav, .side { border: 0; border-bottom: 1px solid var(--line); }
  .main { padding: 18px; }
  .launch { grid-template-columns: 1fr; }
  .run-row { grid-template-columns: 1fr; }
}
`;

function installStyles() {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

function setToken(value) {
  state.token = value;
  writeStoredToken(value);
}

async function rpc(method, params = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (state.token) {
    headers.set("authorization", "Bearer " + state.token);
  }
  const response = await fetch((boot.rpcPath ?? "/v1/rpc") + "/" + method, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  const frame = await response.json().catch(() => null);
  if (!response.ok || !frame?.ok) {
    throw new Error(frame?.error?.message ?? "Gateway request failed");
  }
  return frame.payload;
}

function statusClass(status) {
  if (status === "finished") return "ok";
  if (status === "failed" || status === "cancelled") return "warn";
  return "";
}

function formatAge(ms) {
  if (!ms) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  return Math.floor(minutes / 60) + "h ago";
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function renderRuns() {
  if (state.runs.length === 0) {
    return '<div class="empty">No runs found.</div>';
  }
  return state.runs.map((run) => `
    <div class="run-row">
      <div>
        <div class="run-id">${escapeText(run.runId)}</div>
        <div class="muted">${escapeText(run.workflowKey ?? run.workflowName ?? "workflow")}</div>
      </div>
      <div><span class="pill ${statusClass(run.status)}">${escapeText(run.status)}</span></div>
      <div class="muted">${escapeText(formatAge(run.createdAtMs))}</div>
      <div class="muted">${escapeText(run.triggeredBy ?? run.auth?.triggeredBy ?? "")}</div>
    </div>
  `).join("");
}

function renderApprovals() {
  if (state.approvals.length === 0) {
    return '<div class="empty">No pending approvals.</div>';
  }
  return state.approvals.map((approval, index) => `
    <section class="approval">
      <div>
        <div class="approval-title">${escapeText(approval.requestTitle ?? approval.nodeId)}</div>
        <div class="muted">${escapeText(approval.workflowKey)} / ${escapeText(approval.runId)}</div>
      </div>
      <div class="approval-actions">
        <button data-approve="${index}">Approve</button>
        <button class="danger" data-deny="${index}">Deny</button>
      </div>
    </section>
  `).join("");
}

function renderWorkflows() {
  const options = state.workflows.map((workflow) => {
    const selected = workflow.key === state.selectedWorkflow ? " selected" : "";
    return `<option value="${escapeText(workflow.key)}"${selected}>${escapeText(workflow.readableName ?? workflow.key)}</option>`;
  }).join("");
  return `<select id="workflow">${options || '<option value="">No workflows</option>'}</select>`;
}

function render() {
  const activeRuns = state.runs.filter((run) => ["running", "waiting-approval", "waiting-event", "waiting-timer"].includes(run.status)).length;
  root.innerHTML = `
    <div class="shell">
      <aside class="nav">
        <div class="brand">Smithers Console</div>
        <div class="nav-section">
          <div class="label">Gateway</div>
          <span class="pill ${state.health ? "ok" : "warn"}">${state.health ? "online" : "checking"}</span>
          <span class="pill">${escapeText(state.health?.features?.join(", ") ?? "features pending")}</span>
        </div>
        <div class="nav-section">
          <label class="label" for="token">Bearer token</label>
          <input class="token" id="token" value="${escapeText(state.token)}" type="password" autocomplete="off">
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <div>
            <div class="title">Operations</div>
            <div class="muted">${escapeText(state.status)}</div>
          </div>
          <div class="meta">
            <span class="pill">${state.workflows.length} workflows</span>
            <span class="pill">${activeRuns} active</span>
            <span class="pill">${state.approvals.length} approvals</span>
            <button class="secondary" id="refresh">Refresh</button>
          </div>
        </div>
        <form class="launch" id="launch">
          <label class="field">
            <span class="label">Workflow</span>
            ${renderWorkflows()}
          </label>
          <label class="field">
            <span class="label">Input JSON</span>
            <textarea id="run-input" spellcheck="false">${escapeText(state.runInput)}</textarea>
          </label>
          <button type="submit" ${state.busy ? "disabled" : ""}>Launch</button>
        </form>
        <section class="runs">${renderRuns()}</section>
      </main>
      <aside class="side">
        <div>
          <h2>Pending Approvals</h2>
          <div class="error">${escapeText(state.error)}</div>
        </div>
        ${renderApprovals()}
      </aside>
    </div>
  `;
  bind();
}

function bind() {
  document.getElementById("token")?.addEventListener("input", (event) => {
    setToken(event.target.value);
  });
  document.getElementById("workflow")?.addEventListener("change", (event) => {
    state.selectedWorkflow = event.target.value;
  });
  document.getElementById("run-input")?.addEventListener("input", (event) => {
    state.runInput = event.target.value;
  });
  document.getElementById("refresh")?.addEventListener("click", () => refresh());
  document.getElementById("launch")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await launchRun();
  });
  for (const button of document.querySelectorAll("[data-approve]")) {
    button.addEventListener("click", () => decideApproval(Number(button.dataset.approve), true));
  }
  for (const button of document.querySelectorAll("[data-deny]")) {
    button.addEventListener("click", () => decideApproval(Number(button.dataset.deny), false));
  }
}

async function refresh() {
  state.error = "";
  try {
    const [health, workflows, runs, approvals] = await Promise.all([
      rpc("health"),
      rpc("listWorkflows", { limit: 100 }),
      rpc("listRuns", { limit: 100 }),
      rpc("listApprovals", { limit: 50 }),
    ]);
    state.health = health;
    state.workflows = workflows;
    state.runs = runs;
    state.approvals = approvals;
    if (!state.selectedWorkflow && workflows[0]) {
      state.selectedWorkflow = workflows[0].key;
    }
    state.status = "Updated " + new Date().toLocaleTimeString();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.status = "Refresh failed";
  }
  render();
}

async function launchRun() {
  state.busy = true;
  state.error = "";
  render();
  try {
    const input = JSON.parse(state.runInput || "{}");
    await rpc("launchRun", { workflow: state.selectedWorkflow, input });
    state.status = "Run launched";
    await refresh();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.busy = false;
    render();
  }
  state.busy = false;
}

async function decideApproval(index, approved) {
  const approval = state.approvals[index];
  if (!approval) return;
  state.error = "";
  try {
    await rpc("submitApproval", {
      runId: approval.runId,
      nodeId: approval.nodeId,
      iteration: approval.iteration ?? 0,
      approved,
      decision: { approved },
    });
    await refresh();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

installStyles();
render();
refresh();
setInterval(refresh, 5000);
}

export const DEFAULT_OPERATOR_UI_CLIENT_JS = `(${defaultOperatorUiClient.toString()})();\n`;
