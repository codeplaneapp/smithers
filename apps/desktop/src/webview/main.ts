import { Electroview } from "electrobun/view";
import {
  Agent,
  ChatPanel,
  registerMessageRenderer,
} from "@mariozechner/pi-web-ui";
import type { AgentTransport } from "@mariozechner/pi-web-ui";
import type { AgentEvent, Message } from "@mariozechner/pi-ai";
import { html } from "lit";
import { Type } from "@sinclair/typebox";
import type {
  AppRPCType,
  AgentStreamEventDTO,
  AttachmentDTO,
  FrameSnapshotDTO,
  RunAttemptsDTO,
  RunDetailDTO,
  RunOutputsDTO,
  RunToolCallsDTO,
  RunSummaryDTO,
  SettingsDTO,
  SmithersEventDTO,
  WorkspaceStateDTO,
  WorkflowRef,
  WorkflowCardMessage,
} from "../shared/rpc";

const rpc = Electroview.defineRPC<AppRPCType>({
  handlers: {
    requests: {},
    messages: {
      agentEvent: (payload: AgentStreamEventDTO) => {
        eventMux.push(payload.runId, payload.event);
      },
      chatMessage: ({ sessionId, message }) => {
        if (sessionId === state.sessionId && state.agent) {
          state.agent.appendMessage(message as any);
        }
      },
      workflowEvent: (payload) => {
        handleWorkflowEvent(payload);
      },
      workflowFrame: (frame) => {
        state.frames.set(frame.runId, frame);
        if (state.selectedRunId === frame.runId) {
          renderRunInspector();
        }
      },
      workspaceState: (payload) => {
        handleWorkspaceState(payload);
      },
      toast: (payload) => {
        pushToast(payload.level, payload.message);
      },
    },
  },
});

new Electroview({ rpc });

class AsyncQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T) {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close() {
    this.closed = true;
    while (this.resolvers.length) {
      const resolver = this.resolvers.shift();
      if (resolver) resolver({ value: undefined as T, done: true });
    }
  }

  async *iterator(signal?: AbortSignal): AsyncIterable<T> {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      if (this.queue.length > 0) {
        yield this.queue.shift() as T;
        continue;
      }
      if (this.closed) return;
      const value = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (value.done) return;
      yield value.value as T;
    }
  }
}

class AgentEventMux {
  private queues = new Map<string, AsyncQueue<AgentEvent>>();

  get(runId: string): AsyncQueue<AgentEvent> {
    const existing = this.queues.get(runId);
    if (existing) return existing;
    const queue = new AsyncQueue<AgentEvent>();
    this.queues.set(runId, queue);
    return queue;
  }

  push(runId: string, event: AgentEvent) {
    const queue = this.get(runId);
    queue.push(event);
    if (event.type === "agent_end") {
      queue.close();
      this.queues.delete(runId);
    }
  }
}

const eventMux = new AgentEventMux();

class BunAgentTransport implements AgentTransport {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async *run(_messages: Message[], userMessage: Message, _config: any, signal?: AbortSignal) {
    const text = extractText(userMessage);
    const attachments = (userMessage as any).attachments as AttachmentDTO[] | undefined;
    const { runId } = await rpc.request.sendChatMessage({
      sessionId: this.sessionId,
      text,
      attachments,
    });

    const queue = eventMux.get(runId);
    if (signal) {
      signal.addEventListener("abort", () => {
        rpc.request.abortChatRun({ sessionId: this.sessionId, runId }).catch(() => {});
        queue.close();
      });
    }

    for await (const event of queue.iterator(signal)) {
      yield event;
      if (event.type === "agent_end") break;
    }
  }

  async *continue(_messages: Message[], _config: any, signal?: AbortSignal) {
    const text = "";
    const { runId } = await rpc.request.sendChatMessage({
      sessionId: this.sessionId,
      text,
    });

    const queue = eventMux.get(runId);
    if (signal) {
      signal.addEventListener("abort", () => {
        rpc.request.abortChatRun({ sessionId: this.sessionId, runId }).catch(() => {});
        queue.close();
      });
    }

    for await (const event of queue.iterator(signal)) {
      yield event;
      if (event.type === "agent_end") break;
    }
  }
}

const TOOL_DEFS = [
  {
    name: "read",
    label: "read",
    description: "Read a file",
    parameters: Type.Object({ path: Type.String() }),
  },
  {
    name: "write",
    label: "write",
    description: "Write a file",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  },
  {
    name: "edit",
    label: "edit",
    description: "Apply a unified diff patch",
    parameters: Type.Object({ path: Type.String(), patch: Type.String() }),
  },
  {
    name: "bash",
    label: "bash",
    description: "Run a shell command",
    parameters: Type.Object({ command: Type.String() }),
  },
  {
    name: "smithers.listWorkflows",
    label: "smithers.listWorkflows",
    description: "List workflows in the workspace",
    parameters: Type.Object({ root: Type.Optional(Type.String()) }),
  },
  {
    name: "smithers.runWorkflow",
    label: "smithers.runWorkflow",
    description: "Run a Smithers workflow",
    parameters: Type.Object({ workflowPath: Type.String(), input: Type.Any(), focus: Type.Optional(Type.Boolean()) }),
  },
  {
    name: "smithers.getRun",
    label: "smithers.getRun",
    description: "Get Smithers run status",
    parameters: Type.Object({ runId: Type.String() }),
  },
  {
    name: "smithers.approveNode",
    label: "smithers.approveNode",
    description: "Approve a Smithers node",
    parameters: Type.Object({ runId: Type.String(), nodeId: Type.String(), iteration: Type.Optional(Type.Number()) }),
  },
  {
    name: "smithers.denyNode",
    label: "smithers.denyNode",
    description: "Deny a Smithers node",
    parameters: Type.Object({ runId: Type.String(), nodeId: Type.String(), iteration: Type.Optional(Type.Number()) }),
  },
  {
    name: "smithers.cancelRun",
    label: "smithers.cancelRun",
    description: "Cancel a Smithers run",
    parameters: Type.Object({ runId: Type.String() }),
  },
  {
    name: "smithers.resumeRun",
    label: "smithers.resumeRun",
    description: "Resume a Smithers run",
    parameters: Type.Object({ runId: Type.String() }),
  },
  {
    name: "smithers.getFrame",
    label: "smithers.getFrame",
    description: "Get latest Smithers frame",
    parameters: Type.Object({ runId: Type.String(), frameNo: Type.Optional(Type.Number()) }),
  },
];

const state: {
  agent?: Agent;
  sessionId?: string;
  sessions: { sessionId: string; title?: string | null }[];
  workspaceRoot?: string | null;
  settings?: SettingsDTO;
  workflows: WorkflowRef[];
  runs: RunSummaryDTO[];
  selectedRunId?: string;
  runDetails: Map<string, RunDetailDTO>;
  runEvents: Map<string, SmithersEventDTO[]>;
  runEventSeq: Map<string, number>;
  frames: Map<string, FrameSnapshotDTO>;
  outputs: Map<string, RunOutputsDTO>;
  attempts: Map<string, RunAttemptsDTO>;
  toolCalls: Map<string, RunToolCallsDTO>;
  activeTab: "graph" | "timeline" | "logs" | "outputs" | "attempts";
  sidebarOpen: boolean;
  contextRunId?: string;
  logQuery: string;
  logFilters: Set<string>;
  graphZoom: number;
  graphPan: { x: number; y: number };
} = {
  sessions: [],
  workflows: [],
  runs: [],
  runDetails: new Map(),
  runEvents: new Map(),
  runEventSeq: new Map(),
  frames: new Map(),
  outputs: new Map(),
  attempts: new Map(),
  toolCalls: new Map(),
  activeTab: "graph",
  sidebarOpen: true,
  logQuery: "",
  logFilters: new Set(["run", "node", "approval", "revert"]),
  graphZoom: 1,
  graphPan: { x: 0, y: 0 },
};

