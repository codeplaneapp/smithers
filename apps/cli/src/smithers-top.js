/**
 * `smithers supervisor` — workflow supervisor outline TUI
 * (right pane of the herdr *cockpit* tab: harness left, supervisor right).
 *
 * Single-run primary outline: phases top→bottom; multi-agent nested under phase.
 * Enter on agent → herdr detail tab (or hint if herdr offline).
 * [ ] switch runs · f follow live · j/k select · q quit
 */

import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SmithersError } from "@smithers-orchestrator/errors";
import { computeRunStateFromRow } from "@smithers-orchestrator/db/runState";
import { createHerdrClient, openTabPane, shortNodeId } from "@smithers-orchestrator/herdr";
import { findAndOpenDb } from "./find-db.js";
import { openSmithersStore } from "smithers-orchestrator/openSmithersStore";
import { deriveTailStatus, isTailActiveState } from "./tail.js";
import { buildCockpitOutlineModel, createCockpitOutlineHud } from "./cockpit-outline.js";
import { ACTIVITY_STRIP_LINES } from "./cockpit-activity.js";
import { createDirectDbObservationSource } from "./supervisor-observation.js";
import {
  buildGateCommand,
  buildTailCommand,
  herdrWorkspaceLabel,
  openHerdrNodePane,
  makeHerdrStderrLogger,
  probeCompatibleHerdr,
} from "./herdr.js";

const POLL_MS = 400;
const FRAME_MS = 200;
const FLEET_LIMIT = 32;
const FINISHED_FLEET_CAP = 4;
const ACTIVE_STATUSES = ["running", "waiting-approval", "waiting-event", "waiting-timer", "paused", "continued"];

/**
 * @param {{ db?: string, cwd?: string }} opts
 */
export async function openTopStore(opts = {}) {
  if (typeof opts.db === "string" && opts.db !== "") {
    const dbPath = resolve(opts.cwd ?? process.cwd(), opts.db);
    if (!existsSync(dbPath)) {
      throw new SmithersError("CLI_DB_NOT_FOUND", `No database at ${dbPath}`);
    }
    // Explicit --db path: open that store only (post-rebase API is openSmithersStore).
    const opened = await openSmithersStore({
      cwd: dirname(dbPath),
      dbPath,
      mode: "read",
      backend: "sqlite",
    });
    return { adapter: opened.adapter, dbPath: opened.dbPath ?? dbPath, cleanup: opened.cleanup };
  }
  const from = opts.cwd ? resolve(opts.cwd) : process.cwd();
  // Read path only: never scaffold a store under a foreign cwd (contaminates
  // non-smithers repos and shows a false empty supervisor).
  const opened = await findAndOpenDb(from);
  return { adapter: opened.adapter, dbPath: opened.dbPath, cleanup: opened.cleanup };
}

/**
 * @param {any} adapter
 */
export async function listFleetRuns(adapter) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  const recent = await adapter.listRuns(FLEET_LIMIT);
  for (const row of recent ?? []) {
    if (row?.runId) byId.set(row.runId, row);
  }
  for (const status of ACTIVE_STATUSES) {
    try {
      const rows = await adapter.listRuns(FLEET_LIMIT, status);
      for (const row of rows ?? []) {
        if (row?.runId) byId.set(row.runId, row);
      }
    } catch {
      /* soft */
    }
  }
  const all = [...byId.values()];
  /** @type {any[]} */
  const active = [];
  /** @type {any[]} */
  const finished = [];
  for (const r of all) {
    // DB can still say "running" after a killed campaign — derive without
    // mutating `status` (re-deriving on a mutated "stale" row yields "unknown").
    let derived = r.status;
    try {
      const d = deriveTailStatus(await computeRunStateFromRow(adapter, r));
      if (typeof d === "string" && d !== "") derived = d;
    } catch {
      /* keep stored */
    }
    const row = { ...r, derivedStatus: derived };
    if (isTailActiveState(derived)) active.push(row);
    else finished.push(row);
  }
  active.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
  finished.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
  return [...active, ...finished.slice(0, FINISHED_FLEET_CAP)].slice(0, FLEET_LIMIT);
}

/**
 * @param {any[]} fleetRuns
 * @param {number} focusIndex
 * @param {string | undefined} focusedRunId
 * @param {{ pin?: boolean }} [opts]
 */
function fleetEffectiveStatus(r) {
  return typeof r?.derivedStatus === "string" && r.derivedStatus !== "" ? r.derivedStatus : r?.status;
}

