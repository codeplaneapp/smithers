import { createHerdrClient } from "./createHerdrClient.js";
import { HERDR_PROTOCOL } from "./HERDR_PROTOCOL.js";
import {
  gateTabLabel,
  isLikelyWorkerNodeId,
  isPinnedNodeId,
  shouldAutoOpenDetailTab,
  updateSoftPinSet,
} from "./cockpitPolicy.js";
import {
  detectHarnessCommand,
  resolveHarnessCommand,
  shouldDockIntoCurrentPane,
  shouldSplitCockpit,
} from "./cockpitLayout.js";

/** @typedef {import("./HerdrClientOptions.ts").HerdrClient} HerdrClient */
/** @typedef {import("./HerdrClientOptions.ts").HerdrLogger} HerdrLogger */
/** @typedef {import("./HerdrRunSurface.ts").HerdrRunSurfaceOptions} HerdrRunSurfaceOptions */
/** @typedef {import("./HerdrRunSurface.ts").HerdrRunSurface} HerdrRunSurface */
/** @typedef {import("./HerdrRunSurface.ts").SmithersEventLike} SmithersEventLike */
/** @typedef {import("./HerdrRunSurface.ts").HijackLaunchSpec} HijackLaunchSpec */
/** @typedef {import("./HerdrRunSurface.ts").HijackPaneContext} HijackPaneContext */
/** @typedef {import("./HerdrRunSurface.ts").HijackPaneResult} HijackPaneResult */

/** The `source` tag all authoritative Smithers reports carry (herdr keys authority by it). */
const SOURCE = "smithers";

/** Per-call timeout used to size the circuit-breaker cooldown and `close()` drain deadline. */
const DEFAULT_CALL_TIMEOUT_MS = 5000;

/** Consecutive timeout-class failures that trip the circuit breaker. */
const BREAKER_THRESHOLD = 3;

/** Minimum wait before a memoized workspace failure is retried (avoids hammering a down herdr). */
const WORKSPACE_RETRY_INTERVAL_MS = 5000;

/**
 * In-flight workspace acquisitions shared by surface instances in this process.
 * herdr exposes list/create but no server-side idempotency key or compare-and-set,
 * so this closes the same-process check-then-create race. The critical section
 * still re-lists and reconciles after create for independently racing processes.
 * @type {Map<string, Promise<string | undefined>>}
 */
const workspaceCreationBarriers = new Map();

/**
 * Coalesce one same-run workspace acquisition across surface instances. Entries
 * live only while the acquisition is in flight; later callers re-list server
 * state instead of retaining process-global workspace state forever.
 *
 * @param {string} key
 * @param {() => Promise<string | undefined>} acquire
 * @returns {Promise<string | undefined>}
 */
function withWorkspaceCreationBarrier(key, acquire) {
  const pending = workspaceCreationBarriers.get(key);
  if (pending) {
    return pending;
  }
  const attempt = Promise.resolve().then(acquire);
  workspaceCreationBarriers.set(key, attempt);
  void attempt
    .finally(() => {
      if (workspaceCreationBarriers.get(key) === attempt) {
        workspaceCreationBarriers.delete(key);
      }
    })
    .catch(() => undefined);
  return attempt;
}

/** Default tab budget for the adaptive cap — the cockpit tab plus mirrored node tabs. */
const DEFAULT_TAB_CAP = 6;

/** Longest tab label we set for a node; longer node ids are truncated for the tab bar. */
const MAX_TAB_LABEL_LEN = 40;

/**
 * The label the workspace's first tab is renamed to (cockpit = control plane;
 * when not docking a harness it still holds the overview board alone).
 */
const COCKPIT_TAB_LABEL = "cockpit";

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
export const OUTCOME_MARKERS = Object.freeze({ finished: "✓", failed: "✗", cancelled: "◻" });

/** The set of outcome-marker glyphs, for stripping a marker off a label. */
const OUTCOME_MARKER_SET = new Set(Object.values(OUTCOME_MARKERS));

/**
 * The outcome marker for a terminal run kind (or `undefined` for a non-terminal
 * kind), for callers that render the same finished/failed/cancelled signal.
 *
 * @param {string} kind
 * @returns {string | undefined}
 */
export function outcomeMarkerFor(kind) {
  return /** @type {any} */ (OUTCOME_MARKERS)[kind];
}

/**
 * Strip a single leading outcome marker (glyph + one space) off a workspace
 * label, so a renamed terminal workspace normalizes back to its original
 * find-or-create label. A label without a marker is returned unchanged. The
 * inverse never double-strips: only ONE leading `<marker> ` is removed.
 *
 * @param {string} label
 * @returns {string}
 */
export function stripOutcomeMarker(label) {
  if (typeof label !== "string") {
    return label;
  }
  const sp = label.indexOf(" ");
  if (sp > 0 && OUTCOME_MARKER_SET.has(label.slice(0, sp))) {
    return label.slice(sp + 1);
  }
  return label;
}

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
export function workspaceLabelMatches(candidateLabel, targetLabel) {
  if (typeof candidateLabel !== "string") {
    return false;
  }
  if (candidateLabel === targetLabel) {
    return true;
  }
  const stripped = stripOutcomeMarker(candidateLabel);
  return stripped === targetLabel;
}

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
export const HERDR_SURFACE_EVENT_TYPES = Object.freeze(
  new Set([
    "RunStarted",
    "RunFinished",
    "RunFailed",
    "RunCancelled",
    "NodeStarted",
    "NodeRetrying",
    "NodeFinished",
    "NodeFailed",
    "NodeCancelled",
    "NodeWaitingApproval",
    "ApprovalRequested",
    "ApprovalGranted",
    "ApprovalAutoApproved",
    "AgentEvent",
  ]),
);

/**
 * First 8 chars of a run id (the repo's `shortRunId` convention). DISPLAY-ONLY:
 * it is NOT an identity — the CLI's default run ids (`run-<Date.now()>`) share
 * their first 8 chars for an ~11.6-day window, so pane/workspace/agent names and
 * every find-or-create key use the FULL run id. Keep this for humans only.
 *
 * @param {string} runId
 * @returns {string}
 */
export function shortRunId(runId) {
  if (typeof runId !== "string") {
    return "";
  }
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

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
export function shortNodeId(nodeId) {
  if (typeof nodeId !== "string") {
    return "";
  }
  if (nodeId.length <= MAX_TAB_LABEL_LEN) {
    return nodeId;
  }
  return `${nodeId.slice(0, MAX_TAB_LABEL_LEN - 1)}…`;
}

/**
 * Join an argv into a single POSIX-shell command line, single-quoting any token
 * that is not already a bare "safe" word. Used to type an overview command into
 * the run's root shell via `pane.send_text` (herdr's `pane run` semantics).
 *
 * @param {string[]} argv
 * @returns {string}
 */
function shellQuoteArgv(argv) {
  return argv
    .map((arg) => {
      const s = String(arg);
      if (s !== "" && /^[A-Za-z0-9_/:=@%+,.-]+$/.test(s)) {
        return s;
      }
      return `'${s.replace(/'/g, "'\\''")}'`;
    })
    .join(" ");
}

/**
 * @param {HerdrLogger | undefined} logger
 * @returns {HerdrLogger}
 */
function makeLogger(logger) {
  if (logger) {
    return logger;
  }
  return (level, message, data) => {
    if (level !== "warn") {
      return;
    }
    if (data === undefined) {
      console.warn(`[herdr] ${message}`);
    } else {
      console.warn(`[herdr] ${message}`, data);
    }
  };
}

/**
 * Resolve the client from surface options: an explicit `HerdrClient`, a
 * `HerdrClientOptions` under `client`, or the top-level options themselves.
 *
 * @param {HerdrRunSurfaceOptions} opts
 * @returns {HerdrClient}
 */
function resolveClient(opts) {
  const c = opts.client;
  if (
    c &&
    typeof (/** @type {any} */ (c).call) === "function" &&
    typeof (/** @type {any} */ (c).tryCall) === "function"
  ) {
    return /** @type {HerdrClient} */ (c);
  }
  if (c && typeof c === "object") {
    return createHerdrClient(/** @type {any} */ (c));
  }
  return createHerdrClient(opts);
}

/**
 * Condense an unknown error into a short single-line summary for a blocked
 * pane message.
 *
 * @param {unknown} error
 * @returns {string}
 */
function summarizeError(error) {
  /** @param {string} s */
  const clip = (s) => (s.length > 200 ? `${s.slice(0, 197)}...` : s);
  if (error == null) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return clip(error);
  }
  if (typeof error === "object") {
    const message = /** @type {{ message?: unknown }} */ (error).message;
    if (typeof message === "string" && message !== "") {
      return clip(message);
    }
    try {
      return clip(JSON.stringify(error));
    } catch {
      return "unknown error";
    }
  }
  return clip(String(error));
}

