/**
 * ObservationSource — the read seam for the `smithers supervisor` main TUI.
 *
 * The supervisor's `refreshData()` loop reads exactly four things per poll:
 *   1. the run fleet list                    -> listFleet()
 *   2. the focused run's paint input         -> focusView(fleetRuns, focusIndex)
 *   3. the focused run's outline tree         -> outlineTree(runId, metaByNode)
 *   4. the selected agent's activity strip    -> nodeActivity(runId, nodeId, opts)
 *
 * This module extracts those four reads behind one contract so the same TUI can
 * be fed either from the local SQLite store (the default, permanent fallback) or
 * from a workspace gateway over RPC (opt-in via `--gateway`).
 *
 * - The DIRECT-DB source is a thin delegator to the UNCHANGED helpers in
 *   smithers-top.js / cockpit-*.js, so the default path has zero behavior change
 *   and existing tests keep importing those helpers directly.
 * - The GATEWAY source reconstructs the fleet/focus/outline shapes from the
 *   poll-friendly RPCs (`listRuns` + `getRun` + `getDevToolsSnapshot`) at the
 *   SAME poll cadence, and feeds the per-node activity strip from the
 *   `StreamRunEvents` WebSocket (a background, resilient subscription bound to
 *   the focused run; see nodeActivity()/ensureStreamFor below). A stream drop
 *   degrades the strip to last-known/empty and never crashes the TUI.
 *
 * @typedef {import("./SupervisorObservationSource.ts").SupervisorObservationSource} SupervisorObservationSource
 */

import { loadOutlineTreeFromAdapter, mapDevToolsNodeToOutline } from "./cockpit-outline-graph.js";
import { buildActivityLinesFromEvents, loadNodeActivity } from "./cockpit-activity.js";
import { deriveTailStatus, isTailActiveState } from "./tail.js";
// listFleetRuns / buildTopPaintInput are hoisted function declarations in
// smithers-top.js. This is a (safe) cyclic import: smithers-top.js imports the
// factories below, and this module imports those two helpers — but every use is
// deferred to a runtime method call, never module top-level, so the live
// bindings are always initialized by the time they run.
import { buildTopPaintInput, isSupervisorActiveState, listFleetRuns } from "./smithers-top.js";

// --- Fleet windowing constants (mirror smithers-top.js listFleetRuns) --------
// Kept local so the gateway impl matches the direct-db listFleetRuns windowing
// without a cross-module const import over the smithers-top cycle.
const FLEET_LIMIT = 32;
const FINISHED_FLEET_CAP = 4;
const ACTIVE_STATUSES = ["running", "waiting-approval", "waiting-event", "waiting-timer", "paused", "continued"];

// ============================================================================
// Direct-DB source — current behavior, refactored behind the interface.
// ============================================================================

/**
 * Build the default observation source: the current SQLite-backed behavior,
 * delegating verbatim to the existing helpers.
 *
 * @param {any} adapter SmithersDb adapter (read-only usage)
 * @returns {SupervisorObservationSource}
 */
export function createDirectDbObservationSource(adapter) {
  return {
    kind: "direct-db",
    listFleet: () => listFleetRuns(adapter),
    focusView: (fleetRuns, focusIndex) => buildTopPaintInput(adapter, fleetRuns, focusIndex),
    // S2: node-detail-entry.js and the herdr tail panes stay direct-db; only
    // this four-read seam is sourced.
    outlineTree: (runId, metaByNode) => loadOutlineTreeFromAdapter(adapter, runId, metaByNode),
    nodeActivity: (runId, nodeId, opts) => loadNodeActivity(adapter, runId, nodeId, opts),
  };
}

// ============================================================================
// Gateway source — same poll cadence, over gateway-client RPCs.
// ============================================================================

/**
 * Walk a DevTools snapshot root, invoking `visit` on every task node.
 * @param {any} snapshot
 * @param {(task: any) => void} visit
 */
function forEachSnapshotTask(snapshot, visit) {
  const root = snapshot?.root;
  if (!root || typeof root !== "object") return;
  /** @type {any[]} */
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.task && typeof node.task === "object" && typeof node.task.nodeId === "string") {
      visit(node.task);
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) stack.push(child);
  }
}

