/**
 * Typed request params and result shapes for the herdr socket methods Smithers
 * uses (protocol 16, hand-written from `herdr api schema --json`). Unknown
 * extra fields are tolerated everywhere: the client parses responses as loose
 * records and only these documented fields are relied upon.
 */
/** `pane.report_agent` accepts only these four states (no `done`). */
type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";
/** Status herdr reports back on panes/workspaces (a superset of {@link HerdrAgentState}). */
type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
/** Which slice of a pane's buffer to read. `recent` is scrollback (empty for young panes). */
type HerdrReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";
/** Read output format. */
type HerdrReadFormat = "text" | "ansi";
/** Direction to split when launching an agent into an existing workspace/tab. */
type HerdrSplitDirection = "right" | "down";
/** Toast corner for `notification.show`. */
type HerdrToastPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
/** Sound for `notification.show`. */
type HerdrNotificationSound = "none" | "done" | "request";
/** Substring/regex matcher for `pane.wait_for_output`. */
type HerdrOutputMatch = {
    type: "substring" | "regex";
    value: string;
};
type HerdrServerCapabilities = {
    live_handoff: boolean;
    detached_server_daemon?: boolean;
};
type HerdrPong = {
    type: "pong";
    version: string;
    protocol: number;
    capabilities?: HerdrServerCapabilities | null;
};
type HerdrWorkspaceInfo = {
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
type HerdrTabInfo = {
    tab_id: string;
    workspace_id: string;
    number: number;
    label: string;
    focused: boolean;
    pane_count: number;
    agent_status: HerdrAgentStatus;
};
type HerdrPaneInfo = {
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
type HerdrAgentInfo = HerdrPaneInfo & {
    name?: string | null;
    screen_detection_skipped?: boolean;
};
type HerdrPaneReadResult = {
    pane_id: string;
    workspace_id: string;
    tab_id: string;
    source: HerdrReadSource;
    format: HerdrReadFormat;
    text: string;
    revision: number;
    truncated: boolean;
};
type HerdrWorkspaceCreateParams = {
    label?: string;
    cwd?: string;
    env?: Record<string, string>;
    focus?: boolean;
};
type HerdrWorkspaceCreateResult = {
    type: "workspace_created";
    workspace: HerdrWorkspaceInfo;
    tab: HerdrTabInfo;
    root_pane: HerdrPaneInfo;
};
type HerdrWorkspaceCloseParams = {
    workspace_id: string;
};
/** `workspace.rename`: set a workspace's sidebar label (used to flag a run's terminal outcome). */
type HerdrWorkspaceRenameParams = {
    workspace_id: string;
    label: string;
};
/** Result of `workspace.rename` (the renamed workspace record). */
type HerdrWorkspaceRenameResult = {
    type: "workspace_renamed";
    workspace: HerdrWorkspaceInfo;
};
type HerdrWorkspaceListResult = {
    type: "workspace_list";
    workspaces: HerdrWorkspaceInfo[];
};
/** Generic acknowledgement returned by mutating methods (e.g. `workspace.close`). */
type HerdrOkResult = {
    type: "ok";
};
type HerdrAgentStartParams = {
    name: string;
    argv: string[];
    workspace_id?: string;
    tab_id?: string;
    split?: HerdrSplitDirection;
    cwd?: string;
    env?: Record<string, string>;
    focus?: boolean;
};
type HerdrAgentStartResult = {
    type: "agent_started";
    agent: HerdrAgentInfo;
    argv: string[];
};
type HerdrAgentListResult = {
    type: "agent_list";
    agents: HerdrAgentInfo[];
};
type HerdrPaneListParams = {
    workspace_id?: string;
};
type HerdrPaneListResult = {
    type: "pane_list";
    panes: HerdrPaneInfo[];
};
type HerdrPaneReportAgentParams = {
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
type HerdrPaneReportAgentSessionParams = {
    pane_id: string;
    source: string;
    agent: string;
    agent_session_id?: string;
    agent_session_path?: string;
    session_start_source?: string;
    seq?: number;
};
type HerdrPaneReleaseAgentParams = {
    pane_id: string;
    source: string;
    agent: string;
    seq?: number;
};
type HerdrPaneReportMetadataParams = {
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
type HerdrPaneReadParams = {
    pane_id: string;
    source: HerdrReadSource;
    lines?: number;
    format?: HerdrReadFormat;
    strip_ansi?: boolean;
};
type HerdrPaneReadResultEnvelope = {
    type: "pane_read";
    read: HerdrPaneReadResult;
};
type HerdrPaneWaitForOutputParams = {
    pane_id: string;
    source: HerdrReadSource;
    match: HerdrOutputMatch;
    timeout_ms?: number;
    lines?: number;
    strip_ansi?: boolean;
};
type HerdrPaneWaitForOutputResult = {
    type: "output_matched";
    pane_id: string;
    revision: number;
    matched_line?: string | null;
    read: HerdrPaneReadResult;
};
type HerdrNotificationShowParams = {
    title: string;
    body?: string;
    sound?: HerdrNotificationSound;
    position?: HerdrToastPosition;
};
type HerdrNotificationShowResult = {
    type: "notification_show";
    shown: boolean;
    reason: string;
};

/** Severity passed to a {@link HerdrLogger}. */
type HerdrLogLevel = "warn" | "debug";
/**
 * Sink for the client's diagnostics. `"warn"` covers soft failures (a
 * `tryCall()` that failed, a protocol mismatch); `"debug"` covers noisy
 * internals (a dropped subscribe frame, a subscribe-socket reconnect). The
 * default logger prints `"warn"` to `console.warn` and drops `"debug"`.
 */
type HerdrLogger = (level: HerdrLogLevel, message: string, data?: unknown) => void;
/** Options for {@link createHerdrClient}. */
type HerdrClientOptions = {
    /** Explicit socket path; wins over every other resolution input. */
    socketPath?: string;
    /** Named herdr session whose socket to use (below `socketPath`). */
    session?: string;
    /** Per-call timeout in milliseconds. Defaults to `5000`. */
    callTimeoutMs?: number;
    /** Diagnostics sink. Defaults to a `console.warn`-backed logger. */
    logger?: HerdrLogger;
};
/** Compatibility policy for {@link HerdrClient.ping}. */
type HerdrPingOptions = {
    /** Reject with `HerdrError(code="protocol_mismatch")` when the server protocol differs. */
    requireProtocolMatch?: boolean;
};
/**
 * A herdr event delivered to a {@link HerdrClient.subscribe} consumer. `event`
 * is the raw name as received (herdr emits snake_case kinds like
 * `workspace_created`, though some — e.g. `pane.agent_status_changed` — arrive
 * dotted); `type` is the normalized dotted form so consumers can match
 * tolerantly; `data` is the event payload as a loose record.
 */
type HerdrEvent = {
    event: string;
    type: string;
    data: Record<string, unknown>;
};
/**
 * A single subscription filter, e.g. `{ type: "workspace.created" }` or a
 * per-pane filter `{ type: "pane.agent_status_changed", pane_id }`. Extra keys
 * are forwarded verbatim to herdr.
 */
type HerdrSubscription = {
    type: string;
    [key: string]: unknown;
};
/** Handle returned by {@link HerdrClient.subscribe}. */
type HerdrSubscriptionHandle = {
    /** Stop reconnecting and destroy the underlying socket. Idempotent. */
    close(): void;
};
/**
 * A herdr socket client. Each `call()`/`tryCall()` uses its own short-lived
 * connection (herdr serves one request per connection); `subscribe()` holds a
 * dedicated long-lived connection that auto-reconnects.
 */
type HerdrClient = {
    /** The resolved control-socket path this client connects to. */
    socketPath: string;
    /**
     * Perform one herdr RPC. Rejects with a `HerdrError` on an error frame
     * (including empty-id protocol errors), a per-call timeout, an absent
     * socket, or a connection that closes before responding.
     */
    call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
    /** Like {@link HerdrClient.call} but soft-fails: logs a warning and resolves `undefined`. */
    tryCall<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T | undefined>;
    /**
     * Open a long-lived subscription. The first frame is the
     * `subscription_started` ack (not delivered); subsequent event frames are
     * delivered to `onEvent`. The connection auto-reconnects with capped
     * exponential backoff and resubscribes on reconnect.
     */
    subscribe(subscriptions: HerdrSubscription[], onEvent: (event: HerdrEvent) => void): HerdrSubscriptionHandle;
    /**
     * Ping the server. Transport failures remain soft (`undefined`). A protocol
     * mismatch warns by default, or rejects when `requireProtocolMatch` is true.
     */
    ping(options?: HerdrPingOptions): Promise<HerdrPong | undefined>;
};

export type { HerdrPingOptions as A, HerdrPong as B, HerdrReadFormat as C, HerdrReadSource as D, HerdrServerCapabilities as E, HerdrSplitDirection as F, HerdrSubscription as G, HerdrAgentInfo as H, HerdrSubscriptionHandle as I, HerdrTabInfo as J, HerdrWorkspaceCloseParams as K, HerdrWorkspaceCreateParams as L, HerdrWorkspaceCreateResult as M, HerdrWorkspaceInfo as N, HerdrWorkspaceListResult as O, HerdrWorkspaceRenameParams as P, HerdrWorkspaceRenameResult as Q, HerdrAgentListResult as a, HerdrAgentStartParams as b, HerdrAgentStartResult as c, HerdrAgentState as d, HerdrAgentStatus as e, HerdrClient as f, HerdrClientOptions as g, HerdrEvent as h, HerdrLogLevel as i, HerdrLogger as j, HerdrNotificationShowParams as k, HerdrNotificationShowResult as l, HerdrOkResult as m, HerdrOutputMatch as n, HerdrPaneInfo as o, HerdrPaneListParams as p, HerdrPaneListResult as q, HerdrPaneReadParams as r, HerdrPaneReadResult as s, HerdrPaneReadResultEnvelope as t, HerdrPaneReleaseAgentParams as u, HerdrPaneReportAgentParams as v, HerdrPaneReportAgentSessionParams as w, HerdrPaneReportMetadataParams as x, HerdrPaneWaitForOutputParams as y, HerdrPaneWaitForOutputResult as z };