/**
 * Pull the human-facing question text out of an approval event. The typed
 * `SmithersEvent` union omits it, but at runtime both `ApprovalRequested` and
 * `NodeWaitingApproval` carry a parsed `request` object (`title` defaults to the
 * node label, `summary` from `meta.requestSummary`). Read it structurally.
 *
 * @param {SmithersEventLike} event
 * @returns {string}
 */
function approvalMessage(event) {
  const req = event.request;
  if (req && typeof req === "object") {
    const title = /** @type {{ title?: unknown }} */ (req).title;
    if (typeof title === "string" && title !== "") {
      return title;
    }
    const summary = /** @type {{ summary?: unknown }} */ (req).summary;
    if (typeof summary === "string" && summary !== "") {
      return summary;
    }
  }
  return "waiting for approval";
}

/**
 * Find an existing herdr pane by its agent name via `agent.list` (never by
 * parsing ids out of an `agent_name_taken` error string). A workspace-scoped
 * match wins; failing that we fall back to an UNSCOPED (name-only) match. That
 * fallback is safe because the agent name embeds the full run identity, so a
 * label change between attaches (which moves the pane to a different workspace)
 * must not permanently block re-binding. Soft: returns `undefined` when herdr is
 * unreachable.
 *
 * @param {HerdrClient} client
 * @param {string} name
 * @param {string} [workspaceId]
 * @returns {Promise<{ paneId: string, tabId: string | undefined, workspaceId: string | undefined } | undefined>}
 */
async function adoptPaneByName(client, name, workspaceId) {
  const list = /** @type {{ agents?: any[] } | undefined} */ (await client.tryCall("agent.list", {}));
  const agents = list && Array.isArray(list.agents) ? list.agents : [];
  /** @type {{ paneId: string, tabId: string | undefined, workspaceId: string | undefined } | undefined} */
  let unscoped;
  for (const agent of agents) {
    if (!agent || agent.name !== name) {
      continue;
    }
    const paneId = typeof agent.pane_id === "string" ? agent.pane_id : undefined;
    if (paneId === undefined) {
      continue;
    }
    const found = {
      paneId,
      tabId: typeof agent.tab_id === "string" ? agent.tab_id : undefined,
      workspaceId: typeof agent.workspace_id === "string" ? agent.workspace_id : undefined,
    };
    if (workspaceId != null && agent.workspace_id === workspaceId) {
      return found;
    }
    if (unscoped === undefined) {
      unscoped = found;
    }
  }
  return unscoped;
}

/**
 * Close every pane in `tabId` that is not `keepPaneId`. A freshly created tab
 * always seeds a plain root shell pane; `agent.start {tab_id}` then SPLITS that
 * shell (herdr's default) rather than replacing it, leaving the tab with two panes
 * (the seed + the agent). Closing the seed collapses the agent pane back to the
 * full tab area — the "one full-size pane per tab" the layout design wants. Soft:
 * on replay the seed is already gone, so `pane.list` shows only the agent pane and
 * this is a no-op. Never throws.
 *
 * @param {HerdrClient} client
 * @param {string | undefined} workspaceId
 * @param {string} tabId
 * @param {string} keepPaneId
 * @returns {Promise<void>}
 */
async function closeSeedPanes(client, workspaceId, tabId, keepPaneId) {
  /** @type {Record<string, unknown>} */
  const listParams = {};
  if (workspaceId) {
    listParams.workspace_id = workspaceId;
  }
  const res = /** @type {{ panes?: any[] } | undefined} */ (await client.tryCall("pane.list", listParams));
  const panes = res && Array.isArray(res.panes) ? res.panes : [];
  for (const pane of panes) {
    if (pane && pane.tab_id === tabId && typeof pane.pane_id === "string" && pane.pane_id !== keepPaneId) {
      await client.tryCall("pane.close", { pane_id: pane.pane_id });
    }
  }
}

/**
 * Open ONE full-size pane in its OWN tab: adopt by the authoritative agent name,
 * or create a new tab and start the command into it, then close that new tab's
 * seeded shell so the agent pane fills the tab. Labels are presentation only:
 * an operator-owned tab may have the same label, so it is never reused or closed.
 * Idempotent replay/attach is keyed exclusively by the full agent name. Soft
 * throughout — returns
 * `undefined` on any failure (dead socket, breaker open, no tab).
 *
 * `agent.start` goes through `client.call` (so a breaker-wrapped client observes
 * its failures); the tab/pane bookkeeping uses `tryCall` (pure best-effort).
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
 * @param {HerdrClient} client
 * @param {{ workspaceId?: string, label: string, name: string, argv: string[], cwd?: string, env?: Record<string, string>, focus?: boolean }} opts
 * @returns {Promise<{ tabId: string, paneId: string, workspaceId: string | undefined } | undefined>}
 */
