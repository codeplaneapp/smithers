import type { PromptInput } from "./promptInputs";
import type { StudioRpcSchema } from "./desktopRpc";
import type { WorkspaceBackendRequest, WorkspaceBackendResponse, WorkspaceStatus } from "./workspaceProtocol";

export type WorkspacePrompt = {
  id: string;
  entryFile: string | null;
  source: string | null;
  inputs: PromptInput[];
};

export type WorkspaceTicket = {
  id: string;
  content: string | null;
  status: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
};

export type WorkspaceSearchScope = "code" | "issues" | "repos" | "transcripts";

export type WorkspaceSearchResult = {
  id: string;
  title: string;
  description?: string | null;
  snippet?: string | null;
  filePath?: string | null;
  lineNumber?: number | null;
  lineNumbers?: number[] | null;
  kind?: string | null;
  snippetRanges?: Array<{ content: string; startLine?: number | null }> | null;
  fileSize?: number | null;
  fileExtension?: string | null;
  skipReason?: string | null;
};

export type WorkspaceMemoryFact = {
  namespace: string;
  key: string;
  valueJson: string;
  schemaSig: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  ttlMs: number | null;
};

export type WorkspaceMemoryRecallResult = {
  score: number;
  content: string;
  metadata: string | null;
};

export type WorkspaceScoreRow = {
  id: string;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  scorerId: string;
  scorerName: string;
  source: string;
  score: number;
  reason: string | null;
  metaJson: string | null;
  inputJson: string | null;
  outputJson: string | null;
  latencyMs: number | null;
  scoredAtMs: number;
  durationMs: number | null;
};

export type WorkspaceAggregateScore = {
  scorerId: string;
  scorerName: string;
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  stddev: number;
  sources?: string[];
  firstScoredAtMs?: number;
  latestScoredAtMs?: number;
};

export type WorkspaceScoreRun = {
  runId: string;
  count: number;
  firstScoredAtMs?: number;
  latestScoredAtMs: number;
};

export type WorkspaceScoreScopeAggregate = {
  runId?: string;
  nodeId?: string;
  workflowId?: string;
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  stddev: number;
  sources: string[];
  firstScoredAtMs: number;
  latestScoredAtMs: number;
};

export type WorkspaceAgent = {
  id: string;
  name: string;
  command: string;
  binaryPath: string;
  status: string;
  hasAuth: boolean;
  hasAPIKey: boolean;
  usable: boolean;
  roles: string[];
  version: string | null;
  authExpired: boolean | null;
  checks: string[];
  unusableReasons: string[];
  defaultModel?: string | null;
  modelOptions: Array<{ id: string; label: string }>;
};

export type WorkspaceVersions = {
  appVersion: string;
  smithersVersion: string | null;
  smithersMinimumVersion: string;
  smithersMeetsMinimum: boolean | null;
};

export type WorkspaceSettingsPreferences = {
  vimModeEnabled: boolean;
  developerToolsEnabled: boolean;
  smithersGUIControlSidebarEnabled: boolean;
  externalAgentUnsafeFlagsEnabled: boolean;
  shortcutCheatSheetFooterEnabled: boolean;
  browserSearchEngine: string;
  defaultShellPath: string;
  shortcutOverrides: Record<string, string>;
};

export type WorkspaceSettingsDetections = {
  settingsPath: string;
  shellCandidates: string[];
  resolvedShellPath: string | null;
  neovimPath: string | null;
  neovimAvailable: boolean;
};

export type WorkspaceSettings = {
  preferences: WorkspaceSettingsPreferences;
  detections: WorkspaceSettingsDetections;
};

export type WorkspaceCloudWorkspace = {
  id: string;
  name: string;
  status: string | null;
  createdAt: string | null;
};

export type WorkspaceCloudSnapshot = {
  id: string;
  workspaceId: string;
  name: string | null;
  createdAt: string | null;
};

export type WorkspaceIssue = {
  id: string;
  number: number | null;
  title: string;
  body: string | null;
  state: string | null;
  labels: string[] | null;
  assignees: string[] | null;
  commentCount: number | null;
};

export type WorkspaceLanding = {
  id: string;
  number: number | null;
  title: string;
  description: string | null;
  state: string | null;
  targetBranch: string | null;
  author: string | null;
  createdAt: string | null;
  reviewStatus: string | null;
};

