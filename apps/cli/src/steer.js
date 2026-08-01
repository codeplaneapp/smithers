import { createHerdrClient, workspaceLabelMatches } from "@smithers-orchestrator/herdr";
import { probeCompatibleHerdr } from "./herdr.js";

/**
 * Helpers backing `smithers steer` — the zero-ceremony steering command. Steering
 * is "hand me the live agent session for a run": in a herdr mirror it opens the
 * session as a hijack pane alongside the run's other panes; with no mirror it
 * takes over the current terminal. The command itself lives in `index.js`
 * (`runSteerCommand`, sharing the hijack flow); this module supplies the two
 * pure/soft bits that are worth testing on their own — the active-run resolver
 * (for a bare `smithers steer`) and the herdr-mirror auto-detector.
 */

/** Run statuses that count as "steerable now": a live engine or a durable wait. */
const STEER_ACTIVE_STATUSES = ["running", "waiting-approval", "waiting-event", "waiting-timer"];

/**
 * List the runs a bare `smithers steer` (no run id) could target: every run in a
 * currently-active state, newest first, de-duped by run id. `listRuns("running")`
 * already folds in the `continued` status, so a resumed run is not missed. Used
 * to auto-pick the single active run, or to drive the interactive picker when
 * several are live. Read-only.
 *
 * @param {any} adapter SmithersDb adapter (read-only)
 * @param {number} [limit] per-status scan cap
 * @returns {Promise<any[]>} active run rows, newest first, unique by runId
 */
export async function listActiveRunsForSteer(adapter, limit = 50) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {any[]} */
  const out = [];
  for (const status of STEER_ACTIVE_STATUSES) {
    let rows;
    try {
      rows = await adapter.listRuns(limit, status);
    } catch {
      // Soft: one status query failing must not blank the whole picker.
      continue;
    }
    if (!Array.isArray(rows)) {
      continue;
    }
    for (const row of rows) {
      if (row && typeof row.runId === "string" && !seen.has(row.runId)) {
        seen.add(row.runId);
        out.push(row);
      }
    }
  }
  out.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
  return out;
}

/**
 * Auto-detect whether a herdr workspace mirrors the given run, so `smithers steer`
 * can route the hand-off into that mirror (a hijack pane) instead of the current
 * terminal without the operator naming a session. The client is built from the
 * herdr session-resolution contract (explicit `session` → `HERDR_SOCKET_PATH` /
 * `HERDR_SESSION` env → default socket), so a steer fired from inside a herdr
 * tail pane — where herdr exports `HERDR_SOCKET_PATH` — auto-targets that very
 * session. Matching requires the complete deterministic workspace identity,
 * tolerating only the terminal outcome-marker prefix, so an operator workspace
 * that happens to mention the same run id is never adopted.
 *
 * Fully soft and read-only: any failure (no server reachable, malformed
 * response) resolves to `{ mirrored: false }`, and the caller falls back to a
 * plain current-terminal hand-off.
 *
 * @param {{
 *   runId: string,
 *   label: string,
 *   session?: string | undefined,
 *   client?: import("@smithers-orchestrator/herdr").HerdrClient,
 *   logger?: import("@smithers-orchestrator/herdr").HerdrLogger,
 * }} params
 * @returns {Promise<{ mirrored: boolean, socketPath: string, workspaceId?: string }>}
 */
export async function detectHerdrMirrorForRun(params) {
  const client = params.client ?? createHerdrClient({ session: params.session, logger: params.logger ?? (() => {}) });
  const socketPath = client.socketPath;
  const compatibility = await probeCompatibleHerdr(client);
  if (!compatibility.available) {
    return { mirrored: false, socketPath };
  }
  const list = await client.tryCall("workspace.list", {}).catch(() => undefined);
  const workspaces = list && Array.isArray(list.workspaces) ? list.workspaces : [];
  for (const ws of workspaces) {
    if (!ws || typeof ws.label !== "string") {
      continue;
    }
    if (workspaceLabelMatches(ws.label, params.label)) {
      return {
        mirrored: true,
        socketPath,
        workspaceId: typeof ws.workspace_id === "string" ? ws.workspace_id : undefined,
      };
    }
  }
  return { mirrored: false, socketPath };
}

/**
 * Parse an attempt's `metaJson` into an object, tolerantly (a malformed / absent
 * blob yields `{}`), mirroring the hijack candidate resolver.
 *
 * @param {string | null | undefined} metaJson
 * @returns {Record<string, unknown>}
 */