export function resolveFocusIndex(fleetRuns, focusIndex, focusedRunId, opts = {}) {
  if (!fleetRuns.length) return 0;
  const pin = opts.pin === true;
  const activeIdx = fleetRuns.findIndex((r) => isTailActiveState(fleetEffectiveStatus(r)));
  const found = typeof focusedRunId === "string" ? fleetRuns.findIndex((r) => r.runId === focusedRunId) : -1;
  if (pin && found >= 0) return found;
  if (activeIdx >= 0) {
    if (found >= 0 && isTailActiveState(fleetEffectiveStatus(fleetRuns[found]))) return found;
    return activeIdx;
  }
  if (found >= 0) return found;
  return Math.max(0, Math.min(focusIndex, fleetRuns.length - 1));
}

/**
 * @param {any} adapter
 * @param {any[]} fleetRuns
 * @param {number} focusIndex
 */
export async function buildTopPaintInput(adapter, fleetRuns, focusIndex) {
  const nowMs = Date.now();
  if (!fleetRuns.length) {
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
  // Prefer derivedStatus from listFleetRuns; re-derive from a clean getRun row.
  let status =
    typeof run.derivedStatus === "string" && run.derivedStatus !== "" ? run.derivedStatus : (run.status ?? "unknown");
  try {
    const fresh = (await adapter.getRun(run.runId)) ?? run;
    const derived = deriveTailStatus(await computeRunStateFromRow(adapter, fresh));
    if (typeof derived === "string" && derived !== "") status = derived;
  } catch {
    /* keep */
  }
  const nodes = (await adapter.listNodes(run.runId)) ?? [];
  /** @type {Record<string, Record<string, unknown>>} */
  const agentMetaByNode = {};
  try {
    const attempts = (await adapter.listAttemptsForRun(run.runId)) ?? [];
    for (const at of attempts) {
      if (!at?.nodeId) continue;
      const hasEffortCol = typeof at.effort === "string" && at.effort !== "";
      // Parse meta_json when present; a row that set ONLY the first-class effort
      // column (no meta_json) still contributes its effort so the direct-db
      // supervisor matches node-detail / gateway (which render the column even
      // with an empty meta). Neither meta_json nor effort column -> nothing to add.
      let meta = {};
      if (typeof at.metaJson === "string" && at.metaJson !== "") {
        try {
          const parsed = JSON.parse(at.metaJson);
          if (!parsed || typeof parsed !== "object") continue;
          meta = parsed;
        } catch {
          continue; // soft: skip a corrupt meta_json row
        }
      } else if (!hasEffortCol) {
        continue;
      }
      // Keep highest attempt number per node
      const prev = agentMetaByNode[at.nodeId];
      const prevA = typeof prev?.__attempt === "number" ? prev.__attempt : 0;
      const curA = typeof at.attempt === "number" ? at.attempt : 0;
      if (!prev || curA >= prevA) {
        // First-class effort COLUMN wins over meta_json (spread last) for parity
        // with the node-detail / gateway paths.
        agentMetaByNode[at.nodeId] = {
          ...meta,
          ...(hasEffortCol ? { effort: at.effort } : {}),
          __attempt: curA,
        };
      }
    }
  } catch {
    /* soft */
  }
  /** @type {Array<{ nodeId: string, status?: string }>} */
  let queuedSteers = [];
  try {
    if (typeof adapter.listSteers === "function") {
      const all = (await adapter.listSteers(run.runId)) ?? [];
      queuedSteers = all.filter((n) => n && n.status === "queued");
    }
  } catch {
    /* soft — pre-migration stores */
  }
  const workflow =
    run.workflowName || (typeof run.workflowPath === "string" ? run.workflowPath.split(/[/\\]/).pop() : "") || "";
  // "stale"/"orphaned" are not active — engine is dead even if DB said running.
  const active = isTailActiveState(status);
  const anyActive = fleetRuns.some((r) => {
    const st = r.derivedStatus ?? r.status;
    return isTailActiveState(st);
  });
  let finishedAtMs = typeof run.finishedAtMs === "number" ? run.finishedAtMs : null;
  if (!finishedAtMs && !active) {
    // Freeze timer for terminal/stale runs without finishedAtMs
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
      startedAtMs: run.startedAtMs ?? run.createdAtMs ?? nowMs,
      finishedAtMs,
      nowMs,
      live: active,
      liveElsewhere: !active && anyActive,
      queuedSteers,
    },
  };
}

