import { g as HerdrClientOptions, f as HerdrClient$1, j as HerdrLogger$1 } from './HerdrClientOptions-BtuPmN3E.js';

/**
 * Type surface for the herdr run mirror: {@link createHerdrRunSurface} (mirrors a
 * Smithers run into a herdr workspace, one pane per agent node) and
 * {@link launchHijackPane} (opens an interactive hijack pane). Hand-written from
 * the integration spec; the runtime lives in `createHerdrRunSurface.js`.
 *
 * `onEvent` is typed against a local structural {@link SmithersEventLike} rather
 * than importing the observability `SmithersEvent` union, so this package stays
 * dependency-free (a `SmithersEvent` value is still assignable to it). Only the
 * fields the mapping actually reads are named.
 */

/**
 * The `AgentEvent.event` payload, structurally. The session resume pointer is
 * `resume` (present on the `started`/`completed` agent-CLI variants).
 */
type AgentCliEventLike = {
    type?: string;
    engine?: string;
    /** Engine-specific resume/session id used for `pane.report_agent_session`. */
    resume?: string | null;
    [key: string]: unknown;
};
/**
 * The structural slice of a `SmithersEvent` the run surface consumes. A real
 * observability `SmithersEvent` is assignable to this (every field it reads is
 * optional here and the index signature tolerates the rest).
 */