export async function openTabPane(client, opts) {
  /** @type {string | undefined} */
  let workspaceId = opts.workspaceId;
  /** @type {string | undefined} */
  let lastError;

  // Prefer an already-running pane with this agent name (herdr mirror / prior open).
  // Avoids agent_name_taken races and duplicate tails while a run is live.
  const existing = await adoptPaneByName(client, opts.name, workspaceId);
  if (existing) {
    if (opts.focus === true) {
      await client.tryCall("pane.focus", { pane_id: existing.paneId });
    }
    return {
      tabId: existing.tabId,
      paneId: existing.paneId,
      workspaceId: existing.workspaceId ?? workspaceId,
    };
  }

  /** @type {string | undefined} */
  let tabId;
  /** @type {Record<string, unknown>} */
  const createParams = { label: opts.label, focus: false };
  if (opts.workspaceId) {
    createParams.workspace_id = opts.workspaceId;
  }
  try {
    const created = /** @type {{ tab?: { tab_id?: string, workspace_id?: string } } | undefined} */ (
      await client.tryCall("tab.create", createParams)
    );
    tabId = created && created.tab && typeof created.tab.tab_id === "string" ? created.tab.tab_id : undefined;
    if (created && created.tab && typeof created.tab.workspace_id === "string") {
      workspaceId = created.tab.workspace_id;
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
  if (!tabId) {
    return undefined;
  }
  /** @type {string | undefined} */
  let paneId;
  try {
    /** @type {Record<string, unknown>} */
    const startParams = { name: opts.name, argv: opts.argv, tab_id: tabId, focus: opts.focus === true };
    if (workspaceId) {
      startParams.workspace_id = workspaceId;
    }
    if (opts.cwd) {
      startParams.cwd = opts.cwd;
    }
    if (opts.env) {
      startParams.env = opts.env;
    }
    const res = /** @type {{ agent?: { pane_id?: string, workspace_id?: string } }} */ (
      await client.call("agent.start", startParams)
    );
    paneId = res && res.agent ? res.agent.pane_id : undefined;
    if (res && res.agent && typeof res.agent.workspace_id === "string") {
      workspaceId = res.agent.workspace_id;
    }
  } catch (err) {
    // agent_name_taken (replay/attach) or any failure: adopt the existing pane.
    lastError = err instanceof Error ? err.message : String(err);
    let adopted = await adoptPaneByName(client, opts.name, workspaceId);
    // Brief retry — agent.list can lag agent.start on a busy herdr.
    if (!adopted) {
      await new Promise((r) => setTimeout(r, 80));
      adopted = await adoptPaneByName(client, opts.name, workspaceId);
    }
    if (adopted) {
      paneId = adopted.paneId;
      workspaceId = adopted.workspaceId ?? workspaceId;
      // Another caller won the agent-name race in a different tab. This tab was
      // created by THIS invocation, so it is safe to clean up; no label-found or
      // operator-owned resource is ever closed.
      if (adopted.tabId && adopted.tabId !== tabId) {
        await client.tryCall("tab.close", { tab_id: tabId });
        tabId = adopted.tabId;
      }
    }
  }
  if (!paneId) {
    const adopted = await adoptPaneByName(client, opts.name, workspaceId);
    if (adopted) {
      paneId = adopted.paneId;
      workspaceId = adopted.workspaceId ?? workspaceId;
      if (adopted.tabId && adopted.tabId !== tabId) {
        await client.tryCall("tab.close", { tab_id: tabId });
        tabId = adopted.tabId;
      }
    }
  }
  if (typeof paneId !== "string") {
    // The tab ID came directly from this invocation's tab.create response.
    await client.tryCall("tab.close", { tab_id: tabId });
    if (lastError) {
      /** @type {any} */
      const fail = new Error(lastError);
      fail.code = "herdr_open_failed";
      throw fail;
    }
    return undefined;
  }
  await closeSeedPanes(client, workspaceId, tabId, paneId);
  return { tabId, paneId, workspaceId };
}

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
export function createHerdrRunSurface(opts = {}) {
  const rawClient = resolveClient(opts);
  const log = makeLogger(opts.logger);
  const callTimeoutMs =
    typeof opts.callTimeoutMs === "number" && opts.callTimeoutMs > 0 ? opts.callTimeoutMs : DEFAULT_CALL_TIMEOUT_MS;
  const closeWorkspaceOnFinish = opts.closeWorkspaceOnFinish === true;
  // A mirrored pane passes `--linger` so it stays open on a terminal state (the
  // human can come back and read what happened) instead of exiting the moment the
  // run finishes and letting herdr tear the pane down. A plain interactive
  // `smithers tail` keeps the default exit-on-terminal behavior.
  const defaultTail = (/** @type {{ runId: string, nodeId: string }} */ ctx) => [
    "smithers",
    "tail",
    ctx.runId,
    "--node",
    ctx.nodeId,
    "--linger",
  ];
  // The overview (tab 1) pane tails the WHOLE run (no `--node`) so the human sees
  // the run-level event stream at a glance. Default mirrors `defaultTail` but drops
  // `--node`; the CLI wires a checkout-aware builder in a later stage. `--linger`
  // keeps it open on a terminal run state.
  const defaultOverview = (/** @type {{ runId: string }} */ ctx) => ["smithers", "tail", ctx.runId, "--linger"];
  // Adaptive cap: the total tab budget INCLUDING the overview tab. Past the cap a
  // new ordinary node gets no pane (it stays unpaned) — attention promotions
  // (approval gates, NodeFailed, hijack panes) bypass the cap and always get a tab.
  const tabCap = typeof opts.tabCap === "number" && opts.tabCap > 0 ? Math.floor(opts.tabCap) : DEFAULT_TAB_CAP;
  // One slot is reserved for the cockpit tab, so mirrored NODE tabs cap at tabCap-1.
  const nodeTabBudget = Math.max(0, tabCap - 1);
  /** Cockpit auto-open / soft-pin policy (see cockpitPolicy.js). */
  const cockpitPolicy = {
    autoOpen: opts.autoOpen,
    softPinSlots: opts.softPinSlots,
    pin: opts.pin,
    workerPattern: opts.workerPattern,
  };
  /** @type {Set<string>} in-progress soft-pinned stage node ids */
  const softPins = new Set();

  // ── circuit breaker over the client ───────────────────────────────────────
  // A herdr that accepts connections but never answers would cost each queued
  // task up to N×callTimeoutMs on the global FIFO. After BREAKER_THRESHOLD
  // consecutive timeout-class failures we open the breaker: calls short-circuit
  // (call throws immediately, tryCall returns undefined) until a cooldown lets a
  // single probe through. A responsive round-trip (even an error frame like
  // `agent_name_taken`) counts as healthy and resets the counter.
  const breakerCooldownMs = callTimeoutMs * 2;
  let consecutiveTimeouts = 0;
  let breakerOpenSinceMs = 0;

  /** @param {unknown} err */
  function isTimeoutClass(err) {
    if (!err || typeof err !== "object") {
      return false;
    }
    const code = /** @type {{ code?: unknown }} */ (err).code;
    return (
      code === "timeout" ||
      code === "closed" ||
      code === "socket_error" ||
      code === "ENOENT" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "EPIPE"
    );
  }
  function breakerAllows() {
    if (breakerOpenSinceMs === 0) {
      return true;
    }
    // Half-open: after the cooldown, let one probe through.
    return Date.now() - breakerOpenSinceMs >= breakerCooldownMs;
  }
  function noteResponsive() {
    consecutiveTimeouts = 0;
    if (breakerOpenSinceMs !== 0) {
      breakerOpenSinceMs = 0;
      log("debug", "herdr responsive again; breaker closed");
    }
  }
  function noteTimeout() {
    consecutiveTimeouts += 1;
    if (breakerOpenSinceMs === 0) {
      if (consecutiveTimeouts >= BREAKER_THRESHOLD) {
        breakerOpenSinceMs = Date.now();
        log("warn", `herdr unresponsive after ${consecutiveTimeouts} consecutive timeouts; pausing mirror pushes`);
      }
    } else {
      // A failed half-open probe: re-arm the cooldown window.
      breakerOpenSinceMs = Date.now();
    }
  }
  /** @param {unknown} err */
  function recordOutcome(err) {
    if (err && isTimeoutClass(err)) {
      noteTimeout();
    } else {
      noteResponsive();
    }
  }

  // The surface reimplements tryCall over the raw client's `call` so the breaker
  // can observe failures (the raw tryCall swallows them). Callers keep using
  // `call`/`tryCall` unchanged.
  const client = /** @type {HerdrClient} */ ({
    socketPath: rawClient.socketPath,
    /**
     * @param {string} method
     * @param {Record<string, unknown>} [params]
     */
    async call(method, params) {
      if (!breakerAllows()) {
        throw new Error(`herdr breaker open; skipping ${method}`);
      }
      try {
        const r = await rawClient.call(method, params);
        recordOutcome(undefined);
        return r;
      } catch (err) {
        recordOutcome(err);
        throw err;
      }
    },
    /**
     * @param {string} method
     * @param {Record<string, unknown>} [params]
     */
    async tryCall(method, params) {
      if (!breakerAllows()) {
        return undefined;
      }
      try {
        const r = await rawClient.call(method, params);
        recordOutcome(undefined);
        return r;
      } catch (err) {
        recordOutcome(err);
        log("warn", `herdr ${method} failed (soft): ${err instanceof Error ? err.message : String(err)}`, err);
        return undefined;
      }
    },
  });

  /** @type {string | null} */
  let runId = null;
  let closed = false;

  /**
   * Per-node pane state. Key = nodeId; one pane, reused across attempts. `seq`
   * is seeded from `Date.now()` (not 0) so a fresh surface incarnation re-attaching
   * to an existing pane always issues a HIGHER seq than the previous incarnation's
   * high-water mark — herdr silently drops stale-or-equal-seq reports, so without
   * the seed a re-attach mirror would be permanently frozen.
   *
   * `approvalGate` marks a node whose pane was force-created to surface a parked
   * human approval gate (see the `NodeWaitingApproval` handler) — such a node
   * resolves to idle "approved" rather than the "working"/"done" an ordinary
   * agent node reports.
   *
   * `tabLabel` is the node's herdr tab label (short node id). `capExempt` marks a
   * node whose pane must be created regardless of the adaptive tab cap (a parked
   * approval gate, a failed node promoted from unpaned, a hijack) — it also
   * bypasses `nodeFilter`. `unpaned` records that the node was deliberately denied
   * a pane by the cap (so a later attention promotion is a genuine state change,
   * not a duplicate creation).
   *
   * @typedef {{ runId: string, nodeId: string, iteration?: number, attempt?: number }} NodeCtx
   * @typedef {{ nodeId: string, name: string, tabLabel: string, paneId: string | undefined, seq: number, lastState: string | null, ctx: NodeCtx, mirror: boolean | undefined, filterWarned: boolean, approvalGate: boolean, capExempt: boolean, unpaned: boolean }} NodeEntry
   * @type {Map<string, NodeEntry>}
   */
  const nodes = new Map();

  // ── internal serial queue ────────────────────────────────────────────────
  // A single FIFO chain: onEvent maps an event to queued tasks synchronously,
  // tasks run in arrival order (so per-pane order is preserved), and every link
  // swallows so nothing ever rejects.
  /** @type {Promise<void>} */
  let tail = Promise.resolve();
  /** @type {Set<Promise<void>>} */
  const pending = new Set();

  /**
   * @param {() => Promise<void> | void} task
   * @returns {Promise<void>}
   */
  function enqueue(task) {
    const guarded = tail
      .then(() => task())
      .catch((err) => {
        log("debug", "herdr surface task failed (soft)", err);
      });
    tail = guarded;
    pending.add(guarded);
    guarded.finally(() => pending.delete(guarded));
    return guarded;
  }

  /**
   * @param {string | undefined} id
   */
  function setRunId(id) {
    if (runId || typeof id !== "string" || id === "") {
      return;
    }
    runId = id;
  }

  function resolveLabel() {
    if (opts.workspaceLabel) {
      return opts.workspaceLabel;
    }
    return `smithers ${runId}`;
  }

  /**
   * @param {string} nodeId
   * @returns {NodeEntry}
   */
  function getEntry(nodeId) {
    let entry = nodes.get(nodeId);
    if (!entry) {
      entry = {
        nodeId,
        name: `${SOURCE}:${runId}:${nodeId}`,
        tabLabel: shortNodeId(nodeId),
        paneId: undefined,
        seq: Date.now(),
        lastState: null,
        ctx: { runId: /** @type {string} */ (runId), nodeId },
        mirror: undefined,
        filterWarned: false,
        approvalGate: false,
        capExempt: false,
        unpaned: false,
      };
      nodes.set(nodeId, entry);
    }
    return entry;
  }

  /**
   * Get (or create) a node entry and refresh its filter context from `event`.
   *
   * @param {SmithersEventLike} event
   * @param {string} nodeId
   * @returns {NodeEntry}
   */
  function touchNode(event, nodeId) {
    const entry = getEntry(nodeId);
    entry.ctx = {
      runId: /** @type {string} */ (runId),
      nodeId,
      iteration: typeof event.iteration === "number" ? event.iteration : undefined,
      attempt: typeof event.attempt === "number" ? event.attempt : undefined,
    };
    return entry;
  }

  /**
   * Evaluate the optional `nodeFilter` for a node. A boolean decision is CACHED
   * (asked once per node): `true` mirrors, `false` permanently skips the pane.
   * `undefined` is the "unknown" channel — the filter could not decide this time
   * (e.g. a transient read it soft-handled): the pane is skipped for THIS
   * evaluation but the result is NOT cached, so the node's next event re-asks
   * (without an unknown channel a transient failure would freeze the pane off
   * forever). A throwing filter is a hard skip: it warns once for that node and
   * caches `false` (like an explicit `false`). Default = mirror.
   *
   * @param {NodeEntry} entry
   * @returns {Promise<boolean>}
   */
  async function shouldMirror(entry) {
    if (!opts.nodeFilter) {
      return true;
    }
    if (entry.mirror !== undefined) {
      return entry.mirror;
    }
    /** @type {boolean | undefined} */
    let decision;
    try {
      decision = await opts.nodeFilter(entry.ctx);
    } catch (err) {
      if (!entry.filterWarned) {
        entry.filterWarned = true;
        log("warn", `herdr nodeFilter threw for node ${entry.nodeId}; skipping pane`, err);
      }
      entry.mirror = false;
      return false;
    }
    if (decision === undefined) {
      // Unknown: skip this evaluation WITHOUT caching so the next event re-asks.
      return false;
    }
    entry.mirror = decision !== false;
    return entry.mirror;
  }

  /**
   * How many mirrored NODE tabs currently hold a pane. The adaptive cap compares
   * this against {@link nodeTabBudget}. Counted from the in-memory node map (the
   * surface is the single writer and its tasks run serially, so the count is exact
   * at decision time) — no per-pane RPC. The overview tab is not a node and is not
   * counted here (its slot is already reserved by `nodeTabBudget = tabCap - 1`).
   *
   * @returns {number}
   */
  function panedNodeCount() {
    let n = 0;
    for (const entry of nodes.values()) {
      if (entry.paneId) {
        n += 1;
      }
    }
    return n;
  }

  /**
   * Type argv into a pane as a shell command line + newline (herdr pane-run
   * semantics). Soft: never throws.
   *
   * @param {string} paneId
   * @param {string[]} argv
   */
  async function sendCommandToPane(paneId, argv) {
    if (typeof paneId !== "string" || !Array.isArray(argv) || argv.length === 0) {
      return;
    }
    await client.tryCall("pane.send_text", {
      pane_id: paneId,
      text: `${shellQuoteArgv(argv)}\n`,
    });
  }

  /**
   * Resolve overview argv for the bound run.
   * @returns {string[] | undefined}
   */
  function resolveOverviewArgv() {
    const overviewFn = opts.overviewCommand ?? defaultOverview;
    try {
      const argv = overviewFn({ runId: /** @type {string} */ (runId) });
      return Array.isArray(argv) && argv.length > 0 ? argv : undefined;
    } catch (err) {
      log("debug", "herdr overviewCommand threw", err);
      return undefined;
    }
  }

  /**
   * Resolve harness argv for path B (spawn).
   * @returns {string[] | null}
   */
  function resolveHarnessArgvForSetup() {
    const raw = opts.harnessCommand;
    if (raw === false || raw === "none" || raw === "off") {
      return null;
    }
    if (Array.isArray(raw)) {
      return raw.length > 0 ? raw.map(String) : null;
    }
    if (raw === "auto" || raw === true) {
      return detectHarnessCommand();
    }
    if (typeof raw === "string") {
      return resolveHarnessCommand({ harnessCommand: raw });
    }
    // undefined: auto-detect only when chrome explicitly wants a split
    if (opts.chrome === "split") {
      return detectHarnessCommand();
    }
    return null;
  }

  /**
   * Cockpit setup (product freeze):
   * - Always rename tab 1 → "cockpit".
   * - Path A (dock): HERDR_ENV=1 — left pane is the existing harness; split right for overview.
   * - Path B (spawn): new workspace — optional harness CLI on left, overview on right (~50/50).
   * - Fallback: full-width overview in the root shell (workspace survival via shell, not
   *   replaced agent pane — same load-bearing reason as the pre-split overview).
   *
   * Soft/best-effort throughout. Runs ONCE on workspace create (or dock adopt).
   *
   * @param {string} tabId
   * @param {string | undefined} rootPaneId
   * @param {{ dock?: boolean }} [mode]
   * @returns {Promise<void>}
   */
  /**
   * If the tab is already a vertical split (operator pre-split), return the
   * leftmost pane (harness) and rightmost pane (overview target).
   * @param {string} tabId
   * @param {string} preferredLeftId
   * @returns {Promise<{ leftId: string, rightId: string | undefined, alreadySplit: boolean }>}
   */
  async function resolveCockpitPanes(tabId, preferredLeftId) {
    const list = /** @type {{ panes?: Array<{ pane_id?: string, tab_id?: string }> } | undefined} */ (
      await client.tryCall("pane.list", {})
    );
    const onTab = (list?.panes ?? []).filter((p) => p && p.tab_id === tabId && typeof p.pane_id === "string");
    if (onTab.length >= 2) {
      // Prefer geometry: leftmost x = harness, rightmost = overview.
      const layout =
        /** @type {{ layout?: { panes?: Array<{ pane_id?: string, rect?: { x?: number } }> } } | undefined} */ (
          await client.tryCall("pane.layout", { pane_id: preferredLeftId })
        );
      const geo = layout?.layout?.panes;
      if (Array.isArray(geo) && geo.length >= 2) {
        const sorted = [...geo]
          .filter((p) => typeof p.pane_id === "string")
          .sort((a, b) => (a.rect?.x ?? 0) - (b.rect?.x ?? 0));
        const leftId = sorted[0]?.pane_id ?? preferredLeftId;
        const rightId = sorted[sorted.length - 1]?.pane_id;
        if (leftId && rightId && leftId !== rightId) {
          return { leftId, rightId, alreadySplit: true };
        }
      }
      // Fallback: list order — first vs last on tab.
      const leftId = onTab[0]?.pane_id ?? preferredLeftId;
      const rightId = onTab[onTab.length - 1]?.pane_id;
      if (leftId && rightId && leftId !== rightId) {
        return { leftId, rightId, alreadySplit: true };
      }
    }
    return { leftId: preferredLeftId, rightId: undefined, alreadySplit: false };
  }

  async function setupCockpit(tabId, rootPaneId, mode = {}) {
    const overviewArgv = resolveOverviewArgv();
    await client.tryCall("tab.rename", { tab_id: tabId, label: COCKPIT_TAB_LABEL });
    if (!overviewArgv || typeof rootPaneId !== "string") {
      return;
    }

    const dock = mode.dock === true;
    const chrome = opts.chrome === "split" || opts.chrome === "tabs" || opts.chrome === "auto" ? opts.chrome : "auto";
    // Operator dock: never auto-spawn a harness on the left — human owns that pane.
    const harnessArgv = dock ? null : resolveHarnessArgvForSetup();
    const wantSplit = shouldSplitCockpit(
      { chrome, harnessCommand: dock ? "none" : opts.harnessCommand },
      { dock, harnessArgv },
    );

    if (!wantSplit || chrome === "tabs") {
      // Full-width overview (tabs chrome / no harness / machine stubs).
      await sendCommandToPane(rootPaneId, overviewArgv);
      return;
    }

    // Path B: spawn harness on the left (root shell) when not docking.
    if (!dock && harnessArgv && harnessArgv.length > 0) {
      await sendCommandToPane(rootPaneId, harnessArgv);
      log("debug", `cockpit harness spawn: ${shellQuoteArgv(harnessArgv)}`);
    }

    // Operator already split L|R → put overview on the right pane only.
    const resolved = await resolveCockpitPanes(tabId, rootPaneId);
    /** @type {string | undefined} */
    let rightPaneId = resolved.rightId;

    if (!rightPaneId) {
      // Split right ~50% for overview (left keeps harness / shell).
      const splitRes = /** @type {{ pane?: { pane_id?: string } } | undefined} */ (
        await client.tryCall("pane.split", {
          direction: "right",
          ratio: 0.5,
          target_pane_id: resolved.leftId,
          focus: false,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
        })
      );
      rightPaneId =
        splitRes && splitRes.pane && typeof splitRes.pane.pane_id === "string" ? splitRes.pane.pane_id : undefined;
    }

    if (rightPaneId) {
      // Brief beat so the new shell can paint a prompt before we type.
      await new Promise((r) => setTimeout(r, 150));
      await sendCommandToPane(rightPaneId, overviewArgv);
      log(
        "debug",
        resolved.alreadySplit
          ? "cockpit dock: reuse pre-split right pane for overview HUD"
          : "cockpit split: harness left + overview right",
      );
    } else {
      // Split failed — degrade to full-width overview so the board still appears.
      if (!dock) {
        await sendCommandToPane(rootPaneId, overviewArgv);
      }
      log("warn", "cockpit split failed; overview full-width fallback");
    }
  }

  // ── workspace (memoized find-or-create, retry after transient failure) ─────
  /** @type {Promise<string | undefined> | null} */
  let workspacePromise = null;
  /** @type {string | undefined} */
  let workspaceId;
  let workspaceClosed = false;
  let lastWorkspaceAttemptMs = 0;

  /**
   * Path A: when running inside herdr (HERDR_ENV=1), adopt the current pane's
   * workspace as the run cockpit — rename, split right for overview, leave the
   * live harness on the left. Returns workspace id or undefined.
   * @returns {Promise<string | undefined>}
   */
  async function tryDockIntoHarnessWorkspace() {
    if (!shouldDockIntoCurrentPane({ dock: opts.dock })) {
      return undefined;
    }
    const cur = /** @type {{ pane?: { pane_id?: string, tab_id?: string, workspace_id?: string } } | undefined} */ (
      await client.tryCall("pane.current", {})
    );
    const pane = cur && cur.pane;
    if (
      !pane ||
      typeof pane.pane_id !== "string" ||
      typeof pane.tab_id !== "string" ||
      typeof pane.workspace_id !== "string"
    ) {
      return undefined;
    }
    // Operator-owned workspace: keep their label (e.g. "smithers-ops") unless
    // explicitly asked to rename to the run label (legacy find-or-create key).
    if (opts.renameWorkspaceOnDock === true) {
      await client.tryCall("workspace.rename", {
        workspace_id: pane.workspace_id,
        label: resolveLabel(),
      });
    }
    // Prefer leftmost pane as harness root when already split.
    const resolved = await resolveCockpitPanes(pane.tab_id, pane.pane_id);
    await setupCockpit(pane.tab_id, resolved.leftId, { dock: true });
    log("debug", `cockpit dock: focused pane ${pane.pane_id} (left=${resolved.leftId}) → overview on right`);
    return pane.workspace_id;
  }

  /** @returns {Promise<string | undefined>} */
  function ensureWorkspace() {
    if (workspacePromise) {
      return workspacePromise;
    }
    const now = Date.now();
    if (lastWorkspaceAttemptMs !== 0 && now - lastWorkspaceAttemptMs < WORKSPACE_RETRY_INTERVAL_MS) {
      // A recent attempt failed (resolved undefined); back off before retrying
      // so a down herdr isn't hammered on every event.
      return Promise.resolve(workspaceId);
    }
    lastWorkspaceAttemptMs = now;
    const attempt = (async () => {
      if (!runId) {
        return undefined;
      }
      // A surface is mutation-heavy (workspace/tab/pane creation). Probe an
      // injectable client's strict ping when available and stop before the
      // first mutation on a known protocol mismatch. `undefined` stays soft so
      // legacy test/fake clients and a transiently unavailable daemon retain
      // the existing best-effort behavior; subsequent calls will fail softly.
      if (typeof rawClient.ping === "function") {
        try {
          const pong = await rawClient.ping({ requireProtocolMatch: true });
          // Injected clients may ignore the strict option, so validate the pong
          // as well. Version drift is fine when the wire protocol still matches.
          if (pong && pong.protocol !== HERDR_PROTOCOL) {
            log(
              "warn",
              `herdr protocol mismatch: client expects ${HERDR_PROTOCOL}, server reports ${pong.protocol}; mirror disabled`,
              pong,
            );
            return undefined;
          }
        } catch (error) {
          const code = error && typeof error === "object" ? error.code : undefined;
          if (code === "protocol_mismatch") {
            log("warn", `herdr protocol mismatch; mirror disabled: ${summarizeError(error)}`, error);
            return undefined;
          }
          // Connectivity remains soft and is still handled by the first RPC.
        }
      }
      const label = resolveLabel();
      /** @param {{ workspaces?: any[] } | undefined} result */
      const findExisting = (result) =>
        result && Array.isArray(result.workspaces)
          ? result.workspaces.find((w) => w && typeof w.label === "string" && workspaceLabelMatches(w.label, label))
          : undefined;
      const list = /** @type {{ workspaces?: any[] } | undefined} */ (await client.tryCall("workspace.list", {}));
      const existing = findExisting(list);
      if (existing && typeof existing.workspace_id === "string") {
        workspaceId = existing.workspace_id;
        return workspaceId;
      }

      // Path A: dock into the operator's live harness pane when HERDR_ENV=1.
      const docked = await tryDockIntoHarnessWorkspace();
      if (typeof docked === "string") {
        workspaceId = docked;
        return workspaceId;
      }

      // A second list INSIDE the same-run barrier closes the check-then-create
      // race between surface instances. The server protocol has no idempotency
      // key/CAS, so after creating we list once more and retain the stable oldest
      // matching workspace; this also converges independently racing processes.
      const barrierKey = `${String(client.socketPath)}\0${String(runId)}`;
      workspaceId = await withWorkspaceCreationBarrier(barrierKey, async () => {
        const checked = /** @type {{ workspaces?: any[] } | undefined} */ (await client.tryCall("workspace.list", {}));
        const found = findExisting(checked);
        if (found && typeof found.workspace_id === "string") {
          return found.workspace_id;
        }
        // `tryCall` uses undefined for transport/protocol failure. Never turn an
        // indeterminate list into a create: a timed-out list may have hidden the
        // workspace we are trying to find.
        if (!checked || !Array.isArray(checked.workspaces)) {
          return undefined;
        }

        /** @type {Record<string, unknown>} */
        const params = { label, focus: false };
        if (opts.cwd) {
          params.cwd = opts.cwd;
        }
        const created =
          /** @type {{ workspace?: { workspace_id?: string, number?: number }, tab?: { tab_id?: string }, root_pane?: { pane_id?: string } } | undefined} */ (
            await client.tryCall("workspace.create", params)
          );
        const createdId = created?.workspace?.workspace_id;
        if (typeof createdId !== "string") {
          return undefined;
        }

        const afterCreate = /** @type {{ workspaces?: any[] } | undefined} */ (
          await client.tryCall("workspace.list", {})
        );
        const matching =
          afterCreate && Array.isArray(afterCreate.workspaces)
            ? afterCreate.workspaces
                .filter(
                  (w) =>
                    w &&
                    typeof w.workspace_id === "string" &&
                    typeof w.label === "string" &&
                    workspaceLabelMatches(w.label, label),
                )
                .sort((a, b) => {
                  if (typeof a.number === "number" && typeof b.number === "number" && a.number !== b.number) {
                    return a.number - b.number;
                  }
                  return String(a.workspace_id).localeCompare(String(b.workspace_id));
                })
            : [];
        const winnerId = matching[0]?.workspace_id;
        if (typeof winnerId === "string" && winnerId !== createdId) {
          // Only close the workspace ID returned by THIS callback's create.
          // Label matches alone never grant ownership of another workspace.
          await client.tryCall("workspace.close", { workspace_id: createdId });
          return winnerId;
        }

        // We created (and, when reconciliation was available, won) the workspace,
        // so this callback alone owns one-time cockpit setup.
        const tabId = created?.tab?.tab_id;
        const rootPaneId = created?.root_pane?.pane_id;
        if (typeof tabId === "string") {
          await setupCockpit(tabId, rootPaneId, { dock: false });
        }
        return createdId;
      });
      return workspaceId;
    })().catch(() => undefined);
    workspacePromise = attempt;
    // On failure (undefined) clear the memo so a later event retries (gated by
    // WORKSPACE_RETRY_INTERVAL_MS above); on success keep it memoized forever.
    attempt.then((resolved) => {
      if (workspacePromise === attempt && resolved === undefined) {
        workspacePromise = null;
      }
    });
    return attempt;
  }

  async function closeWorkspaceInner() {
    if (workspaceClosed) {
      return;
    }
    workspaceClosed = true;
    const id = await ensureWorkspace();
    if (!id) {
      return;
    }
    await client.tryCall("workspace.close", { workspace_id: id });
  }

  /**
   * On a terminal run, prepend the outcome marker to the workspace label
   * (`✓`/`✗`/`◻`) while KEEPING the run id in the label, so the herdr sidebar
   * shows the finished/failed/cancelled signal at a glance. Idempotent on replay:
   * the new label is always derived from the clean {@link resolveLabel} (never the
   * current, possibly-already-prefixed workspace label), so re-finalizing never
   * stacks markers. Soft/best-effort; a workspace we could not resolve is skipped.
   *
   * @param {"finished" | "failed" | "cancelled"} kind
   * @returns {Promise<void>}
   */
  async function renameWorkspaceOutcome(kind) {
    const id = await ensureWorkspace();
    if (!id) {
      return;
    }
    const marker = OUTCOME_MARKERS[kind];
    if (!marker) {
      return;
    }
    await client.tryCall("workspace.rename", { workspace_id: id, label: `${marker} ${resolveLabel()}` });
  }

  // ── pane (lazy: own tab per node, adaptive cap, agent_name_taken adoption) ──
  /**
   * Ensure the node's mirror pane exists: its OWN full-size pane in its OWN tab
   * (label = short node id), created via {@link openTabPane}. Governed by the
   * adaptive cap — an ordinary node past {@link nodeTabBudget} gets no pane and is
   * recorded `unpaned`, so the tab bar stays legible under a large fan-out. A
   * cap-EXEMPT node (`entry.capExempt`: a parked approval gate, a failed node
   * promoted from unpaned, a hijack) always gets its tab and also bypasses
   * `nodeFilter`. Idempotent for replay: a live-adopted pane returns early and a
   * taken agent name adopts its pane; tab labels never confer ownership.
   *
   * @param {NodeEntry} entry
   * @returns {Promise<string | undefined>}
   */
  /**
   * Soft-pin / worker / pin gate for ordinary (non-exempt) detail tabs.
   * @param {NodeEntry} entry
   * @param {"stage" | "ordinary"} reason
   * @returns {boolean}
   */
  function policyAllowsOrdinaryPane(entry, reason) {
    const isWorker = isLikelyWorkerNodeId(entry.nodeId, cockpitPolicy.workerPattern);
    if (isPinnedNodeId(entry.nodeId, cockpitPolicy.pin)) {
      return true;
    }
    return shouldAutoOpenDetailTab(
      {
        nodeId: entry.nodeId,
        reason,
        isWorker,
        softPinnedNodeIds: [...softPins],
      },
      cockpitPolicy,
    );
  }

  async function ensurePane(entry) {
    if (entry.paneId) {
      return entry.paneId;
    }
    const exempt = entry.capExempt === true;
    if (!exempt && !(await shouldMirror(entry))) {
      return undefined;
    }
    // Cockpit policy: workers stay board-only; non-workers soft-pin K stages.
    // Attention promotions set capExempt and skip this gate.
    if (!exempt && !policyAllowsOrdinaryPane(entry, "stage")) {
      entry.unpaned = true;
      return undefined;
    }
    const wsId = await ensureWorkspace();
    if (!wsId) {
      return undefined;
    }
    if (entry.paneId) {
      return entry.paneId;
    }
    // Adaptive cap: an ordinary node past the node-tab budget stays unpaned (a
    // later attention promotion flips `capExempt` and re-enters here to create the
    // tab). Exempt nodes never hit the cap.
    if (!exempt && panedNodeCount() >= nodeTabBudget) {
      entry.unpaned = true;
      return undefined;
    }
    // A parked approval gate's pane runs the INTERACTIVE gate command
    // (`approve --watch`) when one is provided, so the human answers in-pane
    // instead of just reading a tail. Only pure gate nodes reach here for their
    // first pane; an agent node that hits a mid-flight gate already has its tail
    // pane (returned above), so it is never re-commanded. Absent a gateCommand
    // this falls back to the tail command (the prior behavior).
    const cmdFn =
      entry.approvalGate === true && opts.gateCommand ? opts.gateCommand : (opts.tailCommand ?? defaultTail);
    let argv;
    try {
      argv = cmdFn({ runId: /** @type {string} */ (runId), nodeId: entry.nodeId });
    } catch (err) {
      log("debug", "herdr pane command builder threw", err);
      return undefined;
    }
    if (!Array.isArray(argv) || argv.length === 0) {
      return undefined;
    }
    // A pane started via agent.start does NOT inherit the workspace cwd — it runs
    // in the herdr SERVER's cwd. The tail viewer must run in the run's directory
    // so `smithers tail` can locate the run's store, so forward the surface cwd to
    // the pane explicitly (the workspace cwd only affects the root/overview pane).
    const opened = await openTabPane(client, {
      workspaceId: wsId,
      label: entry.tabLabel,
      name: entry.name,
      argv,
      cwd: opts.cwd,
      focus: false,
    });
    if (opened) {
      entry.paneId = opened.paneId;
      entry.unpaned = false;
      // Track soft-pin when we opened a non-exempt stage tab.
      if (!exempt) {
        updateSoftPinSet(
          softPins,
          {
            nodeId: entry.nodeId,
            action: "start",
            isWorker: isLikelyWorkerNodeId(entry.nodeId, cockpitPolicy.workerPattern),
          },
          cockpitPolicy,
        );
      }
      return opened.paneId;
    }
    return undefined;
  }

  // ── reports (per-pane monotonic seq on every push) ────────────────────────
  /**
   * @param {NodeEntry} entry
   * @param {"idle" | "working" | "blocked" | "unknown"} state
   * @param {string} message
   */
  async function reportAgent(entry, state, message) {
    const paneId = await ensurePane(entry);
    if (!paneId) {
      return;
    }
    entry.lastState = state;
    const seq = ++entry.seq;
    await client.tryCall("pane.report_agent", {
      pane_id: paneId,
      source: SOURCE,
      agent: entry.name,
      state,
      message,
      seq,
    });
  }

  /**
   * @param {NodeEntry} entry
   * @param {string} customStatus
   */
  async function reportCustomStatus(entry, customStatus) {
    if (!entry.paneId) {
      return;
    }
    const seq = ++entry.seq;
    await client.tryCall("pane.report_metadata", {
      pane_id: entry.paneId,
      source: SOURCE,
      custom_status: customStatus,
      seq,
    });
  }

  /**
   * @param {NodeEntry} entry
   * @param {string} sessionId
   */
  async function reportSession(entry, sessionId) {
    const paneId = await ensurePane(entry);
    if (!paneId) {
      return;
    }
    const seq = ++entry.seq;
    await client.tryCall("pane.report_agent_session", {
      pane_id: paneId,
      source: SOURCE,
      agent: entry.name,
      agent_session_id: sessionId,
      seq,
    });
  }

  /**
   * @param {string} title
   * @param {string} body
   * @param {"none" | "done" | "request"} sound
   */
  async function notify(title, body, sound) {
    await client.tryCall("notification.show", { title, body, sound });
  }

  /**
   * @param {"finished" | "failed" | "cancelled"} kind
   * @param {number} [failedChildren]
   */
  function finalizeRun(kind, failedChildren) {
    enqueue(async () => {
      for (const entry of nodes.values()) {
        if (kind === "finished") {
          // Only a still-working pane transitions to done. A pane left blocked
          // (a NodeFailed under a run that finishes with tolerated failures)
          // KEEPS its failure — do not overwrite it with "idle done".
          if (entry.lastState !== "working") {
            continue;
          }
          await reportAgent(entry, "idle", "done");
          await reportCustomStatus(entry, "done");
        } else {
          if (entry.lastState !== "working" && entry.lastState !== "blocked") {
            continue;
          }
          await reportAgent(entry, "blocked", `run ${kind}`);
        }
      }
      const sound = kind === "finished" ? (failedChildren && failedChildren > 0 ? "request" : "done") : "request";
      await notify(`smithers run ${kind}`, /** @type {string} */ (runId), sound);
      // Flag the run's outcome on the workspace label (✓/✗/◻) before any close,
      // so a workspace left open (closeWorkspaceOnFinish=false, the CLI default)
      // carries the finished/failed/cancelled marker in the sidebar.
      await renameWorkspaceOutcome(kind);
      if (closeWorkspaceOnFinish) {
        await closeWorkspaceInner();
      }
    });
  }

  /**
   * @param {SmithersEventLike} event
   */
  function onEvent(event) {
    if (closed || !event || typeof event.type !== "string") {
      return;
    }
    setRunId(event.runId);
    if (!runId) {
      return;
    }
    // Drop foreign-run events: the surface binds ONE run. A child-run / other-run
    // event sharing this onProgress must not create panes under the bound run or
    // build a `smithers tail <bound-run> --node <foreign-node>` viewer.
    if (event.runId !== runId) {
      return;
    }
    const nodeId = typeof event.nodeId === "string" ? event.nodeId : undefined;
    switch (event.type) {
      case "RunStarted": {
        enqueue(() => ensureWorkspace().then(() => undefined));
        return;
      }
      case "NodeStarted": {
        if (!nodeId) {
          return;
        }
        const entry = touchNode(event, nodeId);
        // Soft-pin set is updated only when ensurePane actually opens a tab
        // (see ensurePane success path) so a denied worker never burns a slot.
        enqueue(() => reportAgent(entry, "working", nodeId));
        return;
      }
      case "NodeRetrying": {
        if (!nodeId) {
          return;
        }
        const entry = touchNode(event, nodeId);
        const attempt = typeof event.attempt === "number" ? ` (attempt ${event.attempt})` : "";
        enqueue(() => reportAgent(entry, "working", `retrying${attempt}`));
        return;
      }
      case "NodeWaitingApproval":
      case "ApprovalRequested": {
        if (!nodeId) {
          return;
        }
        const entry = touchNode(event, nodeId);
        const message = approvalMessage(event);
        enqueue(async () => {
          // A node parked on a human approval gate is EXACTLY what the human
          // must see, so its pane must exist even when `nodeFilter` would drop
          // it. Pure gate nodes have no agent attempt row, so the CLI's
          // agent-only filter skips them and no pane was ever created. When
          // there is no pane yet, treat this as a parked gate: force the pane
          // (bypass the cached filter decision) and remember it is a gate so
          // its resolution reports "approved", not the "working"/"done" an
          // agent node reports. A node that already has a pane (an agent node
          // hitting a mid-flight gate) keeps the ordinary blocked -> working
          // path. Idempotent on replay: setting these flags again is a no-op.
          if (!entry.paneId) {
            const gatesOn = cockpitPolicy.autoOpen?.gates !== false;
            if (!gatesOn) {
              // Declarative autoOpen.gates:false — report nothing new.
              return;
            }
            entry.approvalGate = true;
            entry.mirror = true;
            // A parked human gate is attention-worthy: it always gets its tab,
            // even past the adaptive cap and even when `nodeFilter` would drop it.
            entry.capExempt = true;
            // Clear naming: gate tabs are `gate:<nodeId>` (product freeze).
            entry.tabLabel = shortNodeId(gateTabLabel(nodeId));
          }
          await reportAgent(entry, "blocked", message);
          if (entry.approvalGate) {
            // herdr does NOT echo the report_agent `message` back in its agent
            // query JSON (AgentInfo has no message field), so also push the gate
            // question as the queryable `custom_status`: a sidebar / dashboard
            // reading `herdr agent list` then shows WHAT needs approving, not
            // just that the pane is blocked. Resolution overwrites it with
            // "approved".
            await reportCustomStatus(entry, message);
          }
          await notify("smithers approval needed", message, "request");
        });
        return;
      }
      case "ApprovalGranted":
      case "ApprovalAutoApproved": {
        if (!nodeId) {
          return;
        }
        const entry = touchNode(event, nodeId);
        if (entry.approvalGate) {
          // A parked gate we surfaced: the gate cleared and the node is done,
          // so report idle "approved" (not the "working" an agent node resumes
          // into) with a matching custom status.
          enqueue(async () => {
            await reportAgent(entry, "idle", "approved");
            await reportCustomStatus(entry, "approved");
          });
        } else {
          enqueue(() => reportAgent(entry, "working", "approved"));
        }
        return;
      }
      case "NodeFinished": {
        if (!nodeId) {
          return;
        }
        const entry = touchNode(event, nodeId);
        updateSoftPinSet(softPins, { nodeId, action: "end" }, cockpitPolicy);
        // A force-surfaced approval gate resolves to "approved"; every other
        // node resolves to "done".
        const status = entry.approvalGate ? "approved" : "done";
        enqueue(async () => {
          // Never open a brand-new pane just to mark done — board-only / unpaned
          // nodes stay unpaned (soft-pin release must not retro-open siblings).
          if (!entry.paneId) {
            return;
          }
          await reportAgent(entry, "idle", status);
          await reportCustomStatus(entry, status);
        });
        return;
      }
      case "NodeFailed": {
        if (!nodeId) {
          return;
        }
        const entry = touchNode(event, nodeId);
        updateSoftPinSet(softPins, { nodeId, action: "end" }, cockpitPolicy);
        const summary = summarizeError(event.error);
        // Failures always promote when autoOpen.failures is on (default).
        const auto = cockpitPolicy.autoOpen;
        const failOpen = auto?.failures !== false;
        if (failOpen) {
          entry.capExempt = true;
        }
        enqueue(async () => {
          if (!failOpen && !entry.paneId) {
            return;
          }
          await reportAgent(entry, "blocked", `failed: ${summary}`);
          await notify("smithers node failed", entry.name, "request");
        });
        return;
      }
      case "NodeCancelled": {
        // Only for a node we already track (it was running) — never spin up a
        // pane just to mark a never-started node cancelled.
        if (!nodeId || !nodes.has(nodeId)) {
          return;
        }
        const entry = touchNode(event, nodeId);
        updateSoftPinSet(softPins, { nodeId, action: "end" }, cockpitPolicy);
        enqueue(async () => {
          if (!entry.paneId) {
            return;
          }
          await reportAgent(entry, "idle", "cancelled");
          await reportCustomStatus(entry, "cancelled");
        });
        return;
      }
      case "AgentEvent": {
        if (!nodeId) {
          return;
        }
        const inner = event.event;
        const resume = inner && typeof inner === "object" ? inner.resume : undefined;
        if (typeof resume === "string" && resume !== "") {
          const entry = touchNode(event, nodeId);
          enqueue(() => reportSession(entry, resume));
        }
        return;
      }
      case "RunFinished": {
        const failed = typeof event.failedChildren === "number" ? event.failedChildren : 0;
        finalizeRun("finished", failed);
        return;
      }
      case "RunFailed": {
        finalizeRun("failed");
        return;
      }
      case "RunCancelled": {
        finalizeRun("cancelled");
        return;
      }
      default:
        return;
    }
  }

  /**
   * Bind a run id and reconcile against existing herdr state: find-or-create the
   * workspace by label, then adopt this run's existing node panes by name.
   *
   * NOTE: adoption does NOT set `entry.lastState`, so `finalizeRun` skips
   * adopted-but-untouched panes on run terminal. That is intentional — the CLI
   * replays the current node states as synthetic events after `attach()`, which
   * sets `lastState` for the panes that are still active.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function attach(id) {
    if (closed) {
      return;
    }
    setRunId(id);
    if (!runId) {
      return;
    }
    await enqueue(async () => {
      const wsId = await ensureWorkspace();
      if (!wsId) {
        return;
      }
      const list = /** @type {{ agents?: any[] } | undefined} */ (await client.tryCall("agent.list", {}));
      const agents = list && Array.isArray(list.agents) ? list.agents : [];
      const prefix = `${SOURCE}:${runId}:`;
      const hijackPrefix = `${prefix}hijack:`;
      for (const agent of agents) {
        if (!agent || typeof agent.name !== "string") {
          continue;
        }
        if (!agent.name.startsWith(prefix) || agent.name.startsWith(hijackPrefix)) {
          continue;
        }
        if (agent.workspace_id !== wsId) {
          continue;
        }
        const adoptedNodeId = agent.name.slice(prefix.length);
        const entry = getEntry(adoptedNodeId);
        if (typeof agent.pane_id === "string") {
          entry.paneId = agent.pane_id;
        }
        // Rebuild soft-pin set from adopted working stages so K remains honest after resume.
        const st = typeof agent.agent_status === "string" ? agent.agent_status : agent.state;
        if (
          entry.paneId &&
          (st === "working" || st === "blocked") &&
          !isLikelyWorkerNodeId(adoptedNodeId, cockpitPolicy.workerPattern) &&
          !isPinnedNodeId(adoptedNodeId, cockpitPolicy.pin)
        ) {
          softPins.add(adoptedNodeId);
        }
      }
    });
  }

  /**
   * Mark an already-bound node as a human approval gate, so its terminal
   * resolution reports "approved" (not the "done" an agent node reports).
   *
   * The `NodeWaitingApproval` handler sets this flag for a gate it parks
   * in-process, but that flag lives only in memory. The default `smithers up`
   * flow EXITS when it parks at a gate (exit 3 = awaiting a decision); the human
   * approves and resumes in a FRESH process whose surface has no memory of the
   * gate. That resumed surface adopts the parked pane via `attach()` and calls
   * this to re-flag the gate, so the live resolution on resume moves the pane
   * blocked -> approved instead of leaving it stuck "blocked" forever. Also sets
   * `mirror` and `capExempt` so neither an agent-only `nodeFilter` (which drops
   * attempt-less gate nodes) nor the adaptive tab cap can suppress a gate the human
   * must see. Idempotent; no-op once closed or before a run id is bound.
   *
   * @param {string} nodeId
   * @returns {void}
   */
  function markApprovalGate(nodeId) {
    if (closed || !runId || typeof nodeId !== "string" || nodeId === "") {
      return;
    }
    const entry = getEntry(nodeId);
    entry.approvalGate = true;
    entry.mirror = true;
    entry.capExempt = true;
  }

  /**
   * Resolve the run's herdr workspace id (find-or-create), for consumers that
   * need to target it directly (e.g. launching a hijack pane into the run
   * workspace). Resolves `undefined` when no run is bound or herdr is unreachable.
   *
   * @returns {Promise<string | undefined>}
   */
  function workspaceIdAccessor() {
    return ensureWorkspace();
  }

  /**
   * @returns {Promise<void>}
   */
  async function close() {
    closed = true;
    // Drain queued tasks, but never let a hung herdr block host shutdown: after
    // 2×callTimeoutMs we abandon the (still-guarded, never-rejecting) queue.
    const deadlineMs = callTimeoutMs * 2;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadlineTimer;
    await Promise.race([
      (async () => {
        while (pending.size > 0) {
          await Promise.all(pending).catch(() => undefined);
        }
      })(),
      new Promise((resolve) => {
        deadlineTimer = setTimeout(resolve, deadlineMs);
        if (typeof deadlineTimer.unref === "function") {
          deadlineTimer.unref();
        }
      }),
    ]);
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
    if (closeWorkspaceOnFinish) {
      await closeWorkspaceInner();
    }
  }

  return { onEvent, attach, markApprovalGate, close, workspaceId: workspaceIdAccessor };
}

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
export async function launchHijackPane(client, spec, ctx) {
  try {
    if (!client || typeof client.call !== "function" || !spec || !ctx || !spec.command) {
      return undefined;
    }
    // Full run id in the name (identity, not display) — matches the surface's
    // pane naming so a re-attach adopts, not duplicates.
    const name = `${SOURCE}:${ctx.runId}:hijack:${ctx.nodeId}`;
    const args = Array.isArray(spec.args) ? spec.args : [];
    const opened = await openTabPane(client, {
      workspaceId: ctx.workspaceId,
      label: `hijack ${shortNodeId(ctx.nodeId)}`,
      name,
      argv: [spec.command, ...args],
      cwd: spec.cwd || undefined,
      env: spec.env || undefined,
      focus: ctx.focus !== false,
    });
    if (!opened) {
      return undefined;
    }

    const source = ctx.source ?? SOURCE;
    // Seed seq from Date.now() (not a hardcoded 1) so a re-launched hijack pane
    // out-ranks the previous incarnation's seq and herdr applies the report.
    await client.tryCall("pane.report_agent", {
      pane_id: opened.paneId,
      source,
      agent: name,
      state: "blocked",
      message: "hijacked - attach to drive",
      seq: Date.now(),
    });
    await client.tryCall("notification.show", { title: "smithers hijack", body: name, sound: "request" });
    return { paneId: opened.paneId, workspaceId: opened.workspaceId, name };
  } catch {
    return undefined;
  }
}
