import type { RPCSchema } from "electrobun";
import type {
  AttachmentDTO,
  AppMessageDTO,
  ChatSessionSummary,
  ChatSessionDTO,
  AgentStreamEventDTO,
  DeepPartial,
  WorkflowRef,
  WorkspaceStateDTO,
  RunSummaryDTO,
  RunDetailDTO,
  SmithersEventDTO,
  FrameSnapshotDTO,
  RunOutputsDTO,
  RunAttemptsDTO,
  RunToolCallsDTO,
  SettingsDTO,
  SecretKey,
  SecretStatusDTO,
  WorkflowCardMessage,
} from "@smithers/shared";

export * from "@smithers/shared";

export type AppRPCType = {
  bun: RPCSchema<{
    requests: {
      // workspace
      openWorkspace: { params: { path: string }; response: { ok: true } };
      getWorkspaceState: { params: {}; response: WorkspaceStateDTO };

      listChatSessions: { params: {}; response: ChatSessionSummary[] };
      createChatSession: {
        params: { title?: string };
        response: { sessionId: string };
      };
      getChatSession: {
        params: { sessionId: string };
        response: ChatSessionDTO;
      };
      sendChatMessage: {
        params: {
          sessionId: string;
          text: string;
          attachments?: AttachmentDTO[];
        };
        response: { runId: string };
      };
      abortChatRun: {
        params: { sessionId: string; runId: string };
        response: { ok: true };
      };

      // workflows
      listWorkflows: { params: { root?: string }; response: WorkflowRef[] };
      runWorkflow: {
        params: {
          workflowPath: string;
          input: unknown;
          attachToSessionId?: string;
        };
        response: { runId: string };
      };
      listRuns: {
        params: { status?: "active" | "finished" | "failed" | "all" };
        response: RunSummaryDTO[];
      };
      getRun: { params: { runId: string }; response: RunDetailDTO };
      getRunEvents: {
        params: { runId: string; afterSeq?: number };
        response: { events: SmithersEventDTO[]; lastSeq: number };
      };
      getFrame: {
        params: { runId: string; frameNo?: number };
        response: FrameSnapshotDTO;
      };
      getRunOutputs: { params: { runId: string }; response: RunOutputsDTO };
      getRunAttempts: { params: { runId: string }; response: RunAttemptsDTO };
      getRunToolCalls: { params: { runId: string }; response: RunToolCallsDTO };
      approveNode: {
        params: { runId: string; nodeId: string; iteration?: number; note?: string };
        response: { ok: true };
      };
      denyNode: {
        params: { runId: string; nodeId: string; iteration?: number; note?: string };
        response: { ok: true };
      };
      cancelRun: { params: { runId: string }; response: { ok: true } };
      resumeRun: { params: { runId: string }; response: { ok: true } };

      // filesystem
      browseDirectory: { params: { startingFolder?: string }; response: { path: string | null } };

      // settings
      getSettings: { params: {}; response: SettingsDTO };
      setSettings: { params: { patch: DeepPartial<SettingsDTO> }; response: SettingsDTO };
      getSecretStatus: { params: {}; response: SecretStatusDTO };
      setSecret: { params: { key: SecretKey; value: string }; response: { ok: true } };
      clearSecret: { params: { key: SecretKey }; response: { ok: true } };
    };
    messages: {
      agentEvent: AgentStreamEventDTO;
      chatMessage: { sessionId: string; message: AppMessageDTO };
      workflowEvent: SmithersEventDTO & { seq: number };
      workflowFrame: FrameSnapshotDTO;
      workspaceState: WorkspaceStateDTO;
      toast: { level: "info" | "warning" | "error"; message: string };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};
