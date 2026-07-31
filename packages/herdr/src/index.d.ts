// Hand-written public type surface for @smithers-orchestrator/herdr. Keep in
// sync with the runtime exports in src/index.js and the JSDoc-referenced type
// files (HerdrClientOptions.ts, HerdrProtocol.ts). This package is not covered
// by scripts/check-dts.mjs, so drift is not machine-checked.

// ── protocol constant + error ────────────────────────────────────────────────

/** Herdr socket wire-protocol version this client targets (herdr 0.7.3). */
export const HERDR_PROTOCOL: 16;

/** Error thrown by `HerdrClient.call()` on failure (error frame, timeout, absent socket, early close). */
export class HerdrError extends Error {
	constructor(message: string, info?: { method?: string; code?: string; cause?: unknown });
	name: "HerdrError";
	method?: string;
	code?: string;
	cause?: unknown;
}

// ── client options + surface ─────────────────────────────────────────────────

export type HerdrLogLevel = "warn" | "debug";
export type HerdrLogger = (level: HerdrLogLevel, message: string, data?: unknown) => void;

export type HerdrClientOptions = {
	socketPath?: string;
	session?: string;
	callTimeoutMs?: number;
	logger?: HerdrLogger;
};

export type HerdrPingOptions = {
	requireProtocolMatch?: boolean;
};

export type HerdrEvent = {
	event: string;
	type: string;
	data: Record<string, unknown>;
};

export type HerdrSubscription = {
	type: string;
	[key: string]: unknown;
};

export type HerdrSubscriptionHandle = {
	close(): void;
};

export type HerdrClient = {
	socketPath: string;
	call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
	tryCall<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T | undefined>;
	subscribe(subscriptions: HerdrSubscription[], onEvent: (event: HerdrEvent) => void): HerdrSubscriptionHandle;
	ping(options?: HerdrPingOptions): Promise<HerdrPong | undefined>;
};

export function createHerdrClient(opts?: HerdrClientOptions): HerdrClient;

/** Normalize a herdr event name to its dotted namespace form (`workspace_created` -> `workspace.created`). */
export function normalizeHerdrEventName(name: string): string;

/** Resolve the herdr control-socket path (socketPath > session > HERDR_SOCKET_PATH > HERDR_SESSION > default). */
export function resolveSocketPath(opts?: { socketPath?: string; session?: string }, env?: NodeJS.ProcessEnv): string;

/** The control-socket path for a named herdr session. */
export function sessionSocketPath(name: string, env?: NodeJS.ProcessEnv): string;

// ── run surface + hijack pane ────────────────────────────────────────────────

/** The `AgentEvent.event` payload, structurally (carries the session `resume` pointer). */
export type AgentCliEventLike = {
	type?: string;
	engine?: string;
	resume?: string | null;
	[key: string]: unknown;
};

/** The structural slice of a `SmithersEvent` the run surface reads (a real `SmithersEvent` is assignable). */
export type SmithersEventLike = {
	type: string;
	runId?: string;
	nodeId?: string;
	iteration?: number;
	attempt?: number;
	error?: unknown;
	event?: AgentCliEventLike;
	request?: { title?: string; summary?: string; [key: string]: unknown };
	failedChildren?: number;
	timestampMs?: number;
	[key: string]: unknown;
};