registerMessageRenderer("workflow" as any, {
  render: (message: WorkflowCardMessage) => {
    const approvals = message.approvals ?? [];
    return html`
      <div class="workflow-card">
        <div class="workflow-card__header">
          <div>
            <div class="workflow-card__title">${message.workflowName}</div>
            <div class="workflow-card__meta">Run ${message.runId.slice(0, 6)} - ${message.status}</div>
          </div>
          <div class="workflow-card__actions">
            <button class="btn btn-ghost" @click=${() => focusRun(message.runId)}>Open</button>
            <button class="btn btn-ghost" @click=${() => rpc.request.cancelRun({ runId: message.runId })}>Cancel</button>
          </div>
        </div>
        ${approvals.length
          ? html`
              <div class="workflow-card__approvals">
                ${approvals.map(
                  (a) => html`
                    <div class="workflow-card__approval">
                      <div>Approval needed: <span class="mono">${a.nodeId}</span></div>
                      <div class="workflow-card__actions">
                        <button class="btn btn-primary" @click=${() => approveFromCard(message.runId, a.nodeId, a.iteration ?? 0)}>
                          Approve
                        </button>
                        <button class="btn btn-danger" @click=${() => denyFromCard(message.runId, a.nodeId, a.iteration ?? 0)}>
                          Deny
                        </button>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : html``}
      </div>
    `;
  },
});

const appRoot = document.createElement("div");
appRoot.className = "app";
appRoot.innerHTML = `
  <div class="menubar">
    <button class="menu-item" data-menu="file">File</button>
    <button class="menu-item" data-menu="workflow">Workflow</button>
    <button class="menu-item" data-menu="view">View</button>
    <button class="menu-item" data-menu="settings">Settings</button>
    <button class="menu-item" data-menu="help">Help</button>
    <div class="menubar__spacer"></div>
    <div class="menubar__title">Smithers</div>
  </div>
  <div id="menu-dropdown" class="menu-dropdown hidden"></div>
  <div class="toolbar">
    <div class="toolbar__left">
      <div class="logo">Smithers</div>
      <select id="workspace-select" class="select"></select>
      <select id="session-select" class="select"></select>
      <button id="new-session" class="btn btn-ghost">New Session</button>
    </div>
    <div class="toolbar__right">
      <button id="run-workflow" class="btn btn-primary">Run Workflow</button>
      <button id="toggle-sidebar" class="btn btn-ghost">Workflow Panel</button>
    </div>
  </div>
  <div class="content">
    <div id="chat-pane" class="chat-pane"></div>
    <aside id="sidebar" class="sidebar">
      <div class="sidebar__tabs">
        <button class="tab-btn active" data-tab="runs">Runs</button>
        <button class="tab-btn" data-tab="workflows">Workflows</button>
      </div>
      <div class="sidebar__body">
        <div id="runs-tab" class="tab-panel"></div>
        <div id="workflows-tab" class="tab-panel hidden"></div>
      </div>
    </aside>
    <div id="sidebar-collapsed" class="sidebar-collapsed hidden">
      <button id="sidebar-open" class="btn btn-ghost">Runs</button>
      <div id="approval-badge" class="badge hidden">0</div>
      <div class="sidebar-collapsed__actions">
        <button id="collapsed-run" class="btn btn-primary">Run</button>
        <button id="collapsed-history" class="btn btn-ghost">History</button>
      </div>
    </div>
  </div>
  <div id="toast-container" class="toast-container"></div>
`;

document.body.style.margin = "0";
document.body.style.height = "100vh";
document.body.appendChild(appRoot);

const chatPane = document.getElementById("chat-pane") as HTMLDivElement;
const sidebar = document.getElementById("sidebar") as HTMLDivElement;
const sidebarCollapsed = document.getElementById("sidebar-collapsed") as HTMLDivElement;
const runsTab = document.getElementById("runs-tab") as HTMLDivElement;
const workflowsTab = document.getElementById("workflows-tab") as HTMLDivElement;

const menuDropdown = document.getElementById("menu-dropdown") as HTMLDivElement;
const menuButtons = Array.from(appRoot.querySelectorAll<HTMLButtonElement>(".menu-item"));
const toastContainer = document.getElementById("toast-container") as HTMLDivElement;

const workspaceSelect = document.getElementById("workspace-select") as HTMLSelectElement;
const sessionSelect = document.getElementById("session-select") as HTMLSelectElement;
const newSessionBtn = document.getElementById("new-session") as HTMLButtonElement;
const runWorkflowBtn = document.getElementById("run-workflow") as HTMLButtonElement;
const toggleSidebarBtn = document.getElementById("toggle-sidebar") as HTMLButtonElement;
const sidebarOpenBtn = document.getElementById("sidebar-open") as HTMLButtonElement;
const approvalBadge = document.getElementById("approval-badge") as HTMLDivElement;
const collapsedRunBtn = document.getElementById("collapsed-run") as HTMLButtonElement;
const collapsedHistoryBtn = document.getElementById("collapsed-history") as HTMLButtonElement;

const tabButtons = Array.from(appRoot.querySelectorAll<HTMLButtonElement>(".tab-btn"));

const contextBar = document.createElement("div");
contextBar.className = "context-bar";
chatPane.appendChild(contextBar);

const mentionBox = document.createElement("div");
mentionBox.className = "mention-box hidden";
chatPane.appendChild(mentionBox);

for (const btn of tabButtons) {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.toggle("active", b === btn));
    if (btn.dataset.tab === "runs") {
      runsTab.classList.remove("hidden");
      workflowsTab.classList.add("hidden");
    } else {
      runsTab.classList.add("hidden");
      workflowsTab.classList.remove("hidden");
    }
  });
}

for (const btn of menuButtons) {
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    const key = btn.dataset.menu;
    if (!key) return;
    openMenu(key, btn);
  });
}

document.addEventListener("click", () => {
  closeMenu();
});

newSessionBtn.addEventListener("click", async () => {
  const result = await rpc.request.createChatSession({ title: "New Session" });
  await bootstrapSession(result.sessionId);
});

runWorkflowBtn.addEventListener("click", () => {
  openRunDialog();
});

toggleSidebarBtn.addEventListener("click", () => {
  toggleSidebar();
});

sidebarOpenBtn.addEventListener("click", () => {
  toggleSidebar(true);
});

collapsedRunBtn.addEventListener("click", () => {
  openRunDialog();
});

collapsedHistoryBtn.addEventListener("click", () => {
  switchTab("runs");
  toggleSidebar(true);
});

workspaceSelect.addEventListener("change", () => {
  const value = workspaceSelect.value;
  if (value === "__open__") {
    openWorkspaceDialog();
    return;
  }
  if (value === "__close__") {
    void rpc.request.openWorkspace({ path: "" }).then(() => loadWorkspaceState());
    return;
  }
  if (value) {
    void rpc.request.openWorkspace({ path: value }).then(() => loadWorkspaceState());
  }
});

sessionSelect.addEventListener("change", () => {
  const sessionId = sessionSelect.value;
  if (sessionId) {
    bootstrapSession(sessionId).catch(console.error);
  }
});

window.addEventListener("keydown", (event) => {
  handleShortcuts(event);
});

window.addEventListener("resize", () => {
  if (window.innerWidth < 1200) {
    sidebar.classList.add("sidebar--overlay");
  } else {
    sidebar.classList.remove("sidebar--overlay");
  }
});

if (window.innerWidth < 1200) {
  sidebar.classList.add("sidebar--overlay");
}