export async function probeHerdr(client = createHerdrClient({ logger: () => {} })) {
  try {
    return (await probeCompatibleHerdr(client)).available;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   runId: string,
 *   nodeId: string,
 *   workflowName?: string,
 *   dbPath: string,
 *   cwd: string,
 *   herdrAvailable: boolean,
 *   herdrClient?: import("@smithers-orchestrator/herdr").HerdrClient | null,
 *   kind?: "agent" | "gate",
 * }} opts
 */
export async function openNodeDetail(opts) {
  const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));
  // A `waiting-approval` gate opens the interactive `approve --watch` pane (y/n),
  // the SAME surface the herdr mirror gives a gate node — the agent detail/steer
  // tail pane's s/h dock is meaningless on a gate. buildGateCommand relies on the
  // pane cwd (the store root, set below) to find the run's DB, like the mirror.
  const isGate = opts.kind === "gate";
  // Pin store via --db so detail panes match the supervisor mid-run (cwd walk alone
  // can miss a just-committed run under concurrent engine writes).
  const argv = isGate
    ? buildGateCommand(cliPath)({ runId: opts.runId, nodeId: opts.nodeId })
    : buildTailCommand(cliPath, { dbPath: opts.dbPath })({
        runId: opts.runId,
        nodeId: opts.nodeId,
      });
  // cwd must be the store root (directory that contains smithers.db).
  const storeCwd =
    typeof opts.dbPath === "string" && opts.dbPath.endsWith("smithers.db") ? resolve(opts.dbPath, "..") : opts.cwd;
  if (!opts.herdrAvailable) {
    return {
      mode: "hint",
      message: isGate
        ? `no herdr — run: smithers approve ${opts.runId} --node ${opts.nodeId}`
        : `no herdr — run: smithers tail ${opts.runId} --node ${opts.nodeId} --hud --linger`,
    };
  }

  // Reuse a live client when the supervisor already holds one (lower click latency).
  const client = opts.herdrClient ?? createHerdrClient({ logger: () => {} });
  const compatibility = await probeCompatibleHerdr(client);
  if (!compatibility.available) {
    const detail =
      !compatibility.available && compatibility.reason === "protocol_mismatch"
        ? "herdr protocol mismatch"
        : "herdr unavailable";
    return { mode: "hint", message: `${detail} · ${opts.nodeId} · no pane opened` };
  }
  const name = `smithers:${opts.runId}:${opts.nodeId}`;
  // Unique per-run tab label so a finished prior "greet" tab is not reused while
  // a new live run is open (stale linger + closeSeed races).
  const shortRun =
    typeof opts.runId === "string" && opts.runId.length > 10 ? opts.runId.slice(-6) : String(opts.runId ?? "");
  const tabLabel = `${shortNodeId(opts.nodeId)} · ${shortRun}`;

  // Prefer the *current* herdr workspace (cockpit left harness + right overview).
  // openHerdrNodePane creates/finds a per-run workspace by label — wrong for ops
  // dual-control where the human already lives in HERDR_WORKSPACE_ID.
  const envWorkspaceId =
    typeof process.env.HERDR_WORKSPACE_ID === "string" && process.env.HERDR_WORKSPACE_ID !== ""
      ? process.env.HERDR_WORKSPACE_ID
      : undefined;

  if (envWorkspaceId) {
    try {
      // focus:true on open is enough — skip a second awaited pane.focus round-trip.
      const opened = await openTabPane(client, {
        workspaceId: envWorkspaceId,
        label: tabLabel,
        name,
        argv,
        cwd: storeCwd,
        focus: true,
      });
      if (!opened?.paneId) {
        return {
          mode: "hint",
          message: `herdr open failed · ${opts.nodeId} · workspace ${envWorkspaceId}`,
        };
      }
      return {
        mode: "herdr",
        opened: {
          paneId: opened.paneId,
          workspaceId: opened.workspaceId ?? envWorkspaceId,
          tabLabel,
          name,
          nodeId: opts.nodeId,
        },
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        mode: "hint",
        message: `herdr open failed · ${opts.nodeId} · ${detail}`,
      };
    }
  }

  // Outside a herdr pane: legacy find-or-create run workspace.
  const wf = (opts.workflowName || "smithers").replace(/\.(tsx|ts|jsx|js)$/i, "");
  const label = herdrWorkspaceLabel(wf, opts.runId);
  try {
    const opened = await openHerdrNodePane({
      client,
      label,
      cwd: storeCwd,
      runId: opts.runId,
      nodeId: opts.nodeId,
      argv,
      logger: makeHerdrStderrLogger(),
    });
    if (!opened?.paneId) {
      return { mode: "hint", message: `herdr open failed · ${opts.nodeId}` };
    }
    // Focus without blocking the "opened" return path longer than needed.
    void client.tryCall("workspace.focus", { workspace_id: opened.workspaceId }).catch(() => {});
    void client.tryCall("pane.focus", { pane_id: opened.paneId }).catch(() => {});
    return { mode: "herdr", opened };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { mode: "hint", message: `herdr open failed · ${opts.nodeId} · ${detail}` };
  }
}

