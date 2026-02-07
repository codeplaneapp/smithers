import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AgentStreamEventDTO,
  AppMessageDTO,
  RpcProcedures,
  FrameSnapshotDTO,
  SmithersEventDTO,
  WorkspaceStateDTO,
} from "@smithers/shared";
import { AppDb } from "./db";
import { AgentService } from "./agent/AgentService";
import { SmithersService } from "./smithers/SmithersService";
import { WorkspaceService } from "./workspace/WorkspaceService";
import { PluginRegistry } from "./plugins/registry";
import { createSmithersPlugin } from "./plugins/smithersPlugin";
import { SecretStore } from "./secrets";
import type { CustomToolRegistry } from "./agent/runner";

export type RpcSend = {
  agentEvent: (payload: AgentStreamEventDTO) => void;
  chatMessage: (payload: { sessionId: string; message: AppMessageDTO }) => void;
  workflowEvent: (payload: SmithersEventDTO & { seq: number }) => void;
  workflowFrame: (payload: FrameSnapshotDTO) => void;
  workspaceState: (payload: WorkspaceStateDTO) => void;
  toast: (payload: { level: "info" | "warning" | "error"; message: string }) => void;
};

export type RpcRequestHandlers = {
  [K in keyof RpcProcedures]: (
    params: RpcProcedures[K]["params"],
  ) => Promise<RpcProcedures[K]["response"]> | RpcProcedures[K]["response"];
};

export type AppRuntime = {
  handlers: { requests: RpcRequestHandlers; messages: {} };
  setSend: (send: RpcSend) => void;
  emitWorkspaceState: () => Promise<void>;
  shutdown: () => void;
};

const noopSend: RpcSend = {
  agentEvent: () => {},
  chatMessage: () => {},
  workflowEvent: () => {},
  workflowFrame: () => {},
  workspaceState: () => {},
  toast: () => {},
};