type SmithersEventLike$1 = {
    type: string;
    runId?: string;
    nodeId?: string;
    iteration?: number;
    attempt?: number;
    /** Error payload on `NodeFailed` (summarized into the blocked message). */
    error?: unknown;
    /** Agent-CLI payload on `AgentEvent`. */
    event?: AgentCliEventLike;
    /**
     * Parsed approval request carried by `ApprovalRequested` / `NodeWaitingApproval`
     * at runtime (the typed `SmithersEvent` union omits it). `title`/`summary`
     * become the blocked-pane message.
     */
    request?: {
        title?: string;
        summary?: string;
        [key: string]: unknown;
    };
    /** Tolerated-failure count on `RunFinished` (picks the finish notification sound). */
    failedChildren?: number;
    timestampMs?: number;
    [key: string]: unknown;
};
/** Options for {@link createHerdrRunSurface}. Also accepts {@link HerdrClientOptions} fields to build a client. */
type HerdrRunSurfaceOptions$1 = HerdrClientOptions & {
    /** An existing client, or client options to build one; else options above are used. */
    client?: HerdrClient$1 | HerdrClientOptions;
    /** Workspace label used for find-or-create. Defaults to `smithers <runId>` (FULL run id). */
    workspaceLabel?: string;
    /** Working directory for a newly created workspace. */
    cwd?: string;
    /**
     * Resolves the argv for a node's tail pane, invoked lazily per pane. Defaults
     * to `["smithers", "tail", runId, "--node", nodeId, "--linger"]`.
     */
    tailCommand?: (ctx: {
        runId: string;
        nodeId: string;
    }) => string[];
    /**
     * Resolves the argv for a parked APPROVAL GATE node's pane, invoked lazily when
     * a pure gate node first gets a pane. Lets a gate pane run the interactive
     * `approve --watch` loop (the human answers in-pane) instead of a read-only
     * tail. Only pure gate nodes use it — an agent node that hits a mid-flight gate
     * keeps its existing tail pane. Absent, gate panes fall back to `tailCommand`.
     */
    gateCommand?: (ctx: {
        runId: string;
        nodeId: string;
    }) => string[];
    /**
     * Resolves the argv for the run-level overview pane (the workspace's first tab,
     * renamed "overview"), invoked once on workspace creation. Defaults to the
     * whole-run tail `["smithers", "tail", runId, "--linger"]` (no `--node`).
     */
    overviewCommand?: (ctx: {
        runId: string;
    }) => string[];
    /**
     * Adaptive tab budget: the maximum number of tabs INCLUDING the cockpit tab
     * (so mirrored node tabs cap at `tabCap - 1`). Past the cap an ordinary node
     * gets no pane; attention promotions (parked approval gates, `NodeFailed`,
     * hijack panes) always bypass the cap. Default `6`.
     */
    tabCap?: number;
    /**
     * Decide whether a node is eligible to mirror at all (agent vs compute). A
     * boolean decision is cached (asked once per node): `true` mirrors, `false`
     * (or a throw, which soft-fails and warns once) permanently skips the pane.
     * `undefined` is the "unknown" channel. Default: mirror every node.
     *
     * Cockpit soft-pin / worker policy is applied *after* this filter for ordinary
     * nodes. BYPASS: gates and failures set `capExempt` and force the pane.
     */
    nodeFilter?: (ctx: {
        runId: string;
        nodeId: string;
        iteration?: number;
        attempt?: number;
    }) => boolean | undefined | Promise<boolean | undefined>;
    /** Close the herdr workspace when the run finishes / on `close()`. Default `false`. */
    closeWorkspaceOnFinish?: boolean;
    /**
     * Cockpit auto-open matrix. Defaults: stage soft-pin on, workers off, gates
     * and failures on.
     */
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
    /** Extra RegExp treated as worker leaves (board-only unless pinned). */
    workerPattern?: RegExp;
    /**
     * Cockpit chrome: `split` = harness|overview 50/50, `tabs` = full-width overview,
     * `auto` = dock when HERDR_ENV=1 or split when a harness is available (default).
     */
    chrome?: "split" | "tabs" | "auto";
    /**
     * Left-pane harness for path B (spawn). `"auto"` / `true` = first of grok/claude/…
     * on PATH; `string[]` = explicit argv; `"none"` / `false` = no spawn; env
     * `SMITHERS_HERDR_HARNESS` overrides.
     */
    harnessCommand?: string[] | "auto" | "none" | false | true | string;
    /**
     * Dock into the operator's focused herdr pane (path A / ops flow).
     * Also enabled by `HERDR_ENV=1` or `SMITHERS_HERDR_DOCK=1`.
     * Keeps left shell for the human harness; overview HUD on the right.
     */
    dock?: boolean;
    /**
     * When docking, rename the workspace to the run label. Default false so
     * operator-owned workspaces (e.g. "smithers-ops") keep a stable name.
     */
    renameWorkspaceOnDock?: boolean;
};
/** A live mirror of one Smithers run into a herdr workspace. */
type HerdrRunSurface$1 = {
    /** Feed a Smithers event. Synchronous entry; work is queued internally and never throws. */
    onEvent(event: SmithersEventLike$1): void;
    /** Bind a run id and reconcile against existing herdr state (find-or-create workspace, adopt panes). */
    attach(runId: string): Promise<void>;
    /**
     * Mark an already-bound node as a human approval gate so its terminal
     * resolution reports "approved" (not "done"). Used on resume: `smithers up`
     * exits when it parks at a gate, so the fresh surface that resumes the run
     * adopts the parked pane via `attach()` and calls this to re-flag the gate,
     * moving the pane blocked -> approved instead of leaving it stuck blocked.
     * No-op once closed or before a run id is bound.
     */
    markApprovalGate(nodeId: string): void;
    /** Resolve this run's herdr workspace id (find-or-create); `undefined` if unbound / herdr unreachable. */
    workspaceId(): Promise<string | undefined>;
    /** Detach: drain queued work (bounded by `2×callTimeoutMs`); closes the workspace only when `closeWorkspaceOnFinish`. */
    close(): Promise<void>;
};
/** An interactive launch spec (mirror of the CLI's `HijackLaunchSpec`). */
type HijackLaunchSpec$1 = {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
};
/** Context for {@link launchHijackPane}: the run/node the hijack targets and the workspace to host it. */
type HijackPaneContext$1 = {
    runId: string;
    nodeId: string;
    /** The run workspace to launch the pane in; omitted lets herdr choose. */
    workspaceId?: string;
    /** `pane.report_agent` source. Defaults to `"smithers"`. */
    source?: string;
    /** Focus the pane on launch. Defaults to `true`. */
    focus?: boolean;
};
/** Result of a successful {@link launchHijackPane}. */
type HijackPaneResult$1 = {
    paneId: string;
    workspaceId: string | undefined;
    /** The herdr agent name the pane was launched under (`smithers:<runId>:hijack:<nodeId>`). */
    name: string;
};

/**
 * The outcome marker for a terminal run kind (or `undefined` for a non-terminal
 * kind), for callers that render the same finished/failed/cancelled signal.
 *
 * @param {string} kind
 * @returns {string | undefined}
 */
declare function outcomeMarkerFor(kind: string): string | undefined;
/**
 * Strip a single leading outcome marker (glyph + one space) off a workspace
 * label, so a renamed terminal workspace normalizes back to its original
 * find-or-create label. A label without a marker is returned unchanged. The
 * inverse never double-strips: only ONE leading `<marker> ` is removed.
 *
 * @param {string} label
 * @returns {string}
 */
