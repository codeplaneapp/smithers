export type WorkspaceReadinessStatus =
  | "idle"
  | "checking"
  | "ready"
  | "invalid-path"
  | "missing-setup"
  | "gateway-unavailable"
  | "gateway-mismatch"
  | "error";

export type LocalWorkspaceReadiness = {
  status: Exclude<WorkspaceReadinessStatus, "idle" | "checking" | "error">;
  workspaceRoot: string;
  serverWorkspaceRoot: string;
  gatewayBase: string;
  gatewayReachable: boolean;
  gatewayStatus: number | null;
  scopedToSelectedRoot: boolean;
  missing: string[];
  message: string;
};

export const RECENT_WORKSPACES_KEY = "smithers.local.recentWorkspaces";
export const MAX_RECENT_WORKSPACES = 8;

export function normalizeRecentWorkspaces(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const root = item.trim();
    if (!root || seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
    if (roots.length >= MAX_RECENT_WORKSPACES) break;
  }
  return roots;
}

export function nextRecentWorkspaces(current: readonly string[], workspaceRoot: string): string[] {
  const root = workspaceRoot.trim();
  if (!root) return normalizeRecentWorkspaces(current);
  return normalizeRecentWorkspaces([root, ...current.filter((item) => item !== root)]);
}

export type WorkspaceStateSnapshot = {
  selectedWorkspaceRoot: string | null;
  recentWorkspaces: string[];
  serverWorkspaceRoot: string | null;
  readiness: LocalWorkspaceReadiness | null;
  status: WorkspaceReadinessStatus;
  error: string | null;
};

export function applyWorkspaceReadiness(
  current: Pick<WorkspaceStateSnapshot, "recentWorkspaces">,
  readiness: LocalWorkspaceReadiness,
): WorkspaceStateSnapshot {
  const ready = readiness.status === "ready";
  return {
    selectedWorkspaceRoot: readiness.workspaceRoot,
    recentWorkspaces: ready
      ? nextRecentWorkspaces(current.recentWorkspaces, readiness.workspaceRoot)
      : current.recentWorkspaces,
    serverWorkspaceRoot: readiness.serverWorkspaceRoot,
    readiness,
    status: readiness.status,
    error: ready ? null : readiness.message,
  };
}