export type HerdrRunSurfaceOptions = HerdrClientOptions & {
	client?: HerdrClient | HerdrClientOptions;
	workspaceLabel?: string;
	cwd?: string;
	tailCommand?: (ctx: { runId: string; nodeId: string }) => string[];
	/**
	 * Resolves the argv for a parked APPROVAL GATE node's pane, so a gate pane can
	 * run the interactive `approve --watch` loop instead of a read-only tail. Only
	 * pure gate nodes use it; absent, gate panes fall back to `tailCommand`.
	 */
	gateCommand?: (ctx: { runId: string; nodeId: string }) => string[];
	/**
	 * Resolves the argv for the run-level overview pane (the workspace's first tab,
	 * renamed "overview"), invoked once on workspace creation. Defaults to the
	 * whole-run tail `["smithers", "tail", runId, "--linger"]` (no `--node`).
	 */
	overviewCommand?: (ctx: { runId: string }) => string[];
	/**
	 * Adaptive tab budget: the maximum number of tabs INCLUDING the overview tab
	 * (mirrored node tabs cap at `tabCap - 1`). Past the cap an ordinary node gets
	 * no pane; attention promotions (approval gates, `NodeFailed`, hijack panes)
	 * bypass the cap. Default `6`.
	 */
	tabCap?: number;
	/**
	 * Decide whether a node gets a mirrored pane. A boolean is cached (asked once
	 * per node); `undefined` is the "unknown" channel — skipped for this evaluation
	 * but not cached, so the node's next event re-asks.
	 *
	 * BYPASS: `NodeWaitingApproval` / `ApprovalRequested` for a node with no pane
	 * yet override this filter and force the pane, so a parked human approval gate
	 * (which carries no agent attempt row and would otherwise be filtered out) is
	 * always surfaced blocked with its question.
	 */
	nodeFilter?: (ctx: {
		runId: string;
		nodeId: string;
		iteration?: number;
		attempt?: number;
	}) => boolean | undefined | Promise<boolean | undefined>;
	closeWorkspaceOnFinish?: boolean;
	/** Cockpit auto-open matrix (stage soft-pin on, workers off, gates/failures on by default). */
	autoOpen?: {
		stage?: boolean;
		workers?: boolean;
		gates?: boolean;
		failures?: boolean;
	};
	/** Max concurrent soft-pinned non-worker stage tabs. Default `1`. */
	softPinSlots?: number;
	/** Node ids (exact or `*` globs) that always get a detail tab. */
	pin?: string[];
	/** Extra RegExp treated as worker leaves. */
	workerPattern?: RegExp;
	/**
	 * Cockpit chrome: `split` = harness|overview 50/50, `tabs` = full-width overview,
	 * `auto` = dock when HERDR_ENV=1 or split when a harness is available (default).
	 */
	chrome?: "split" | "tabs" | "auto";
	/**
	 * Left-pane harness for path B (spawn). `"auto"` / `true` = first of grok/claude/…
	 * on PATH; `string[]` = explicit argv; `"none"` / `false` = no spawn.
	 */
	harnessCommand?: string[] | "auto" | "none" | false | true | string;
	/**
	 * Dock into the operator's focused herdr pane (path A / ops flow).
	 * Also enabled by `HERDR_ENV=1` or `SMITHERS_HERDR_DOCK=1`.
	 */
	dock?: boolean;
	/**
	 * When docking, rename the workspace to the run label. Default false so
	 * operator-owned workspaces keep a stable name.
	 */
	renameWorkspaceOnDock?: boolean;
};

export type HerdrRunSurface = {
	onEvent(event: SmithersEventLike): void;
	attach(runId: string): Promise<void>;
	/**
	 * Mark an already-bound node as a human approval gate so its terminal
	 * resolution reports "approved" (not "done"). Used on resume, when the fresh
	 * surface that resumes a parked run adopts the gate's pane via `attach()` and
	 * re-flags it so the pane moves blocked -> approved rather than staying stuck
	 * blocked. No-op once closed or before a run id is bound.
	 */
	markApprovalGate(nodeId: string): void;
	workspaceId(): Promise<string | undefined>;
	close(): Promise<void>;
};

export type HijackLaunchSpec = {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
};

export type HijackPaneContext = {
	runId: string;
	nodeId: string;
	workspaceId?: string;
	source?: string;
	focus?: boolean;
};

export type HijackPaneResult = {
	paneId: string;
	workspaceId: string | undefined;
	/** The herdr agent name the pane was launched under (`smithers:<runId>:hijack:<nodeId>`). */
	name: string;
};

/** Mirror one Smithers run into a herdr workspace, one pane per agent node; soft/degradable throughout. */
export function createHerdrRunSurface(opts?: HerdrRunSurfaceOptions): HerdrRunSurface;

/**
 * The Smithers event types {@link createHerdrRunSurface}'s `onEvent` maps to a
 * pane action — the single source of truth for pre-filtering an event stream
 * before feeding the surface (skip every other row, chiefly `NodeOutput`).
 */
export const HERDR_SURFACE_EVENT_TYPES: ReadonlySet<string>;

/** Launch an interactive hijack pane in a herdr workspace; soft-fails to `undefined`. */
export function launchHijackPane(
	client: HerdrClient,
	spec: HijackLaunchSpec,
	ctx: HijackPaneContext,
): Promise<HijackPaneResult | undefined>;

/** First 8 chars of a run id (the repo's `shortRunId` convention). */
export function shortRunId(runId: string): string;

/** The herdr tab label for a node: the node id, truncated (with an ellipsis) only when it exceeds 40 chars. */
export function shortNodeId(nodeId: string): string;

/**
 * Place ONE full-size pane in its OWN tab. Idempotent replay adopts only by the
 * authoritative agent name; a label-only match is never reused or closed because
 * it may be an operator-owned tab. Soft — resolves `undefined` on bookkeeping
 * failure and may reject when `agent.start` cannot be recovered by adoption.
 */
export function openTabPane(
	client: HerdrClient,
	opts: {
		workspaceId?: string;
		label: string;
		name: string;
		argv: string[];
		cwd?: string;
		env?: Record<string, string>;
		focus?: boolean;
	},
): Promise<{ tabId: string; paneId: string; workspaceId: string | undefined } | undefined>;

/**
 * Outcome markers prepended to a run's workspace label on a terminal state
 * (finished `✓`, failed `✗`, cancelled `◻`) while keeping the run id in the label.
 */
export const OUTCOME_MARKERS: Readonly<Record<"finished" | "failed" | "cancelled", string>>;

