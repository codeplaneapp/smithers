import { createStore } from "solid-js/store";
import type { ChatAgent } from "../../chat/ChatAgent.js";
import type {
  RunSummaryDTO,
  RunDetailDTO,
  SmithersEventDTO,
  FrameSnapshotDTO,
  RunOutputsDTO,
  RunAttemptsDTO,
  RunToolCallsDTO,
  SettingsDTO,
  SecretStatusDTO,
  WorkflowRef,
} from "@smithers/shared";

export type AppView = "chat" | "runs" | "workflows" | "settings";
export type InspectorTab = "graph" | "timeline" | "logs" | "outputs" | "attempts" | "db";

export type ToastItem = {
  id: string;
  level: "info" | "warning" | "error";
  message: string;
};

export type AppState = {
  currentView: AppView;
  agent: ChatAgent | null;
  sessionId: string | null;
  sessions: Array<{ sessionId: string; title?: string | null }>;
  workspaceRoot: string | null;
  settings: SettingsDTO | null;
  secretStatus: SecretStatusDTO;
  workflows: WorkflowRef[];
  runs: RunSummaryDTO[];
  selectedRunId: string | null;
  contextRunId: string | null;
  runDetails: Record<string, RunDetailDTO>;
  runEvents: Record<string, SmithersEventDTO[]>;
  runEventSeq: Record<string, number>;
  frames: Record<string, FrameSnapshotDTO>;
  outputs: Record<string, RunOutputsDTO>;
  attempts: Record<string, RunAttemptsDTO>;
  toolCalls: Record<string, RunToolCallsDTO>;
  activeTab: InspectorTab;
  inspectorOpen: boolean;
  inspectorExpanded: boolean;
  logQuery: string;
  logFilters: Set<string>;
  graphZoom: number;
  graphPan: { x: number; y: number };
  toasts: ToastItem[];
};

const initialState: AppState = {
  currentView: "chat",
  agent: null,
  sessionId: null,
  sessions: [],
  workspaceRoot: null,
  settings: null,
  secretStatus: { openai: false, anthropic: false },
  workflows: [],
  runs: [],
  selectedRunId: null,
  contextRunId: null,
  runDetails: {},
  runEvents: {},
  runEventSeq: {},
  frames: {},
  outputs: {},
  attempts: {},
  toolCalls: {},
  activeTab: "graph",
  inspectorOpen: false,
  inspectorExpanded: false,
  logQuery: "",
  logFilters: new Set(["run", "node", "approval", "revert"]),
  graphZoom: 1,
  graphPan: { x: 0, y: 0 },
  toasts: [],
};

export const [appState, setAppState] = createStore<AppState>(initialState);

let toastId = 0;
export function pushToast(level: "info" | "warning" | "error", message: string) {
  const id = `toast-${++toastId}`;
  setAppState("toasts", (prev) => [...prev, { id, level, message }]);
  setTimeout(() => {
    setAppState("toasts", (prev) => prev.filter((t) => t.id !== id));
  }, 3500);
}