function parseAttemptMeta(metaJson) {
  if (!metaJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether an attempt's meta identifies an AGENT attempt (as opposed to a
 * compute/static/human node). An agent attempt carries `kind: "agent"` or a
 * recorded `agentEngine`; either is sufficient.
 *
 * @param {Record<string, unknown>} meta
 * @returns {boolean}
 */
function isAgentAttemptMeta(meta) {
  return meta.kind === "agent" || typeof meta.agentEngine === "string";
}

/**
 * The distinct node ids of OTHER agent nodes currently mid-generate (an
 * `in-progress` agent attempt) for a run, excluding `targetNodeId`. This is the
 * blast radius of a run-wide takeover: the hijack aborts the shared run signal,
 * so every one of these in-flight siblings is cancelled and re-runs on resume.
 * Read-only; drawn from the same attempt table the hijack candidate resolver
 * reads, so "in-flight agent node" means exactly what the engine will abort.
 *
 * @param {any} adapter SmithersDb adapter (read-only)
 * @param {string} runId
 * @param {string | undefined} targetNodeId the node being taken over (excluded)
 * @returns {Promise<string[]>} sibling node ids, sorted, unique
 */
export async function countInFlightAgentSiblings(adapter, runId, targetNodeId) {
  const attempts = await adapter.listAttemptsForRun(runId);
  /** @type {Set<string>} */
  const siblings = new Set();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (!attempt || attempt.state !== "in-progress") {
      continue;
    }
    if (typeof attempt.nodeId !== "string" || attempt.nodeId === targetNodeId) {
      continue;
    }
    if (isAgentAttemptMeta(parseAttemptMeta(attempt.metaJson))) {
      siblings.add(attempt.nodeId);
    }
  }
  return [...siblings].sort();
}

/**
 * Resolve the node a bare `smithers steer <runId> "message"` should target when
 * no `--node` is given: the newest agent node currently mid-generate (the run's
 * "current" agent). A steer to that node lands on its next agent step. Returns
 * `undefined` when the run has no in-flight agent node — the caller then asks the
 * operator to name one with `--node`. An explicit `--node` always wins. Read-only.
 *
 * @param {any} adapter SmithersDb adapter (read-only)
 * @param {string} runId
 * @param {string | undefined} explicitNode `--node` value, if any
 * @returns {Promise<string | undefined>}
 */
export async function resolveSteerTargetNode(adapter, runId, explicitNode) {
  if (typeof explicitNode === "string" && explicitNode !== "") {
    return explicitNode;
  }
  const attempts = await adapter.listAttemptsForRun(runId);
  /** @type {any} */
  let best;
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (!attempt || attempt.state !== "in-progress" || typeof attempt.nodeId !== "string") {
      continue;
    }
    if (!isAgentAttemptMeta(parseAttemptMeta(attempt.metaJson))) {
      continue;
    }
    if (!best || (attempt.startedAtMs ?? 0) > (best.startedAtMs ?? 0)) {
      best = attempt;
    }
  }
  return best ? best.nodeId : undefined;
}

/**
 * Whether `nodeId` names a real node in the run — i.e. a node the run has actually
 * instantiated (present in `_smithers_nodes`). Used to validate an explicit
 * `--node` before queueing a steer: a `--node` that matches no node in the run
 * would queue a steer keyed to a node that never runs, so it would silently expire
 * at run end instead of ever landing. Read-only, and fail-open — if the node list
 * can't be read we return `true` rather than block a legitimate steer. The pane
 * `s` key always names its own in-flight node (present here), so it is unaffected.
 *
 * @param {any} adapter SmithersDb adapter (read-only)
 * @param {string} runId
 * @param {string} nodeId
 * @returns {Promise<boolean>}
 */
export async function nodeExistsInRun(adapter, runId, nodeId) {
  /** @type {any} */
  let nodes;
  try {
    nodes = await adapter.listNodes(runId);
  } catch {
    // Soft: an unreadable node list must not block steering.
    return true;
  }
  if (!Array.isArray(nodes)) {
    return true;
  }
  return nodes.some((node) => node && node.nodeId === nodeId);
}

/**
 * The exact, honest warning `smithers steer --takeover` prints when a run has
 * OTHER in-flight agent nodes: a run-wide hijack aborts them and they re-run on
 * resume, so the operator must consciously accept the loss. Callers require a
 * `y` confirmation (or `--yes`) after showing it.
 *
 * @param {string[]} siblingNodeIds the in-flight agent siblings that would be aborted
 * @returns {string}
 */
export function formatTakeoverWarning(siblingNodeIds) {
  const n = siblingNodeIds.length;
  const names = siblingNodeIds.join(", ");
  return (
    `⚠ Takeover is run-wide: it aborts ${n} in-flight sibling${n === 1 ? "" : "s"} ` +
    `(${names}); they re-run on resume.`
  );
}

/**
 * The author stamped on a steer queued from the CLI: the OS user, else a generic
 * "cli" marker. Purely descriptive (surfaced in `inspect`/events), never a
 * security boundary.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveSteerAuthor(env = process.env) {
  const user = env.USER || env.USERNAME || env.LOGNAME;
  return typeof user === "string" && user.trim() !== "" ? user : "cli";
}