/**
 * Flatten a DevTools snapshot's task nodes into the flat listNodes-shaped rows
 * the paint model consumes ({ nodeId, state, lastAttempt, iteration }).
 *
 * NOTE: the snapshot carries no per-node `updatedAtMs`, so the finishedAtMs
 * node-fallback in focusView is degraded on the gateway path for stale runs
 * that lack a `finishedAtMs` (documented divergence).
 *
 * @param {any} snapshot
 * @returns {Array<{ nodeId: string, state: string, lastAttempt: number, iteration: number }>}
 */
export function flattenSnapshotToNodeRows(snapshot) {
  /** @type {Array<{ nodeId: string, state: string, lastAttempt: number, iteration: number }>} */
  const rows = [];
  forEachSnapshotTask(snapshot, (task) => {
    rows.push({
      nodeId: task.nodeId,
      state: typeof task.state === "string" && task.state !== "" ? task.state : "pending",
      lastAttempt: typeof task.attempt === "number" ? task.attempt : 0,
      iteration: typeof task.iteration === "number" ? task.iteration : 0,
    });
  });
  return rows;
}

/**
 * Reconstruct the per-node agent metadata map from a DevTools snapshot.
 *
 * The direct-db map comes from `listAttemptsForRun`'s persisted `metaJson`;
 * the snapshot carries the same display identity via `task.agentRan`
 * (engine/model/effort actually executed) and `task.agentSummary` (declared
 * label/engine/model/effort). The DevTools snapshot now carries `effort` (the
 * attempt's first-class column, falling back to `meta_json`), so the model line
 * renders the effort suffix at parity with the direct-db path.
 *
 * The keys chosen (`agentEngine`/`agentModel`/`effort`/`label`) are exactly what
 * cockpit-outline-graph.js's identityFromMeta reads.
 *
 * @param {any} snapshot
 * @returns {Record<string, Record<string, unknown>>}
 */
export function metaByNodeFromSnapshot(snapshot) {
  /** @type {Record<string, Record<string, unknown>>} */
  const meta = {};
  forEachSnapshotTask(snapshot, (task) => {
    const ran = task.agentRan && typeof task.agentRan === "object" ? task.agentRan : {};
    const summary = task.agentSummary && typeof task.agentSummary === "object" ? task.agentSummary : {};
    const engine =
      (typeof ran.engine === "string" && ran.engine) || (typeof summary.engine === "string" && summary.engine) || "";
    const model =
      (typeof ran.model === "string" && ran.model) || (typeof summary.model === "string" && summary.model) || "";
    const label =
      (typeof summary.label === "string" && summary.label) || (typeof task.label === "string" && task.label) || "";
    const effort =
      (typeof ran.effort === "string" && ran.effort) || (typeof summary.effort === "string" && summary.effort) || "";
    /** @type {Record<string, unknown>} */
    const entry = {};
    if (engine) entry.agentEngine = engine;
    if (model) entry.agentModel = model;
    if (effort) entry.effort = effort;
    if (label) entry.label = label;
    if (Object.keys(entry).length > 0) meta[task.nodeId] = entry;
  });
  return meta;
}

/**
 * Rebuild the graph-primary outline roots from a DevTools snapshot, applying the
 * SAME promotion rules as cockpit-outline-graph.js's loadOutlineTreeFromAdapter
 * (only the snapshot source swaps: RPC instead of the server route).
 *
 * @param {any} snapshot
 * @param {Record<string, Record<string, unknown>>} [metaByNode]
 * @returns {{ roots: import("./cockpit-outline-graph.js").OutlineTreeNode[], frameNo: number, source: "graph" } | null}
 */
export function buildOutlineRootsFromSnapshot(snapshot, metaByNode = {}) {
  if (!snapshot?.root) return null;
  const mapped = mapDevToolsNodeToOutline(snapshot.root, metaByNode, "root");
  if (!mapped) return null;
  /** @type {import("./cockpit-outline-graph.js").OutlineTreeNode[]} */
  const roots = [];
  if (
    mapped.kind === "group" &&
    (mapped.groupType === "sequence" || mapped.groupType === "workflow") &&
    mapped.children.length > 0
  ) {
    roots.push(...mapped.children);
  } else {
    roots.push(mapped);
  }
  if (roots.length === 0) return null;
  return { roots, frameNo: typeof snapshot.frameNo === "number" ? snapshot.frameNo : 0, source: "graph" };
}

