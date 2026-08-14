/**
 * Typed request params and result shapes for the herdr socket methods Smithers
 * uses (protocol 19 / herdr 0.8.0, hand-written from `herdr api schema --json`).
 * Unknown extra fields are tolerated everywhere: the client parses responses as
 * loose records and only these documented fields are relied upon.
 */

/** `pane.report_agent` accepts only these four states (no `done`). */
export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

/** Status herdr reports back on panes/workspaces (a superset of {@link HerdrAgentState}). */
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** Which slice of a pane's buffer to read. `recent` is scrollback (empty for young panes). */
export type HerdrReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";

/** Read output format. */
export type HerdrReadFormat = "text" | "ansi";

/** Direction to split an existing pane. */
export type HerdrSplitDirection = "right" | "down";

/**
 * Free-form display metadata attached to a pane or workspace by a reporting
 * source. Protocol 19 replaced the single `custom_status` string with this map;
 * keys must match `[A-Za-z0-9_-]{1,32}`.
 */
export type HerdrMetadataTokens = Record<string, string>;

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
  tokens?: HerdrMetadataTokens;
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
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  label?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  state_labels?: Record<string, string>;
  tokens?: HerdrMetadataTokens;
};

/**
 * `name` is herdr's own registered agent name, set only by `agent.start` /
 * `agent.rename` and constrained to `[a-z][a-z0-9_-]{0,31}`. Smithers' pane
 * identity (`smithers:<runId>:<nodeId>`) does not fit it, so ownership keys on
 * the reported {@link HerdrPaneInfo.agent} instead.
 */
export type HerdrAgentInfo = HerdrPaneInfo & {
  name?: string | null;
  screen_detection_skipped?: boolean;
  launch_pending?: boolean;
  interactive_ready?: boolean;
  state_change_seq?: number;
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
  label?: string | null;
  cwd?: string | null;
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
  type: "workspace_info";
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

// ── tab.create ───────────────────────────────────────────────────────────────

/**
 * `tab.create` seeds the tab's root pane with a shell. `cwd`/`env` shape that
 * shell, which is how Smithers places a pane's command in the run directory now
 * that protocol 19's `agent.start` no longer forwards them.
 */
export type HerdrTabCreateParams = {
  workspace_id?: string | null;
  label?: string | null;
  cwd?: string | null;
  env?: Record<string, string>;
  focus?: boolean;
};

export type HerdrTabCreateResult = {
  type: "tab_created";
  tab: HerdrTabInfo;
  root_pane: HerdrPaneInfo;
};

// ── agent.start / agent.list ─────────────────────────────────────────────────

/**
 * Protocol 19 reshaped `agent.start`: it no longer creates a pane and no longer
 * accepts an arbitrary `argv`. It attaches one of herdr's KNOWN interactive
 * agent kinds (`server.agent_manifests`) to an existing shell pane, rejecting
 * anything else with `unsupported_agent_kind`. Smithers therefore launches its
 * own commands with `tab.create` + {@link HerdrPaneSendInputParams} instead.
 */
export type HerdrAgentStartParams = {
  name: string;
  kind: string;
  pane_id: string;
  args?: string[];
  timeout_ms?: number;
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
  message?: string | null;
  agent_session_id?: string | null;
  agent_session_path?: string | null;
  /** Monotonically increasing per pane so herdr can order authority reports. */
  seq?: number;
};

export type HerdrPaneReportAgentSessionParams = {
  pane_id: string;
  source: string;
  agent: string;
  agent_session_id?: string | null;
  agent_session_path?: string | null;
  session_start_source?: string | null;
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
  title?: string | null;
  display_agent?: string | null;
  agent?: string | null;
  state_labels?: Record<string, string> | null;
  /** Protocol 19's `custom_status` replacement. A `null` value clears one token. */
  tokens?: Record<string, string | null>;
  /** 1..86_400_000 in protocol 19; omit for metadata that persists until cleared. */
  ttl_ms?: number;
  applies_to_source?: string | null;
  clear_title?: boolean;
  clear_display_agent?: boolean;
  clear_state_labels?: boolean;
  seq?: number;
};

/**
 * `pane.send_input`: literal text plus key presses in ONE call — herdr's own
 * `pane run` (and how protocol 19 `agent.start` submits its command line), so a
 * command and its Enter can never interleave with another writer.
 */
export type HerdrPaneSendInputParams = {
  pane_id: string;
  text: string;
  keys?: string[];
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
  body?: string | null;
  sound?: HerdrNotificationSound | null;
  position?: HerdrToastPosition | null;
};

export type HerdrNotificationShowResult = {
  type: "notification_show";
  shown: boolean;
  reason: string;
};
