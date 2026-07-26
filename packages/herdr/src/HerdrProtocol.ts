/**
 * Typed request params and result shapes for the herdr socket methods Smithers
 * uses (protocol 16, hand-written from `herdr api schema --json`). Unknown
 * extra fields are tolerated everywhere: the client parses responses as loose
 * records and only these documented fields are relied upon.
 */

/** `pane.report_agent` accepts only these four states (no `done`). */
export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

/** Status herdr reports back on panes/workspaces (a superset of {@link HerdrAgentState}). */
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Which slice of a pane's buffer to read. `recent` is scrollback (empty for young panes). */
export type HerdrReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";

/** Read output format. */
export type HerdrReadFormat = "text" | "ansi";

/** Direction to split when launching an agent into an existing workspace/tab. */
export type HerdrSplitDirection = "right" | "down";

/** Toast corner for `notification.show`. */
export type HerdrToastPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Sound for `notification.show`. */
export type HerdrNotificationSound = "none" | "done" | "request";

/** Substring/regex matcher for `pane.wait_for_output`. */
export type HerdrOutputMatch = {
  type: "substring" | "regex";
  value: string;
};

// ── ping ────────────────────────────────────────────────────────────────────

export type HerdrServerCapabilities = {
  live_handoff: boolean;
  detached_server_daemon?: boolean;
};

export type HerdrPong = {
  type: "pong";
  version: string;
  protocol: number;
  capabilities?: HerdrServerCapabilities | null;
};

// ── shared info records ─────────────────────────────────────────────────────

export type HerdrWorkspaceInfo = {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: HerdrAgentStatus;
  worktree?: unknown | null;
};

export type HerdrTabInfo = {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: HerdrAgentStatus;
};

export type HerdrPaneInfo = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: HerdrAgentStatus;
  revision: number;
  agent?: string | null;
  display_agent?: string | null;
  custom_status?: string | null;
  title?: string | null;
  label?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  state_labels?: Record<string, string>;
};

export type HerdrAgentInfo = HerdrPaneInfo & {
  name?: string | null;
  screen_detection_skipped?: boolean;
};

export type HerdrPaneReadResult = {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  source: HerdrReadSource;
  format: HerdrReadFormat;
  text: string;
  revision: number;
  truncated: boolean;
};

// ── workspace.create / workspace.close / workspace.list ──────────────────────

export type HerdrWorkspaceCreateParams = {
  label?: string;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
};

export type HerdrWorkspaceCreateResult = {
  type: "workspace_created";
  workspace: HerdrWorkspaceInfo;
  tab: HerdrTabInfo;
  root_pane: HerdrPaneInfo;
};

export type HerdrWorkspaceCloseParams = {
  workspace_id: string;
};

/** `workspace.rename`: set a workspace's sidebar label (used to flag a run's terminal outcome). */
export type HerdrWorkspaceRenameParams = {
  workspace_id: string;
  label: string;
};

/** Result of `workspace.rename` (the renamed workspace record). */
export type HerdrWorkspaceRenameResult = {
  type: "workspace_renamed";
  workspace: HerdrWorkspaceInfo;
};

export type HerdrWorkspaceListResult = {
  type: "workspace_list";
  workspaces: HerdrWorkspaceInfo[];
};

/** Generic acknowledgement returned by mutating methods (e.g. `workspace.close`). */
export type HerdrOkResult = {
  type: "ok";
};

// ── agent.start / agent.list ─────────────────────────────────────────────────

export type HerdrAgentStartParams = {
  name: string;
  argv: string[];
  workspace_id?: string;
  tab_id?: string;
  split?: HerdrSplitDirection;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
};

export type HerdrAgentStartResult = {
  type: "agent_started";
  agent: HerdrAgentInfo;
  argv: string[];
};

export type HerdrAgentListResult = {
  type: "agent_list";
  agents: HerdrAgentInfo[];
};

// ── pane.list ────────────────────────────────────────────────────────────────

export type HerdrPaneListParams = {
  workspace_id?: string;
};

export type HerdrPaneListResult = {
  type: "pane_list";
  panes: HerdrPaneInfo[];
};

// ── pane.report_agent / report_agent_session / release_agent / report_metadata ─

export type HerdrPaneReportAgentParams = {
  pane_id: string;
  source: string;
  agent: string;
  state: HerdrAgentState;
  message?: string;
  custom_status?: string;
  agent_session_id?: string;
  agent_session_path?: string;
  /** Monotonically increasing per pane so herdr can order authority reports. */
  seq?: number;
};

export type HerdrPaneReportAgentSessionParams = {
  pane_id: string;
  source: string;
  agent: string;
  agent_session_id?: string;
  agent_session_path?: string;
  session_start_source?: string;
  seq?: number;
};

export type HerdrPaneReleaseAgentParams = {
  pane_id: string;
  source: string;
  agent: string;
  seq?: number;
};

export type HerdrPaneReportMetadataParams = {
  pane_id: string;
  source: string;
  title?: string;
  custom_status?: string;
  display_agent?: string;
  agent?: string;
  state_labels?: Record<string, string>;
  ttl_ms?: number;
  applies_to_source?: string;
  clear_title?: boolean;
  clear_custom_status?: boolean;
  clear_display_agent?: boolean;
  clear_state_labels?: boolean;
  seq?: number;
};

// ── pane.read / pane.wait_for_output ─────────────────────────────────────────

export type HerdrPaneReadParams = {
  pane_id: string;
  source: HerdrReadSource;
  lines?: number;
  format?: HerdrReadFormat;
  strip_ansi?: boolean;
};

export type HerdrPaneReadResultEnvelope = {
  type: "pane_read";
  read: HerdrPaneReadResult;
};

export type HerdrPaneWaitForOutputParams = {
  pane_id: string;
  source: HerdrReadSource;
  match: HerdrOutputMatch;
  timeout_ms?: number;
  lines?: number;
  strip_ansi?: boolean;
};

export type HerdrPaneWaitForOutputResult = {
  type: "output_matched";
  pane_id: string;
  revision: number;
  matched_line?: string | null;
  read: HerdrPaneReadResult;
};

// ── notification.show ────────────────────────────────────────────────────────

export type HerdrNotificationShowParams = {
  title: string;
  body?: string;
  sound?: HerdrNotificationSound;
  position?: HerdrToastPosition;
};

export type HerdrNotificationShowResult = {
  type: "notification_show";
  shown: boolean;
  reason: string;
};