async function bootstrap() {
  const settings = await rpc.request.getSettings({});
  applySettings(settings);
  await loadSessions();
  if (state.sessionId) {
    await bootstrapSession(state.sessionId);
  } else if (state.sessions.length) {
    await bootstrapSession(state.sessions[0]!.sessionId);
  } else {
    const session = await rpc.request.createChatSession({ title: "New Session" });
    await bootstrapSession(session.sessionId);
  }
  await loadWorkspaceState();
  await refreshRuns();
}

async function loadSessions() {
  const sessions = await rpc.request.listChatSessions({});
  state.sessions = sessions;
  sessionSelect.innerHTML = "";
  sessions.forEach((s) => {
    const option = document.createElement("option");
    option.value = s.sessionId;
    option.textContent = s.title ?? s.sessionId.slice(0, 6);
    sessionSelect.appendChild(option);
  });
}

async function bootstrapSession(sessionId: string) {
  state.sessionId = sessionId;
  sessionSelect.value = sessionId;
  const session = await rpc.request.getChatSession({ sessionId });
  const transport = new BunAgentTransport(sessionId);
  const agent = new Agent({
    transport,
    initialState: {
      messages: session.messages ?? [],
    },
  });
  state.agent = agent;
  chatPane.innerHTML = "";
  chatPane.appendChild(contextBar);
  const chatPanel = new ChatPanel();
  (chatPanel as any).style.flex = "1";
  (chatPanel as any).style.minHeight = "0";
  await chatPanel.setAgent(agent, {
    toolsFactory: () =>
      TOOL_DEFS.map((tool) => ({
        ...tool,
        execute: async () => {
          throw new Error("Tools run in Bun");
        },
      })),
  });
  chatPane.appendChild(chatPanel);
  setupMentions(chatPanel);
  renderContextBar();
}

function setupMentions(chatPanel: ChatPanel) {
  const root = (chatPanel as any).shadowRoot ?? chatPanel;
  const textarea = root.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!textarea) return;

  const updateMentions = () => {
    const value = textarea.value;
    const cursor = textarea.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const workflowMatch = /@workflow\\(?([^\\s)]*)$/.exec(before);
    const runMatch = /#run\\(?([^\\s)]*)$/.exec(before);

    let items: Array<{ label: string; value: string }> = [];
    let match: RegExpExecArray | null = null;
    if (workflowMatch) {
      match = workflowMatch;
      const query = (workflowMatch[1] ?? "").toLowerCase();
      items = state.workflows
        .filter((wf) => (wf.path ?? "").toLowerCase().includes(query))
        .slice(0, 6)
        .map((wf) => ({
          label: wf.name ?? wf.path,
          value: `@workflow(${wf.path})`,
        }));
    } else if (runMatch) {
      match = runMatch;
      const query = (runMatch[1] ?? "").toLowerCase();
      items = state.runs
        .filter((run) => run.runId.toLowerCase().includes(query))
        .slice(0, 6)
        .map((run) => ({
          label: run.runId.slice(0, 8),
          value: `#run(${run.runId})`,
        }));
    }

    if (!match || items.length === 0) {
      mentionBox.classList.add("hidden");
      mentionBox.innerHTML = "";
      return;
    }

    mentionBox.innerHTML = items
      .map(
        (item) =>
          `<button class="mention-item" data-value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</button>`,
      )
      .join("");
    mentionBox.classList.remove("hidden");

    const rect = textarea.getBoundingClientRect();
    const parentRect = chatPane.getBoundingClientRect();
    mentionBox.style.left = `${rect.left - parentRect.left}px`;
    mentionBox.style.top = `${rect.top - parentRect.top - 140}px`;

    mentionBox.querySelectorAll<HTMLButtonElement>(".mention-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.dataset.value ?? "";
        const start = match ? match.index : before.length;
        const newValue = value.slice(0, start) + val + value.slice(cursor);
        textarea.value = newValue;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        mentionBox.classList.add("hidden");
      });
    });
  };

  textarea.addEventListener("input", updateMentions);
  textarea.addEventListener("blur", () => {
    setTimeout(() => mentionBox.classList.add("hidden"), 200);
  });
}

async function loadWorkspaceState() {
  const ws = await rpc.request.getWorkspaceState({});
  handleWorkspaceState(ws);
}

async function refreshRuns() {
  const runs = await rpc.request.listRuns({ status: "all" });
  state.runs = state.workspaceRoot
    ? runs.filter((run) => run.workspaceRoot === state.workspaceRoot)
    : runs;
  if (state.selectedRunId && !state.runs.find((r) => r.runId === state.selectedRunId)) {
    state.selectedRunId = undefined;
    state.contextRunId = undefined;
  }
  updateApprovalBadge();
  renderRuns();
}

function renderRuns() {
  const selected = state.selectedRunId;
  runsTab.innerHTML = `
    <div class="panel">
      <div class="panel__header">Runs</div>
      <div class="panel__body" id="runs-list"></div>
      <div id="run-inspector" class="run-inspector"></div>
    </div>
  `;
  const list = runsTab.querySelector("#runs-list") as HTMLDivElement;
  state.runs.forEach((run) => {
    const row = document.createElement("div");
    row.className = `run-row status-${run.status}`;
    const activeNode = run.activeNodes && run.activeNodes.length ? run.activeNodes[0] : null;
    const approvals = run.waitingApprovals ?? 0;
    row.innerHTML = `
      <div class="run-row__status"></div>
      <div class="run-row__info">
        <div class="run-row__title">${run.workflowName}</div>
        <div class="run-row__meta">
          <span class="mono">${run.runId.slice(0, 6)}</span>
          <span>• ${formatTime(run.startedAtMs)}</span>
          <span>• ${formatDuration(run.startedAtMs, run.finishedAtMs ?? null)}</span>
          ${activeNode ? `<span>• Active: <span class="mono">${activeNode}</span></span>` : ""}
          ${approvals ? `<span class="badge badge-inline">${approvals} approvals</span>` : ""}
        </div>
      </div>
      <div class="run-row__actions">
        <button class="btn btn-ghost" data-action="open">Open</button>
        ${run.status === "running" ? `<button class="btn btn-ghost" data-action="cancel">Cancel</button>` : ""}
        ${run.status === "waiting-approval" ? `<button class="btn btn-ghost" data-action="resume">Resume</button>` : ""}
        <button class="btn btn-ghost" data-action="copy">Copy ID</button>
      </div>
    `;
    row.addEventListener("click", () => focusRun(run.runId));
    row.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const action = btn.dataset.action;
        if (action === "open") {
          focusRun(run.runId);
        } else if (action === "cancel") {
          rpc.request.cancelRun({ runId: run.runId }).catch(() => {});
        } else if (action === "resume") {
          rpc.request.resumeRun({ runId: run.runId }).catch(() => {});
        } else if (action === "copy") {
          navigator.clipboard?.writeText(run.runId).catch(() => {});
        }
      });
    });
    list.appendChild(row);
  });

  if (selected) {
    void renderRunInspector();
  }
}

function renderWorkflows() {
  workflowsTab.innerHTML = `
    <div class="panel">
      <div class="panel__header">Workflows</div>
      <div class="panel__body" id="workflow-list"></div>
    </div>
  `;
  const list = workflowsTab.querySelector("#workflow-list") as HTMLDivElement;
  if (!state.workflows.length) {
    list.innerHTML = `<div class="empty">No workflows found. Open a workspace to scan for .tsx workflows.</div>`;
    return;
  }
  state.workflows.forEach((wf) => {
    const row = document.createElement("div");
    row.className = "workflow-row";
    row.innerHTML = `
      <div>
        <div class="workflow-row__title">${wf.name ?? wf.path}</div>
        <div class="workflow-row__meta">${wf.path}</div>
      </div>
      <button class="btn btn-primary">Run</button>
    `;
    const btn = row.querySelector("button") as HTMLButtonElement;
    btn.addEventListener("click", () => openRunDialog(wf));
    list.appendChild(row);
  });
}