declare function stripOutcomeMarker(label: string): string;
/**
 * Whether a candidate workspace label identifies the run whose deterministic
 * find-or-create label is `targetLabel`.
 * Tolerant of the terminal-state OUTCOME MARKER prefix: a workspace renamed
 * `✓ <label>` / `✗ <label>` / `◻ <label>` must still be found (and re-adopted,
 * not duplicated) by a later `up --herdr` / `herdr attach`. The normalized
 * labels must otherwise be exactly equal: a matching run-id-like suffix alone
 * never grants Smithers ownership of an operator-created workspace.
 *
 * @param {string} candidateLabel
 * @param {string} targetLabel
 * @returns {boolean}
 */
declare function workspaceLabelMatches(candidateLabel: string, targetLabel: string): boolean;
/**
 * First 8 chars of a run id (the repo's `shortRunId` convention). DISPLAY-ONLY:
 * it is NOT an identity — the CLI's default run ids (`run-<Date.now()>`) share
 * their first 8 chars for an ~11.6-day window, so pane/workspace/agent names and
 * every find-or-create key use the FULL run id. Keep this for humans only.
 *
 * @param {string} runId
 * @returns {string}
 */
declare function shortRunId(runId: string): string;
/**
 * The tab label for a node's mirror tab: the node id, truncated (with an ellipsis)
 * only when it exceeds {@link MAX_TAB_LABEL_LEN} so the herdr tab bar stays legible.
 * DISPLAY-ONLY, but also the tab find-or-create key — so it is kept collision-safe
 * for the common case by preserving the FULL node id whenever it is short (real
 * Smithers node ids are human-readable slugs like `implement` / `ship-approval`,
 * which are unique per run and never truncated). Pane/agent identity is always the
 * full node id via the agent name (`smithers:<runId>:<nodeId>`), so replay/attach
 * idempotency never depends on this label.
 *
 * @param {string} nodeId
 * @returns {string}
 */
declare function shortNodeId(nodeId: string): string;
/**
 * Open ONE full-size pane in its OWN tab: adopt by the authoritative agent name,
 * or create a new tab and start the command into it, then close that new tab's
 * seeded shell so the agent pane fills the tab. Labels are presentation only:
 * an operator-owned tab may have the same label, so it is never reused or closed.
 * Idempotent replay/attach is keyed exclusively by the full agent name. Soft
 * throughout — returns
 * `undefined` on any failure (dead socket, breaker open, no tab).
 *
 * `tab.create` goes through `client.call` (so a breaker-wrapped client observes
 * its failures); the claim/run/bookkeeping calls use `tryCall` (pure best-effort).
 *
 * `workspaceId` may be omitted (herdr targets the focused workspace); the resolved
 * workspace id is returned alongside the tab/pane.
 *
 * Exported so on-demand consumers (e.g. the CLI's `smithers herdr open`) can place
 * a node/overview pane into a run's workspace with the SAME find-or-create/adopt
 * semantics the live surface uses — reuse the smithers naming convention
 * (`smithers:<runId>:<nodeId>` name, {@link shortNodeId} label) so a pane opened
 * on demand adopts the surface's existing pane instead of duplicating it.
 *
 * `seq` orders the identity claim inside the CALLER's per-pane report sequence.
 * herdr drops any authority report whose seq is `<=` the last one it recorded
 * for the source, so a claim stamped out of band (a raw `Date.now()` against a
 * caller counter seeded earlier) would silently swallow every status push that
 * follows it. Callers with a running counter must pass their next value.
 *
 * @param {HerdrClient} client
 * @param {{ workspaceId?: string, label: string, name: string, argv: string[], cwd?: string, env?: Record<string, string>, focus?: boolean, seq?: number }} opts
 * @returns {Promise<{ tabId: string, paneId: string, workspaceId: string | undefined } | undefined>}
 */
declare function openTabPane(client: HerdrClient, opts: {
    workspaceId?: string;
    label: string;
    name: string;
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    focus?: boolean;
    seq?: number;
}): Promise<{
    tabId: string;
    paneId: string;
    workspaceId: string | undefined;
} | undefined>;
/**
 * Create a herdr run surface: mirror one Smithers run into a herdr workspace,
 * pushing authoritative status from the event stream. The workspace's first tab
 * becomes the run-level "overview" (a whole-run tail); each mirrored node then
 * gets its OWN tab (label = short node id) holding ONE full-size pane, subject to
 * an adaptive cap (`tabCap`, default 6 tabs incl. overview) — past the cap an
 * ordinary node gets no pane, but attention promotions (parked approval gates,
 * failed nodes, hijack panes) always bypass the cap. Loop iterations reuse their
 * node's tab. Every herdr interaction is soft (fire-and-forget); a dead or absent
 * herdr never throws, blocks, or rejects. A consecutive-timeout circuit breaker drops
 * pushes fast once herdr stops responding, and `close()` has a bounded drain
 * deadline, so a hung herdr can never slow host shutdown beyond `2×callTimeoutMs`.
 *
 * The default logger prints soft-failure warnings to `console.warn`; a CLI
 * consumer should INJECT a `logger` (e.g. one writing to stderr / a debug log)
 * so mirror warnings do not pollute command output.
 *
 * @param {HerdrRunSurfaceOptions} [opts]
 * @returns {HerdrRunSurface}
 */