export function createAppRuntime(options: { dbPath?: string; workspaceRoot?: string } = {}): AppRuntime {
  const db = new AppDb({ path: options.dbPath });
  const secretStore = new SecretStore(db);
  const initialSettings = db.getSettings();
  const initialWorkspaceRoot =
    options.workspaceRoot ?? resolveInitialWorkspaceRoot(initialSettings.ui?.lastWorkspaceRoot ?? null);

  const MAX_BUFFERED_EVENTS = 2000;
  const bufferedEvents: Array<{ type: keyof RpcSend; payload: unknown }> = [];
  const buffer = (type: keyof RpcSend, payload: unknown) => {
    bufferedEvents.push({ type, payload });
    if (bufferedEvents.length > MAX_BUFFERED_EVENTS) {
      bufferedEvents.shift();
    }
  };

  const bufferingSend: RpcSend = {
    agentEvent: (payload) => buffer("agentEvent", payload),
    chatMessage: (payload) => buffer("chatMessage", payload),
    workflowEvent: (payload) => buffer("workflowEvent", payload),
    workflowFrame: (payload) => buffer("workflowFrame", payload),
    workspaceState: (payload) => buffer("workspaceState", payload),
    toast: (payload) => buffer("toast", payload),
  };

  const sendRef: { current: RpcSend } = { current: bufferingSend };

  let agentService: AgentService;
  let smithersService: SmithersService;
  let workspaceService: WorkspaceService;
  const plugins = new PluginRegistry();
  const toolRegistry: CustomToolRegistry = new Map();

  workspaceService = new WorkspaceService({
    root: initialWorkspaceRoot,
    onChange: (state) => {
      sendRef.current.workspaceState(state);
    },
    onError: (err) => {
      sendRef.current.toast({ level: "warning", message: err.message });
    },
  });

  smithersService = new SmithersService({
    db,
    workspaceRoot: workspaceService.getRoot() ?? process.cwd(),
    emitWorkflowEvent: (event) => {
      sendRef.current.workflowEvent(event);
      if (event.type === "ApprovalRequested") {
        sendRef.current.toast({ level: "warning", message: `Approval requested: ${event.nodeId}` });
      }
    },
    emitWorkflowFrame: (frame) => {
      sendRef.current.workflowFrame(frame);
    },
    emitChatMessage: (sessionId, message) => {
      db.insertMessage({ sessionId, role: message.role, content: message, runId: message.runId });
      sendRef.current.chatMessage({ sessionId, message });
    },
  });

  agentService = new AgentService({
    db,
    workspaceRoot: workspaceService.getRoot() ?? process.cwd(),
    emit: (event) => {
      sendRef.current.agentEvent(event);
    },
    secretStore,
    toolRegistry,
    smithers: {
      runWorkflow: (params) => smithersService.runWorkflow(params),
    },
    listWorkflows: () => workspaceService.listWorkflows(),
    listRuns: (status) => Promise.resolve(smithersService.listRuns(status as any)),
  });

  plugins.register(
    createSmithersPlugin({
      smithers: smithersService,
      workspace: workspaceService,
    }),
  );
  plugins.applyTools({
    registerTool: (name, handler) => {
      toolRegistry.set(name.toLowerCase(), handler as any);
    },
  });
  plugins.applyRpc({ registerNamespace: () => {} });
  plugins.applyMigrations({ addMigration: () => {} });
  plugins.applyUi({ addPanel: () => {} });

  const handlers: RpcRequestHandlers = {
    openWorkspace: async ({ path }) => {
      const trimmed = path?.trim();
      await workspaceService.setRoot(trimmed ? trimmed : null);
      const root = workspaceService.getRoot();
      agentService.setWorkspaceRoot(root ?? process.cwd());
      smithersService.setWorkspaceRoot(root ?? process.cwd());
      db.setSettings({ ui: { lastWorkspaceRoot: root ?? null } });
      return { ok: true };
    },
    getWorkspaceState: () => workspaceService.getState(),
    getSettings: () => db.getSettings(),
    setSettings: ({ patch }) => db.setSettings(patch),
    getSecretStatus: () => ({
      openai: secretStore.has("openai.apiKey") || Boolean(process.env.OPENAI_API_KEY),
      anthropic: secretStore.has("anthropic.apiKey") || Boolean(process.env.ANTHROPIC_API_KEY),
    }),
    setSecret: async ({ key, value }) => {
      await secretStore.set(key, value);
      return { ok: true };
    },
    clearSecret: ({ key }) => {
      secretStore.clear(key);
      return { ok: true };
    },

    listChatSessions: () => agentService.listChatSessions(),
    createChatSession: ({ title }) => ({ sessionId: agentService.createChatSession(title) }),
    getChatSession: ({ sessionId }) => {
      const session = agentService.getChatSession(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      return session;
    },
    sendChatMessage: async ({ sessionId, text, attachments }) => {
      const runId = await agentService.sendChatMessage({
        sessionId,
        text,
        attachments,
      });
      return { runId };
    },
    abortChatRun: ({ runId }) => {
      agentService.abortRun(runId);
      return { ok: true };
    },

    listWorkflows: ({ root }) => workspaceService.listWorkflows(root),
    runWorkflow: async ({ workflowPath, input, attachToSessionId }) => {
      const runId = await smithersService.runWorkflow({ workflowPath, input, attachToSessionId });
      return { runId };
    },
    listRuns: ({ status }) => smithersService.listRuns(status),
    getRun: ({ runId }) => smithersService.getRun(runId),
    getRunEvents: ({ runId, afterSeq }) => smithersService.getRunEvents(runId, afterSeq),
    getFrame: ({ runId, frameNo }) => smithersService.getFrame(runId, frameNo),
    getRunOutputs: ({ runId }) => smithersService.getRunOutputs(runId),
    getRunAttempts: ({ runId }) => smithersService.getRunAttempts(runId),
    getRunToolCalls: ({ runId }) => smithersService.getRunToolCalls(runId),
    approveNode: ({ runId, nodeId, iteration, note }) => {
      void smithersService.approveNode(runId, nodeId, iteration ?? 0, note);
      return { ok: true };
    },
    denyNode: ({ runId, nodeId, iteration, note }) => {
      void smithersService.denyNode(runId, nodeId, iteration ?? 0, note);
      return { ok: true };
    },
    cancelRun: ({ runId }) => {
      void smithersService.cancelRun(runId);
      return { ok: true };
    },
    resumeRun: ({ runId }) => {
      void smithersService.resumeRun(runId);
      return { ok: true };
    },
    browseDirectory: () => ({ path: null }),
  };

  return {
    handlers: { requests: handlers, messages: {} },
    setSend: (send) => {
      sendRef.current = send;
      if (bufferedEvents.length) {
        const pending = bufferedEvents.splice(0, bufferedEvents.length);
        for (const event of pending) {
          try {
            send[event.type](event.payload as any);
          } catch {
            // ignore flush errors
          }
        }
      }
    },
    emitWorkspaceState: async () => {
      const state = await workspaceService.getState();
      sendRef.current.workspaceState(state);
    },
    shutdown: () => {
      agentService.abortAllRuns();
      smithersService.cancelAllRuns();
      workspaceService.shutdown();
    },
  };
}

function resolveInitialWorkspaceRoot(savedRoot: string | null): string {
  const candidates = [
    savedRoot ?? null,
    process.env.SMITHERS_WORKSPACE ?? null,
    process.env.PWD ?? null,
    process.env.INIT_CWD ?? null,
  ];

  const cwd = process.cwd();
  if (isAppBundlePath(cwd)) {
    const inferred = findWorkspaceFromPath(cwd);
    if (inferred) return inferred;
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = resolve(candidate);
    if (!isDirectory(resolved)) continue;
    if (looksLikeWorkspace(resolved)) return resolved;
  }

  if (!isAppBundlePath(cwd) && isDirectory(cwd)) {
    return cwd;
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = resolve(candidate);
    if (isDirectory(resolved)) return resolved;
  }

  return cwd;
}

function looksLikeWorkspace(dir: string): boolean {
  try {
    // Has a .smithers/ directory (explicit Smithers project)
    if (existsSync(join(dir, ".smithers"))) return true;

    // Has a workflows/ subdirectory (convention for workflow projects)
    if (existsSync(join(dir, "workflows"))) return true;

    // Original check: package.json named "smithers" with src/examples/apps
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const raw = readFileSync(pkgPath, "utf8");
      const parsed = JSON.parse(raw) as { name?: string };
      if (parsed?.name === "smithers") {
        return existsSync(join(dir, "src")) || existsSync(join(dir, "examples")) || existsSync(join(dir, "apps"));
      }
    }

    return false;
  } catch {
    return false;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isAppBundlePath(path: string): boolean {
  return path.includes(".app/Contents/MacOS");
}

function findWorkspaceFromPath(start: string): string | null {
  let current = resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (looksLikeWorkspace(current)) return current;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}