/**
 * @param {{
 *   db?: string,
 *   cwd?: string,
 *   pollMs?: number,
 *   frameMs?: number,
 *   stdout?: NodeJS.WriteStream,
 *   stdin?: NodeJS.ReadStream,
 *   maxTicks?: number,
 *   source?: import("./SupervisorObservationSource.ts").SupervisorObservationSource,
 * }} opts
 */
export async function runSmithersTop(opts = {}) {
  const pollMs = opts.pollMs ?? POLL_MS;
  const frameMs = opts.frameMs ?? FRAME_MS;
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  // The read seam goes through `source`. The local store is only needed to
  // (a) build the DEFAULT direct-db source when none is injected, and (b) back
  // the still-direct-db herdr detail panes (openNodeDetail). On the gateway
  // path (an injected `source`) a local smithers.db may not exist — opening it
  // is lazy and tolerant: a miss leaves the detail panes unavailable (null
  // dbPath) but the supervisor still runs on the gateway source. On the direct
  // path the store is required, so a missing db fails fast exactly as before.
  /** @type {{ adapter: any, dbPath: string | null, cleanup?: (() => void) | undefined }} */
  let store;
  if (opts.source) {
    try {
      store = await openTopStore({ db: opts.db, cwd: opts.cwd });
    } catch {
      store = { adapter: null, dbPath: null, cleanup: undefined };
    }
  } else {
    store = await openTopStore({ db: opts.db, cwd: opts.cwd });
  }
  const { adapter, dbPath, cleanup } = store;
  // No injected source => build the default direct-db source over the local
  // adapter (guaranteed present on this branch), so the default path is
  // byte-for-byte unchanged.
  const source = opts.source ?? createDirectDbObservationSource(adapter);
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
  const herdrAvailable = await probeHerdr();
  // Keep one herdr client for the supervisor lifetime (faster Enter → tab).
  const herdrClient = herdrAvailable ? createHerdrClient({ logger: () => {} }) : null;

  const hud = createCockpitOutlineHud({
    stdout,
    useAltScreen: Boolean(stdout.isTTY) && process.env.SMITHERS_HUD_NO_ALT !== "1",
  });
  hud.enter();
  // Mouse: wheel scrolls the *view* only; click selects a row. Arrows/j/k move selection.
  const mouseOn = Boolean(stdout.isTTY) && process.env.SMITHERS_TOP_NO_MOUSE !== "1";
  if (mouseOn) {
    // 1000 = button tracking, 1006 = SGR coords, 1007 = alternate scroll (optional)
    stdout.write("\x1b[?1000h\x1b[?1006h");
  }
  if (process.stderr.isTTY) {
    // No local db on the gateway path: report the data-path instead of a null.
    const via = dbPath ?? `via ${source.kind}`;
    process.stderr.write(`[smithers supervisor] ${via}${herdrAvailable ? " · herdr" : ""}\n`);
  }

  let focusIndex = 0;
  /** @type {string | undefined} */
  let focusedRunId;
  let focusPinned = false;
  /** @type {string | undefined} */
  let selectedKey;
  /** @type {Record<string, boolean>} */
  let expandOverrides = {};
  let scrollOffset = 0;
  /** @type {any[]} */
  let fleetCache = [];
  /** @type {Record<string, unknown> | null} */
  let baseInput = null;
  /** @type {any} */
  let lastRun = null;
  let dataTicks = 0;
  let animTick = 0;
  let lastPollAtMs = Date.now();
  /** @type {string} */
  let statusBanner = "";
  /** @type {{ nodeId: string, label: string, lines: import("./cockpit-activity.js").ActivityLine[] } | null} */
  let selectedActivity = null;
  /** @type {string | undefined} */
  let activityForKey;
  /** When true, wheel/page scroll is not yanked back to keep selection in view. */
  let freeScroll = false;
  /** @type {string | null} */
  let lastActivitySig = null;
  /** @type {import("./cockpit-outline-graph.js").OutlineTreeNode[] | null} */
  let outlineRoots = null;
  /** @type {"graph" | "flat"} */
  let outlineSource = "flat";

  const refreshData = async () => {
    fleetCache = await source.listFleet();
    focusIndex = resolveFocusIndex(fleetCache, focusIndex, focusedRunId, {
      pin: focusPinned,
    });
    const built = await source.focusView(fleetCache, focusIndex);
    focusIndex = built.focusIndex;
    focusedRunId = fleetCache[focusIndex]?.runId;
    lastRun = built.run;
    lastPollAtMs = Date.now();
    // sourceKind rides through baseInput → the model → the header tag so the
    // operator can see whether reads come via the gateway or direct-db.
    baseInput = { ...built.input, herdrAvailable, sourceKind: source.kind };
    // Graph-primary outline from last frame BEFORE validating selection —
    // graph group keys (group:…) are not in the flat listNodes model, so
    // validating against flat first would snap selection back to Setup.
    const runId = typeof baseInput.runId === "string" ? baseInput.runId : "";
    if (runId && !runId.startsWith("(")) {
      const graph = await source.outlineTree(runId, baseInput.agentMetaByNode ?? {});
      if (graph?.roots?.length) {
        outlineRoots = graph.roots;
        outlineSource = "graph";
      } else {
        outlineRoots = null;
        outlineSource = "flat";
      }
    } else {
      outlineRoots = null;
      outlineSource = "flat";
    }

    const model = buildCockpitOutlineModel({
      ...baseInput,
      selectedKey,
      expandOverrides,
      scrollOffset,
      lastPollAtMs,
      nowMs: Date.now(),
      outlineRoots: outlineRoots ?? undefined,
      outlineSource,
    });
    if (!selectedKey || !model.selectables.some((s) => s.key === selectedKey)) {
      selectedKey = model.selected?.key;
    }

    // Live activity strip for the focused agent (tool/actions).
    const sel = model.selectables.find((s) => s.key === selectedKey) ?? model.selected;
    if (sel?.kind === "agent" && sel.nodeId && runId && !runId.startsWith("(")) {
      // Direct-db reads durable events; the gateway source drains its
      // background StreamRunEvents ring for the same lines (last-known on a
      // stream drop). Either way this is the focused agent's tool activity.
      const lines = await source.nodeActivity(runId, sel.nodeId, {
        limit: ACTIVITY_STRIP_LINES,
      });
      selectedActivity = {
        nodeId: sel.nodeId,
        label: sel.label || sel.nodeId,
        lines,
      };
      activityForKey = sel.key;
    } else if (sel) {
      setOptimisticActivity(sel);
    } else {
      selectedActivity = null;
      activityForKey = undefined;
    }
    dataTicks += 1;
  };

  const paintFrame = () => {
    if (!baseInput) return;
    animTick += 1;
    // Prefer matching activity for current selection; keep a stable strip shape.
    const activity =
      selectedActivity && activityForKey && activityForKey === selectedKey
        ? selectedActivity
        : selectedKey
          ? {
              nodeId: selectedKey,
              label: selectedKey,
              lines: [],
            }
          : null;
    hud.update({
      ...baseInput,
      nowMs: Date.now(),
      tick: animTick,
      lastPollAtMs,
      selectedKey,
      expandOverrides,
      scrollOffset,
      herdrAvailable,
      statusBanner,
      selectedActivity: activity,
      freeScroll,
      outlineRoots: outlineRoots ?? undefined,
      outlineSource,
    });
    // Sync scroll from paint (clamp or free-scroll bounds).
    if (typeof hud.layout?.scrollOffset === "number") {
      scrollOffset = hud.layout.scrollOffset;
    }
  };

  /**
   * Optimistic activity strip for the current selection (fixed height, no clear→flash).
   * @param {{ key?: string, nodeId?: string | null, label?: string, kind?: string } | null | undefined} sel
   */
  const setOptimisticActivity = (sel) => {
    if (!sel?.key) {
      selectedActivity = null;
      activityForKey = undefined;
      lastActivitySig = null;
      return;
    }
    const nodeId = sel.nodeId || sel.key;
    const label = sel.label || sel.nodeId || sel.key;
    // Keep prior tool lines only if still the same agent; otherwise empty strip.
    const keepLines = selectedActivity && selectedActivity.nodeId === nodeId ? selectedActivity.lines : [];
    selectedActivity = { nodeId, label, lines: keepLines };
    activityForKey = sel.key;
  };

  // Hoisted so the finally can clear them even if the initial refresh throws.
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let dataTimer;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let frameTimer;
  try {
    await refreshData();
    paintFrame();

    dataTimer = setInterval(() => {
      void refreshData()
        .then(() => paintFrame())
        .catch(() => paintFrame());
    }, pollMs);
    if (typeof dataTimer.unref === "function") dataTimer.unref();

    // Animate frames only while the focused run is live (saves work + matches UX:
    // calm overview when nothing is running). Still re-paint on data polls.
    frameTimer = setInterval(() => {
      const live = Boolean(baseInput && baseInput.live);
      if (live) paintFrame();
    }, frameMs);
    if (typeof frameTimer.unref === "function") frameTimer.unref();

    await new Promise((resolvePromise) => {
      if (typeof opts.maxTicks === "number" && opts.maxTicks > 0) {
        const stop = setInterval(() => {
          if (dataTicks >= opts.maxTicks) {
            clearInterval(stop);
            resolvePromise(undefined);
          }
        }, 50);
        return;
      }

      let raw = false;
      try {
        if (stdin.isTTY && typeof stdin.setRawMode === "function") {
          stdin.setRawMode(true);
          raw = true;
        }
      } catch {
        /* ignore */
      }
      if (typeof stdin.resume === "function") stdin.resume();

      const followLive = () => {
        focusPinned = false;
        selectedKey = undefined;
        statusBanner = "";
        void refreshData().then(() => paintFrame());
      };

      const refreshActivityForSelection = () => {
        const runId = typeof baseInput?.runId === "string" ? baseInput.runId : "";
        const key = selectedKey;
        if (!key || !runId || runId.startsWith("(") || !baseInput) {
          return;
        }
        const model = buildCockpitOutlineModel({
          ...baseInput,
          selectedKey: key,
          expandOverrides,
          scrollOffset,
          lastPollAtMs,
          nowMs: Date.now(),
        });
        const sel = model.selected;
        if (!sel) return;
        // Phases: strip shows label only (no DB tool load).
        if (sel.kind !== "agent" || !sel.nodeId) {
          setOptimisticActivity(sel);
          return;
        }
        void source
          .nodeActivity(runId, sel.nodeId, {
            limit: ACTIVITY_STRIP_LINES,
          })
          .then((lines) => {
            if (selectedKey !== key) return;
            const sig = `${sel.nodeId}\0${lines.map((l) => `${l.id}:${l.status}:${l.title}`).join("|")}`;
            if (sig === lastActivitySig) return; // no visual change — skip repaint
            lastActivitySig = sig;
            selectedActivity = {
              nodeId: sel.nodeId,
              label: sel.label || sel.nodeId,
              lines,
            };
            activityForKey = key;
            paintFrame();
          });
      };

      const moveSelection = (delta) => {
        const model = hud.model;
        if (!model?.selectables?.length) return;
        const n = model.selectables.length;
        let idx = (model.selectedIndex + delta + n) % n;
        const next = model.selectables[idx];
        selectedKey = next?.key;
        freeScroll = false; // j/k: keep selection in view
        setOptimisticActivity(next);
        lastActivitySig = null;
        paintFrame();
        refreshActivityForSelection();
      };

      const scrollBy = (delta) => {
        const lay = hud.layout;
        const bodyLen = lay?.bodyLen ?? 0;
        const bodyBudget = lay?.bodyBudget ?? 1;
        // No scroll when content fits the pane.
        if (bodyLen <= bodyBudget) {
          scrollOffset = 0;
          return;
        }
        const maxScroll = Math.max(0, bodyLen - bodyBudget);
        const next = Math.max(0, Math.min(maxScroll, scrollOffset + delta));
        if (next === scrollOffset) return;
        scrollOffset = next;
        freeScroll = true; // wheel/page: do not re-clamp to selection
        paintFrame();
      };

      /**
       * SGR mouse: ESC [ < btn ; col ; row M/m
       * Wheel up=64, down=65 — scroll view only (do not move selection).
       * Trackpads often batch many wheel events in one read — process all.
       * Left click btn=0 — select row under cursor.
       * @param {string} text
       * @returns {boolean} true if consumed
       */
      const handleMouse = (text) => {
        const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
        let m;
        let matched = false;
        let wheelDelta = 0;
        while ((m = re.exec(text)) !== null) {
          matched = true;
          const btn = Number(m[1]);
          const row1 = Number(m[3]); // 1-based terminal row
          const isPress = m[4] === "M";
          // Wheel (press and/or release depending on terminal)
          if (btn === 64) {
            wheelDelta -= 1;
            continue;
          }
          if (btn === 65) {
            wheelDelta += 1;
            continue;
          }
          // Left click select
          if (btn === 0 && isPress) {
            const lay = hud.layout;
            const headerRows = typeof lay?.headerRows === "number" ? lay.headerRows : 0;
            const bodyKeys = Array.isArray(lay?.bodyKeys) ? lay.bodyKeys : [];
            const viewIdx = row1 - 1 - headerRows; // 0-based in visible body
            if (viewIdx < 0 || viewIdx >= (lay?.bodyBudget ?? 0)) continue;
            const absIdx = (lay?.scrollOffset ?? 0) + viewIdx;
            const key = bodyKeys[absIdx];
            if (typeof key === "string" && key !== "") {
              selectedKey = key;
              freeScroll = false;
              const model = buildCockpitOutlineModel({
                ...baseInput,
                selectedKey: key,
                expandOverrides,
                scrollOffset,
                lastPollAtMs,
                nowMs: Date.now(),
              });
              setOptimisticActivity(model.selected);
              lastActivitySig = null;
              paintFrame();
              refreshActivityForSelection();
            }
          }
        }
        if (wheelDelta !== 0) {
          // ~3 rows per discrete notch; trackpads send many notches per gesture.
          scrollBy(wheelDelta * 3);
        }
        return matched;
      };

      const activate = async () => {
        const model = hud.model;
        const sel = model?.selected;
        if (!sel) return;
        if (sel.kind === "phase") {
          // Graph groups use sel.key; legacy flat phases use phase:${id}.
          const id = sel.key || (sel.phaseId ? `phase:${sel.phaseId}` : "");
          if (!id) return;
          const cur = expandOverrides[id] !== undefined ? expandOverrides[id] : true;
          expandOverrides = { ...expandOverrides, [id]: !cur };
          selectedKey = id;
          paintFrame();
          return;
        }
        if (sel.kind === "agent" && sel.nodeId && lastRun?.runId) {
          if (!dbPath) {
            // Gateway source with no local smithers.db: detail panes are
            // still direct-db (openNodeDetail pins the store via --db), so
            // there is nothing to open. Hint instead of failing.
            statusBanner = "no local db for detail panes (gateway source)";
            paintFrame();
            setTimeout(() => {
              statusBanner = "";
            }, 5000);
            return;
          }
          // A gate awaiting a decision opens the approve/deny pane, not the
          // agent steer/inspect tail (s/h are meaningless on a gate).
          const isGate = sel.state === "waiting-approval";
          const mode = isGate ? "approve" : sel.steerable ? "steer" : "inspect";
          statusBanner = `opening ${sel.label || sel.nodeId} (${mode})…`;
          paintFrame();
          const result = await openNodeDetail({
            runId: lastRun.runId,
            nodeId: sel.nodeId,
            workflowName: String(baseInput?.workflowName ?? ""),
            dbPath,
            cwd,
            herdrAvailable,
            herdrClient,
            ...(isGate ? { kind: "gate" } : {}),
          });
          if (result.mode === "herdr" && result.opened) {
            // Gate → approve/deny pane; steerable → live in-progress (s-steer);
            // otherwise read-only inspect.
            statusBanner = isGate
              ? `opened ${result.opened.tabLabel} · approve/deny`
              : sel.steerable
                ? `opened ${result.opened.tabLabel} · steer ready`
                : `opened ${result.opened.tabLabel} · inspect`;
          } else if (result.mode === "hint") {
            statusBanner = result.message ?? "";
          } else {
            statusBanner = "open failed";
          }
          paintFrame();
          setTimeout(() => {
            statusBanner = "";
          }, 5000);
        }
      };

      /** @param {Buffer | string} chunk */
      const onData = (chunk) => {
        const text = chunk.toString();
        if (mouseOn && text.includes("\x1b[<") && handleMouse(text)) return;
        if (/[qQ\u0003]/.test(text)) {
          cleanupKeys();
          resolvePromise(undefined);
          return;
        }
        if (text === "f" || text === "F") {
          followLive();
          return;
        }
        // j/k and arrows move selection (re-clamp viewport to selection).
        // Mouse wheel / PgUp/PgDn / Ctrl-u/d free-scroll without yanking selection.
        if (text === "j" || text === "\x1b[B") moveSelection(1);
        else if (text === "k" || text === "\x1b[A") moveSelection(-1);
        else if (text === "g") {
          freeScroll = false;
          scrollOffset = 0;
          const first = hud.model?.selectables?.[0]?.key;
          if (first) {
            selectedKey = first;
            setOptimisticActivity(hud.model?.selectables?.[0]);
            lastActivitySig = null;
          }
          paintFrame();
          refreshActivityForSelection();
        } else if (text === "G") {
          freeScroll = false;
          const sels = hud.model?.selectables ?? [];
          if (sels.length) {
            selectedKey = sels[sels.length - 1]?.key;
            setOptimisticActivity(sels[sels.length - 1]);
            lastActivitySig = null;
          }
          scrollOffset = 1e9;
          paintFrame();
          refreshActivityForSelection();
        } else if (text === "\u0004") {
          // Ctrl-d half page down
          scrollBy(Math.max(1, Math.floor((hud.layout?.bodyBudget ?? 10) / 2)));
        } else if (text === "\u0015") {
          // Ctrl-u half page up
          scrollBy(-Math.max(1, Math.floor((hud.layout?.bodyBudget ?? 10) / 2)));
        } else if (text.includes("[6~") || text.includes("[5~")) {
          const dir = text.includes("[6~") ? 1 : -1;
          scrollBy(dir * Math.max(1, (hud.layout?.bodyBudget ?? 10) - 1));
        } else if (text === "\r" || text === "\n") void activate();
        else if (text === "r" || text === "R") void refreshData().then(() => paintFrame());
        else if (text === "]" || text === "n") {
          focusPinned = true;
          focusIndex = Math.min(focusIndex + 1, Math.max(0, fleetCache.length - 1));
          focusedRunId = fleetCache[focusIndex]?.runId;
          selectedKey = undefined;
          expandOverrides = {};
          scrollOffset = 0;
          void refreshData().then(() => paintFrame());
        } else if (text === "[" || text === "p") {
          focusPinned = true;
          focusIndex = Math.max(0, focusIndex - 1);
          focusedRunId = fleetCache[focusIndex]?.runId;
          selectedKey = undefined;
          expandOverrides = {};
          scrollOffset = 0;
          void refreshData().then(() => paintFrame());
        }
      };

      const cleanupKeys = () => {
        if (mouseOn) {
          try {
            stdout.write("\x1b[?1006l\x1b[?1000l");
          } catch {
            /* ignore */
          }
        }
        try {
          if (raw && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
        if (typeof stdin.off === "function") stdin.off("data", onData);
        else stdin.removeListener?.("data", onData);
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
      };
      const onSig = () => {
        cleanupKeys();
        resolvePromise(undefined);
      };
      stdin.on("data", onData);
      process.on("SIGINT", onSig);
      process.on("SIGTERM", onSig);
    });
  } finally {
    // Deterministic teardown even if the initial refreshData(), the input
    // loop, or hud.exit() throws — otherwise the gateway source's background
    // activity WebSocket would dangle until the process exits.
    if (dataTimer) clearInterval(dataTimer);
    if (frameTimer) clearInterval(frameTimer);
    try {
      hud.exit();
    } catch {
      /* ignore */
    }
    // Release the gateway source's background activity WebSocket so it never
    // leaks past supervisor exit; no-op on the direct-db source.
    source.dispose?.();
    cleanup?.();
  }
  return { dbPath };
}

/**
 * @param {any} c
 * @param {{
 *   resolveSource?: () => Promise<import("./SupervisorObservationSource.ts").SupervisorObservationSource | undefined>,
 * }} [opts] `resolveSource` is injected by index.js (which owns the gateway
 *   wiring / resolveBrowserGateway) so `--gateway` can pick a poll-over-RPC
 *   source; it runs inside this try so an explicit-url miss surfaces as a fail.
 *   Absent/returns-undefined => the default direct-db source.
 */
export async function runTopCommand(c, opts = {}) {
  const fail = makeFail(c);
  try {
    const interval = c.options?.interval;
    const pollMs = typeof interval === "number" && interval > 0 ? Math.round(interval * 1000) : POLL_MS;
    const source = opts.resolveSource ? await opts.resolveSource() : undefined;
    const result = await runSmithersTop({
      db: c.options?.db,
      cwd: c.options?.cwd,
      pollMs,
      source,
    });
    return c.ok(result);
  } catch (error) {
    return fail({
      code: error instanceof SmithersError ? error.code : "TOP_FAILED",
      message: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    });
  }
}

/** @param {any} c */
function makeFail(c) {
  // incur contexts expose `error`/`ok` — never `fail`. Delegate to `c.error` so
  // `--format json` failures render structured error output (the run's `run(c)`
  // returns this straight to incur); record the exit code so a plain invocation
  // still exits non-zero. Raw stderr only if the context has no `error`.
  return (x) => {
    process.exitCode = x.exitCode ?? 1;
    if (typeof c.error === "function") return c.error(x);
    process.stderr.write(`Error (${x.code}): ${x.message}\n`);
    return undefined;
  };
}