/** The outcome marker glyph for a terminal run kind, or `undefined` for a non-terminal kind. */
export function outcomeMarkerFor(kind: string): string | undefined;

/** Strip a single leading outcome marker (`<glyph> `) off a workspace label; a label without one is returned unchanged. */
export function stripOutcomeMarker(label: string): string;

/**
 * Whether a candidate workspace label identifies the run whose deterministic
 * label is `targetLabel` (and, when known, whose id is `runId`), tolerant of the
 * terminal-state outcome-marker prefix — so a renamed workspace is still found
 * (and re-adopted, not duplicated) by a later `up --herdr` / `herdr attach`.
 */
export function workspaceLabelMatches(candidateLabel: string, targetLabel: string, runId?: string): boolean;


// ── cockpit policy / digest / session (presentation helpers) ─────────────────

export const DEFAULT_SOFT_PIN_SLOTS: number;
export function gateTabLabel(nodeId: string): string;
export function isLikelyWorkerNodeId(nodeId: string, extraPattern?: RegExp): boolean;
export function isPinnedNodeId(nodeId: string, pins?: string[]): boolean;
export function resolveAutoOpenPolicy(autoOpen?: {
	stage?: boolean;
	workers?: boolean;
	gates?: boolean;
	failures?: boolean;
}): { stage: boolean; workers: boolean; gates: boolean; failures: boolean };
export function resolveSoftPinSlots(opts?: { softPinSlots?: number }): number;
export function shouldAutoOpenDetailTab(
	ctx: {
		nodeId: string;
		reason: "stage" | "gate" | "failure" | "pin" | "open" | "ordinary";
		isWorker?: boolean;
		softPinnedNodeIds?: string[];
	},
	policy?: {
		autoOpen?: { stage?: boolean; workers?: boolean; gates?: boolean; failures?: boolean };
		softPinSlots?: number;
		pin?: string[];
		workerPattern?: RegExp;
	},
): boolean;
export function updateSoftPinSet(
	softPins: Set<string>,
	event: { nodeId: string; action: "start" | "end"; isWorker?: boolean },
	policy?: {
		autoOpen?: { stage?: boolean; workers?: boolean; gates?: boolean; failures?: boolean };
		softPinSlots?: number;
		pin?: string[];
		workerPattern?: RegExp;
	},
): Set<string>;

export const DEFAULT_DIGEST_INTERVAL_MS: number;
export function formatElapsed(ms: number | undefined): string;
export function formatClockHm(nowMs: number): string;
export function buildFleetStrip(
	runs: Array<{ runId: string; status?: string; label?: string; blocked?: number; working?: number }>,
	focusedRunId?: string,
): string;
export function buildDigestBlock(input: {
	runId: string;
	status?: string;
	elapsedMs?: number;
	working?: number;
	blocked?: number;
	failed?: number;
	done?: number;
	activeNodeIds?: string[];
	attentionLines?: string[];
	queuedSteerCount?: number;
	lastEventSummary?: string;
	nowMs?: number;
}): string;
export function digestSignature(input: {
	runId: string;
	status?: string;
	elapsedMs?: number;
	working?: number;
	blocked?: number;
	failed?: number;
	done?: number;
	activeNodeIds?: string[];
	attentionLines?: string[];
	queuedSteerCount?: number;
	lastEventSummary?: string;
	nowMs?: number;
}): string;

export function defaultSessionNameForRun(runId: string): string;
export function stubWorkspaceLabel(workflowId: string, runId: string, sessionName: string): string;
export function isStubWorkspaceLabel(label: string): boolean;
export function sessionAttachHint(opts: { sessionName: string; runId: string }): string;

// ── protocol method params/results (herdr protocol 16) ───────────────────────

export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";
export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type HerdrReadSource = "visible" | "recent" | "recent_unwrapped" | "detection";
export type HerdrReadFormat = "text" | "ansi";
export type HerdrSplitDirection = "right" | "down";
export type HerdrToastPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type HerdrNotificationSound = "none" | "done" | "request";

export type HerdrOutputMatch = {
	type: "substring" | "regex";
	value: string;
};

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

export type HerdrWorkspaceRenameParams = {
	workspace_id: string;
	label: string;
};

export type HerdrWorkspaceRenameResult = {
	type: "workspace_renamed";
	workspace: HerdrWorkspaceInfo;
};

export type HerdrWorkspaceListResult = {
	type: "workspace_list";
	workspaces: HerdrWorkspaceInfo[];
};

export type HerdrOkResult = {
	type: "ok";
};

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

export type HerdrPaneListParams = {
	workspace_id?: string;
};

export type HerdrPaneListResult = {
	type: "pane_list";
	panes: HerdrPaneInfo[];
};

export type HerdrPaneReportAgentParams = {
	pane_id: string;
	source: string;
	agent: string;
	state: HerdrAgentState;
	message?: string;
	custom_status?: string;
	agent_session_id?: string;
	agent_session_path?: string;
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