/**
 * Derive the fleet "derivedStatus" for one run from its server-computed
 * runState, falling back to the persisted status. Applies the tail.js
 * succeeded->finished rename in both branches so the gateway path matches the
 * direct-db `deriveTailStatus(computeRunStateFromRow(...))` naming.
 *
 * @param {any} runState server RunStateView ({ state, ... }) or undefined
 * @param {string | undefined} fallbackStatus persisted run status
 * @returns {string | undefined}
 */
export function deriveDerivedStatusFromRunState(runState, fallbackStatus) {
  const derived = deriveTailStatus(runState);
  if (typeof derived === "string" && derived !== "") return derived;
  return fallbackStatus === "succeeded" || fallbackStatus === "succeeded-with-failures" ? "finished" : fallbackStatus;
}

// Cap the per-node activity ring buffer. The strip only paints the last few
// lines (ACTIVITY_STRIP_LINES), but pairing tool started/completed + node
// filtering needs a window of recent rows; mirrors the direct-db afterSeq-500
// window loadNodeActivity uses.
const ACTIVITY_RING_CAP = 500;

// The gateway streams every run-event under a dotted, server-mapped name (see
// `mapEvent` in packages/server/src/gateway.js). This map translates those names
// onto the direct-db row `type` names buildActivityLinesFromEvents renders, so
// the SAME pure builder feeds both paths.
//
// Per-node tool/agent activity arrives EXCLUSIVELY as `agent.event` (the
// `AgentEvent` case in mapEvent), whose payload carries `{ nodeId, event }` —
// exactly the shape the direct-db `AgentEvent` row stores in its payload_json,
// so a streamed frame maps 1:1 onto a durable row. The gateway emits no separate
// `ToolCallStarted`/`ToolCallFinished` frames: CLI tool calls surface inside an
// AgentEvent's `event: { type: "action", action: { kind: "tool", … } }` body,
// which buildActivityLinesFromEvents already renders under type "AgentEvent".
//
// Restricting the ring to the mapped activity carriers IS the parity pre-filter:
// a busy multi-node run's node/approval/heartbeat frames are dropped at push
// time so they never crowd the focused node's rows out of the bounded ring
// (matches the direct-db path's SQL `types` filter / loadNodeActivity window).
const GATEWAY_EVENT_TO_ACTIVITY_TYPE = new Map([
  ["agent.event", "AgentEvent"],
  ["tool.call.started", "ToolCallStarted"],
  ["tool.call.finished", "ToolCallFinished"],
]);

/**
 * Build a gateway-backed observation source over a SmithersGatewayClient. The
 * fleet/focus/outline reads use ONLY `client.rpc()` (HTTP POST
 * /v1/rpc/<method>); the focused run's DevTools snapshot is memoized per runId
 * so focusView() + outlineTree() within a single poll tick share one
 * `getDevToolsSnapshot` call.
 *
 * The per-node activity strip is fed from a single background `StreamRunEvents`
 * WebSocket subscription bound to the focused run (ensureStreamFor). Streamed
 * `run.event` frames map 1:1 onto the durable event rows the direct-db path
 * reads, so the SAME pure `buildActivityLinesFromEvents` renders both paths.
 * The subscription is resilient (auto-reconnect + seq resume) and every error
 * is swallowed: a stream drop degrades the strip to last-known/empty and never
 * crashes the TUI. `dispose()` aborts the subscription on exit.
 *
 * @param {import("smthrs/gateway-client").SmithersGatewayClient} client
 * @param {{ dbPath?: string, cwd?: string }} [_opts] resolved locally for the
 *   still-direct-db herdr detail panes (S2); not needed by the read seam itself.
 * @returns {SupervisorObservationSource}
 */
