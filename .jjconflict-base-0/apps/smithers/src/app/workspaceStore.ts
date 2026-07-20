import { create } from "zustand";
import {
  RECENT_WORKSPACES_KEY,
  applyWorkspaceReadiness,
  normalizeRecentWorkspaces,
  type LocalWorkspaceReadiness,
  type WorkspaceReadinessStatus,
} from "./workspaceState";

export type { LocalWorkspaceReadiness, WorkspaceReadinessStatus } from "./workspaceState";

type LocalWorkspaceResponse = {
  ok: boolean;
  defaultWorkspaceRoot?: string;
  readiness?: LocalWorkspaceReadiness;
  error?: string;
};

function readRecentWorkspaces(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return normalizeRecentWorkspaces(JSON.parse(localStorage.getItem(RECENT_WORKSPACES_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function writeRecentWorkspaces(roots: readonly string[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(normalizeRecentWorkspaces([...roots])));
}

async function readWorkspaceMetadata(): Promise<LocalWorkspaceResponse> {
  const res = await fetch("/__smithers/local-workspace", { headers: { accept: "application/json" } });
  return (await res.json()) as LocalWorkspaceResponse;
}

async function checkWorkspaceRoot(workspaceRoot: string): Promise<LocalWorkspaceReadiness> {
  const res = await fetch("/__smithers/local-workspace/readiness", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ workspaceRoot }),
  });
  const payload = (await res.json()) as LocalWorkspaceResponse;
  if (!payload.ok || !payload.readiness) {
    throw new Error(payload.error ?? "Local workspace readiness check failed.");
  }
  return payload.readiness;
}

type WorkspaceState = {
  selectedWorkspaceRoot: string | null;
  recentWorkspaces: string[];
  serverWorkspaceRoot: string | null;
  readiness: LocalWorkspaceReadiness | null;
  status: WorkspaceReadinessStatus;
  error: string | null;
  initialized: boolean;
  initialize: () => Promise<void>;
  selectWorkspace: (workspaceRoot: string) => Promise<LocalWorkspaceReadiness>;
  clearSelectedWorkspace: () => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  selectedWorkspaceRoot: null,
  recentWorkspaces: readRecentWorkspaces(),
  serverWorkspaceRoot: null,
  readiness: null,
  status: "idle",
  error: null,
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    const recentWorkspaces = readRecentWorkspaces();
    set({ recentWorkspaces, initialized: true });
    try {
      const metadata = await readWorkspaceMetadata();
      set({ serverWorkspaceRoot: metadata.defaultWorkspaceRoot ?? metadata.readiness?.serverWorkspaceRoot ?? null });
    } catch (error) {
      set({ status: "error", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const restored = recentWorkspaces[0];
    if (restored) {
      await get().selectWorkspace(restored);
    }
  },

  selectWorkspace: async (workspaceRoot: string) => {
    const root = workspaceRoot.trim();
    set({ selectedWorkspaceRoot: root || null, readiness: null, status: "checking", error: null });
    try {
      const readiness = await checkWorkspaceRoot(root);
      const nextState = applyWorkspaceReadiness(get(), readiness);
      if (readiness.status === "ready") writeRecentWorkspaces(nextState.recentWorkspaces);
      set({ ...nextState, selectedWorkspaceRoot: nextState.selectedWorkspaceRoot || root });
      return readiness;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ readiness: null, status: "error", error: message });
      throw error;
    }
  },

  clearSelectedWorkspace: () => {
    set({ selectedWorkspaceRoot: null, readiness: null, status: "idle", error: null });
  },
}));

export function resetWorkspaceStoreForTests(): void {
  const recentWorkspaces = readRecentWorkspaces();
  useWorkspaceStore.setState({
    selectedWorkspaceRoot: null,
    recentWorkspaces,
    serverWorkspaceRoot: null,
    readiness: null,
    status: "idle",
    error: null,
    initialized: false,
  });
}
