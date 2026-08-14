import pc from "picocolors";
import { buildDigestBlock, buildFleetStrip, digestSignature } from "@smthrs/herdr";

/**
 * Run-level overview block for `smithers tail <run> --overview`. Renders a
 * periodic per-node status board (node id · state · attempt), a summary of any
 * queued steers, and action CTA lines when something is blocked or
 * failed (a one-key affordance — in a node's tab press `s` to steer it with a
 * steer or `h` to hijack, and `y`/`n` in a gate tab to answer — plus the
 * exact `approve` / `steer` command to run), and a compact queue summary when the
 * run has more than a handful of nodes. Optional fleet strip (multi-run) and
 * deterministic digest (no LLM). `pc.dim` self-disables on a non-TTY, so the
 * secondary command lines stay plain (and deterministic) when piped or tested.
 * The tail loop calls {@link overviewSignature} to reprint the board only when
 * it actually changes (digest has its own signature for interval updates).
 */

/** Node states that are attention-worthy; when a run has many nodes only these are listed individually. */
export const ATTENTION_STATES = new Set([
  "in-progress",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "failed",
]);

/** Node count above which the per-node list is trimmed to attention-worthy nodes and a queue summary line is added. */
export const OVERVIEW_QUEUE_SUMMARY_THRESHOLD = 8;

/** Cap on the number of CTA lines appended, so a large fan-out cannot flood the board. */
export const MAX_OVERVIEW_CTAS = 6;

const OVERVIEW_ACTIVE_RUN_STATES = new Set([
  "running",
  "in-progress",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
]);

/** Keep only the highest iteration for each logical node. */
function currentOverviewNodes(nodes) {
  const byId = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node?.nodeId) continue;
    const previous = byId.get(node.nodeId);
    if (!previous || (node.iteration ?? 0) >= (previous.iteration ?? 0)) byId.set(node.nodeId, node);
  }
  return [...byId.values()];
}

/**
 * @param {string | null | undefined} state
 * @returns {string}
 */
export function overviewStateLabel(state) {
  switch (state) {
    case "in-progress":
      return "working";
    case "waiting-approval":
      return "blocked · approval";
    case "waiting-event":
      return "blocked · event";
    case "waiting-timer":
      return "waiting · timer";
    case "pending":
      return "pending";
    case "finished":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return String(state ?? "unknown");
  }
}

/**
 * Color the state column for a TTY overview board (no-op when colors disabled).
 * @param {string | null | undefined} state
 * @param {string} label
 */
export function colorOverviewState(state, label) {
  switch (state) {
    case "in-progress":
      return pc.cyan(label);
    case "waiting-approval":
    case "waiting-event":
      return pc.yellow(label);
    case "failed":
      return pc.red(label);
    case "finished":
      return pc.green(label);
    case "cancelled":
      return pc.dim(label);
    default:
      return label;
  }
}

/**
 * A stable signature of the run's derived status + every node's (id, state,
 * attempt). The tail loop reprints the board only when this changes, so an
 * append-only tail is not spammed with an identical board every poll.
 *
 * @param {string | undefined} status
 * @param {Array<{ nodeId: string, state?: string | null, iteration?: number | null, lastAttempt?: number | null }>} nodes
 * @param {string} [digestSig] optional digest signature (interval / state)
 * @param {string} [fleetSig] optional fleet strip signature
 * @returns {string}
 */
export function overviewSignature(status, nodes, digestSig = "", fleetSig = "") {
  const parts = currentOverviewNodes(nodes)
    .map((n) => `${n.nodeId}\u0000${n.iteration ?? 0}\u0000${n.state ?? ""}\u0000${n.lastAttempt ?? ""}`)
    .sort();
  return `${status ?? ""}\u0001${parts.join("\u0001")}\u0001${digestSig}\u0001${fleetSig}`;
}

/**
 * Build digest input from the same node list the overview board uses.
 *
 * @param {{
 *   runId: string;
 *   status: string | undefined;
 *   nodes: Array<{ nodeId: string, state?: string | null }>;
 *   queuedSteers?: Array<{ nodeId: string }>;
 *   startedAtMs?: number | null;
 *   nowMs?: number;
 *   lastEventSummary?: string;
 * }} input
 * @returns {import("@smthrs/herdr").buildDigestBlock extends Function ? Parameters<typeof buildDigestBlock>[0] : any}
 */