declare function createHerdrRunSurface(opts?: HerdrRunSurfaceOptions): HerdrRunSurface;
/**
 * Launch an interactive hijack pane in a herdr workspace: open ONE full-size pane
 * in its OWN tab running the hijack launch spec, mark it `blocked` ("hijacked -
 * attach to drive"), and notify. The hijack tab is cap-exempt (it always gets a
 * tab) and — uniquely among the surface's panes — FOCUSED by default, so the
 * operator's screen jumps to the interactive session they just launched. Its tab
 * label is distinct from the node's mirror tab so a hijack never splits into it.
 * Idempotent for a re-launch: the existing hijack pane is adopted by its full
 * agent name, not by its presentation label. Fully soft: returns `undefined` on any
 * failure (dead socket, etc.) and never throws.
 *
 * @param {HerdrClient} client
 * @param {HijackLaunchSpec} spec
 * @param {HijackPaneContext} ctx
 * @returns {Promise<HijackPaneResult | undefined>}
 */
declare function launchHijackPane(client: HerdrClient, spec: HijackLaunchSpec, ctx: HijackPaneContext): Promise<HijackPaneResult | undefined>;
/**
 * Outcome markers prepended to a run's workspace label when the run reaches a
 * terminal state, so the herdr sidebar shows at a glance whether a finished run
 * succeeded, failed, or was cancelled — WITHOUT dropping the run id from the
 * label (find-or-create/attach still resolve the workspace by run id, see
 * {@link workspaceLabelMatches}). Check-mark = finished, ballot-x = failed,
 * white square = cancelled.
 *
 * @type {Readonly<Record<"finished" | "failed" | "cancelled", string>>}
 */
declare const OUTCOME_MARKERS: Readonly<Record<"finished" | "failed" | "cancelled", string>>;
/**
 * The Smithers event types the surface's {@link createHerdrRunSurface} `onEvent`
 * maps to a herdr pane action — every other row (chiefly the high-volume
 * `NodeOutput` stream) is inert. Exported as the SINGLE source of truth so a
 * consumer that pre-filters an event stream before feeding the surface (e.g. the
 * CLI's attach follow loop, which skips non-mapped rows BEFORE parsing their
 * payload) never keeps a private, drift-prone copy. A parity test pins this set
 * to the `onEvent` switch cases so the two can never diverge.
 *
 * @type {ReadonlySet<string>}
 */
declare const HERDR_SURFACE_EVENT_TYPES: ReadonlySet<string>;
type HerdrClient = HerdrClient$1;
type HerdrLogger = HerdrLogger$1;
type HerdrRunSurfaceOptions = HerdrRunSurfaceOptions$1;
type HerdrRunSurface = HerdrRunSurface$1;
type SmithersEventLike = SmithersEventLike$1;
type HijackLaunchSpec = HijackLaunchSpec$1;
type HijackPaneContext = HijackPaneContext$1;
type HijackPaneResult = HijackPaneResult$1;

export { type AgentCliEventLike as A, type HerdrRunSurface$1 as H, OUTCOME_MARKERS as O, type SmithersEventLike$1 as S, type HerdrRunSurfaceOptions$1 as a, type HijackLaunchSpec$1 as b, type HijackPaneContext$1 as c, type HijackPaneResult$1 as d, HERDR_SURFACE_EVENT_TYPES as e, createHerdrRunSurface as f, outcomeMarkerFor as g, shortRunId as h, stripOutcomeMarker as i, type HerdrClient as j, type HerdrLogger as k, launchHijackPane as l, type HerdrRunSurface as m, type HerdrRunSurfaceOptions as n, openTabPane as o, type HijackLaunchSpec as p, type HijackPaneContext as q, type HijackPaneResult as r, shortNodeId as s, type SmithersEventLike as t, workspaceLabelMatches as w };