async function focusRun(runId: string) {
  state.selectedRunId = runId;
  state.contextRunId = runId;
  state.sidebarOpen = true;
  sidebar.classList.remove("sidebar--closed");
  renderContextBar();
  const detail = await rpc.request.getRun({ runId });
  state.runDetails.set(runId, detail);
  const events = await rpc.request.getRunEvents({ runId, afterSeq: -1 });
  state.runEvents.set(runId, events.events);
  state.runEventSeq.set(runId, events.lastSeq);
  try {
    const frame = await rpc.request.getFrame({ runId });
    state.frames.set(runId, frame);
  } catch {
    // ignore
  }
  await renderRunInspector();
}

function renderContextBar() {
  const runId = state.contextRunId;
  const run = runId ? state.runs.find((r) => r.runId === runId) : undefined;
  const workspaceLabel = state.workspaceRoot ? shortenPath(state.workspaceRoot) : "None";
  contextBar.innerHTML = `
    <div class="context-chip">Workspace: <span class="mono">${workspaceLabel}</span></div>
    ${
      run
        ? `<div class="context-chip">Run: <span class="mono">${run.runId.slice(
            0,
            6,
          )}</span><button class="chip-btn" data-clear="run">x</button></div>`
        : ""
    }
  `;
  const clearBtn = contextBar.querySelector("[data-clear='run']") as HTMLButtonElement | null;
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      state.contextRunId = undefined;
      renderContextBar();
    });
  }
}

async function renderRunInspector() {
  const runId = state.selectedRunId;
  const container = runsTab.querySelector("#run-inspector") as HTMLDivElement;
  if (!runId || !container) return;
  const detail = state.runDetails.get(runId) ?? (await rpc.request.getRun({ runId }));
  state.runDetails.set(runId, detail);

  const approvals = detail.nodes.filter((n) => n.state === "waiting-approval");

  container.innerHTML = `
    <div class="run-header">
      <div>
        <div class="run-header__title">${detail.run.workflowName}</div>
        <div class="run-header__meta">
          <span class="mono">${detail.run.runId}</span>
          <span>• ${detail.run.status}</span>
          <span>• ${formatTime(detail.run.startedAtMs)}</span>
          <span>• ${formatDuration(detail.run.startedAtMs, detail.run.finishedAtMs ?? null)}</span>
          ${approvals.length ? `<span class="badge badge-inline">${approvals.length} approvals</span>` : ""}
        </div>
      </div>
      <div class="run-header__actions">
        <button class="btn btn-ghost" id="run-cancel">Cancel</button>
        <button class="btn btn-ghost" id="run-resume">Resume</button>
      </div>
    </div>
    ${approvals.length ? renderApprovalCard(approvals) : ""}
    <div class="run-tabs">
      <button class="run-tab ${state.activeTab === "graph" ? "active" : ""}" data-tab="graph">Graph</button>
      <button class="run-tab ${state.activeTab === "timeline" ? "active" : ""}" data-tab="timeline">Timeline</button>
      <button class="run-tab ${state.activeTab === "logs" ? "active" : ""}" data-tab="logs">Logs</button>
      <button class="run-tab ${state.activeTab === "outputs" ? "active" : ""}" data-tab="outputs">Outputs</button>
      <button class="run-tab ${state.activeTab === "attempts" ? "active" : ""}" data-tab="attempts">Attempts</button>
    </div>
    <div class="run-tab-body"></div>
  `;

  container.querySelectorAll<HTMLButtonElement>(".run-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab as any;
      renderRunInspector();
    });
  });

  const cancelBtn = container.querySelector("#run-cancel") as HTMLButtonElement;
  const resumeBtn = container.querySelector("#run-resume") as HTMLButtonElement;
  cancelBtn?.addEventListener("click", () => rpc.request.cancelRun({ runId }));
  resumeBtn?.addEventListener("click", () => rpc.request.resumeRun({ runId }));

  container.querySelectorAll<HTMLButtonElement>("[data-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nodeId = btn.dataset.approve!;
      const iteration = Number(btn.dataset.iter ?? 0);
      await rpc.request.approveNode({ runId, nodeId, iteration });
      await refreshRuns();
      await focusRun(runId);
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-deny]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nodeId = btn.dataset.deny!;
      const iteration = Number(btn.dataset.iter ?? 0);
      await rpc.request.denyNode({ runId, nodeId, iteration });
      await refreshRuns();
      await focusRun(runId);
    });
  });

  container.querySelectorAll<HTMLButtonElement>("[data-ask]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nodeId = btn.dataset.ask!;
      const iteration = Number(btn.dataset.iter ?? 0);
      await askAgentAboutNode(runId, nodeId, iteration);
    });
  });

  const body = container.querySelector(".run-tab-body") as HTMLDivElement;
  if (!body) return;

  if (state.activeTab === "graph") {
    body.innerHTML = renderGraph(runId);
    attachGraphHandlers(body, runId);
  } else if (state.activeTab === "timeline") {
    body.innerHTML = renderTimeline(runId);
  } else if (state.activeTab === "logs") {
    body.innerHTML = renderLogs(runId);
    attachLogsHandlers(body, runId);
  } else if (state.activeTab === "outputs") {
    body.innerHTML = await renderOutputs(runId);
  } else if (state.activeTab === "attempts") {
    body.innerHTML = await renderAttempts(runId);
  }
}

