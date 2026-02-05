import { BrowserWindow, BrowserView } from "electrobun/bun";
import type { AppRPCType } from "../shared/rpc";
import { AppDb } from "./db";
import { AgentService } from "./agent/AgentService";
import { SmithersService } from "./smithers/SmithersService";
import { WorkspaceService } from "./workspace/WorkspaceService";
import { PluginRegistry } from "./plugins/registry";

const db = new AppDb();
const initialSettings = db.getSettings();
const initialWorkspaceRoot = initialSettings.ui?.lastWorkspaceRoot ?? process.cwd();

let agentService: AgentService;
let smithersService: SmithersService;
let workspaceService: WorkspaceService;
const plugins = new PluginRegistry();
plugins.register({ id: "smithers" });

const rpc = BrowserView.defineRPC<AppRPCType>({
  handlers: {
    requests: {
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
      runWorkflow: ({ workflowPath, input, attachToSessionId }) =>
        smithersService.runWorkflow({ workflowPath, input, attachToSessionId }),
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
    },
    messages: {},
  },
});

workspaceService = new WorkspaceService({
  root: initialWorkspaceRoot,
  onChange: (state) => {
    rpc.send.workspaceState(state);
  },
});

smithersService = new SmithersService({
  db,
  workspaceRoot: workspaceService.getRoot() ?? process.cwd(),
  emitWorkflowEvent: (event) => {
    rpc.send.workflowEvent(event);
    if (event.type === "ApprovalRequested") {
      rpc.send.toast({ level: "warning", message: `Approval requested: ${event.nodeId}` });
    }
  },
  emitWorkflowFrame: (frame) => {
    rpc.send.workflowFrame(frame);
  },
  emitChatMessage: (sessionId, message) => {
    db.insertMessage({ sessionId, role: message.role, content: message, runId: message.runId });
    rpc.send.chatMessage({ sessionId, message });
  },
});

agentService = new AgentService({
  db,
  workspaceRoot: workspaceService.getRoot() ?? process.cwd(),
  emit: (event) => {
    rpc.send.agentEvent(event);
  },
  smithers: {
    runWorkflow: (params) => smithersService.runWorkflow(params),
  },
});

const win = new BrowserWindow({
  title: "Smithers",
  frame: { width: 1400, height: 900, x: 100, y: 100 },
  url: "views://main/index.html",
  rpc,
});

void workspaceService.getState().then((state) => rpc.send.workspaceState(state));

win.on("closed", () => {
  // no-op for now
});