export function createGatewayObservationSource(client, _opts = {}) {
  /** @type {{ runId: string, promise: Promise<any> } | null} */
  let snapshotMemo = null;

  // Per-tick getRun memo. refreshData drives listFleet → focusView → outlineTree
  // in order, and the focused active run is getRun'd by BOTH listFleet's
  // runStatesFor() (for its server-derived fleet status) and focusView() (for
  // its status/timers). Sharing one promise per runId collapses that duplicate;
  // listFleet clears it at the top of each tick so status never goes stale.
  /** @type {Map<string, Promise<any>>} */
  const getRunMemo = new Map();
  /** @param {string} runId */
  const getRunMemoized = (runId) => {
    let promise = getRunMemo.get(runId);
    if (!promise) {
      promise = client.getRun({ runId });
      getRunMemo.set(runId, promise);
    }
    return promise;
  };

  // --- Streamed activity state (spec item 1) ------------------------------
  // One background WS subscription at a time, bound to the focused runId. The
  // consumer loop does O(1) synchronous work per frame (map + push into a
  // capped ring) and swallows every error so a drop is invisible to the TUI.
  /** @type {Array<{ type: string, seq: number, payloadJson: string, timestampMs: number }>} */
  let activityRing = [];
  /** @type {string | null} */
  let activeStreamRunId = null;
  /** @type {AbortController | null} */
  let streamController = null;
  const supportsStreaming = typeof client?.streamRunEventsResilient === "function";

  /**
   * (Re)bind the background activity subscription to `runId`. A no-op when the
   * client can't stream or we're already bound to this run; otherwise aborts
   * the prior subscription, clears the ring, and starts a fresh resilient
   * consumer loop. `afterSeq:0` asks the server for its bounded retained
   * replay window + live tail (the native "catch-up" the spec calls for).
   *
   * @param {string} runId
   */
  const ensureStreamFor = (runId) => {
    if (!supportsStreaming || !runId) return;
    if (activeStreamRunId === runId && streamController) return;
    if (streamController) {
      try {
        streamController.abort();
      } catch {
        /* ignore */
      }
    }
    const controller = new AbortController();
    streamController = controller;
    activeStreamRunId = runId;
    activityRing = [];
    const { signal } = controller;
    // Fire-and-forget background loop. Any throw (connect failure, error
    // frame, invalid frame) is swallowed → the strip degrades to last-known.
    void (async () => {
      try {
        for await (const frame of client.streamRunEventsResilient({ runId, afterSeq: 0 }, { signal })) {
          if (signal.aborted) break;
          // Only `run.event` frames carry a run-event row; skip
          // heartbeat/gap_resync/error control frames.
          if (!frame || frame.event !== "run.event") continue;
          const p = frame.payload;
          if (!p || typeof p !== "object") continue;
          // `p.event` is the server-mapped dotted name (e.g. "agent.event"),
          // NOT the direct-db PascalCase row `type`. Translate it, which also
          // pre-filters to the activity carriers the strip renders (parity with
          // the direct-db SQL `types` filter) — retaining only these keeps the
          // bounded ring from being diluted/evicted by other event types on a
          // busy run, so the focused node's tool lines don't starve.
          const rowType = typeof p.event === "string" ? GATEWAY_EVENT_TO_ACTIVITY_TYPE.get(p.event) : undefined;
          if (!rowType) continue;
          const rowPayload = p.payload;
          activityRing.push({
            type: rowType,
            seq: typeof p.seq === "number" ? p.seq : 0,
            // The mapped payload (e.g. { nodeId, event }) IS the durable row's
            // payload_json, which buildActivityLinesFromEvents parses per type.
            payloadJson: JSON.stringify(rowPayload ?? {}),
            // The run.event frame carries no top-level timestampMs; fall back to
            // the mapped payload's if present (else 0 — cosmetic: only the
            // AgentEvent display fallback reads it; ordering uses seq).
            timestampMs:
              typeof p.timestampMs === "number"
                ? p.timestampMs
                : rowPayload && typeof rowPayload === "object" && typeof rowPayload.timestampMs === "number"
                  ? rowPayload.timestampMs
                  : 0,
          });
          // Drop-oldest: we only ever exceed the cap by one per push.
          if (activityRing.length > ACTIVITY_RING_CAP) activityRing.shift();
        }
      } catch {
        /* swallow — a drop degrades the strip, never crashes the TUI */
      }
    })();
  };

  /**
   * @param {string} runId
   * @param {{ reuse?: boolean }} [opts]
   * @returns {Promise<any>} the snapshot payload, or null on any RPC failure
   */
  const getSnapshot = (runId, opts = {}) => {
    if (opts.reuse && snapshotMemo && snapshotMemo.runId === runId) {
      return snapshotMemo.promise;
    }
    // focusView opens each tick with reuse:false, refreshing the memo, so the
    // snapshot is never stale across ticks; outlineTree reuses within the tick.
    const promise = client.getDevToolsSnapshot({ runId }).catch(() => null);
    snapshotMemo = { runId, promise };
    return promise;
  };

  /**
   * Fetch runState for the small active set so the fleet's derivedStatus is
   * server-computed (a DB-"running" but dead run derives orphaned/stale),
   * matching direct-db's computeRunStateFromRow derivation.
   * @param {Set<string>} activeIds
   * @returns {Promise<Map<string, any>>}
   */
  const runStatesFor = async (activeIds) => {
    /** @type {Map<string, any>} */
    const byId = new Map();
    await Promise.all(
      [...activeIds].map(async (runId) => {
        try {
          const run = await getRunMemoized(runId);
          byId.set(runId, run?.runState);
        } catch {
          // Soft — keep persisted status for this run. Drop the failed
          // promise so focusView can retry with a fresh getRun.
          getRunMemo.delete(runId);
        }
      }),
    );
    return byId;
  };

  return {
    kind: "gateway",

    async listFleet() {
      // Top of the tick: reset the per-tick getRun memo so focusView shares
      // this tick's runStatesFor() getRun instead of re-fetching.
      getRunMemo.clear();
      /** @type {Map<string, any>} */
      const byId = new Map();
      try {
        const recent = await client.listRuns({ filter: { limit: FLEET_LIMIT } });
        for (const row of recent ?? []) {
          if (row?.runId) byId.set(row.runId, row);
        }
      } catch {
        /* soft — an empty recent list still lets active-status queries fill in */
      }
      // listRuns' filter takes a SINGLE status, so the fleet needs 1 (recent)
      // + N (per active status) round-trips. Collapsing that fan-out would
      // need a multi-status listRuns filter (a new RPC) and is intentionally
      // out of scope here; the cheap win is deduping the focused getRun below.
      /** @type {Set<string>} */
      const activeIds = new Set();
      for (const status of ACTIVE_STATUSES) {
        try {
          const rows = await client.listRuns({ filter: { status, limit: FLEET_LIMIT } });
          for (const row of rows ?? []) {
            if (!row?.runId) continue;
            byId.set(row.runId, row);
            activeIds.add(row.runId);
          }
        } catch {
          /* soft */
        }
      }
      const boundedActiveIds = new Set(
        [...byId.values()]
          .filter((run) => activeIds.has(run.runId))
          .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))
          .slice(0, FLEET_LIMIT)
          .map((run) => run.runId),
      );
      const runStateById = await runStatesFor(boundedActiveIds);
      /** @type {any[]} */
      const active = [];
      /** @type {any[]} */
      const finished = [];
      for (const r of byId.values()) {
        const derived = boundedActiveIds.has(r.runId)
          ? deriveDerivedStatusFromRunState(runStateById.get(r.runId), r.status)
          : r.status === "succeeded" || r.status === "succeeded-with-failures"
            ? "finished"
            : r.status;
        // listRuns rows carry workflowKey, not workflowName — map so the
        // paint header resolves a name identically to the direct-db path.
        const workflowName =
          typeof r.workflowName === "string" && r.workflowName !== ""
            ? r.workflowName
            : typeof r.workflowKey === "string"
              ? r.workflowKey
              : r.workflowName;
        const row = { ...r, workflowName, derivedStatus: derived };
        if (isSupervisorActiveState(derived)) active.push(row);
        else finished.push(row);
      }
      active.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
      finished.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
      return [...active, ...finished.slice(0, FINISHED_FLEET_CAP)].slice(0, FLEET_LIMIT);
    },

    async focusView(fleetRuns, focusIndex) {
      const nowMs = Date.now();
      if (!fleetRuns.length) {
        // Byte-identical to buildTopPaintInput's empty case.
        return {
          focusIndex: 0,
          input: {
            runId: "(no runs yet)",
            workflowName: "",
            status: "idle",
            nodes: [],
            startedAtMs: nowMs,
            nowMs,
          },
          run: null,
        };
      }
      const idx = Math.max(0, Math.min(focusIndex, fleetRuns.length - 1));
      const run = fleetRuns[idx];
      // Warm the activity subscription for the focused run so the strip is
      // primed before the next nodeActivity() read (rebinds on run change).
      ensureStreamFor(run.runId);
      let status =
        typeof run.derivedStatus === "string" && run.derivedStatus !== ""
          ? run.derivedStatus
          : (run.status ?? "unknown");
      /** @type {any} */
      let getRunRow = null;
      try {
        // Reuse listFleet's getRun for the focused run when it's active;
        // getRunMemoized issues a fresh call only for a non-active focus.
        getRunRow = await getRunMemoized(run.runId);
        const derived = deriveTailStatus(getRunRow?.runState);
        if (typeof derived === "string" && derived !== "") status = derived;
      } catch {
        /* keep */
      }
      const snapshot = await getSnapshot(run.runId, { reuse: false });
      const nodes = flattenSnapshotToNodeRows(snapshot);
      const agentMetaByNode = metaByNodeFromSnapshot(snapshot);
      // listSteers has no RPC; buildTopPaintInput already treats steers as
      // soft/optional. S2.
      const queuedSteers = [];
      const workflow =
        (typeof run.workflowName === "string" && run.workflowName) ||
        (typeof getRunRow?.workflowKey === "string" && getRunRow.workflowKey) ||
        (typeof run.workflowKey === "string" && run.workflowKey) ||
        "";
      const active = isSupervisorActiveState(status);
      const anyActive = fleetRuns.some((r) => {
        const st = r.derivedStatus ?? r.status;
        return isSupervisorActiveState(st);
      });
      let finishedAtMs =
        typeof getRunRow?.finishedAtMs === "number"
          ? getRunRow.finishedAtMs
          : typeof run.finishedAtMs === "number"
            ? run.finishedAtMs
            : null;
      if (!finishedAtMs && !active) {
        // Freeze timer for terminal/stale runs without finishedAtMs. Snapshot
        // nodes carry no updatedAtMs, so this stays 0 (degraded — documented).
        let maxU = 0;
        for (const n of nodes) {
          if (typeof n?.updatedAtMs === "number" && n.updatedAtMs > maxU) maxU = n.updatedAtMs;
        }
        if (maxU > 0) finishedAtMs = maxU;
      }
      return {
        focusIndex: idx,
        run,
        input: {
          runId: run.runId,
          workflowName: workflow,
          status,
          nodes,
          agentMetaByNode,
          startedAtMs: getRunRow?.startedAtMs ?? run.startedAtMs ?? run.createdAtMs ?? nowMs,
          finishedAtMs,
          nowMs,
          live: active,
          liveElsewhere: !active && anyActive,
          queuedSteers,
        },
      };
    },

    async outlineTree(runId, metaByNode = {}) {
      if (!runId) return null;
      const snapshot = await getSnapshot(runId, { reuse: true });
      return buildOutlineRootsFromSnapshot(snapshot, metaByNode);
    },

    // Per-node activity strip, fed from the background StreamRunEvents ring
    // (spec item 1). ensureStreamFor is idempotent, so a nodeActivity read
    // on a run focusView hasn't warmed yet still binds the subscription. The
    // ring holds ALL nodes' recent events for the focused run;
    // buildActivityLinesFromEvents filters to `nodeId` — the SAME pure path
    // as direct-db. Reads a snapshot of the ring so a concurrent push can't
    // perturb the (synchronous) build.
    async nodeActivity(runId, nodeId, opts) {
      ensureStreamFor(runId);
      if (!supportsStreaming) return [];
      return buildActivityLinesFromEvents(activityRing.slice(), nodeId, opts);
    },

    // Abort the background activity subscription so the WS never leaks past
    // supervisor exit. Idempotent; safe to call when no stream is bound.
    dispose() {
      if (streamController) {
        try {
          streamController.abort();
        } catch {
          /* ignore */
        }
        streamController = null;
      }
      activeStreamRunId = null;
      activityRing = [];
    },
  };
}