export function buildDigestInputFromOverview(input) {
  const nodes = currentOverviewNodes(input.nodes);
  const tallies = tallyNodes(nodes);
  const activeNodeIds = nodes.filter((n) => n.state === "in-progress").map((n) => n.nodeId);
  const attentionLines = [];
  for (const n of nodes) {
    if (n.state === "waiting-approval") {
      attentionLines.push(`${n.nodeId} blocked`);
    } else if (n.state === "failed") {
      attentionLines.push(`${n.nodeId} failed`);
    }
  }
  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now();
  const started = typeof input.startedAtMs === "number" ? input.startedAtMs : undefined;
  return {
    runId: input.runId,
    status: input.status,
    elapsedMs: started != null ? Math.max(0, nowMs - started) : undefined,
    working: tallies.working,
    blocked: tallies.blocked,
    failed: tallies.failed,
    done: tallies.done,
    activeNodeIds,
    attentionLines,
    queuedSteerCount: Array.isArray(input.queuedSteers) ? input.queuedSteers.length : 0,
    lastEventSummary: input.lastEventSummary,
    nowMs,
  };
}

/**
 * @param {Array<{ nodeId: string, state?: string | null }>} nodes
 * @returns {{ working: number, blocked: number, failed: number, done: number, other: number }}
 */
export function tallyNodes(nodes) {
  const counts = { working: 0, blocked: 0, failed: 0, done: 0, other: 0 };
  for (const n of nodes) {
    switch (n.state) {
      case "in-progress":
        counts.working += 1;
        break;
      case "waiting-approval":
      case "waiting-event":
      case "waiting-timer":
        counts.blocked += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "finished":
        counts.done += 1;
        break;
      default:
        counts.other += 1;
        break;
    }
  }
  return counts;
}

/**
 * Build the overview board text (always ends with a newline).
 *
 * @param {{
 *   runId: string,
 *   status: string | undefined,
 *   nodes: Array<{ nodeId: string, state?: string | null, iteration?: number | null, lastAttempt?: number | null }>,
 *   pendingApprovals?: Array<{ nodeId: string, iteration?: number | null }>,
 *   queuedSteers?: Array<{ nodeId: string }>,
 *   fleetRuns?: Array<{ runId: string, status?: string, label?: string, blocked?: number }>,
 *   focusedRunId?: string,
 *   includeDigest?: boolean,
 *   startedAtMs?: number | null,
 *   nowMs?: number,
 *   lastEventSummary?: string,
 * }} input
 * @returns {string}
 */
