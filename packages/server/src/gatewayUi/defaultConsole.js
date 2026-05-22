export function renderDefaultConsoleClient() {
    return `
const boot = globalThis.__SMITHERS_GATEWAY_UI__ || {};
const root = document.getElementById("root");
const state = {
  token: "",
  workflows: [],
  runs: [],
  approvals: [],
  error: "",
  loading: false,
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[ch]);
}

function age(ms) {
  if (!ms) return "unknown";
  const delta = Math.max(0, Date.now() - Number(ms));
  if (delta < 60_000) return Math.floor(delta / 1000) + "s";
  if (delta < 3_600_000) return Math.floor(delta / 60_000) + "m";
  if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + "h";
  return Math.floor(delta / 86_400_000) + "d";
}

async function rpc(method, params = {}) {
  const headers = { "content-type": "application/json" };
  if (state.token.trim()) headers.authorization = "Bearer " + state.token.trim();
  const response = await fetch((boot.rpcPath || "/v1/rpc") + "/" + method, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error?.message || response.statusText || "Gateway request failed");
  }
  return body.payload;
}

async function refresh() {
  state.loading = true;
  state.error = "";
  render();
  try {
    const [workflows, runs, approvals] = await Promise.all([
      rpc("listWorkflows", {}),
      rpc("listRuns", { filter: { limit: 100 } }),
      rpc("listApprovals", { filter: { limit: 100 } }),
    ]);
    state.workflows = Array.isArray(workflows) ? workflows : [];
    state.runs = Array.isArray(runs) ? runs : [];
    state.approvals = Array.isArray(approvals) ? approvals : [];
  } catch (error) {
    state.error = error?.message || "Gateway request failed";
  } finally {
    state.loading = false;
    render();
  }
}

async function decide(approval, approved) {
  state.error = "";
  render();
  try {
    await rpc("submitApproval", {
      runId: approval.runId,
      nodeId: approval.nodeId,
      iteration: approval.iteration || 0,
      approved,
      note: approved ? "Approved from Gateway Console" : "Denied from Gateway Console",
    });
    await refresh();
  } catch (error) {
    state.error = error?.message || "Approval request failed";
    render();
  }
}

function runRows() {
  if (state.runs.length === 0) {
    return '<tr><td colspan="4" class="empty">No runs found.</td></tr>';
  }
  return state.runs.map((run) => \`
    <tr>
      <td><code>\${escapeHtml(run.runId)}</code></td>
      <td><span class="status status-\${escapeHtml(run.status)}">\${escapeHtml(run.status)}</span></td>
      <td>\${escapeHtml(run.workflowKey || run.workflowName || "workflow")}</td>
      <td>\${escapeHtml(age(run.createdAtMs))}</td>
    </tr>
  \`).join("");
}

function workflowRows() {
  if (state.workflows.length === 0) {
    return '<tr><td colspan="3" class="empty">No workflows registered.</td></tr>';
  }
  return state.workflows.map((workflow) => \`
    <tr>
      <td><code>\${escapeHtml(workflow.key)}</code></td>
      <td>\${workflow.hasUi ? '<span class="signal">UI</span>' : '<span class="muted">Headless</span>'}</td>
      <td>\${workflow.schedule ? escapeHtml(workflow.schedule) : '<span class="muted">Manual</span>'}</td>
    </tr>
  \`).join("");
}

function approvalRows() {
  if (state.approvals.length === 0) {
    return '<tr><td colspan="5" class="empty">No pending approvals.</td></tr>';
  }
  return state.approvals.map((approval, index) => \`
    <tr>
      <td>
        <strong>\${escapeHtml(approval.requestTitle || approval.nodeId)}</strong>
        <small>\${escapeHtml(approval.requestSummary || "")}</small>
      </td>
      <td><code>\${escapeHtml(approval.runId)}</code></td>
      <td><code>\${escapeHtml(approval.nodeId)}</code></td>
      <td>\${escapeHtml(age(approval.requestedAtMs))}</td>
      <td class="actions">
        <button data-approve="\${index}">Approve</button>
        <button data-deny="\${index}" class="ghost">Deny</button>
      </td>
    </tr>
  \`).join("");
}

function render() {
  root.innerHTML = \`
    <style>
      :root { color-scheme: light; --ink: #111827; --muted: #667085; --line: #d9dee8; --surface: #f6f8fb; --accent: #008f73; --danger: #b42318; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #fff; }
      main { min-height: 100svh; display: grid; grid-template-columns: 280px minmax(0, 1fr); }
      aside { border-right: 1px solid var(--line); background: var(--surface); padding: 24px; display: flex; flex-direction: column; gap: 24px; }
      h1 { margin: 0; font-size: 22px; line-height: 1.1; letter-spacing: 0; }
      h2 { margin: 0 0 12px; font-size: 14px; letter-spacing: 0; text-transform: uppercase; color: var(--muted); }
      p { margin: 0; color: var(--muted); line-height: 1.5; }
      .workspace { padding: 24px; overflow: auto; }
      .toolbar { display: flex; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 22px; }
      .token { display: flex; gap: 8px; min-width: 320px; }
      input { width: 100%; height: 36px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; font: inherit; }
      button { height: 36px; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 6px; padding: 0 12px; font: inherit; cursor: pointer; }
      button.ghost { background: white; color: var(--ink); border-color: var(--line); }
      .stats { display: grid; gap: 12px; }
      .stat strong { display: block; font-size: 28px; letter-spacing: 0; }
      .stat span { display: block; color: var(--muted); font-size: 13px; }
      .section { margin-bottom: 28px; }
      table { width: 100%; border-collapse: collapse; font-size: 14px; }
      th { color: var(--muted); font-weight: 500; text-align: left; border-bottom: 1px solid var(--line); padding: 9px 8px; }
      td { border-bottom: 1px solid var(--line); padding: 10px 8px; vertical-align: top; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      small { display: block; color: var(--muted); margin-top: 3px; }
      .status { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; }
      .status-running, .status-waiting-approval, .signal { color: var(--accent); }
      .status-failed { color: var(--danger); }
      .muted, .empty { color: var(--muted); }
      .error { border-left: 3px solid var(--danger); padding: 8px 12px; margin-bottom: 16px; background: #fff3f2; color: var(--danger); }
      .actions { display: flex; gap: 8px; }
      @media (max-width: 760px) {
        main { grid-template-columns: 1fr; }
        aside { border-right: 0; border-bottom: 1px solid var(--line); }
        .toolbar, .token { display: grid; min-width: 0; width: 100%; }
      }
    </style>
    <main>
      <aside>
        <div>
          <h1>Smithers Console</h1>
          <p>Gateway operations for long-running coding-agent workflows.</p>
        </div>
        <div class="stats">
          <div class="stat"><strong>\${state.runs.length}</strong><span>Runs</span></div>
          <div class="stat"><strong>\${state.approvals.length}</strong><span>Pending approvals</span></div>
          <div class="stat"><strong>\${state.workflows.length}</strong><span>Workflows</span></div>
        </div>
      </aside>
      <section class="workspace">
        <div class="toolbar">
          <div class="token">
            <input id="gateway-token" type="password" autocomplete="off" placeholder="Bearer token" value="\${escapeHtml(state.token)}">
            <button id="save-token" class="ghost">Apply</button>
          </div>
          <button id="refresh">\${state.loading ? "Refreshing..." : "Refresh"}</button>
        </div>
        \${state.error ? '<div class="error">' + escapeHtml(state.error) + '</div>' : ""}
        <div class="section">
          <h2>Approvals</h2>
          <table><thead><tr><th>Request</th><th>Run</th><th>Node</th><th>Waiting</th><th>Decision</th></tr></thead><tbody>\${approvalRows()}</tbody></table>
        </div>
        <div class="section">
          <h2>Active Runs</h2>
          <table><thead><tr><th>Run</th><th>Status</th><th>Workflow</th><th>Age</th></tr></thead><tbody>\${runRows()}</tbody></table>
        </div>
        <div class="section">
          <h2>Workflows</h2>
          <table><thead><tr><th>Workflow</th><th>Surface</th><th>Schedule</th></tr></thead><tbody>\${workflowRows()}</tbody></table>
        </div>
      </section>
    </main>
  \`;
  document.getElementById("refresh")?.addEventListener("click", refresh);
  document.getElementById("save-token")?.addEventListener("click", () => {
    state.token = document.getElementById("gateway-token")?.value || "";
    refresh();
  });
  root.querySelectorAll("[data-approve]").forEach((button) => {
    button.addEventListener("click", () => decide(state.approvals[Number(button.dataset.approve)], true));
  });
  root.querySelectorAll("[data-deny]").forEach((button) => {
    button.addEventListener("click", () => decide(state.approvals[Number(button.dataset.deny)], false));
  });
}

render();
refresh();
`;
}