// ============================================================================
// `--gateway <url|auto>` / `--direct` flag resolution.
// ============================================================================

/**
 * Map the `--gateway` flag value to a resolveBrowserGateway-shaped target.
 *
 * Gateway `auto` is now the DEFAULT: an unset flag (and `auto`) both mean
 * start-or-attach the workspace gateway. `--direct` is the explicit escape
 * hatch that forces the local direct-db read path (the broken-gateway
 * diagnosis path).
 *
 *   --direct        -> null                                      (force direct-db)
 *   "<url>"         -> { gateway: url, autostart: false }        (attach only)
 *   "auto"          -> { gateway: undefined, autostart: true }   (start-or-attach)
 *   unset/empty     -> { gateway: undefined, autostart: true }   (the default: auto)
 *
 * Two guards protect the DEFAULT (implicit) path — an explicit `--gateway auto`
 * or `--gateway <url>` overrides both:
 *
 *  - `pinnedDb` (an explicit `--db <path>`): a pinned db is a direct-db concept
 *    the gateway cannot serve (a gateway reads its own workspace's db, not an
 *    arbitrary path), so honor the pin by reading direct — restoring the
 *    pre-flip guarantee that `--db X` reads exactly X. Without this, `--db`
 *    became a silent no-op for primary reads once gateway became the default.
 *  - `interactive`: the implicit default only autostarts a background gateway
 *    daemon when interactive (a TTY). A headless / scripted supervisor keeps the
 *    pre-flip behavior — an instant, silent direct-db read that spawns no daemon
 *    and leaves nothing behind (process hygiene for `timeout N smithers top`).
 *
 * @param {unknown} value
 * @param {{ direct?: boolean, pinnedDb?: boolean, interactive?: boolean }} [opts]
 * @returns {{ gateway: string | undefined, autostart: boolean } | null}
 */