export function buildOverviewBlock(input) {
  const nodes = currentOverviewNodes(input.nodes);
  const pendingApprovals = Array.isArray(input.pendingApprovals) ? input.pendingApprovals : [];
  const queuedSteers = Array.isArray(input.queuedSteers) ? input.queuedSteers : [];
  const total = nodes.length;
  const many = total > OVERVIEW_QUEUE_SUMMARY_THRESHOLD;
  const fleet = buildFleetStrip(input.fleetRuns ?? [], input.focusedRunId ?? input.runId);
  const lines = [""];
  if (fleet) {
    lines.push(fleet);
  }
  const statusRaw = input.status ?? "unknown";
  const statusPretty =
    statusRaw === "running" || statusRaw === "in-progress"
      ? pc.cyan(statusRaw)
      : statusRaw === "failed"
        ? pc.red(statusRaw)
        : statusRaw === "finished"
          ? pc.green(statusRaw)
          : statusRaw;
  lines.push(`── cockpit overview · run ${input.runId} · ${statusPretty} · ${total} node${total === 1 ? "" : "s"} ──`);
  lines.push(pc.dim("  harness ← left pane  ·  this board → right  ·  detail in sibling tabs"));

  // Per-node board. With many nodes, list only attention-worthy nodes (the rest
  // roll up into the queue summary) so the board stays legible under a fan-out.
  // Attention-first sort when listing all (small runs): blocked/failed before calm.
  const listedBase = many ? nodes.filter((n) => ATTENTION_STATES.has(String(n.state ?? ""))) : nodes;
  const rank = (state) => {
    const s = String(state ?? "");
    if (s === "failed") return 0;
    if (s === "waiting-approval" || s === "waiting-event") return 1;
    if (s === "in-progress") return 2;
    if (s === "waiting-timer" || s === "pending") return 3;
    return 4;
  };
  const listed = [...listedBase].sort((a, b) => rank(a.state) - rank(b.state) || a.nodeId.localeCompare(b.nodeId));
  const nameWidth = Math.max(
    4,
    listed.reduce((w, n) => Math.max(w, n.nodeId.length), 0),
  );
  const stateWidth = 18;
  if (listed.length > 0) {
    lines.push(pc.dim(`  ${"node".padEnd(nameWidth)}  ${"state".padEnd(stateWidth)}  attempt`));
  }
  for (const n of listed) {
    const attempt = typeof n.lastAttempt === "number" ? n.lastAttempt : 0;
    const stateLabel = overviewStateLabel(n.state);
    const stateCol = colorOverviewState(n.state, stateLabel.padEnd(stateWidth));
    lines.push(`  ${n.nodeId.padEnd(nameWidth)}  ${stateCol}  ${attempt}`);
  }
  if (many && listed.length === 0) {
    lines.push("  (no nodes need attention)");
  }

  // Queued steers: a run-level line per target node so the supervisor
  // sees pending steers that have not yet been consumed (they land on the node's
  // next agent step). Grouped by node, insertion order preserved.
  if (queuedSteers.length > 0) {
    /** @type {Map<string, number>} */
    const byNode = new Map();
    for (const steer of queuedSteers) {
      const node = steer && typeof steer.nodeId === "string" ? steer.nodeId : "?";
      byNode.set(node, (byNode.get(node) ?? 0) + 1);
    }
    for (const [node, count] of byNode) {
      lines.push(`  ↪ ${count} steer${count === 1 ? "" : "s"} queued → ${node} (lands on its next agent step)`);
    }
  }

  // Action CTAs: the exact command to unblock each waiting gate / steer each
  // failed node. Gates are keyed by pending-approval rows (falling back to
  // waiting-approval nodes), failures by failed node state.
  /** @type {string[]} */
  const ctas = [];
  const gateKeys = new Set();
  const addGate = (nodeId, iteration) => {
    const key = `${nodeId}\u0000${iteration ?? 0}`;
    if (gateKeys.has(key) || ctas.length >= MAX_OVERVIEW_CTAS) {
      return;
    }
    gateKeys.add(key);
    ctas.push(`  ▶ approve  smithers approve ${input.runId} --node ${nodeId} --iteration ${iteration ?? 0}`);
  };
  for (const approval of pendingApprovals) {
    addGate(approval.nodeId, approval.iteration ?? 0);
  }
  for (const n of nodes) {
    if (n.state === "waiting-approval") {
      addGate(n.nodeId, n.iteration ?? 0);
    }
  }
  const activeRun = OVERVIEW_ACTIVE_RUN_STATES.has(String(input.status ?? ""));
  for (const n of nodes) {
    if (n.state === "failed" && ctas.length < MAX_OVERVIEW_CTAS) {
      if (activeRun) {
        ctas.push(`  ▶ steer    ${n.nodeId} failed — in its node tab press s to steer · h to hijack, or run:`);
        ctas.push(
          `             ${pc.dim(`smithers steer ${input.runId} --node ${n.nodeId} "…"  ·  smithers steer ${input.runId} --node ${n.nodeId} --takeover`)}`,
        );
      } else {
        ctas.push(`  ▶ hijack   ${n.nodeId} failed — smithers steer ${input.runId} --node ${n.nodeId} --takeover`);
      }
    }
  }
  lines.push(...ctas);

  // Compact queue summary once the run is large enough to make the per-node board
  // unwieldy on its own.
  if (many) {
    const c = tallyNodes(nodes);
    lines.push(`  ${c.working} working / ${c.blocked} blocked / ${c.failed} failed / ${c.done} done`);
  }

  // Deterministic digest (product freeze: no LLM; cheap to refresh on interval).
  if (input.includeDigest !== false) {
    const digestIn = buildDigestInputFromOverview({
      runId: input.runId,
      status: input.status,
      nodes,
      queuedSteers,
      startedAtMs: input.startedAtMs,
      nowMs: input.nowMs,
      lastEventSummary: input.lastEventSummary,
    });
    const digestText = buildDigestBlock(digestIn).trimEnd();
    if (digestText) {
      lines.push(digestText);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Signature for the digest portion alone (for interval-driven board refresh).
 * @param {Parameters<typeof buildDigestInputFromOverview>[0]} input
 */
export function overviewDigestSignature(input) {
  return digestSignature(buildDigestInputFromOverview(input));
}