function renderApprovalCard(approvals: { nodeId: string; iteration: number }[]): string {
  return `
    <div class="approval-card">
      <div class="approval-card__title">Approval Required</div>
      ${approvals
        .map(
          (a) => `
        <div class="approval-row">
          <div><span class="mono">${a.nodeId}</span> (iteration ${a.iteration})</div>
          <div class="approval-actions">
            <button class="btn btn-primary" data-approve="${a.nodeId}" data-iter="${a.iteration}">Approve</button>
            <button class="btn btn-danger" data-deny="${a.nodeId}" data-iter="${a.iteration}">Deny</button>
            <button class="btn btn-ghost" data-ask="${a.nodeId}" data-iter="${a.iteration}">Ask agent</button>
          </div>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderGraph(runId: string): string {
  const frame = state.frames.get(runId);
  if (!frame) {
    return `<div class="empty">No frame data yet.</div>`;
  }
  const svg = buildGraphSvg(frame);
  const transform = `transform: translate(${state.graphPan.x}px, ${state.graphPan.y}px) scale(${state.graphZoom});`;
  return `
    <div class="graph">
      <div class="graph-toolbar">
        <button class="btn btn-ghost" data-graph-action="zoom-in">+</button>
        <button class="btn btn-ghost" data-graph-action="zoom-out">-</button>
        <button class="btn btn-ghost" data-graph-action="fit">Fit</button>
      </div>
      <div class="graph-viewport">
        <div class="graph-canvas" style="${transform}">
          ${svg}
        </div>
      </div>
    </div>
    <div id="node-drawer" class="node-drawer"></div>
  `;
}

function renderTimeline(runId: string): string {
  const events = state.runEvents.get(runId) ?? [];
  return `
    <div class="timeline">
      ${events
        .map(
          (e) => `
        <div class="timeline-row">
          <div class="timeline-time">${formatTime(e.timestampMs)}</div>
          <div class="timeline-event">${escapeHtml(formatEvent(e))}</div>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderLogs(runId: string): string {
  const events = filterEvents(runId);
  return `
    <div class="logs-toolbar">
      <input id="logs-search" class="input" placeholder="Search logs" value="${state.logQuery}" />
      <div class="logs-filters">
        ${renderLogFilter("run", "Run")}
        ${renderLogFilter("node", "Node")}
        ${renderLogFilter("approval", "Approval")}
        ${renderLogFilter("revert", "Revert")}
      </div>
      <div class="logs-actions">
        <button class="btn btn-ghost" id="logs-copy">Copy filtered</button>
        <button class="btn btn-ghost" id="logs-export">Export JSONL</button>
      </div>
    </div>
    <pre class="logs">${escapeHtml(events.map((e) => JSON.stringify(e)).join("\n"))}</pre>
  `;
}

function renderLogFilter(key: string, label: string): string {
  const active = state.logFilters.has(key);
  return `<button class="btn btn-ghost logs-filter ${active ? "active" : ""}" data-filter="${key}">${label}</button>`;
}

function filterEvents(runId: string): SmithersEventDTO[] {
  const events = state.runEvents.get(runId) ?? [];
  const query = state.logQuery.trim().toLowerCase();
  return events.filter((event) => {
    const group = eventGroup(event.type);
    if (!state.logFilters.has(group)) return false;
    if (!query) return true;
    return JSON.stringify(event).toLowerCase().includes(query);
  });
}

function eventGroup(type: SmithersEventDTO["type"]): "run" | "node" | "approval" | "revert" {
  if (type.startsWith("Run")) return "run";
  if (type.startsWith("Node")) return "node";
  if (type.startsWith("Approval")) return "approval";
  if (type.startsWith("Revert")) return "revert";
  return "node";
}

function attachLogsHandlers(container: HTMLElement, runId: string) {
  const search = container.querySelector("#logs-search") as HTMLInputElement | null;
  const copyBtn = container.querySelector("#logs-copy") as HTMLButtonElement | null;
  const exportBtn = container.querySelector("#logs-export") as HTMLButtonElement | null;
  const filterButtons = container.querySelectorAll<HTMLButtonElement>(".logs-filter");

  search?.addEventListener("input", () => {
    state.logQuery = search.value;
    void renderRunInspector();
  });

  filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.filter;
      if (!key) return;
      if (state.logFilters.has(key)) {
        state.logFilters.delete(key);
      } else {
        state.logFilters.add(key);
      }
      void renderRunInspector();
    });
  });

  copyBtn?.addEventListener("click", async () => {
    const events = filterEvents(runId);
    await navigator.clipboard?.writeText(events.map((e) => JSON.stringify(e)).join("\n"));
    pushToast("info", "Filtered logs copied.");
  });

  exportBtn?.addEventListener("click", () => {
    const events = filterEvents(runId);
    const blob = new Blob([events.map((e) => JSON.stringify(e)).join("\n")], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `run-${runId}-logs.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

async function renderOutputs(runId: string): Promise<string> {
  let data = state.outputs.get(runId);
  if (!data) {
    data = await rpc.request.getRunOutputs({ runId });
    state.outputs.set(runId, data);
  }
  if (!data.tables.length) {
    return `<div class="empty">No outputs available.</div>`;
  }
  return `
    <div class="outputs">
      ${data.tables
        .map(
          (t) => `
        <div class="output-table">
          <div class="output-table__title">${escapeHtml(t.name)} (${t.rows.length})</div>
          <pre>${escapeHtml(JSON.stringify(t.rows, null, 2))}</pre>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

async function renderAttempts(runId: string): Promise<string> {
  let data = state.attempts.get(runId);
  if (!data) {
    data = await rpc.request.getRunAttempts({ runId });
    state.attempts.set(runId, data);
  }
  if (!data.attempts.length) {
    return `<div class="empty">No attempts logged.</div>`;
  }
  return `
    <div class="attempts">
      ${data.attempts
        .map(
          (a) => `
        <div class="attempt-row">
          <div class="attempt-row__meta">
            <div class="mono">${a.nodeId}</div>
            <div>iter ${a.iteration} - attempt ${a.attempt}</div>
            ${a.jjPointer ? `<div class="muted">JJ: ${a.jjPointer}</div>` : ""}
            ${a.errorJson ? `<div class="muted">Error: ${truncate(String(a.errorJson), 140)}</div>` : ""}
          </div>
          <div class="attempt-row__state">${a.state}</div>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function buildGraphSvg(frame: FrameSnapshotDTO): string {
  const nodes = frame.graph.nodes;
  const edges = frame.graph.edges;
  const spacingX = 180;
  const spacingY = 90;

  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, index) => {
    const depth = node.kind === "Workflow" ? 0 : node.kind === "Task" ? 2 : 1;
    positions.set(node.id, { x: depth * spacingX + 40, y: index * spacingY + 40 });
  });

  const width = Math.max(600, ...Array.from(positions.values()).map((p) => p.x + 160));
  const height = Math.max(400, ...Array.from(positions.values()).map((p) => p.y + 80));

  const nodeSvg = nodes
    .map((node) => {
      const pos = positions.get(node.id)!;
      const color = stateColor(node.state ?? "pending");
      return `
        <g class="graph-node" data-node-id="${node.id}">
          <rect data-node-id="${node.id}" x="${pos.x}" y="${pos.y}" rx="10" ry="10" width="140" height="48" fill="${color.bg}" stroke="${color.stroke}" />
          <text x="${pos.x + 12}" y="${pos.y + 28}" fill="#e9eaf0" font-size="12">${node.label}</text>
        </g>
      `;
    })
    .join("");

  const edgeSvg = edges
    .map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return "";
      const x1 = from.x + 140;
      const y1 = from.y + 24;
      const x2 = to.x;
      const y2 = to.y + 24;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#3a3f4b" stroke-width="2" />`;
    })
    .join("");

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${edgeSvg}
      ${nodeSvg}
    </svg>
  `;
}

function handleWorkflowEvent(payload: SmithersEventDTO & { seq: number }) {
  const runId = payload.runId;
  const list = state.runEvents.get(runId) ?? [];
  const lastSeq = state.runEventSeq.get(runId);
  if (lastSeq !== undefined && payload.seq > lastSeq + 1) {
    void rpc.request.getRunEvents({ runId, afterSeq: lastSeq }).then((res) => {
      const merged = list.concat(res.events);
      state.runEvents.set(runId, merged);
      state.runEventSeq.set(runId, res.lastSeq);
      if (state.selectedRunId === runId) {
        void renderRunInspector();
      }
    });
  } else {
    list.push(payload);
    state.runEvents.set(runId, list);
    state.runEventSeq.set(runId, payload.seq);
  }
  void refreshRuns();
  if (state.selectedRunId === runId) {
    void renderRunInspector();
  }
}

function handleWorkspaceState(payload: WorkspaceStateDTO) {
  state.workspaceRoot = payload.root;
  state.workflows = payload.workflows;
  updateWorkspaceSelect();
  renderWorkflows();
  renderContextBar();
  void refreshRuns();
}

function applySettings(settings: SettingsDTO) {
  state.settings = settings;
  state.sidebarOpen = settings.ui.workflowPanel.isOpen;
  sidebar.style.width = `${settings.ui.workflowPanel.width}px`;
  sidebar.classList.toggle("sidebar--closed", !state.sidebarOpen);
  sidebarCollapsed.classList.toggle("hidden", state.sidebarOpen);
  document.body.classList.toggle("artifacts-hidden", !settings.ui.artifactsPanelOpen);
}

function updateWorkspaceSelect() {
  workspaceSelect.innerHTML = "";
  const root = state.workspaceRoot;
  const current = document.createElement("option");
  current.value = root ?? "";
  current.textContent = root ? shortenPath(root) : "No workspace";
  workspaceSelect.appendChild(current);

  const open = document.createElement("option");
  open.value = "__open__";
  open.textContent = "Open workspace…";
  workspaceSelect.appendChild(open);

  const close = document.createElement("option");
  close.value = "__close__";
  close.textContent = "Close workspace";
  workspaceSelect.appendChild(close);

  workspaceSelect.value = root ?? "";
}

function updateApprovalBadge() {
  const count = state.runs.reduce((sum, run) => sum + (run.waitingApprovals ?? 0), 0);
  if (count > 0) {
    approvalBadge.textContent = String(count);
    approvalBadge.classList.remove("hidden");
  } else {
    approvalBadge.classList.add("hidden");
  }
}

function switchTab(tab: "runs" | "workflows") {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "runs") {
    runsTab.classList.remove("hidden");
    workflowsTab.classList.add("hidden");
  } else {
    runsTab.classList.add("hidden");
    workflowsTab.classList.remove("hidden");
  }
}

function toggleSidebar(open?: boolean) {
  state.sidebarOpen = open ?? !state.sidebarOpen;
  sidebar.classList.toggle("sidebar--closed", !state.sidebarOpen);
  sidebarCollapsed.classList.toggle("hidden", state.sidebarOpen);
  if (state.settings) {
    state.settings.ui.workflowPanel.isOpen = state.sidebarOpen;
    void rpc.request.setSettings({ patch: { ui: { workflowPanel: { isOpen: state.sidebarOpen } } } });
  }
}

type MenuItem = {
  label: string;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
};

function openMenu(key: string, anchor: HTMLElement) {
  const items = getMenuItems(key);
  if (!items.length) return;
  menuDropdown.innerHTML = items
    .map((item, index) => {
      if (item.separator) {
        return `<div class="menu-separator"></div>`;
      }
      return `
        <button class="menu-row ${item.disabled ? "disabled" : ""}" data-menu-index="${index}">
          <span>${escapeHtml(item.label)}</span>
          <span class="menu-shortcut">${item.shortcut ?? ""}</span>
        </button>
      `;
    })
    .join("");
  const rect = anchor.getBoundingClientRect();
  menuDropdown.style.left = `${rect.left}px`;
  menuDropdown.style.top = `${rect.bottom + 4}px`;
  menuDropdown.classList.remove("hidden");
  menuDropdown.querySelectorAll<HTMLButtonElement>(".menu-row").forEach((btn) => {
    const index = Number(btn.dataset.menuIndex ?? -1);
    const item = items[index];
    if (!item || item.disabled || !item.action) return;
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      closeMenu();
      item.action?.();
    });
  });
}

function closeMenu() {
  menuDropdown.classList.add("hidden");
  menuDropdown.innerHTML = "";
}

function getMenuItems(key: string): MenuItem[] {
  switch (key) {
    case "file":
      return [
        { label: "New Chat Session", shortcut: "⌘N", action: () => newSessionBtn.click() },
        { label: "Open Workspace…", shortcut: "⌘O", action: () => openWorkspaceDialog() },
        { label: "Close Workspace", action: () => closeWorkspace(), disabled: !state.workspaceRoot },
      ];
    case "workflow":
      return [
        { label: "Run Workflow…", shortcut: "⌘R", action: () => openRunDialog() },
        { label: "Show Runs", shortcut: "⌘⇧R", action: () => switchTab("runs") },
        { label: "Approvals", shortcut: "⌘⇧A", action: () => focusNextApproval() },
        { label: "Cancel Current Run", shortcut: "⌘.", action: () => cancelCurrentRun() },
      ];
    case "view":
      return [
        { label: "Toggle Workflow Panel", shortcut: "⌘\\", action: () => toggleSidebar() },
        { label: "Toggle Artifacts Panel", shortcut: "⌘⇧\\", action: () => toggleArtifactsPanel() },
        { separator: true, label: "sep" },
        { label: "Zoom In (Graph)", shortcut: "⌘=", action: () => adjustGraphZoom(0.1) },
        { label: "Zoom Out (Graph)", shortcut: "⌘-", action: () => adjustGraphZoom(-0.1) },
      ];
    case "settings":
      return [
        { label: "Preferences…", shortcut: "⌘,", action: () => openSettingsDialog() },
      ];
    case "help":
      return [
        { label: "Docs (smithers.sh)", action: () => pushToast("info", "Open smithers.sh in your browser.") },
      ];
    default:
      return [];
  }
}

function handleShortcuts(event: KeyboardEvent) {
  const meta = event.metaKey || event.ctrlKey;
  if (!meta) return;
  const key = event.key;
  if (key.toLowerCase() === "n" && !event.shiftKey) {
    event.preventDefault();
    newSessionBtn.click();
    return;
  }
  if (key.toLowerCase() === "o") {
    event.preventDefault();
    openWorkspaceDialog();
    return;
  }
  if (key.toLowerCase() === "r" && !event.shiftKey) {
    event.preventDefault();
    openRunDialog();
    return;
  }
  if (key.toLowerCase() === "r" && event.shiftKey) {
    event.preventDefault();
    switchTab("runs");
    toggleSidebar(true);
    return;
  }
  if (key.toLowerCase() === "a" && event.shiftKey) {
    event.preventDefault();
    focusNextApproval();
    return;
  }
  if (key === "." && !event.shiftKey) {
    event.preventDefault();
    cancelCurrentRun();
    return;
  }
  if (key === "\\" && !event.shiftKey) {
    event.preventDefault();
    toggleSidebar();
    return;
  }
  if (key === "\\" && event.shiftKey) {
    event.preventDefault();
    toggleArtifactsPanel();
    return;
  }
  if (key === "=" || (key === "+" && event.shiftKey)) {
    event.preventDefault();
    adjustGraphZoom(0.1);
    return;
  }
  if (key === "-") {
    event.preventDefault();
    adjustGraphZoom(-0.1);
  }
}

function focusNextApproval() {
  const run = state.runs.find((r) => (r.waitingApprovals ?? 0) > 0);
  if (run) {
    void focusRun(run.runId);
  } else {
    pushToast("info", "No pending approvals.");
  }
}

function cancelCurrentRun() {
  if (!state.selectedRunId) return;
  void rpc.request.cancelRun({ runId: state.selectedRunId });
}

function adjustGraphZoom(delta: number) {
  state.graphZoom = Math.max(0.4, Math.min(2.5, state.graphZoom + delta));
  const canvas = document.querySelector(".graph-canvas") as HTMLDivElement | null;
  if (canvas) applyGraphTransform(canvas);
}

function toggleArtifactsPanel() {
  const current = state.settings?.ui.artifactsPanelOpen ?? true;
  const next = !current;
  if (state.settings) {
    state.settings.ui.artifactsPanelOpen = next;
    void rpc.request.setSettings({ patch: { ui: { artifactsPanelOpen: next } } });
  }
  document.body.classList.toggle("artifacts-hidden", !next);
}

function closeWorkspace() {
  void rpc.request.openWorkspace({ path: "" }).then(() => loadWorkspaceState());
}

function pushToast(level: "info" | "warning" | "error", message: string) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${level}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast--hide");
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

function attachGraphHandlers(container: HTMLElement, runId: string) {
  const drawer = container.querySelector("#node-drawer") as HTMLDivElement | null;
  const viewport = container.querySelector(".graph-viewport") as HTMLDivElement | null;
  const canvas = container.querySelector(".graph-canvas") as HTMLDivElement | null;
  if (!drawer || !viewport || !canvas) return;

  container.querySelectorAll<HTMLButtonElement>("[data-graph-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.graphAction;
      if (action === "zoom-in") {
        state.graphZoom = Math.min(2.5, state.graphZoom + 0.1);
      } else if (action === "zoom-out") {
        state.graphZoom = Math.max(0.4, state.graphZoom - 0.1);
      } else if (action === "fit") {
        state.graphZoom = 1;
        state.graphPan = { x: 0, y: 0 };
      }
      applyGraphTransform(canvas);
    });
  });

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startPan = { x: 0, y: 0 };

  viewport.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-node-id]")) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startPan = { ...state.graphPan };
  });

  window.addEventListener("mousemove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    state.graphPan = { x: startPan.x + dx, y: startPan.y + dy };
    applyGraphTransform(canvas);
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
  });

  container.querySelectorAll<SVGElement>("[data-node-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const nodeId = el.getAttribute("data-node-id");
      if (!nodeId) return;
      void renderNodeDrawer(drawer, runId, nodeId);
    });
  });
}

function applyGraphTransform(canvas: HTMLElement) {
  canvas.style.transform = `translate(${state.graphPan.x}px, ${state.graphPan.y}px) scale(${state.graphZoom})`;
}

async function renderNodeDrawer(drawer: HTMLDivElement, runId: string, nodeId: string) {
  const detail = state.runDetails.get(runId) ?? (await rpc.request.getRun({ runId }));
  state.runDetails.set(runId, detail);
  const node = detail.nodes.find((n) => n.nodeId === nodeId);
  if (!node) {
    drawer.innerHTML = `<div class="empty">No node details.</div>`;
    return;
  }

  const outputs = await ensureRunOutputs(runId);
  const attempts = await ensureRunAttempts(runId);
  const toolCalls = await ensureRunToolCalls(runId);

  const nodeAttempts = attempts.attempts.filter(
    (a) => a.nodeId === node.nodeId && a.iteration === node.iteration,
  );
  const latestAttempt = nodeAttempts[0];
  let meta: any = null;
  if (latestAttempt?.metaJson) {
    try {
      meta = JSON.parse(latestAttempt.metaJson);
    } catch {
      meta = null;
    }
  }

  const promptText = meta?.prompt ? String(meta.prompt) : "Not available yet.";
  const outputRows = outputs.tables
    .flatMap((t) =>
      t.rows
        .map((row) => ({ table: t.name, row }))
        .filter((entry) => {
          const row: any = entry.row as any;
          const iter = typeof row?.iteration === "number" ? row.iteration : 0;
          return row?.nodeId === node.nodeId && iter === node.iteration;
        }),
    );
  const outputText = outputRows.length
    ? JSON.stringify(outputRows, null, 2)
    : "No output rows for this node.";

  const nodeToolCalls = toolCalls.toolCalls.filter(
    (call) => call.nodeId === node.nodeId && call.iteration === node.iteration,
  );

  drawer.innerHTML = `
    <div class="node-drawer__header">
      <div>
        <div class="node-drawer__title">${escapeHtml(node.nodeId)}</div>
        <div class="node-drawer__meta">state: ${node.state} • iter ${node.iteration}</div>
      </div>
      <div class="node-drawer__actions">
        <button class="btn btn-ghost" data-copy="prompt">Copy prompt</button>
        <button class="btn btn-ghost" data-copy="output">Copy output</button>
        ${node.state === "waiting-approval" ? `<button class="btn btn-primary" data-approve>Approve</button>` : ""}
        ${node.state === "waiting-approval" ? `<button class="btn btn-danger" data-deny>Deny</button>` : ""}
        <button class="btn btn-ghost" data-ask>Ask agent</button>
      </div>
    </div>
    <div class="node-drawer__section">
      <div class="node-drawer__label">Prompt</div>
      <pre>${escapeHtml(promptText)}</pre>
    </div>
    <div class="node-drawer__section">
      <div class="node-drawer__label">Output</div>
      <pre>${escapeHtml(outputText)}</pre>
    </div>
    <div class="node-drawer__section">
      <div class="node-drawer__label">Tool Calls</div>
      ${
        nodeToolCalls.length
          ? nodeToolCalls
              .map(
                (call) => `
        <div class="tool-call">
          <div class="tool-call__header">
            <span class="mono">${call.toolName}</span>
            <span>${call.status}</span>
          </div>
          <div class="tool-call__meta">attempt ${call.attempt} • ${formatDuration(call.startedAtMs, call.finishedAtMs ?? null)}</div>
          <pre>${escapeHtml(call.inputJson ?? "")}</pre>
          <pre>${escapeHtml(call.outputJson ?? "")}</pre>
        </div>
      `,
              )
              .join("")
          : `<div class="empty">No tool calls recorded.</div>`
      }
    </div>
    <div class="node-drawer__section">
      <div class="node-drawer__label">Last Error</div>
      <pre>${node.lastError ? escapeHtml(JSON.stringify(node.lastError, null, 2)) : "None"}</pre>
    </div>
  `;

  drawer.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.copy;
      const text = type === "prompt" ? promptText : outputText;
      navigator.clipboard?.writeText(text).catch(() => {});
      pushToast("info", `${type === "prompt" ? "Prompt" : "Output"} copied.`);
    });
  });

  const approveBtn = drawer.querySelector<HTMLButtonElement>("[data-approve]");
  const denyBtn = drawer.querySelector<HTMLButtonElement>("[data-deny]");
  approveBtn?.addEventListener("click", async () => {
    await rpc.request.approveNode({ runId, nodeId: node.nodeId, iteration: node.iteration });
    await refreshRuns();
    await focusRun(runId);
  });
  denyBtn?.addEventListener("click", async () => {
    await rpc.request.denyNode({ runId, nodeId: node.nodeId, iteration: node.iteration });
    await refreshRuns();
    await focusRun(runId);
  });

  const askBtn = drawer.querySelector<HTMLButtonElement>("[data-ask]");
  askBtn?.addEventListener("click", () => {
    void askAgentAboutNode(runId, node.nodeId, node.iteration);
  });
}

async function ensureRunOutputs(runId: string): Promise<RunOutputsDTO> {
  let data = state.outputs.get(runId);
  if (!data) {
    data = await rpc.request.getRunOutputs({ runId });
    state.outputs.set(runId, data);
  }
  return data;
}

async function ensureRunAttempts(runId: string): Promise<RunAttemptsDTO> {
  let data = state.attempts.get(runId);
  if (!data) {
    data = await rpc.request.getRunAttempts({ runId });
    state.attempts.set(runId, data);
  }
  return data;
}

async function ensureRunToolCalls(runId: string): Promise<RunToolCallsDTO> {
  let data = state.toolCalls.get(runId);
  if (!data) {
    data = await rpc.request.getRunToolCalls({ runId });
    state.toolCalls.set(runId, data);
  }
  return data;
}

function formatEvent(event: SmithersEventDTO): string {
  switch (event.type) {
    case "RunStarted":
      return `Run started`;
    case "RunFinished":
      return `Run finished`;
    case "RunFailed":
      return `Run failed`;
    case "RunCancelled":
      return `Run cancelled`;
    case "NodeStarted":
      return `Node ${event.nodeId} started (iter ${event.iteration}, attempt ${event.attempt})`;
    case "NodeFinished":
      return `Node ${event.nodeId} finished (iter ${event.iteration}, attempt ${event.attempt})`;
    case "NodeFailed":
      return `Node ${event.nodeId} failed (iter ${event.iteration}, attempt ${event.attempt})`;
    case "NodeRetrying":
      return `Node ${event.nodeId} retrying (iter ${event.iteration}, attempt ${event.attempt})`;
    case "NodeWaitingApproval":
      return `Node ${event.nodeId} waiting approval (iter ${event.iteration})`;
    case "ApprovalRequested":
      return `Approval requested for ${event.nodeId}`;
    case "ApprovalGranted":
      return `Approval granted for ${event.nodeId}`;
    case "ApprovalDenied":
      return `Approval denied for ${event.nodeId}`;
    case "RevertStarted":
      return `Revert started for ${event.nodeId}`;
    case "RevertFinished":
      return `Revert finished for ${event.nodeId} (${event.success ? "ok" : "failed"})`;
    default:
      return event.type;
  }
}

function stateColor(state: string) {
  switch (state) {
    case "in-progress":
      return { bg: "#243d66", stroke: "#3b6bd6" };
    case "finished":
      return { bg: "#1f3a2f", stroke: "#2fa86b" };
    case "failed":
      return { bg: "#4a1f24", stroke: "#e05d6f" };
    case "waiting-approval":
      return { bg: "#4b3b1f", stroke: "#f0b849" };
    case "cancelled":
    case "skipped":
      return { bg: "#2b2f38", stroke: "#5c6270" };
    default:
      return { bg: "#242833", stroke: "#4c5363" };
  }
}

function formatTime(ms: number) {
  const date = new Date(ms);
  return date.toLocaleTimeString();
}

function formatDuration(startMs: number, endMs: number | null) {
  const end = endMs ?? Date.now();
  const delta = Math.max(0, end - startMs);
  const seconds = Math.floor(delta / 1000);
  const mins = Math.floor(seconds / 60);
  const hours = Math.floor(mins / 60);
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (mins % 60 || !hours) parts.push(`${mins % 60}m`);
  if (!hours && mins < 5) parts.push(`${seconds % 60}s`);
  return parts.join(" ");
}

function shortenPath(path: string, max = 28) {
  if (path.length <= max) return path;
  return `…${path.slice(-max)}`;
}

function truncate(value: string, max = 120) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractText(userMessage: Message): string {
  if (typeof (userMessage as any).content === "string") {
    return (userMessage as any).content;
  }
  if (Array.isArray((userMessage as any).content)) {
    return (userMessage as any).content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
  }
  return "";
}

function openWorkspaceDialog() {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `
    <div class="modal__dialog">
      <div class="modal__header">Open Workspace</div>
      <label class="modal__label">Workspace path</label>
      <input class="input" id="workspace-path" value="${state.workspaceRoot ?? ""}" />
      <div class="modal__actions">
        <button class="btn btn-ghost" id="workspace-cancel">Cancel</button>
        <button class="btn btn-ghost" id="workspace-clear">Close Workspace</button>
        <button class="btn btn-primary" id="workspace-open">Open</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#workspace-cancel")?.addEventListener("click", () => overlay.remove());
  overlay.querySelector("#workspace-clear")?.addEventListener("click", async () => {
    await rpc.request.openWorkspace({ path: "" });
    overlay.remove();
    await loadWorkspaceState();
  });
  overlay.querySelector("#workspace-open")?.addEventListener("click", async () => {
    const input = overlay.querySelector("#workspace-path") as HTMLInputElement;
    try {
      await rpc.request.openWorkspace({ path: input.value });
      overlay.remove();
      await loadWorkspaceState();
    } catch (err) {
      pushToast("error", `Failed to open workspace: ${String(err)}`);
    }
  });
}

function openSettingsDialog() {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  const isOpen = state.settings?.ui.workflowPanel.isOpen ?? true;
  const width = state.settings?.ui.workflowPanel.width ?? 380;
  overlay.innerHTML = `
    <div class="modal__dialog">
      <div class="modal__header">Preferences</div>
      <label class="modal__label">Workflow panel open</label>
      <select class="select" id="settings-panel-open">
        <option value="true" ${isOpen ? "selected" : ""}>Open</option>
        <option value="false" ${!isOpen ? "selected" : ""}>Closed</option>
      </select>
      <label class="modal__label">Workflow panel width</label>
      <input class="input" id="settings-panel-width" type="number" value="${width}" />
      <div class="modal__actions">
        <button class="btn btn-ghost" id="settings-cancel">Cancel</button>
        <button class="btn btn-primary" id="settings-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#settings-cancel")?.addEventListener("click", () => overlay.remove());
  overlay.querySelector("#settings-save")?.addEventListener("click", async () => {
    const openValue = (overlay.querySelector("#settings-panel-open") as HTMLSelectElement).value === "true";
    const widthValue = Number((overlay.querySelector("#settings-panel-width") as HTMLInputElement).value || "380");
    const settings = await rpc.request.setSettings({
      patch: { ui: { workflowPanel: { isOpen: openValue, width: widthValue } } },
    });
    applySettings(settings);
    overlay.remove();
  });
}

function openRunDialog(workflow?: WorkflowRef) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `
    <div class="modal__dialog">
      <div class="modal__header">Run Workflow</div>
      <label class="modal__label">Workflow</label>
      <select class="select" id="workflow-select"></select>
      <label class="modal__label">Input (JSON)</label>
      <textarea class="textarea" id="workflow-input">{}</textarea>
      <label class="modal__label">Attach to chat session</label>
      <input class="input" id="workflow-session" value="${state.sessionId ?? ""}" />
      <div class="modal__actions">
        <button class="btn btn-ghost" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-run">Run</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const select = overlay.querySelector("#workflow-select") as HTMLSelectElement;
  if (!state.workflows.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No workflows found";
    select.appendChild(option);
  } else {
    state.workflows.forEach((wf) => {
      const option = document.createElement("option");
      option.value = wf.path;
      option.textContent = wf.name ?? wf.path;
      select.appendChild(option);
    });
  }
  if (workflow) select.value = workflow.path;

  const cancelBtn = overlay.querySelector("#modal-cancel") as HTMLButtonElement;
  cancelBtn.addEventListener("click", () => overlay.remove());

  const runBtn = overlay.querySelector("#modal-run") as HTMLButtonElement;
  runBtn.addEventListener("click", async () => {
    if (!select.value) {
      pushToast("warning", "No workflow selected.");
      return;
    }
    const inputArea = overlay.querySelector("#workflow-input") as HTMLTextAreaElement;
    const sessionInput = overlay.querySelector("#workflow-session") as HTMLInputElement;
    let input: any = {};
    try {
      input = JSON.parse(inputArea.value || "{}");
    } catch {
      input = {};
    }
    const run = await rpc.request.runWorkflow({
      workflowPath: select.value,
      input,
      attachToSessionId: sessionInput.value || undefined,
    });
    overlay.remove();
    await refreshRuns();
    await focusRun(run.runId);
  });
}

async function askAgentAboutNode(runId: string, nodeId: string, iteration: number) {
  const message = `Please review workflow run ${runId}, node ${nodeId} (iteration ${iteration}).`;
  const sent = await sendMessageToAgent(message);
  if (!sent) {
    await navigator.clipboard?.writeText(message);
    pushToast("info", "Request copied. Paste into chat to ask the agent.");
  }
}

async function sendMessageToAgent(text: string): Promise<boolean> {
  const agentAny: any = state.agent as any;
  if (!agentAny) return false;
  if (typeof agentAny.sendUserMessage === "function") {
    await agentAny.sendUserMessage(text);
    return true;
  }
  if (typeof agentAny.appendUserMessage === "function") {
    await agentAny.appendUserMessage(text);
    return true;
  }
  return false;
}

async function approveFromCard(runId: string, nodeId: string, iteration: number) {
  await rpc.request.approveNode({ runId, nodeId, iteration });
  await refreshRuns();
  await focusRun(runId);
}

async function denyFromCard(runId: string, nodeId: string, iteration: number) {
  await rpc.request.denyNode({ runId, nodeId, iteration });
  await refreshRuns();
  await focusRun(runId);
}

bootstrap().catch((err) => {
  console.error("Failed to bootstrap webview", err);
});