export type WorkspaceJjhubWorkflow = {
  id: number;
  repositoryID: number | null;
  name: string;
  path: string;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type WorkspaceJjhubWorkflowRun = {
  id: number | null;
  workflowDefinitionID: number | null;
  status: string | null;
  triggerEvent: string | null;
  triggerRef: string | null;
  triggerCommitSHA: string | null;
  startedAt: string | null;
  completedAt: string | null;
  sessionID: string | null;
  steps: string[] | null;
};

export type WorkspaceFile = {
  path: string;
  name: string;
  extension: string | null;
  size: number;
};

export type WorkspaceLogEntry = {
  id: string;
  timestamp: string | null;
  level: string;
  category: string;
  message: string;
  metadata: Record<string, string> | null;
  sourcePath: string;
  raw: string | null;
};

export type WorkspaceLogSource = {
  path: string;
  sizeBytes: number;
  entryCount: number;
};

export type WorkspaceLogStats = {
  entryCount: number;
  sizeBytes: number;
  errorCount: number;
  warningCount: number;
  categories: Array<{ category: string; count: number }>;
  sources: WorkspaceLogSource[];
};

export type WorkspaceTerminalExecution = {
  id: string;
  command: string;
  cwd: string;
  shellPath: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

export type WorkspaceTerminalSession = WorkspaceTerminalExecution & {
  running: boolean;
  events: Array<{ seq: number; stream: "stdout" | "stderr" | "system"; text: string; at: string }>;
};

export type WorkspaceBrowserResolution = {
  raw: string;
  url: string;
  engine: string;
};

export type WorkspaceDebugRow = {
  label: string;
  value: string;
  tone: "normal" | "good" | "warning" | "danger";
};

export type WorkspaceDebugEvent = {
  id: string;
  timestamp: string | null;
  level: string;
  name: string;
  source: string;
  detail: string;
};

export type WorkspaceDebugPayload = {
  capturedAt: string;
  runtimeRows: WorkspaceDebugRow[];
  workspaceRows: WorkspaceDebugRow[];
  logRows: WorkspaceDebugRow[];
  metricRows: WorkspaceDebugRow[];
  events: WorkspaceDebugEvent[];
  logs: WorkspaceLogEntry[];
};

export type WorkspaceLocalRecent = {
  path: string;
  displayName: string;
  exists: boolean;
  hasSmithers: boolean;
  smithersPath: string | null;
  lastOpenedAt: string;
};

export type WorkspaceJjhubAuthStatus = {
  apiUrl: string | null;
  loggedIn: boolean;
  tokenSet: boolean;
  tokenSource: string | null;
  user: string | null;
  email: string | null;
  message: string | null;
};

export type WorkspaceFileContent = {
  path: string;
  name: string;
  extension: string | null;
  content: string;
  size: number;
  language: string | null;
};

export type WorkspaceLandingConflict = {
  changeID: string | null;
  filePath: string;
  conflictType: string | null;
  resolved: boolean | null;
  resolutionStatus: string | null;
};

export type WorkspaceLandingConflicts = {
  conflictStatus: string | null;
  hasConflicts: boolean;
  conflicts: WorkspaceLandingConflict[];
};

export type WorkspaceEditorTargetKind = "smithers" | "ticket";

export type WorkspaceEditorTarget = {
  path: string;
  cwd: string;
  neovimCommand: string | null;
  neovimAvailable: boolean;
};

export type WorkspaceApprovalDecision = {
  id: string;
  runId: string;
  nodeId: string;
  iteration: number;
  workflowKey: string | null;
  status: string;
  decisionState: string;
  action: string;
  requestTitle: string | null;
  requestSummary: string | null;
  requestedAtMs: number | null;
  decidedAtMs: number | null;
  note: string | null;
  decidedBy: string | null;
  requestJson: string | null;
  decisionJson: string | null;
  autoApproved: boolean;
};

export type WorkspaceTokenMetricsPeriod = {
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type WorkspaceTokenMetrics = {
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  byPeriod: WorkspaceTokenMetricsPeriod[];
};

export type WorkspaceLatencyMetricsPeriod = {
  label: string;
  count: number;
  meanMs: number;
};

export type WorkspaceLatencyMetrics = {
  count: number;
  meanMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  byPeriod: WorkspaceLatencyMetricsPeriod[];
};

export type WorkspaceCostPeriod = {
  label: string;
  totalCostUSD: number;
  runCount: number;
};

export type WorkspaceCostReport = {
  totalCostUSD: number;
  inputCostUSD: number;
  outputCostUSD: number;
  runCount: number;
  byPeriod: WorkspaceCostPeriod[];
};

export type WorkspaceWorkflowLaunchField = {
  key: string;
  name: string;
  type: string | null;
  defaultValue: string | null;
  required: boolean;
};

export type WorkspaceRepo = {
  id: string | number | null;
  name: string | null;
  fullName: string | null;
  owner: string | null;
  description: string | null;
  defaultBookmark: string | null;
  root: string | null;
  isPublic: boolean | null;
  isArchived: boolean | null;
  numIssues: number | null;
  numStars: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type WorkspaceChange = {
  changeID: string;
  commitID: string | null;
  description: string | null;
  author: {
    name: string | null;
    email: string | null;
  } | null;
  timestamp: string | null;
  bookmarks: string[];
  isEmpty: boolean | null;
  isWorkingCopy: boolean | null;
};

export type WorkspaceBookmark = {
  name: string;
  targetChangeID: string | null;
  targetCommitID: string | null;
  isTrackingRemote: boolean | null;
};

export type WorkspaceWorkflowImport = {
  id: string;
  name: string;
  path: string;
  kind: "component" | "prompt";
  source: string;
};

export type WorkspaceWorkflowSource = {
  workflowKey: string;
  path: string;
  source: string;
  imports: WorkspaceWorkflowImport[];
};

export type WorkspaceWorkflowFrontendManifest = {
  version: number;
  id: string;
  name: string;
  framework: string | null;
  entry: string;
  apiBasePath: string | null;
  defaultPath: string | null;
};

export type WorkspaceWorkflowFrontendDescriptor = {
  manifest: WorkspaceWorkflowFrontendManifest;
  manifestPath: string;
  frontendDirectoryPath: string;
  serverScriptPath: string | null;
  entryPath: string | null;
  routePath: string;
};

export type WorkspaceWorkflowFrontendLaunch = {
  descriptor: WorkspaceWorkflowFrontendDescriptor;
  phase: "ready" | "static";
  url: string | null;
  html: string | null;
  message: string;
};

export type WorkspaceWorkflowGraphTask = {
  nodeId: string;
  ordinal: number | null;
  outputTableName: string | null;
  needsApproval: boolean | null;
  waitAsync: boolean | null;
};

export type WorkspaceWorkflowGraphEdge = {
  from: string;
  to: string;
};

export type WorkspaceWorkflowGraph = {
  workflowKey: string;
  path: string;
  mode: string;
  message: string | null;
  tasks: WorkspaceWorkflowGraphTask[];
  edges: WorkspaceWorkflowGraphEdge[];
  fields: WorkspaceWorkflowLaunchField[];
  entryTask?: string | null;
  raw: unknown;
};

export type WorkspaceWorkflowDoctorIssue = {
  severity: "ok" | "warning" | "error";
  check: string;
  message: string;
};

export type WorkspaceWorkflowDoctor = {
  workflowKey: string;
  path: string;
  workflowRoot: string | null;
  issues: WorkspaceWorkflowDoctorIssue[];
  raw: unknown;
};

export type WorkspaceSqlTable = {
  name: string;
  rowCount: number;
  type: string;
};

export type WorkspaceSqlColumn = {
  cid: number;
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
};

export type WorkspaceSqlSchema = {
  tableName: string;
  columns: WorkspaceSqlColumn[];
};

export type WorkspaceSqlResult = {
  columns: string[];
  rows: string[][];
};

type StudioDesktopRpc = {
  request: {
    workspaceStatus: (params?: undefined) => Promise<WorkspaceStatus>;
    workspaceRequest: (params: WorkspaceBackendRequest) => Promise<WorkspaceBackendResponse>;
  };
  // Electrobun owns this method; Studio only needs it present for Electroview wiring.
  setTransport: (transport: any) => void;
};

let desktopRpcPromise: Promise<StudioDesktopRpc | null> | null = null;
let desktopElectroview: unknown = null;

function hasDesktopBridge() {
  if (typeof window === "undefined") {
    return false;
  }
  const bridgeWindow = window as typeof window & {
    __electrobun?: unknown;
    __electrobunBunBridge?: unknown;
    __electrobunRpcSocketPort?: number;
    __electrobunWebviewId?: number;
  };
  return Boolean(bridgeWindow.__electrobun) ||
    Boolean(bridgeWindow.__electrobunBunBridge) ||
    Boolean(bridgeWindow.__electrobunRpcSocketPort) ||
    Boolean(bridgeWindow.__electrobunWebviewId);
}

async function getDesktopRpc() {
  // Simplified for Studio v2 - no desktop RPC support yet
  return null;
}

function bodyFromRequestInit(init?: RequestInit) {
  if (typeof init?.body !== "string" || !init.body.trim()) {
    return undefined;
  }
  return JSON.parse(init.body) as unknown;
}

function backendRequestFromPath(path: string, init?: RequestInit): WorkspaceBackendRequest {
  const url = new URL(path, "http://smithers-studio.local");
  return {
    method: init?.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    body: bodyFromRequestInit(init),
  };
}

export async function loadWorkspaceStatus() {
  const response = await fetch("/__smithers_studio/workspace");
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `Workspace probe failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as WorkspaceStatus;
}

async function workspaceJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/__smithers_studio/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `Workspace API failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export async function listWorkspacePrompts() {
  const payload = await workspaceJson<{ prompts: WorkspacePrompt[] }>("/prompts");
  return payload.prompts;
}

export async function updateWorkspacePrompt(promptId: string, source: string) {
  const payload = await workspaceJson<{ prompt: WorkspacePrompt }>(`/prompts/${encodeURIComponent(promptId)}`, {
    method: "PUT",
    body: JSON.stringify({ source }),
  });
  return payload.prompt;
}

export async function previewWorkspacePrompt(promptId: string, source: string, input: Record<string, string>) {
  const payload = await workspaceJson<{ preview: string }>(`/prompts/${encodeURIComponent(promptId)}/preview`, {
    method: "POST",
    body: JSON.stringify({ source, input }),
  });
  return payload.preview;
}

export async function listWorkspaceTickets(query = "") {
  const search = new URLSearchParams();
  if (query.trim()) {
    search.set("query", query.trim());
  }
  const payload = await workspaceJson<{ tickets: WorkspaceTicket[] }>(`/tickets${search.size ? `?${search}` : ""}`);
  return payload.tickets;
}

export async function listWorkspaceAgents() {
  const payload = await workspaceJson<{ agents: WorkspaceAgent[] }>("/agents");
  return payload.agents;
}

export async function loadWorkspaceVersions() {
  const payload = await workspaceJson<{ versions: WorkspaceVersions }>("/versions");
  return payload.versions;
}

export async function listWorkspaceFiles(query = "", limit = 80) {
  const search = new URLSearchParams({ limit: String(limit) });
  if (query.trim()) {
    search.set("query", query.trim());
  }
  const payload = await workspaceJson<{ files: WorkspaceFile[] }>(`/files?${search}`);
  return payload.files;
}

export async function executeWorkspaceTerminalCommand(command: string, cwd?: string | null) {
  const payload = await workspaceJson<{ execution: WorkspaceTerminalExecution }>("/terminal/execute", {
    method: "POST",
    body: JSON.stringify({ command, cwd: cwd || null }),
  });
  return payload.execution;
}

export async function resolveWorkspaceBrowserUrl(value: string) {
  const search = new URLSearchParams({ value });
  const payload = await workspaceJson<{ browser: WorkspaceBrowserResolution }>(`/browser/resolve?${search}`);
  return payload.browser;
}

export async function loadWorkspaceDebug() {
  const payload = await workspaceJson<{ debug: WorkspaceDebugPayload }>("/debug");
  return payload.debug;
}

export async function listWorkspaceLogs(params: {
  level?: string | null;
  category?: string | null;
  query?: string;
  limit?: number;
} = {}) {
  return workspaceJson<{ entries: WorkspaceLogEntry[]; stats: WorkspaceLogStats }>(`/logs?${logSearchParams(params)}`);
}

function logSearchParams(params: {
  level?: string | null;
  category?: string | null;
  query?: string;
  limit?: number;
}) {
  const search = new URLSearchParams({ limit: String(params.limit ?? 1_000) });
  if (params.level) {
    search.set("level", params.level);
  }
  if (params.category) {
    search.set("category", params.category);
  }
  if (params.query?.trim()) {
    search.set("query", params.query.trim());
  }
  return search;
}

export async function exportWorkspaceLogs(params: {
  level?: string | null;
  category?: string | null;
  query?: string;
  limit?: number;
} = {}) {
  const payload = await workspaceJson<{ fileName: string; content: string; count: number }>(
    `/logs/export?${logSearchParams(params)}`,
  );
  return payload;
}

export async function clearWorkspaceLogs() {
  const payload = await workspaceJson<{ cleared: string[] }>("/logs", {
    method: "DELETE",
  });
  return payload.cleared;
}

export async function revealWorkspaceLogs() {
  const payload = await workspaceJson<{ paths: string[] }>("/logs/reveal", {
    method: "POST",
  });
  return payload.paths;
}

export async function loadWorkspaceSettings() {
  const payload = await workspaceJson<{ settings: WorkspaceSettings }>("/settings");
  return payload.settings;
}

export async function updateWorkspaceSettings(preferences: Partial<WorkspaceSettingsPreferences>) {
  const payload = await workspaceJson<{ settings: WorkspaceSettings }>("/settings", {
    method: "PUT",
    body: JSON.stringify({ preferences }),
  });
  return payload.settings;
}

export async function listLocalWorkspaces() {
  const payload = await workspaceJson<{ recents: WorkspaceLocalRecent[] }>("/local-workspaces");
  return payload.recents;
}

export async function openLocalWorkspace(path: string) {
  const payload = await workspaceJson<{ workspace: WorkspaceStatus }>("/local-workspaces/open", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
  return payload.workspace;
}

export async function removeLocalWorkspace(path: string) {
  const payload = await workspaceJson<{ recents: WorkspaceLocalRecent[] }>("/local-workspaces", {
    method: "DELETE",
    body: JSON.stringify({ path }),
  });
  return payload.recents;
}

export async function loadJjhubAuthStatus() {
  const payload = await workspaceJson<{ auth: WorkspaceJjhubAuthStatus }>("/auth/status");
  return payload.auth;
}

export async function listCloudWorkspaces() {
  const payload = await workspaceJson<{ workspaces: WorkspaceCloudWorkspace[] }>("/workspaces");
  return payload.workspaces;
}

export async function createCloudWorkspace(name: string, snapshotId?: string | null) {
  const payload = await workspaceJson<{ workspace: WorkspaceCloudWorkspace }>("/workspaces", {
    method: "POST",
    body: JSON.stringify({ name, snapshotId: snapshotId || null }),
  });
  return payload.workspace;
}

export async function getCloudWorkspace(workspaceId: string) {
  const payload = await workspaceJson<{ workspace: WorkspaceCloudWorkspace }>(
    `/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  return payload.workspace;
}

export async function deleteCloudWorkspace(workspaceId: string) {
  await workspaceJson<{ ok: true }>(`/workspaces/${encodeURIComponent(workspaceId)}`, {
    method: "DELETE",
  });
}

export async function suspendCloudWorkspace(workspaceId: string) {
  await workspaceJson<{ ok: true }>(`/workspaces/${encodeURIComponent(workspaceId)}/suspend`, {
    method: "POST",
  });
}

export async function resumeCloudWorkspace(workspaceId: string) {
  await workspaceJson<{ ok: true }>(`/workspaces/${encodeURIComponent(workspaceId)}/resume`, {
    method: "POST",
  });
}

export async function forkCloudWorkspace(workspaceId: string, name?: string | null) {
  const payload = await workspaceJson<{ workspace: WorkspaceCloudWorkspace }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/fork`,
    {
      method: "POST",
      body: JSON.stringify({ name: name || null }),
    },
  );
  return payload.workspace;
}

export async function listCloudWorkspaceSnapshots() {
  const payload = await workspaceJson<{ snapshots: WorkspaceCloudSnapshot[] }>("/workspaces/snapshots");
  return payload.snapshots;
}

export async function createCloudWorkspaceSnapshot(workspaceId: string, name: string) {
  const payload = await workspaceJson<{ snapshot: WorkspaceCloudSnapshot }>("/workspaces/snapshots", {
    method: "POST",
    body: JSON.stringify({ workspaceId, name }),
  });
  return payload.snapshot;
}

export async function deleteCloudWorkspaceSnapshot(snapshotId: string) {
  await workspaceJson<{ ok: true }>(`/workspaces/snapshots/${encodeURIComponent(snapshotId)}`, {
    method: "DELETE",
  });
}

export async function listJjhubIssues(state?: string | null) {
  const search = new URLSearchParams();
  if (state) {
    search.set("state", state);
  }
  const payload = await workspaceJson<{ issues: WorkspaceIssue[] }>(`/issues${search.size ? `?${search}` : ""}`);
  return payload.issues;
}

export async function getJjhubIssue(number: number) {
  const payload = await workspaceJson<{ issue: WorkspaceIssue }>(`/issues/${number}`);
  return payload.issue;
}

export async function createJjhubIssue(title: string, body?: string | null) {
  const payload = await workspaceJson<{ issue: WorkspaceIssue }>("/issues", {
    method: "POST",
    body: JSON.stringify({ title, body: body || null }),
  });
  return payload.issue;
}

export async function closeJjhubIssue(number: number, comment?: string | null) {
  const payload = await workspaceJson<{ issue: WorkspaceIssue }>(`/issues/${number}/close`, {
    method: "POST",
    body: JSON.stringify({ comment: comment || null }),
  });
  return payload.issue;
}

export async function reopenJjhubIssue(number: number) {
  const payload = await workspaceJson<{ issue: WorkspaceIssue }>(`/issues/${number}/reopen`, {
    method: "POST",
  });
  return payload.issue;
}

export async function listJjhubLandings(state?: string | null) {
  const search = new URLSearchParams({ limit: "100" });
  if (state) {
    search.set("state", state);
  }
  const payload = await workspaceJson<{ landings: WorkspaceLanding[] }>(`/landings?${search}`);
  return payload.landings;
}

export async function getJjhubLanding(number: number) {
  const payload = await workspaceJson<{ landing: WorkspaceLanding }>(`/landings/${number}`);
  return payload.landing;
}

export async function createJjhubLanding(title: string, body?: string | null, target?: string | null) {
  const payload = await workspaceJson<{ landing: WorkspaceLanding }>("/landings", {
    method: "POST",
    body: JSON.stringify({ title, body: body || null, target: target || null, stack: true }),
  });
  return payload.landing;
}

export async function getJjhubLandingDiff(number: number) {
  const payload = await workspaceJson<{ diff: string }>(`/landings/${number}/diff`);
  return payload.diff;
}

export async function getJjhubLandingChecks(number: number) {
  const payload = await workspaceJson<{ checks: string }>(`/landings/${number}/checks`);
  return payload.checks;
}

export async function getJjhubLandingConflicts(number: number) {
  const payload = await workspaceJson<{ conflicts: WorkspaceLandingConflicts }>(`/landings/${number}/conflicts`);
  return payload.conflicts;
}

export async function reviewJjhubLanding(number: number, action: "approve" | "request_changes" | "comment", body?: string | null) {
  const payload = await workspaceJson<{ landing: WorkspaceLanding }>(`/landings/${number}/review`, {
    method: "POST",
    body: JSON.stringify({ action, body: body || null }),
  });
  return payload.landing;
}

export async function landJjhubLanding(number: number) {
  const payload = await workspaceJson<{ landing: WorkspaceLanding }>(`/landings/${number}/land`, {
    method: "POST",
  });
  return payload.landing;
}

export async function listJjhubWorkflows(limit = 100) {
  const search = new URLSearchParams({ limit: String(limit) });
  const payload = await workspaceJson<{ workflows: WorkspaceJjhubWorkflow[] }>(`/jjhub-workflows?${search}`);
  return payload.workflows;
}

export async function loadJjhubRepo() {
  const payload = await workspaceJson<{ repo: WorkspaceRepo }>("/jjhub-repo");
  return payload.repo;
}

export async function triggerJjhubWorkflow(workflowID: number, ref: string) {
  const payload = await workspaceJson<{ run: WorkspaceJjhubWorkflowRun }>("/jjhub-workflows/run", {
    method: "POST",
    body: JSON.stringify({ workflowID, ref }),
  });
  return payload.run;
}

export async function getWorkspaceWorkflowSource(workflowKey: string) {
  const payload = await workspaceJson<{ workflow: WorkspaceWorkflowSource }>(
    `/workflow-sources/${encodeURIComponent(workflowKey)}`,
  );
  return payload.workflow;
}

export async function getWorkspaceWorkflowFrontend(workflowKey: string) {
  const payload = await workspaceJson<{ frontend: WorkspaceWorkflowFrontendDescriptor | null }>(
    `/workflow-frontends/${encodeURIComponent(workflowKey)}`,
  );
  return payload.frontend;
}

export async function startWorkspaceWorkflowFrontend(workflowKey: string) {
  const payload = await workspaceJson<{ frontend: WorkspaceWorkflowFrontendLaunch }>(
    `/workflow-frontends/${encodeURIComponent(workflowKey)}/start`,
    { method: "POST" },
  );
  return payload.frontend;
}

export async function getWorkspaceWorkflowGraph(workflowKey: string) {
  const payload = await workspaceJson<{ graph: WorkspaceWorkflowGraph }>(
    `/workflow-sources/${encodeURIComponent(workflowKey)}/graph`,
  );
  return payload.graph;
}

export async function getWorkspaceWorkflowDoctor(workflowKey: string) {
  const payload = await workspaceJson<{ doctor: WorkspaceWorkflowDoctor }>(
    `/workflow-sources/${encodeURIComponent(workflowKey)}/doctor`,
  );
  return payload.doctor;
}

export async function updateWorkspaceWorkflowSource(path: string, source: string) {
  const payload = await workspaceJson<{ path: string }>("/workflow-sources", {
    method: "PUT",
    body: JSON.stringify({ path, source }),
  });
  return payload;
}

export async function loadWorkspaceRepo() {
  const payload = await workspaceJson<{ repo: WorkspaceRepo }>("/changes/repo");
  return payload.repo;
}

export async function listWorkspaceChanges(limit = 50) {
  const search = new URLSearchParams({ limit: String(limit) });
  const payload = await workspaceJson<{ changes: WorkspaceChange[] }>(`/changes?${search}`);
  return payload.changes;
}

export async function getWorkspaceChange(changeID: string) {
  const payload = await workspaceJson<{ change: WorkspaceChange }>(`/changes/${encodeURIComponent(changeID)}`);
  return payload.change;
}

export async function getWorkspaceChangeStatus() {
  const payload = await workspaceJson<{ status: string }>("/changes/status");
  return payload.status;
}

export async function getWorkspaceChangeDiff(changeID?: string | null) {
  const search = new URLSearchParams();
  if (changeID?.trim()) {
    search.set("changeId", changeID.trim());
  }
  const payload = await workspaceJson<{ diff: string }>(`/changes/diff${search.size ? `?${search}` : ""}`);
  return payload.diff;
}

export async function readWorkspaceFile(path: string) {
  const search = new URLSearchParams({ path });
  const payload = await workspaceJson<{ file: WorkspaceFileContent }>(`/files/content?${search}`);
  return payload.file;
}

export async function getWorkspaceEditorTarget(params: {
  kind: WorkspaceEditorTargetKind;
  path?: string | null;
  ticketId?: string | null;
}) {
  const search = new URLSearchParams({ kind: params.kind });
  if (params.path) {
    search.set("path", params.path);
  }
  if (params.ticketId) {
    search.set("ticketId", params.ticketId);
  }
  const payload = await workspaceJson<{ target: WorkspaceEditorTarget }>(`/editor/target?${search}`);
  return payload.target;
}

export async function saveWorkspaceOperatorScreenshot(params: {
  fileName: string;
  pngBase64: string;
  width?: number | null;
  height?: number | null;
}) {
  const payload = await workspaceJson<{
    screenshot: {
      path: string;
      relativePath: string;
      fileName: string;
      bytes: number;
      width: number | null;
      height: number | null;
      capturedAt: string;
    };
  }>("/operator/screenshot", {
    method: "POST",
    body: JSON.stringify(params),
  });
  return payload.screenshot;
}

export async function startWorkspaceTerminalSession(command: string, cwd?: string | null) {
  const payload = await workspaceJson<{ session: WorkspaceTerminalSession }>("/terminal/sessions", {
    method: "POST",
    body: JSON.stringify({ command, cwd: cwd || null }),
  });
  return payload.session;
}

export async function readWorkspaceTerminalSession(sessionId: string) {
  const payload = await workspaceJson<{ session: WorkspaceTerminalSession }>(
    `/terminal/sessions/${encodeURIComponent(sessionId)}`,
  );
  return payload.session;
}

export async function sendWorkspaceTerminalSessionInput(sessionId: string, input: string) {
  const payload = await workspaceJson<{ session: WorkspaceTerminalSession }>(
    `/terminal/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      body: JSON.stringify({ input }),
    },
  );
  return payload.session;
}

export async function stopWorkspaceTerminalSession(sessionId: string) {
  const payload = await workspaceJson<{ session: WorkspaceTerminalSession }>(
    `/terminal/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
  return payload.session;
}

export async function requestApplicationFullScreenToggle() {
  return {
    requested: false,
    fullScreen: typeof document !== "undefined" ? Boolean(document.fullscreenElement) : false,
  };
}

export async function requestApplicationQuit() {
  return false;
}

export async function createWorkspaceBookmark(name: string, changeID: string) {
  const payload = await workspaceJson<{ bookmark: WorkspaceBookmark }>("/changes/bookmarks", {
    method: "POST",
    body: JSON.stringify({ name, changeID }),
  });
  return payload.bookmark;
}

export async function deleteWorkspaceBookmark(name: string) {
  await workspaceJson<{ ok: true }>("/changes/bookmarks", {
    method: "DELETE",
    body: JSON.stringify({ name }),
  });
}

export async function listWorkspaceSqlTables() {
  const payload = await workspaceJson<{ tables: WorkspaceSqlTable[]; dbPath: string }>("/sql/tables");
  return payload;
}

export async function getWorkspaceSqlSchema(tableName: string) {
  const search = new URLSearchParams({ tableName });
  const payload = await workspaceJson<{ schema: WorkspaceSqlSchema; dbPath: string }>(`/sql/schema?${search}`);
  return payload;
}

export async function runWorkspaceSqlQuery(query: string, limit = 500) {
  return workspaceJson<{ result: WorkspaceSqlResult; dbPath: string }>("/sql/query", {
    method: "POST",
    body: JSON.stringify({ query, limit }),
  });
}

export async function createWorkspaceTicket(ticketId: string, content: string) {
  const payload = await workspaceJson<{ ticket: WorkspaceTicket }>("/tickets", {
    method: "POST",
    body: JSON.stringify({ ticketId, content }),
  });
  return payload.ticket;
}

export async function updateWorkspaceTicket(ticketId: string, content: string) {
  const payload = await workspaceJson<{ ticket: WorkspaceTicket }>(`/tickets/${encodeURIComponent(ticketId)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
  return payload.ticket;
}

export async function deleteWorkspaceTicket(ticketId: string) {
  await workspaceJson<{ ok: true }>(`/tickets/${encodeURIComponent(ticketId)}`, {
    method: "DELETE",
  });
}

export async function searchWorkspace(params: {
  query: string;
  scope: WorkspaceSearchScope;
  issueState?: string | null;
  limit?: number;
}) {
  const search = new URLSearchParams({
    query: params.query,
    scope: params.scope,
    limit: String(params.limit ?? 20),
  });
  if (params.issueState) {
    search.set("issueState", params.issueState);
  }
  const payload = await workspaceJson<{ results: WorkspaceSearchResult[] }>(`/search?${search}`);
  return payload.results;
}

export async function listWorkspaceMemoryFacts(params: {
  namespace?: string | null;
  query?: string;
  limit?: number;
} = {}) {
  const search = new URLSearchParams({ limit: String(params.limit ?? 200) });
  if (params.namespace) {
    search.set("namespace", params.namespace);
  }
  if (params.query?.trim()) {
    search.set("query", params.query.trim());
  }
  return workspaceJson<{ facts: WorkspaceMemoryFact[]; dbPath: string }>(`/memory?${search}`);
}

export async function recallWorkspaceMemory(params: {
  query: string;
  namespace?: string | null;
  topK?: number;
}) {
  const search = new URLSearchParams({
    query: params.query,
    topK: String(params.topK ?? 10),
  });
  if (params.namespace) {
    search.set("namespace", params.namespace);
  }
  return workspaceJson<{ results: WorkspaceMemoryRecallResult[]; dbPath: string }>(`/memory/recall?${search}`);
}

export async function listWorkspaceApprovalHistory(params: { limit?: number } = {}) {
  const search = new URLSearchParams({ limit: String(params.limit ?? 100) });
  return workspaceJson<{ decisions: WorkspaceApprovalDecision[]; dbPath: string }>(`/approvals/history?${search}`);
}

export async function listWorkspaceScores(params: {
  runId?: string | null;
  limit?: number;
} = {}) {
  const search = new URLSearchParams({ limit: String(params.limit ?? 200) });
  if (params.runId) {
    search.set("runId", params.runId);
  }
  return workspaceJson<{
    scores: WorkspaceScoreRow[];
    aggregates: WorkspaceAggregateScore[];
    runs: WorkspaceScoreRun[];
    runAggregates?: WorkspaceScoreScopeAggregate[];
    nodeAggregates?: WorkspaceScoreScopeAggregate[];
    workflowAggregates?: WorkspaceScoreScopeAggregate[];
    tokenMetrics: WorkspaceTokenMetrics;
    latencyMetrics: WorkspaceLatencyMetrics;
    costReport: WorkspaceCostReport;
    dbPath: string;
  }>(`/scores?${search}`);
}