export function resolveSupervisorGatewayTarget(value, { direct = false, pinnedDb = false, interactive = true } = {}) {
  if (direct) return null; // --direct: force the local direct-db read path.
  // An explicit --gateway request (a url, or `auto`) overrides the pinnedDb /
  // interactive guards below; the two guards only shape the implicit default.
  const explicit = typeof value === "string" && value !== "";
  if (explicit && value !== "auto") {
    return { gateway: value, autostart: false }; // explicit URL: attach only.
  }
  if (!explicit) {
    // A pinned --db is honored directly (pre-flip semantics: read exactly X).
    if (pinnedDb) return null;
    // Headless/scripted default: keep the pre-flip instant direct-db read
    // rather than spawning a daemon nothing will consume interactively.
    if (!interactive) return null;
  }
  // The flip: unset / empty / `auto` all start-or-attach the workspace gateway.
  return { gateway: undefined, autostart: true };
}

/**
 * Apply the gateway-attach posture for a resolved supervisor target, with the
 * gateway resolver + client factory injected so the fallback-vs-hard-error
 * posture is unit-testable without a live gateway. The caller has already
 * decided that `target` is non-null (i.e. not `--direct`).
 *
 * Posture:
 *  - `autostart:true` (the default `auto`) miss => warn to stderr and return
 *    undefined, so the supervisor falls back to direct-db (the permanent
 *    fallback). The default path NEVER hard-fails.
 *  - explicit `--gateway <url>` (autostart:false) miss => throw (the user
 *    pinned it, so a miss is a hard error).
 *
 * @param {{ gateway: string | undefined, autostart: boolean }} target
 * @param {{
 *   resolveGateway: () => Promise<{ ok: true, base: string, token: string | null } | { ok: false, message: string }>,
 *   makeClient: (resolved: { base: string, token: string | null }) => any,
 *   warn: (message: string) => void,
 *   unreachableError: (message: string) => Error,
 *   sourceOpts?: { dbPath?: string, cwd?: string },
 * }} deps
 * @returns {Promise<SupervisorObservationSource | undefined>}
 */
export async function resolveGatewaySource(target, deps) {
  const resolved = await deps.resolveGateway();
  if (!resolved.ok) {
    if (target.autostart) {
      // `auto`: the gateway is optional; keep the supervisor alive on the
      // permanent direct-db fallback.
      deps.warn(`[smithers supervisor] gateway unavailable; using direct-db. ${resolved.message}\n`);
      return undefined;
    }
    // Explicit `--gateway <url>`: the user pinned it, so a miss is a hard error.
    throw deps.unreachableError(resolved.message);
  }
  return createGatewayObservationSource(deps.makeClient(resolved), deps.sourceOpts ?? {});
}
