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
  selectedRunId: "",
  runInput: "{}",
  status: "Loading",
  error: "",
  busy: false,
  snapshot: null,
  selectedNodeId: null,
  nodeOutput: null,
  nodeDiff: null,
  nodeError: "",
  nodeLoading: false,
  nodeRequestKey: "",
  chronicle: [],
  devtoolsStatus: "Idle",
  eventsStatus: "Idle",
  streamError: "",
  runEventSeq: 0,
  devtoolsSeq: 0,
  lastHeartbeatMs: 0,
  streamGeneration: 0,
  streams: {
    devtools: null,
    events: null,
  },
};

const css = `
:root {
  color-scheme: light;
  --ink: #161616;
  --muted: #6f6a61;
  --line: #ded8ce;
  --surface: #f7f3ec;
  --panel: #fffaf2;
  --panel-strong: #fffdf8;
  --accent: #235c58;
  --accent-soft: rgba(35,92,88,0.1);
  --accent-strong: #17413e;
  --blue: #285f9f;
  --violet: #684aa0;
  --amber: #9b6a16;
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
  min-width: 0;
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
  justify-content: flex-end;
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
.pill.wait { color: var(--violet); border-color: rgba(104,74,160,0.35); }
.pill.live { color: var(--blue); border-color: rgba(40,95,159,0.35); }
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
.workspace {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  gap: 18px;
}
.runs {
  min-height: 0;
  overflow: auto;
  display: grid;
  align-content: start;
}
.run-row {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-left: 3px solid transparent;
  background: transparent;
  color: var(--ink);
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  min-height: auto;
  padding: 13px 10px;
  text-align: left;
  border-radius: 0;
}
.run-row:hover, .run-row.selected {
  background: rgba(255,255,255,0.55);
  border-left-color: var(--accent);
}
.run-row-main {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
}
.run-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.run-row-meta {
  color: var(--muted);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
}
.run-detail {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
}
.detail-empty {
  color: var(--muted);
  border: 1px dashed var(--line);
  padding: 24px;
  background: rgba(255,255,255,0.32);
}
.detail-head {
  border-bottom: 1px solid var(--line);
  padding-bottom: 10px;
  display: grid;
  gap: 8px;
}
.detail-title {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}
.detail-title h2 {
  margin: 0;
  font-size: 16px;
}
.detail-grid {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  gap: 12px;
}
.detail-pane {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.38);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}
.detail-pane.inspector-pane {
  grid-column: 1 / -1;
}
.pane-head {
  min-height: 40px;
  border-bottom: 1px solid var(--line);
  padding: 9px 10px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.pane-title {
  font-size: 13px;
  font-weight: 700;
}
.pane-body {
  min-height: 0;
  overflow: auto;
  padding: 8px;
}
.tree-node {
  width: 100%;
  min-height: 30px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ink);
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 5px 7px;
  text-align: left;
}
.tree-node:hover, .tree-node.selected {
  background: var(--accent-soft);
}
.node-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-type {
  color: var(--muted);
  font-size: 11px;
}
.event-row {
  width: 100%;
  min-height: auto;
  border: 0;
  border-left: 3px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  display: grid;
  gap: 3px;
  padding: 8px 8px 8px 10px;
  text-align: left;
}
.event-row:hover {
  background: rgba(255,255,255,0.5);
}
.event-row.node { border-left-color: var(--blue); }
.event-row.error { border-left-color: var(--danger); }
.event-row.wait { border-left-color: var(--violet); }
.event-line {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.event-kind {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.event-seq {
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
.inspector {
  display: grid;
  gap: 12px;
}
.inspector h3 {
  margin: 0;
  font-size: 15px;
}
.kv {
  display: grid;
  grid-template-columns: minmax(84px, 0.32fr) minmax(0, 1fr);
  gap: 6px 10px;
  font-size: 13px;
}
.kv dt {
  color: var(--muted);
}
.kv dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.code {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--line);
  background: var(--panel-strong);
  padding: 9px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
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
@media (min-width: 1680px) {
  .workspace { grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); }
  .detail-grid { grid-template-columns: minmax(0, 0.85fr) minmax(0, 1fr) minmax(0, 1.05fr); }
  .detail-pane.inspector-pane { grid-column: auto; }
}
@media (max-width: 1180px) {
  .shell { grid-template-columns: 220px minmax(0, 1fr); }
  .side { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); }
  .detail-grid { grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); }
  .detail-pane.inspector-pane { grid-column: 1 / -1; }
}
@media (max-width: 960px) {
  .shell { grid-template-columns: 1fr; }
  .nav, .side { border: 0; border-bottom: 1px solid var(--line); }
  .main { padding: 18px; }
  .launch, .workspace, .detail-grid { grid-template-columns: 1fr; }
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

function websocketUrl() {
  const url = new URL(boot.wsPath ?? "/", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function requestId(method) {
  const cryptoApi = globalThis.crypto;
  const suffix = typeof cryptoApi?.randomUUID === "function"
    ? cryptoApi.randomUUID()
    : Math.random().toString(36).slice(2);
  return method + "-" + suffix;
}

async function openGatewaySocket(onEvent) {
  const socket = new WebSocket(websocketUrl());
  const pending = new Map();
  let settledOpen = false;
  let closed = false;
  const api = {
    request(method, params = {}) {
      if (closed) {
        return Promise.reject(new Error("Gateway WebSocket is closed"));
      }
      const id = requestId(method);
      const frame = { type: "req", id, method, params };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        try {
          socket.send(JSON.stringify(frame));
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of pending.values()) {
        entry.reject(new Error("Gateway WebSocket closed"));
      }
      pending.clear();
      socket.close();
    },
  };
  socket.addEventListener("message", (message) => {
    let frame;
    try {
      frame = JSON.parse(String(message.data));
    } catch {
      onEvent({ type: "client.error", error: new Error("Gateway returned an invalid WebSocket frame") });
      return;
    }
    if (frame?.type === "res" && typeof frame.id === "string") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.ok) {
        entry.resolve(frame.payload);
      } else {
        entry.reject(new Error(frame.error?.message ?? entry.method + " failed"));
      }
      return;
    }
    if (frame?.type === "event") {
      onEvent(frame);
    }
  });
  socket.addEventListener("close", () => {
    closed = true;
    for (const entry of pending.values()) {
      entry.reject(new Error("Gateway WebSocket closed"));
    }
    pending.clear();
    onEvent({ type: "client.close" });
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      api.request("connect", {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "smithers-operator-console", version: "1.0.0", platform: "browser" },
        ...(state.token ? { auth: { token: state.token } } : {}),
      }).then(() => {
        settledOpen = true;
        resolve(api);
      }, (error) => {
        api.close();
        reject(error);
      });
    }, { once: true });
    socket.addEventListener("error", () => {
      const error = new Error("Gateway WebSocket failed");
      if (!settledOpen) {
        reject(error);
      } else {
        onEvent({ type: "client.error", error });
      }
    });
  });
}

async function rpcSocket(method, params = {}) {
  const connection = await openGatewaySocket(() => {});
  try {
    return await connection.request(method, params);
  } finally {
    connection.close();
  }
}

function statusClass(status) {
  if (status === "finished" || status === "succeeded" || status === "completed") return "ok";
  if (status === "failed" || status === "cancelled") return "warn";
  if (String(status ?? "").startsWith("waiting")) return "wait";
  if (status === "running" || status === "recovering") return "live";
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

function formatJson(value, limit = 3600) {
  if (value === null || value === undefined) return "";
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\\n... truncated ...";
}

function selectedRun() {
  return state.runs.find((run) => run.runId === state.selectedRunId) ?? null;
}

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function findNodeWithParent(rootNode, id) {
  const stack = [{ node: rootNode, parent: null, index: -1 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.node.id === id) return current;
    const children = current.node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], parent: current.node, index });
    }
  }
  return null;
}

function findNodeById(rootNode, id) {
  return findNodeWithParent(rootNode, id)?.node ?? null;
}

function findNodeByTaskNodeId(rootNode, taskNodeId) {
  const stack = [rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.task?.nodeId === taskNodeId) return node;
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return null;
}

function firstTaskNode(rootNode) {
  const stack = [rootNode];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) continue;
    if (node.task?.nodeId) return node;
    stack.unshift(...(node.children ?? []));
  }
  return null;
}

function applyDelta(snapshot, delta) {
  if (delta?.version !== 1 || delta.baseSeq !== snapshot.seq) {
    throw new Error("DevTools delta did not match the current snapshot");
  }
  const next = {
    ...snapshot,
    frameNo: delta.seq,
    seq: delta.seq,
    root: cloneValue(snapshot.root),
  };
  for (const op of delta.ops ?? []) {
    if (op.op === "replaceRoot") {
      next.root = cloneValue(op.node);
      continue;
    }
    if (op.op === "removeNode") {
      if (op.id === next.root.id) throw new Error("DevTools delta cannot remove the root node");
      const target = findNodeWithParent(next.root, op.id);
      if (!target?.parent) throw new Error("DevTools delta referenced an unknown node");
      target.parent.children.splice(target.index, 1);
      continue;
    }
    if (op.op === "addNode") {
      const parent = findNodeWithParent(next.root, op.parentId);
      if (!parent) throw new Error("DevTools delta referenced an unknown parent");
      const index = Math.max(0, Math.min(op.index, parent.node.children.length));
      parent.node.children.splice(index, 0, cloneValue(op.node));
      continue;
    }
    if (op.op === "updateProps") {
      const target = findNodeWithParent(next.root, op.id);
      if (!target) throw new Error("DevTools delta referenced an unknown node");
      target.node.props = cloneValue(op.props ?? {});
      continue;
    }
    if (op.op === "updateTask") {
      const target = findNodeWithParent(next.root, op.id);
      if (!target) throw new Error("DevTools delta referenced an unknown node");
      if (op.task === undefined) {
        delete target.node.task;
      } else {
        target.node.task = cloneValue(op.task);
      }
      continue;
    }
    throw new Error("DevTools delta contained an unknown operation");
  }
  return next;
}

function selectedNode() {
  if (!state.snapshot?.root || state.selectedNodeId === null) return null;
  return findNodeById(state.snapshot.root, state.selectedNodeId);
}

function nodeDataKey(node) {
  if (!node?.task?.nodeId) return "";
  return state.selectedRunId + ":" + node.task.nodeId + ":" + (node.task.iteration ?? 0);
}

function syncSelectedNode() {
  if (!state.snapshot?.root) {
    state.selectedNodeId = null;
    return;
  }
  if (state.selectedNodeId !== null && findNodeById(state.snapshot.root, state.selectedNodeId)) {
    ensureNodeData();
    return;
  }
  const first = firstTaskNode(state.snapshot.root) ?? state.snapshot.root;
  state.selectedNodeId = first.id;
  ensureNodeData();
}

function ensureNodeData() {
  const node = selectedNode();
  const key = nodeDataKey(node);
  if (!key) {
    state.nodeOutput = null;
    state.nodeDiff = null;
    state.nodeError = "";
    state.nodeLoading = false;
    state.nodeRequestKey = "";
    return;
  }
  if (state.nodeRequestKey === key) return;
  loadNodeData(node, key);
}

async function loadNodeData(node, key = nodeDataKey(node)) {
  if (!node?.task?.nodeId) return;
  state.nodeRequestKey = key;
  state.nodeLoading = true;
  state.nodeError = "";
  state.nodeOutput = null;
  state.nodeDiff = null;
  render();
  const params = {
    runId: state.selectedRunId,
    nodeId: node.task.nodeId,
    iteration: node.task.iteration ?? 0,
  };
  const [output, diff] = await Promise.allSettled([
    rpcSocket("getNodeOutput", params),
    rpcSocket("getNodeDiff", params),
  ]);
  if (state.nodeRequestKey !== key) return;
  state.nodeLoading = false;
  if (output.status === "fulfilled") {
    state.nodeOutput = output.value;
  }
  if (diff.status === "fulfilled") {
    state.nodeDiff = diff.value;
  }
  const errors = [];
  if (output.status === "rejected") errors.push("output: " + output.reason.message);
  if (diff.status === "rejected") errors.push("diff: " + diff.reason.message);
  state.nodeError = errors.join("; ");
  render();
}

function closeRunStreams() {
  state.streamGeneration += 1;
  for (const close of Object.values(state.streams)) {
    if (typeof close === "function") close();
  }
  state.streams.devtools = null;
  state.streams.events = null;
}

function resetRunDetail() {
  state.snapshot = null;
  state.selectedNodeId = null;
  state.nodeOutput = null;
  state.nodeDiff = null;
  state.nodeError = "";
  state.nodeLoading = false;
  state.nodeRequestKey = "";
  state.chronicle = [];
  state.devtoolsStatus = "Connecting";
  state.eventsStatus = "Connecting";
  state.streamError = "";
  state.runEventSeq = 0;
  state.devtoolsSeq = 0;
  state.lastHeartbeatMs = 0;
}

function selectRun(runId) {
  if (!runId || state.selectedRunId === runId) return;
  closeRunStreams();
  state.selectedRunId = runId;
  resetRunDetail();
  render();
  const generation = state.streamGeneration;
  startDevToolsStream(runId, generation);
  startRunEventsStream(runId, generation);
}

function streamStillCurrent(runId, generation) {
  return state.selectedRunId === runId && state.streamGeneration === generation;
}

function retryDevToolsStream(runId, generation, attempt, message, connection) {
  if (attempt >= 5 || !/not found|closed|failed/i.test(message)) {
    return false;
  }
  if (connection) connection.close();
  state.devtoolsStatus = "Retrying";
  state.streamError = message;
  render();
  setTimeout(() => {
    if (streamStillCurrent(runId, generation)) {
      startDevToolsStream(runId, generation, attempt + 1);
    }
  }, 250 * (attempt + 1));
  return true;
}

function handleDevToolsEvent(event) {
  try {
    if (event?.kind === "snapshot") {
      state.snapshot = event.snapshot;
      state.devtoolsSeq = event.snapshot?.seq ?? state.devtoolsSeq;
    } else if (event?.kind === "delta" && state.snapshot) {
      state.snapshot = applyDelta(state.snapshot, event.delta);
      state.devtoolsSeq = event.delta?.seq ?? state.devtoolsSeq;
    }
    syncSelectedNode();
    state.devtoolsStatus = "Live";
    state.streamError = "";
  } catch (error) {
    state.devtoolsStatus = "Needs refresh";
    state.streamError = error instanceof Error ? error.message : String(error);
  }
  render();
}

async function startDevToolsStream(runId, generation, attempt = 0) {
  let streamId = "";
  let connection = null;
  try {
    connection = await openGatewaySocket((frame) => {
      if (!streamStillCurrent(runId, generation)) return;
      if (frame.type === "client.close") {
        state.devtoolsStatus = state.devtoolsStatus === "Live" ? "Closed" : state.devtoolsStatus;
        render();
        return;
      }
      if (frame.type === "client.error") {
        state.devtoolsStatus = "Error";
        state.streamError = frame.error?.message ?? "DevTools stream failed";
        render();
        return;
      }
      const payloadStreamId = frame.payload?.streamId;
      const matchesStream = !streamId || payloadStreamId === streamId;
      if (frame.event === "devtools.event" && matchesStream) {
        handleDevToolsEvent(frame.payload.event);
      }
      if (frame.event === "devtools.error" && matchesStream) {
        const message = frame.payload?.error?.message ?? "DevTools stream failed";
        if (retryDevToolsStream(runId, generation, attempt, message, connection)) {
          return;
        }
        state.devtoolsStatus = "Error";
        state.streamError = message;
        render();
      }
    });
    if (!streamStillCurrent(runId, generation)) {
      connection.close();
      return;
    }
    state.streams.devtools = () => connection.close();
    const subscribed = await connection.request("streamDevTools", { runId, afterSeq: 0 });
    streamId = subscribed?.streamId ?? "";
    state.devtoolsStatus = "Live";
    render();
  } catch (error) {
    if (!streamStillCurrent(runId, generation)) return;
    const message = error instanceof Error ? error.message : String(error);
    if (retryDevToolsStream(runId, generation, attempt, message, connection)) {
      return;
    }
    if (connection) connection.close();
    state.devtoolsStatus = "Unavailable";
    state.streamError = message;
    render();
  }
}

function eventNodeId(payload) {
  return payload?.nodeId ?? payload?.payload?.nodeId ?? payload?.request?.nodeId ?? "";
}

function pushChronicle(entry) {
  state.chronicle = [entry, ...state.chronicle].slice(0, 160);
}

function handleRunStreamFrame(frame, streamId) {
  const payload = frame.payload ?? {};
  if (streamId && payload.streamId && payload.streamId !== streamId) return;
  if (frame.event === "run.heartbeat") {
    state.lastHeartbeatMs = Date.now();
    state.eventsStatus = "Live";
    render();
    return;
  }
  if (frame.event === "run.event") {
    state.runEventSeq = payload.seq ?? state.runEventSeq;
    pushChronicle({
      event: payload.event ?? "run.event",
      seq: payload.seq ?? frame.seq,
      payload: payload.payload ?? {},
      receivedAtMs: Date.now(),
      nodeId: eventNodeId(payload.payload ?? {}),
    });
    state.eventsStatus = "Live";
    render();
    return;
  }
  if (frame.event === "run.gap_resync") {
    pushChronicle({
      event: "run.gap_resync",
      seq: payload.toSeq ?? frame.seq,
      payload,
      receivedAtMs: Date.now(),
      nodeId: "",
    });
    state.eventsStatus = "Resynced";
    render();
    return;
  }
  if (frame.event === "run.error") {
    pushChronicle({
      event: "run.error",
      seq: frame.seq,
      payload,
      receivedAtMs: Date.now(),
      nodeId: eventNodeId(payload),
    });
    state.eventsStatus = "Error";
    render();
  }
}

async function startRunEventsStream(runId, generation) {
  let streamId = "";
  let connection = null;
  try {
    connection = await openGatewaySocket((frame) => {
      if (!streamStillCurrent(runId, generation)) return;
      if (frame.type === "client.close") {
        state.eventsStatus = state.eventsStatus === "Live" ? "Closed" : state.eventsStatus;
        render();
        return;
      }
      if (frame.type === "client.error") {
        state.eventsStatus = "Error";
        state.streamError = frame.error?.message ?? "Run event stream failed";
        render();
        return;
      }
      if (frame.type === "event") {
        handleRunStreamFrame(frame, streamId);
      }
    });
    if (!streamStillCurrent(runId, generation)) {
      connection.close();
      return;
    }
    state.streams.events = () => connection.close();
    const subscribed = await connection.request("streamRunEvents", { runId, afterSeq: 0 });
    streamId = subscribed?.streamId ?? "";
    state.eventsStatus = "Live";
    render();
  } catch (error) {
    if (connection) connection.close();
    if (!streamStillCurrent(runId, generation)) return;
    state.eventsStatus = "Unavailable";
    state.streamError = error instanceof Error ? error.message : String(error);
    render();
  }
}

function renderRuns() {
  if (state.runs.length === 0) {
    return '<div class="empty">No runs found.</div>';
  }
  return state.runs.map((run) => {
    const selected = run.runId === state.selectedRunId ? " selected" : "";
    return `
      <button class="run-row${selected}" data-run-id="${escapeText(run.runId)}" type="button">
        <div class="run-row-main">
          <div>
            <div class="run-id">${escapeText(run.runId)}</div>
            <div class="muted">${escapeText(run.workflowKey ?? run.workflowName ?? "workflow")}</div>
          </div>
          <span class="pill ${statusClass(run.status)}">${escapeText(run.status)}</span>
        </div>
        <div class="run-row-meta">
          <span>${escapeText(formatAge(run.createdAtMs))}</span>
          <span>${escapeText(run.triggeredBy ?? run.auth?.triggeredBy ?? "")}</span>
        </div>
      </button>
    `;
  }).join("");
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

function flattenTree(rootNode) {
  const rows = [];
  function visit(node, depth) {
    rows.push({ node, depth });
    for (const child of node.children ?? []) {
      visit(child, depth + 1);
    }
  }
  if (rootNode) visit(rootNode, 0);
  return rows;
}

function renderTree() {
  if (!state.snapshot?.root) {
    return '<div class="empty">Waiting for the DevTools snapshot.</div>';
  }
  return flattenTree(state.snapshot.root).map(({ node, depth }) => {
    const selected = node.id === state.selectedNodeId ? " selected" : "";
    const name = node.task?.nodeId ?? node.task?.label ?? node.name;
    return `
      <button class="tree-node${selected}" data-node-id="${escapeText(node.id)}" style="padding-left:${8 + depth * 14}px" type="button">
        <span class="node-name">${escapeText(name)}</span>
        <span class="node-type">${escapeText(node.type)}</span>
      </button>
    `;
  }).join("");
}

function eventClass(entry) {
  if (String(entry.event).includes("failed") || String(entry.event).includes("error")) return "error";
  if (String(entry.event).includes("approval") || String(entry.event).includes("waiting")) return "wait";
  if (entry.nodeId) return "node";
  return "";
}

function eventSummary(entry) {
  const payload = entry.payload ?? {};
  const nodeId = entry.nodeId || eventNodeId(payload);
  const status = payload.status ? " status=" + payload.status : "";
  const workflow = payload.workflowKey || payload.workflowName ? " " + (payload.workflowKey ?? payload.workflowName) : "";
  return [nodeId, workflow.trim(), status.trim()].filter(Boolean).join(" / ") || "run event";
}

function renderChronicle() {
  if (state.chronicle.length === 0) {
    return '<div class="empty">Waiting for run events.</div>';
  }
  return state.chronicle.map((entry, index) => {
    const node = entry.nodeId ? ` data-event-node-id="${escapeText(entry.nodeId)}"` : "";
    return `
      <button class="event-row ${eventClass(entry)}"${node} data-event-index="${index}" type="button">
        <span class="event-line">
          <span class="event-kind">${escapeText(entry.event)}</span>
          <span class="event-seq">#${escapeText(entry.seq)}</span>
        </span>
        <span class="muted">${escapeText(eventSummary(entry))}</span>
      </button>
    `;
  }).join("");
}

function renderProps(node) {
  const props = node?.props ?? {};
  const entries = Object.entries(props);
  if (entries.length === 0) {
    return '<div class="empty">No props captured.</div>';
  }
  return `<dl class="kv">${entries.map(([key, value]) => `
    <dt>${escapeText(key)}</dt>
    <dd>${escapeText(typeof value === "object" ? formatJson(value, 600) : value)}</dd>
  `).join("")}</dl>`;
}

function renderInspector() {
  const node = selectedNode();
  if (!node) {
    return '<div class="empty">Select a tree node to inspect it.</div>';
  }
  const task = node.task ?? null;
  return `
    <div class="inspector">
      <div>
        <h3>${escapeText(task?.nodeId ?? task?.label ?? node.name)}</h3>
        <div class="muted">${escapeText(node.type)}${task?.kind ? " / " + escapeText(task.kind) : ""}</div>
      </div>
      <dl class="kv">
        <dt>Node</dt><dd>${escapeText(node.id)}</dd>
        <dt>Task id</dt><dd>${escapeText(task?.nodeId ?? "none")}</dd>
        <dt>Iteration</dt><dd>${escapeText(task?.iteration ?? 0)}</dd>
        <dt>Agent</dt><dd>${escapeText(task?.agent ?? "none")}</dd>
      </dl>
      <div>
        <div class="pane-title">Props</div>
        ${renderProps(node)}
      </div>
      <div>
        <div class="pane-title">Output ${state.nodeLoading ? "(loading)" : ""}</div>
        ${state.nodeOutput ? `<pre class="code">${escapeText(formatJson(state.nodeOutput))}</pre>` : '<div class="empty">No output loaded.</div>'}
      </div>
      <div>
        <div class="pane-title">Diff ${state.nodeLoading ? "(loading)" : ""}</div>
        ${state.nodeDiff ? `<pre class="code">${escapeText(formatJson(state.nodeDiff))}</pre>` : '<div class="empty">No diff loaded.</div>'}
      </div>
      ${state.nodeError ? `<div class="error">${escapeText(state.nodeError)}</div>` : ""}
    </div>
  `;
}

function renderRunDetail() {
  const run = selectedRun();
  if (!run) {
    return '<section class="detail-empty">Select a run to open its live DevTools tree, event chronicle, output, and diff inspector.</section>';
  }
  const snapshotMeta = state.snapshot
    ? `frame ${state.snapshot.frameNo ?? 0} / seq ${state.snapshot.seq ?? 0}`
    : "snapshot pending";
  return `
    <section class="run-detail">
      <div class="detail-head">
        <div class="detail-title">
          <div>
            <h2>Run Chronicle</h2>
            <div class="run-id">${escapeText(run.runId)}</div>
            <div class="muted">${escapeText(run.workflowKey ?? run.workflowName ?? "workflow")}</div>
          </div>
          <span class="pill ${statusClass(run.status)}">${escapeText(run.status)}</span>
        </div>
        <div class="meta">
          <span class="pill ${state.devtoolsStatus === "Live" ? "live" : ""}">DevTools: ${escapeText(state.devtoolsStatus)}</span>
          <span class="pill ${state.eventsStatus === "Live" ? "live" : ""}">Events: ${escapeText(state.eventsStatus)}</span>
          <span class="pill">${escapeText(snapshotMeta)}</span>
          ${state.lastHeartbeatMs ? `<span class="pill ok">heartbeat ${escapeText(formatAge(state.lastHeartbeatMs))}</span>` : ""}
        </div>
        ${state.streamError ? `<div class="error">${escapeText(state.streamError)}</div>` : ""}
      </div>
      <div class="detail-grid">
        <section class="detail-pane">
          <div class="pane-head">
            <span class="pane-title">Tree</span>
            <span class="muted">${state.snapshot?.root ? flattenTree(state.snapshot.root).length + " nodes" : ""}</span>
          </div>
          <div class="pane-body">${renderTree()}</div>
        </section>
        <section class="detail-pane">
          <div class="pane-head">
            <span class="pane-title">Chronicle</span>
            <span class="muted">${state.chronicle.length} events</span>
          </div>
          <div class="pane-body">${renderChronicle()}</div>
        </section>
        <section class="detail-pane inspector-pane">
          <div class="pane-head">
            <span class="pane-title">Inspector</span>
            <span class="muted">${selectedNode()?.task?.nodeId ? "task" : "node"}</span>
          </div>
          <div class="pane-body">${renderInspector()}</div>
        </section>
      </div>
    </section>
  `;
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
        <section class="workspace">
          <section class="runs">${renderRuns()}</section>
          ${renderRunDetail()}
        </section>
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
  for (const button of document.querySelectorAll("[data-run-id]")) {
    button.addEventListener("click", () => selectRun(button.dataset.runId));
  }
  for (const button of document.querySelectorAll("[data-node-id]")) {
    button.addEventListener("click", () => {
      state.selectedNodeId = Number(button.dataset.nodeId);
      state.nodeRequestKey = "";
      ensureNodeData();
      render();
    });
  }
  for (const button of document.querySelectorAll("[data-event-node-id]")) {
    button.addEventListener("click", () => {
      const taskNodeId = button.dataset.eventNodeId;
      const node = state.snapshot?.root && taskNodeId ? findNodeByTaskNodeId(state.snapshot.root, taskNodeId) : null;
      if (!node) return;
      state.selectedNodeId = node.id;
      state.nodeRequestKey = "";
      ensureNodeData();
      render();
    });
  }
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
    if (state.selectedRunId && !runs.some((run) => run.runId === state.selectedRunId)) {
      closeRunStreams();
      state.selectedRunId = "";
      resetRunDetail();
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
    const launched = await rpc("launchRun", { workflow: state.selectedWorkflow, input });
    state.status = "Run launched";
    await refresh();
    if (launched?.runId) {
      selectRun(launched.runId);
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.busy = false;
    render();
  }
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
