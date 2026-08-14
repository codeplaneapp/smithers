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

import type { HerdrClient, HerdrClientOptions } from "./HerdrClientOptions.ts";

/**
 * The `AgentEvent.event` payload, structurally. The session resume pointer is
 * `resume` (present on the `started`/`completed` agent-CLI variants).
 */
export type AgentCliEventLike = {
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
export type SmithersEventLike = {
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
  request?: { title?: string; summary?: string; [key: string]: unknown };
  /** Tolerated-failure count on `RunFinished` (picks the finish notification sound). */
  failedChildren?: number;
  timestampMs?: number;
  [key: string]: unknown;
};

/** Options for {@link createHerdrRunSurface}. Also accepts {@link HerdrClientOptions} fields to build a client. */
export type HerdrRunSurfaceOptions = HerdrClientOptions & {
  /** An existing client, or client options to build one; else options above are used. */
  client?: HerdrClient | HerdrClientOptions;
  /** Workspace label used for find-or-create. Defaults to `smithers <runId>` (FULL run id). */
  workspaceLabel?: string;
  /** Working directory for a newly created workspace. */
  cwd?: string;
  /**
   * Resolves the argv for a node's tail pane, invoked lazily per pane. Defaults
   * to `["smithers", "tail", runId, "--node", nodeId, "--linger"]`.
   */
  tailCommand?: (ctx: { runId: string; nodeId: string }) => string[];
  /**
   * Resolves the argv for a parked APPROVAL GATE node's pane, invoked lazily when
   * a pure gate node first gets a pane. Lets a gate pane run the interactive
   * `approve --watch` loop (the human answers in-pane) instead of a read-only
   * tail. Only pure gate nodes use it — an agent node that hits a mid-flight gate
   * keeps its existing tail pane. Absent, gate panes fall back to `tailCommand`.
   */
  gateCommand?: (ctx: { runId: string; nodeId: string }) => string[];
  /**
   * Resolves the argv for the run-level overview pane (the workspace's first tab,
   * renamed "overview"), invoked once on workspace creation. Defaults to the
   * whole-run tail `["smithers", "tail", runId, "--linger"]` (no `--node`).
   */
  overviewCommand?: (ctx: { runId: string }) => string[];
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
export type HerdrRunSurface = {
  /** Feed a Smithers event. Synchronous entry; work is queued internally and never throws. */
  onEvent(event: SmithersEventLike): void;
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
export type HijackLaunchSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

/** Context for {@link launchHijackPane}: the run/node the hijack targets and the workspace to host it. */
export type HijackPaneContext = {
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
export type HijackPaneResult = {
  paneId: string;
  workspaceId: string | undefined;
  /** The herdr agent name the pane was launched under (`smithers:<runId>:hijack:<nodeId>`). */
  name: string;
};
