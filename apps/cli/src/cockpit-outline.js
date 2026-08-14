/**
 * Cockpit outline model + paint — herdr-first workflow overview.
 *
 * Layout:
 *   - Vertical spine of phases (full separator between phases)
 *   - Single-agent phase = one selectable row
 *   - Multi-agent phase = phase header + vertical nested agent rows
 *
 * Structure without stored graph: consecutive worker-like node ids form a
 * parallel phase; other nodes are single-agent phases (DB insertion order).
 */

import pc from "picocolors";
import { buildDigestBlock, formatElapsed, isLikelyWorkerNodeId } from "@smthrs/herdr";
import { sanitizeTerminalText } from "@smthrs/tui/src/sanitizeTerminalText.ts";
import { ACTIVITY_STRIP_LINES, formatActivityPlain } from "./cockpit-activity.js";
import { flattenOutlineTree, outlinePhasesToTree } from "./cockpit-outline-graph.js";
import { buildDigestInputFromOverview, overviewStateLabel } from "./tail-overview.js";

/**
 * Outline fan-out: workers plus smithering-style multi-agent prefixes
 * (research:*, probe:*, review:* except synthesis).
 * @param {string} nodeId
 */
export function isOutlineFanoutNodeId(nodeId) {
  if (isLikelyWorkerNodeId(nodeId)) return true;
  const id = String(nodeId ?? "");
  if (id === "") return false;
  if (/:synthesis$/i.test(id)) return false;
  if (/^(?:research|probe|review):/i.test(id)) return true;
  return false;
}

/**
 * Parallel phase title from first agent id prefix (research / probe / review / parallel).
 * @param {string[]} nodeIds
 */
export function fanoutPhaseTitle(nodeIds) {
  const first = nodeIds[0] ?? "";
  const m = String(first).match(/^(research|probe|review)(?=:)/i);
  if (m) return m[1].toLowerCase();
  if (nodeIds.every((id) => isLikelyWorkerNodeId(id))) return "parallel";
  return "parallel";
}

const ESC = "\x1b";
const CLEAR_HOME = `${ESC}[H${ESC}[2J`;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const brand = {
  mark: (s) => pc.bold(pc.cyan(s)),
  title: (s) => pc.bold(s),
  dim: (s) => pc.dim(s),
  muted: (s) => pc.gray(s),
  ok: (s) => pc.green(s),
  warn: (s) => pc.yellow(s),
  err: (s) => pc.red(s),
  live: (s) => pc.cyan(s),
  bar: (s) => pc.dim(s),
  sel: (s) => pc.inverse(s),
  // Live/working agent name (not selection).
  hot: (s) => pc.bold(s),
  // Selection highlight — distinct from LIVE cyan.
  pick: (s) => pc.bold(pc.yellow(s)),
  // Soft success — done work recedes so live work wins the eye.
  okDim: (s) => pc.dim(pc.green(s)),
};

/**
 * Fixed outline columns:
 *   [caret][ ][tree…][name ……][ ][status][ ][attempts][ ][backend][ ][model…]
 *
 * Tree is spine-only (├─ │ └─). Name absorbs leftover tree budget so right
 * columns share one edge.
 */
const TREE_BUDGET = 6; // max tree prefix width (nested "│ ├─ ")
const STATE_W = 8; // "canceled" / "status  "
const ATT_W = 8; // "attempts"
const BACKEND_W = 11; // "backend" / claude-code / opencode

/**
 * Terminal display columns (fullwidth / wide CJK ≈ 2).
 * @param {string} s
 */
export function displayWidth(s) {
  const plain = String(s).replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0xff01 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe10 && c <= 0xfe19) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0x20000 && c <= 0x3fffd) ||
      c === 0x3000
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * Pad to width without inventing an ellipsis when the line is already exact-width
 * (full-width rules used to become `──…` because of `>=`).
 * @param {string} s
 * @param {number} width
 */
function padVis(s, width) {
  const dw = displayWidth(s);
  if (dw > width) {
    // Truncate by display width (fullwidth-safe).
    const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
    let acc = "";
    let w = 0;
    for (const ch of plain) {
      const cw = displayWidth(ch);
      if (w + cw > width - 1) break;
      acc += ch;
      w += cw;
    }
    return acc + "…";
  }
  if (dw === width) return s;
  return s + " ".repeat(width - dw);
}

/**
 * @param {string} s
 * @param {number} width
 */
function clipLine(s, width) {
  const dw = displayWidth(s);
  if (dw < width) return padVis(s, width);
  if (dw === width) return s;
  return padVis(s, width);
}

/**
 * OpenCode-style wordmark is a custom SVG block typeface (filled rectangles per
 * letter), not a system font. In a 1-row TTY we approximate with fullwidth
 * Latin + bold + soft rails — fat, grey/white, no cyan.
 * @param {string} s
 */
export function toFullwidthLatin(s) {
  return [...String(s)]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(0xff21 + (c - 0x41));
      if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(0xff41 + (c - 0x61));
      if (c === 0x20) return "\u3000";
      return ch;
    })
    .join("");
}

/** Brass #cab16a (truecolor when supported). */
function brass(s) {
  if (pc.isColorSupported === false) return s;
  return `\x1b[38;2;202;177;106m${s}\x1b[39m`;
}

/** Compact wordmark for the title bar (right) — bold brass SMITHERS. */
function smithersMark() {
  return pc.bold(brass("SMITHERS"));
}

/**
 * Three-zone title: left | center | right (no overlap).
 * Right mark is never clipped (SMITHERS stays intact); center shrinks first.
 * @param {string} left
 * @param {string} center
 * @param {string} right
 * @param {number} cols
 */
export function layoutTitleBar(left, center, right, cols) {
  const w = Math.max(40, cols);
  const lw = displayWidth(left);
  const rw = displayWidth(right);
  let C = center;
  let cw = displayWidth(C);
  // Reserve right mark + left + gaps; shrink center if needed.
  const minGaps = (lw > 0 ? 1 : 0) + (rw > 0 ? 1 : 0);
  const maxCenter = Math.max(0, w - lw - rw - minGaps);
  if (cw > maxCenter) {
    // Truncate center by display width.
    const plain = String(C).replace(/\x1b\[[0-9;]*m/g, "");
    let acc = "";
    let aw = 0;
    for (const ch of plain) {
      const cwch = displayWidth(ch);
      if (aw + cwch > Math.max(0, maxCenter - 1)) break;
      acc += ch;
      aw += cwch;
    }
    C = maxCenter > 0 ? `${acc}…` : "";
    cw = displayWidth(C);
  }
  let cStart = Math.floor((w - cw) / 2);
  const minC = lw + (lw > 0 ? 1 : 0);
  const maxC = w - rw - cw - (rw > 0 ? 1 : 0);
  if (cStart < minC) cStart = minC;
  if (maxC >= minC && cStart > maxC) cStart = maxC;
  const leftGap = Math.max(0, cStart - lw);
  const afterCenter = cStart + cw;
  const rightStart = w - rw;
  const midGap = Math.max(0, rightStart - afterCenter);
  const line = left + " ".repeat(leftGap) + C + " ".repeat(midGap) + right;
  // Exact visual width: pad if short (never clip the right mark).
  const dw = displayWidth(line);
  if (dw < w) return line + " ".repeat(w - dw);
  return line;
}

/**
 * @param {string | null | undefined} state
 */
export function isActiveNodeState(state) {
  const s = String(state ?? "");
  return s === "in-progress" || s === "waiting-approval" || s === "waiting-event" || s === "waiting-timer";
}

/**
 * @param {string | null | undefined} state
 */
function isFailedState(state) {
  return String(state ?? "") === "failed";
}

/**
 * @param {string | null | undefined} state
 */
function isDoneState(state) {
  const s = String(state ?? "");
  return s === "finished" || s === "skipped" || s === "cancelled" || s === "canceled";
}

/**
 * Split attempt meta into harness backend vs model (+ effort).
 *
 * Effort only appears when the engine persisted it on the attempt
 * (`effort` / `reasoningEffort` / OpenCode `variant` / Pi `thinking`).
 *
 * @param {Record<string, unknown> | null | undefined} meta
 * @returns {{ backend: string, model: string, effort: string, modelLine: string }}
 */
export function parseAgentIdentity(meta) {
  if (!meta || typeof meta !== "object") {
    return { backend: "", model: "", effort: "", modelLine: "" };
  }
  const modelRaw =
    (typeof meta.agentModel === "string" && meta.agentModel) || (typeof meta.model === "string" && meta.model) || "";
  const engineRaw =
    (typeof meta.agentEngine === "string" && meta.agentEngine) ||
    (typeof meta.agentFamily === "string" && meta.agentFamily) ||
    (typeof meta.engine === "string" && meta.engine) ||
    (typeof meta.cliEngine === "string" && meta.cliEngine) ||
    "";
  const effortRaw =
    (typeof meta.effort === "string" && meta.effort) ||
    (typeof meta.reasoningEffort === "string" && meta.reasoningEffort) ||
    (typeof meta.modelEffort === "string" && meta.modelEffort) ||
    (typeof meta.effortLevel === "string" && meta.effortLevel) ||
    (typeof meta.variant === "string" && meta.variant) ||
    (typeof meta.thinking === "string" && meta.thinking) ||
    "";

  let backend = "";
  if (engineRaw && engineRaw !== "Object" && engineRaw !== "[object Object]") {
    const eng = engineRaw.trim();
    if (/opencode/i.test(eng)) backend = "opencode";
    else if (/claude[-_ ]?code|ClaudeCode/i.test(eng) || /^claude$/i.test(eng)) backend = "claude-code";
    else if (/codex/i.test(eng)) backend = "codex";
    else if (/grok/i.test(eng)) backend = "grok";
    else if (/^pi\b|PiAgent/i.test(eng) && !/openai/i.test(eng)) backend = "pi";
    else if (/openai/i.test(eng)) backend = "openai";
    else if (/gemini|antigravity/i.test(eng)) backend = "gemini";
    else if (/hermes/i.test(eng)) backend = "hermes";
    else if (/kimi/i.test(eng)) backend = "kimi";
    else if (/amp/i.test(eng)) backend = "amp";
    else if (/scripted/i.test(eng)) backend = "scripted";
    else {
      backend = eng
        .replace(/Agent$/i, "")
        .replace(/^Smithers/i, "")
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .trim();
    }
  } else if (modelRaw === "scripted-agent" || /scripted/i.test(modelRaw)) {
    backend = "scripted";
  }

  // Display short model: drop vendor prefix already implied by backend
  // (claude-sonnet-5 → sonnet-5 next to backend "claude-code").
  const model = shortModelId(modelRaw === "scripted-agent" ? "scripted-agent" : modelRaw, backend);
  const effort = effortRaw && String(effortRaw) !== "true" && String(effortRaw) !== "false" ? String(effortRaw) : "";
  const modelLine = [model, effort].filter(Boolean).join(" ").trim();
  return { backend, model, effort, modelLine };
}

/**
 * Shorten model id for the model column when backend already names the vendor.
 * @param {string} modelRaw
 * @param {string} backend
 */
export function shortModelId(modelRaw, backend) {
  const m = String(modelRaw ?? "").trim();
  if (!m) return "";
  const b = String(backend ?? "").toLowerCase();
  // claude-code / claude → drop leading claude-
  if ((b === "claude-code" || b === "claude" || b === "") && /^claude[-_]/i.test(m)) {
    return m.replace(/^claude[-_]/i, "");
  }
  // codex / openai → drop openai/ prefix if present; keep gpt-5.5 as-is (distinct id)
  if ((b === "codex" || b === "openai") && /^openai\//i.test(m)) {
    return m.replace(/^openai\//i, "");
  }
  // opencode grok → drop grok- only when backend is already grok? keep full for clarity
  if (b === "opencode" && /^opencode[-_]/i.test(m)) {
    return m.replace(/^opencode[-_]/i, "");
  }
  return m;
}

/**
 * Compact single-line identity (backend model effort) for tests / other surfaces.
 *
 * @param {Record<string, unknown> | null | undefined} meta
 * @returns {string}
 */
export function formatAgentIdentity(meta) {
  const { backend, model, effort } = parseAgentIdentity(meta);
  const parts = [];
  if (backend) parts.push(backend);
  if (model && model.toLowerCase() !== backend) parts.push(model);
  if (effort) parts.push(effort);
  return parts.join(" ").trim();
}

/**
 * Human-facing title for a node: author `label` when set, else nodeId.
 * @param {{ nodeId: string, label?: string | null }} n
 */
export function nodeDisplayLabel(n) {
  const raw = typeof n?.label === "string" ? n.label.trim() : "";
  if (raw !== "") return raw;
  return String(n?.nodeId ?? "");
}

/**
 * @param {Array<{ nodeId: string, state?: string | null, lastAttempt?: number | null, iteration?: number | null, updatedAtMs?: number | null, label?: string | null }>} nodes
 * @param {Record<string, Record<string, unknown>>} [metaByNode]
 * @returns {{ phases: OutlinePhase[], selectables: OutlineSelectable[] }}
 */
export function buildOutlineFromNodes(nodes, metaByNode = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  // Prefer highest iteration per nodeId (current leaf view).
  /** @type {Map<string, (typeof list)[0]>} */
  const byId = new Map();
  for (const n of list) {
    if (!n?.nodeId) continue;
    const prev = byId.get(n.nodeId);
    const it = typeof n.iteration === "number" ? n.iteration : 0;
    const pit = prev && typeof prev.iteration === "number" ? prev.iteration : 0;
    if (!prev || it >= pit) byId.set(n.nodeId, n);
  }
  const ordered = [...byId.values()];

  /** @type {OutlinePhase[]} */
  const phases = [];
  /** @type {typeof ordered} */
  let workerBuf = [];

  const flushWorkers = () => {
    if (workerBuf.length === 0) return;
    const agents = workerBuf.map((n) => toAgent(n, metaByNode[n.nodeId]));
    // Lone fan-out id (e.g. research:design-art) paints as a single phase.
    if (agents.length === 1) {
      const a = agents[0];
      phases.push({
        id: `single:${a.nodeId}`,
        kind: "single",
        title: a.displayName,
        agents: [a],
        expanded: true,
      });
      workerBuf = [];
      return;
    }
    const title = fanoutPhaseTitle(agents.map((a) => a.nodeId));
    const id = `parallel:${agents
      .map((a) => a.nodeId)
      .join("+")
      .slice(0, 48)}`;
    phases.push({
      id,
      kind: "parallel",
      title,
      agents,
      expanded: shouldExpandPhase(agents),
    });
    workerBuf = [];
  };

  for (const n of ordered) {
    if (isOutlineFanoutNodeId(n.nodeId)) {
      // Split fan-out groups when the prefix changes (research → probe → review).
      if (workerBuf.length > 0) {
        const prevTitle = fanoutPhaseTitle(workerBuf.map((x) => x.nodeId));
        const nextTitle = fanoutPhaseTitle([n.nodeId]);
        if (prevTitle !== nextTitle) flushWorkers();
      }
      workerBuf.push(n);
    } else {
      flushWorkers();
      const agent = toAgent(n, metaByNode[n.nodeId]);
      phases.push({
        id: `single:${n.nodeId}`,
        kind: "single",
        title: agent.displayName,
        agents: [agent],
        expanded: true,
      });
    }
  }
  flushWorkers();

  /** @type {OutlineSelectable[]} */
  const selectables = [];
  for (const phase of phases) {
    if (phase.kind === "single") {
      const a = phase.agents[0];
      if (a) {
        selectables.push({
          key: a.nodeId,
          phaseId: phase.id,
          nodeId: a.nodeId,
          label: a.displayName,
          state: a.state,
          attempt: a.attempt,
          kind: "agent",
        });
      }
    } else {
      // Phase header is selectable for expand/collapse; agents listed when expanded
      selectables.push({
        key: `phase:${phase.id}`,
        phaseId: phase.id,
        nodeId: null,
        label: phase.title,
        state: phaseStatus(phase.agents),
        attempt: 0,
        kind: "phase",
      });
      if (phase.expanded) {
        for (const a of phase.agents) {
          selectables.push({
            key: a.nodeId,
            phaseId: phase.id,
            nodeId: a.nodeId,
            label: a.displayName,
            state: a.state,
            attempt: a.attempt,
            kind: "agent",
          });
        }
      }
    }
  }

  return { phases, selectables };
}

/**
 * @param {{ nodeId: string, state?: string | null, lastAttempt?: number | null, label?: string | null }} n
 * @param {Record<string, unknown> | undefined} meta
 */
function toAgent(n, meta) {
  const displayName = nodeDisplayLabel(n);
  const iteration = typeof n.iteration === "number" && n.iteration > 0 ? n.iteration : 0;
  const id = parseAgentIdentity(meta);
  return {
    nodeId: n.nodeId,
    displayName,
    state: n.state ?? "pending",
    attempt: typeof n.lastAttempt === "number" ? n.lastAttempt : 0,
    iteration,
    stateLabel: overviewStateLabel(n.state),
    backend: id.backend,
    modelLine: id.modelLine,
    // Compact identity kept for callers/tests that still read one string.
    identity: formatAgentIdentity(meta),
  };
}

/**
 * 1-based loop iteration label for a phase (empty when still on first pass).
 * Unbounded loops only show current iter — never a fake `/max`.
 * @param {OutlineAgent[]} agents
 */
export function phaseLoopLabel(agents) {
  let maxIt = 0;
  for (const a of agents) {
    const it = typeof a.iteration === "number" ? a.iteration : 0;
    if (it > maxIt) maxIt = it;
  }
  if (maxIt <= 0) return "";
  return `iter ${maxIt + 1}`;
}

/**
 * Only live in-progress agents are steerable (steer). Others may still be opened for inspect.
 * @param {string} state
 * @param {boolean} runLive
 */
export function isSteerableAgent(state, runLive) {
  return runLive === true && String(state ?? "") === "in-progress";
}

/**
 * Default expand policy for parallel phases.
 * Always expanded so large pending fan-outs (probe/workers) match research UX;
 * user can still collapse with Enter / expandOverrides.
 * @param {OutlineAgent[]} _agents
 */
function shouldExpandPhase(_agents) {
  return true;
}

/**
 * @param {OutlineAgent[]} agents
 */
function phaseStatus(agents) {
  if (agents.some((a) => isActiveNodeState(a.state))) return "in-progress";
  if (agents.some((a) => isFailedState(a.state))) return "failed";
  if (agents.length > 0 && agents.every((a) => isDoneState(a.state))) return "finished";
  if (agents.some((a) => String(a.state) === "pending")) return "pending";
  return agents[0]?.state ?? "pending";
}

/**
 * @param {OutlineAgent[]} agents
 */
function phaseTallies(agents) {
  let w = 0;
  let b = 0;
  let f = 0;
  let d = 0;
  for (const a of agents) {
    const s = String(a.state);
    if (s === "in-progress") w += 1;
    else if (s === "waiting-approval" || s === "waiting-event" || s === "waiting-timer") b += 1;
    else if (s === "failed") f += 1;
    else if (isDoneState(s)) d += 1;
  }
  return { w, b, f, d, n: agents.length };
}

/**
 * @typedef {{ nodeId: string, displayName: string, state: string, attempt: number, iteration: number, stateLabel: string, identity?: string }} OutlineAgent
 * @typedef {{ id: string, kind: "single" | "parallel", title: string, agents: OutlineAgent[], expanded: boolean, loopLabel?: string }} OutlinePhase
 * @typedef {{ key: string, phaseId: string, nodeId: string | null, label: string, state: string, attempt: number, kind: "agent" | "phase", identity?: string, steerable?: boolean }} OutlineSelectable
 */

/**
 * Compact deterministic digest lines for the supervisor (no LLM).
 * Omits run/status/elapsed (already on the run strip); keeps tallies,
 * active nodes, attention, and queued steers.
 *
 * @param {Parameters<typeof buildDigestInputFromOverview>[0]} input
 * @returns {string[]} plain lines (no ANSI); empty when nothing useful
 */
export function formatSupervisorDigestLines(input) {
  const dig = buildDigestInputFromOverview(input);
  /** @type {string[]} */
  const lines = [];
  const w = dig.working ?? 0;
  const b = dig.blocked ?? 0;
  const f = dig.failed ?? 0;
  const d = dig.done ?? 0;
  const hasNodes = w + b + f + d > 0 || (Array.isArray(input.nodes) && input.nodes.length > 0);
  if (hasNodes) {
    lines.push(`${w} working · ${b} blocked · ${f} failed · ${d} done`);
  }
  const active = Array.isArray(dig.activeNodeIds) ? dig.activeNodeIds.filter(Boolean) : [];
  if (active.length > 0) {
    lines.push(`active: ${active.slice(0, 8).join(", ")}${active.length > 8 ? "…" : ""}`);
  }
  const attention = Array.isArray(dig.attentionLines) ? dig.attentionLines.filter(Boolean) : [];
  const parts = [];
  if (attention.length > 0) {
    parts.push(attention.slice(0, 4).join(" · "));
  }
  if (typeof dig.queuedSteerCount === "number" && dig.queuedSteerCount > 0) {
    parts.push(`steers: ${dig.queuedSteerCount} queued`);
  }
  if (typeof dig.lastEventSummary === "string" && dig.lastEventSummary !== "") {
    parts.push(`last: ${dig.lastEventSummary}`);
  }
  if (parts.length > 0) {
    lines.push(parts.join(" · "));
  }
  // Fallback: full block if we somehow have digest text but no compact lines
  if (lines.length === 0) {
    const full = buildDigestBlock(dig).trim();
    if (full) {
      // drop header + run line; keep remaining body lines
      const body = full.split("\n").filter((ln) => !ln.startsWith("── digest") && !ln.startsWith("run "));
      return body;
    }
  }
  return lines;
}

/**
 * Run-level tallies across all outline agents.
 * @param {OutlinePhase[]} phases
 */
export function outlineTallies(phases) {
  let w = 0;
  let b = 0;
  let f = 0;
  let d = 0;
  let p = 0;
  let n = 0;
  for (const phase of phases) {
    for (const a of phase.agents) {
      n += 1;
      const s = String(a.state);
      if (s === "in-progress") w += 1;
      else if (s === "waiting-approval" || s === "waiting-event" || s === "waiting-timer") b += 1;
      else if (s === "failed") f += 1;
      else if (isDoneState(s)) d += 1;
      else if (s === "pending") p += 1;
    }
  }
  return { w, b, f, d, p, n };
}

/**
 * Pending nodes after a hard fail (or terminal cancel) were never reached.
 * @param {string} state
 * @param {string} runStatus
 * @param {boolean} runLive
 */
export function effectiveDisplayState(state, runStatus, runLive) {
  const s = String(state ?? "");
  if (!runLive && isActiveNodeState(s)) return "stale";
  if (
    s === "pending" &&
    !runLive &&
    (runStatus === "failed" || runStatus === "cancelled" || runStatus === "canceled")
  ) {
    return "not-reached";
  }
  return s;
}

/**
 * @param {string} state
 */
export function outlineStateLabel(state) {
  if (state === "stale") return "stale";
  if (state === "not-reached") return "not reached";
  return overviewStateLabel(state);
}

/**
 * @param {{
 *   runId: string,
 *   workflowName?: string,
 *   status?: string,
 *   nodes?: any[],
 *   startedAtMs?: number,
 *   finishedAtMs?: number | null,
 *   nowMs?: number,
 *   live?: boolean,
 *   tick?: number,
 *   lastPollAtMs?: number,
 *   selectedKey?: string,
 *   expandOverrides?: Record<string, boolean>,
 *   agentMetaByNode?: Record<string, Record<string, unknown>>,
 *   liveElsewhere?: boolean,
 *   herdrAvailable?: boolean,
 *   sourceKind?: "direct-db" | "gateway",
 *   footer?: string,
 *   statusBanner?: string,
 *   scrollOffset?: number,
 *   selectedActivity?: {
 *     nodeId?: string,
 *     label?: string,
 *     lines?: Array<{
 *       id?: string,
 *       kind?: string,
 *       title?: string,
 *       status?: "running" | "done" | "error" | "info",
 *       detail?: string,
 *       seq?: number,
 *     }>,
 *   } | null,
 *   freeScroll?: boolean,
 *   outlineRoots?: import("./cockpit-outline-graph.js").OutlineTreeNode[],
 *   outlineSource?: "graph" | "flat",
 *   queuedSteers?: Array<{ nodeId: string, status?: string }>,
 *   lastEventSummary?: string,
 * }} input
 */
export function buildCockpitOutlineModel(input) {
  const nowMs = input.nowMs ?? Date.now();
  const startedAtMs = input.startedAtMs ?? nowMs;
  const statusEarly = input.status ?? "unknown";
  const terminal =
    input.live === false ||
    ["finished", "failed", "cancelled", "canceled", "stale", "orphaned", "succeeded"].includes(statusEarly);
  const endMs =
    terminal && typeof input.finishedAtMs === "number" && input.finishedAtMs > 0
      ? input.finishedAtMs
      : terminal && typeof input.lastPollAtMs === "number"
        ? // fallback: freeze at last known time if finishedAt missing (stale kills)
          Math.min(nowMs, input.lastPollAtMs)
        : nowMs;
  // Prefer finishedAtMs for true terminal runs; for stale use max node update if available
  const elapsedEnd = (() => {
    if (!terminal) return nowMs;
    if (typeof input.finishedAtMs === "number" && input.finishedAtMs > startedAtMs) {
      return input.finishedAtMs;
    }
    // Stale / aborted: freeze using latest node update from model nodes
    const nodes = Array.isArray(input.nodes) ? input.nodes : [];
    let maxU = 0;
    for (const n of nodes) {
      if (typeof n?.updatedAtMs === "number" && n.updatedAtMs > maxU) maxU = n.updatedAtMs;
    }
    if (maxU > startedAtMs) return maxU;
    return endMs;
  })();
  const elapsedMs = Math.max(0, elapsedEnd - startedAtMs);
  const metaByNode = input.agentMetaByNode && typeof input.agentMetaByNode === "object" ? input.agentMetaByNode : {};
  /** @type {Record<string, boolean>} */
  const overrides = {
    ...(input.expandOverrides && typeof input.expandOverrides === "object" ? input.expandOverrides : {}),
  };
  const selectedKey = input.selectedKey;
  const status = input.status ?? "unknown";
  // Prefer explicit `live` from top (derived engine state). Never treat stale/orphaned as live.
  const liveFromStatus =
    ["running", "waiting-approval", "waiting-event", "waiting-timer", "paused", "continued"].includes(status) &&
    status !== "stale" &&
    status !== "orphaned";
  const live = typeof input.live === "boolean" ? input.live : liveFromStatus;

  // Graph-primary outline when roots provided; else flat listNodes heuristic.
  const outlineSource = Array.isArray(input.outlineRoots) && input.outlineRoots.length > 0 ? "graph" : "flat";
  const { phases: rawPhases } = buildOutlineFromNodes(input.nodes ?? [], metaByNode);
  const phasesForTree = rawPhases.map((p) => ({
    ...p,
    loopLabel: phaseLoopLabel(p.agents),
  }));
  /** @type {import("./cockpit-outline-graph.js").OutlineTreeNode[]} */
  let outlineRoots = outlineSource === "graph" ? input.outlineRoots : outlinePhasesToTree(phasesForTree);

  // Force-expand ancestors of the selection so the focused node is always listed.
  if (selectedKey) {
    const forceKeys = new Set();
    const findPath = (nodes, trail) => {
      for (const n of nodes ?? []) {
        const next = [...trail, n.key];
        if (n.key === selectedKey || n.nodeId === selectedKey) {
          for (const k of trail) forceKeys.add(k);
          return true;
        }
        if (n.children?.length && findPath(n.children, next)) return true;
      }
      return false;
    };
    findPath(outlineRoots, []);
    if (forceKeys.size > 0) {
      for (const k of forceKeys) {
        if (overrides[k] !== false) overrides[k] = true;
      }
    }
  }

  const flatTree = flattenOutlineTree(outlineRoots, overrides);
  /** @type {OutlineSelectable[]} */
  const selectables = flatTree.selectables.map((s) => ({
    ...s,
    steerable: s.kind === "agent" ? isSteerableAgent(s.state, live) : false,
  }));

  // Legacy phases view kept for tallies / tests that still read model.phases
  const phases = phasesForTree.map((p) => {
    const loopLabel = p.loopLabel ?? phaseLoopLabel(p.agents);
    if (p.kind !== "parallel") {
      return { ...p, loopLabel };
    }
    let expanded = p.expanded;
    const phaseKey = `phase:${p.id}`;
    if (Object.prototype.hasOwnProperty.call(overrides, phaseKey)) {
      expanded = overrides[phaseKey] === true;
    } else if (Object.prototype.hasOwnProperty.call(overrides, p.id)) {
      expanded = overrides[p.id] === true;
    }
    return { ...p, expanded, loopLabel };
  });

  let selectedIndex = selectables.findIndex((s) => s.key === selectedKey);
  if (selectedIndex < 0) {
    // Prefer first steerable (running) agent, else any active, else first agent
    selectedIndex = selectables.findIndex((s) => s.kind === "agent" && s.steerable);
    if (selectedIndex < 0) {
      selectedIndex = selectables.findIndex((s) => s.kind === "agent" && isActiveNodeState(s.state));
    }
    if (selectedIndex < 0) {
      selectedIndex = selectables.findIndex((s) => s.kind === "agent");
    }
    if (selectedIndex < 0) selectedIndex = 0;
  }

  const selected = selectables[selectedIndex] ?? null;
  const tallies = outlineTallies(phases);
  const scrollOffset =
    typeof input.scrollOffset === "number" && input.scrollOffset > 0 ? Math.floor(input.scrollOffset) : 0;

  // Deterministic digest (no LLM) — same tallies source as overview HUD.
  const digestNodes = phasesForTree.flatMap((phase) =>
    phase.agents.map((agent) => ({
      nodeId: agent.nodeId,
      state: agent.state,
      lastAttempt: agent.attempt,
      iteration: agent.iteration,
    })),
  );
  const digestLines = formatSupervisorDigestLines({
    runId: String(input.runId ?? ""),
    status,
    nodes: digestNodes,
    queuedSteers: Array.isArray(input.queuedSteers) ? input.queuedSteers : [],
    startedAtMs: input.startedAtMs,
    nowMs,
    lastEventSummary: typeof input.lastEventSummary === "string" ? input.lastEventSummary : undefined,
  });

  /** @type {{ nodeId: string, label: string, lines: Array<{ id: string, kind: string, title: string, status: "running"|"done"|"error"|"info", detail: string, seq: number }>, kind: "agent" | "phase" } | null} */
  let selectedActivity = null;
  if (selected) {
    const raw = input.selectedActivity;
    const rawLines = Array.isArray(raw?.lines) ? raw.lines : [];
    const lines =
      selected.kind === "agent"
        ? rawLines
            .map((line, i) => ({
              id: String(line?.id ?? `a-${i}`),
              kind: String(line?.kind ?? "action"),
              title: String(line?.title ?? line?.kind ?? "action"),
              status:
                line?.status === "running" ||
                line?.status === "done" ||
                line?.status === "error" ||
                line?.status === "info"
                  ? line.status
                  : "info",
              detail: typeof line?.detail === "string" ? line.detail : "",
              seq: typeof line?.seq === "number" ? line.seq : i,
            }))
            .slice(0, ACTIVITY_STRIP_LINES)
        : [];
    selectedActivity = {
      nodeId: selected.nodeId || selected.key || "",
      label: selected.label || selected.nodeId || selected.key || "selection",
      lines,
      kind: selected.kind === "phase" ? "phase" : "agent",
    };
  }

  return {
    runId: input.runId,
    workflowName: input.workflowName ?? "",
    status,
    elapsedLabel: formatElapsed(elapsedMs),
    phases,
    outlineRoots,
    outlineRows: flatTree.rows,
    outlineSource,
    selectables,
    selectedIndex: Math.max(0, selectedIndex),
    selected,
    selectedActivity,
    tallies,
    digestLines,
    tick: typeof input.tick === "number" ? input.tick : 0,
    pollAgeMs: Math.max(0, nowMs - (input.lastPollAtMs ?? nowMs)),
    live,
    liveElsewhere: input.liveElsewhere === true,
    herdrAvailable: input.herdrAvailable === true,
    // The read path answering the supervisor: rendered as a small header tag.
    sourceKind: input.sourceKind === "gateway" || input.sourceKind === "direct-db" ? input.sourceKind : undefined,
    statusBanner: typeof input.statusBanner === "string" ? input.statusBanner : "",
    scrollOffset,
    // freeScroll: wheel/page keys move the viewport without yanking back to selection
    freeScroll: input.freeScroll === true,
    footer:
      input.footer ??
      (input.herdrAvailable
        ? "j/k select  ·  Enter tab  ·  g/G top/end  ·  [ ] runs  ·  q quit"
        : "j/k select  ·  Enter  ·  g/G  ·  [ ] runs  ·  q quit"),
  };
}

/**
 * Clamp scroll so selection stays in the body viewport.
 * @param {number} scrollOffset
 * @param {number} selectedBodyIndex  index in body rows (-1 if unknown)
 * @param {number} bodyLen
 * @param {number} bodyBudget
 */
export function clampScrollToSelection(scrollOffset, selectedBodyIndex, bodyLen, bodyBudget) {
  const maxScroll = Math.max(0, bodyLen - bodyBudget);
  let s = Math.max(0, Math.min(maxScroll, Math.floor(scrollOffset)));
  if (selectedBodyIndex < 0 || bodyBudget <= 0) return s;
  if (selectedBodyIndex < s) s = selectedBodyIndex;
  if (selectedBodyIndex >= s + bodyBudget) s = selectedBodyIndex - bodyBudget + 1;
  return Math.max(0, Math.min(maxScroll, s));
}

/**
 * Compact run-level status for the supervisor strip (not raw engine enum).
 * Display set: running | waiting | finished | failed | stopped
 *
 * @param {string | null | undefined} status
 * @param {boolean} [live]
 */
export function supervisorRunStatus(status, live) {
  const s = String(status ?? "");
  if (s === "failed") return "failed";
  if (s === "finished" || s === "succeeded") return "finished";
  if (s === "cancelled" || s === "canceled" || s === "stale" || s === "orphaned") {
    return "stopped";
  }
  if (
    s === "waiting-approval" ||
    s === "waiting-event" ||
    s === "waiting-timer" ||
    s === "waiting-quota" ||
    s === "paused"
  ) {
    return "waiting";
  }
  if (s === "running" || s === "continued" || live === true) return "running";
  if (s === "idle" || s === "") return "stopped";
  // Unknown non-terminal → running if live, else stopped
  return live ? "running" : "stopped";
}

/**
 * Short fixed-width state tokens so the state column never reflows.
 * @param {string} state
 */
export function shortOutlineState(state) {
  /** @type {string} */
  let tok;
  switch (String(state ?? "")) {
    case "in-progress":
      tok = "work";
      break;
    case "finished":
      tok = "done";
      break;
    case "failed":
      tok = "fail";
      break;
    case "pending":
      tok = "pend";
      break;
    case "stale":
      tok = "stal";
      break;
    case "not-reached":
      tok = "skip";
      break;
    case "waiting-approval":
      tok = "gate";
      break;
    case "waiting-event":
      tok = "wait";
      break;
    case "waiting-timer":
      tok = "time";
      break;
    case "cancelled":
    case "canceled":
      tok = "canceled";
      break;
    case "skipped":
      tok = "skip";
      break;
    default:
      tok = String(state ?? "?");
  }
  return tok.slice(0, STATE_W);
}

/**
 * @param {string} tree
 * @returns {number}
 */
export function treePlainLen(tree) {
  return String(tree ?? "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * @param {ReturnType<typeof buildCockpitOutlineModel>} model
 * @param {{ rows: number, cols: number }} size
 */
export function renderCockpitOutlineFrame(model, size) {
  const cols = Math.max(40, Math.min(size.cols || 80, 240));
  const rows = Math.max(10, Math.min(size.rows || 24, 200));
  /** @type {string[]} */
  const lines = [];
  const push = (s = "") => lines.push(clipLine(sanitizeTerminalText(String(s), { preserveSgr: true }), cols));
  // Full-width rule — exact `cols` dashes (no trailing …).
  const hline = () => lines.push(brand.bar("─".repeat(cols)));

  // Title bar: LIVE/IDLE far left · Workflow Supervisor centered · SMITHERS mark right.
  const isStale = model.status === "stale" || model.status === "orphaned";
  const liveTag = model.live
    ? brand.live("LIVE")
    : isStale
      ? brand.warn("STALE")
      : model.liveElsewhere
        ? brand.warn("LIVE elsewhere")
        : brand.muted("IDLE");
  // Data-path indicator next to LIVE/IDLE so the operator knows whether reads
  // come via the workspace gateway or directly from the local SQLite store.
  const sourceTag =
    model.sourceKind === "gateway"
      ? brand.dim("via gateway")
      : model.sourceKind === "direct-db"
        ? brand.dim("direct")
        : "";
  const leftZone = sourceTag ? `${liveTag} ${sourceTag}` : liveTag;
  const centerTitle = brand.title("Workflow Supervisor");
  const rightMark = smithersMark();
  // Do not clipLine the title bar — that can eat the trailing S of SMITHERS.
  // Layout into cols-1: many hosts (herdr/iTerm) clip the final cell of a
  // full-width line, which was showing as "SMITHER" (missing trailing S).
  const titleCols = Math.max(40, cols - 1);
  const titleLine = layoutTitleBar(leftZone, centerTitle, rightMark, titleCols);
  const titleDw = displayWidth(titleLine);
  lines.push(titleDw < cols ? titleLine + " ".repeat(cols - titleDw) : titleLine);
  hline();

  // Single run strip: workflow · id · status · time.
  // Prefer full names when the TTY is wide enough; only truncate when needed.
  const wfFull = (model.workflowName || "—").replace(/\.(tsx|ts|jsx|js)$/i, "");
  const runIdFull = String(model.runId || "");
  const runStatus = supervisorRunStatus(model.status, model.live);
  const stPaint =
    runStatus === "running"
      ? brand.live
      : runStatus === "waiting"
        ? brand.warn
        : runStatus === "failed"
          ? brand.err
          : runStatus === "finished"
            ? brand.ok
            : brand.muted;
  const sep = brand.dim(" · ");
  const buildRunLine = (wfShow, runShow) =>
    [
      `${brand.dim("workflow:")} ${brand.title(wfShow)} ${brand.dim(`(${runShow})`)}`,
      `${brand.dim("status:")} ${stPaint(runStatus)}`,
      `${brand.dim("time:")} ${model.elapsedLabel}`,
    ].join(sep);
  let runLine = buildRunLine(wfFull, runIdFull);
  // Fit into cols-1 (leading space). Truncate run id first, then workflow name.
  if (displayWidth(` ${runLine}`) > cols) {
    const budget = Math.max(20, cols - 1);
    const fit = (wfShow, runShow) => {
      const line = buildRunLine(wfShow, runShow);
      return displayWidth(` ${line}`) <= budget ? line : null;
    };
    let runShow = runIdFull;
    let wfShow = wfFull;
    // Shrink run id gradually
    while (runShow.length > 8 && !fit(wfShow, runShow)) {
      runShow = `${runShow.slice(0, Math.max(6, runShow.length - 4))}…`;
    }
    runLine = fit(wfShow, runShow) ?? buildRunLine(wfShow, runShow);
    // Then shrink workflow name
    while (wfShow.length > 8 && displayWidth(` ${runLine}`) > budget) {
      wfShow = `${wfShow.slice(0, Math.max(6, wfShow.length - 4))}…`;
      runLine = buildRunLine(wfShow, runShow);
    }
  }
  push(` ${runLine}`);
  if (isStale) {
    push(brand.warn("  engine heartbeat lost — not running (cancel or start a new fixture)"));
  }
  if (model.liveElsewhere) {
    push(brand.warn("  ● live run elsewhere — press f to follow"));
  }
  // Deterministic digest (tallies / active / attention). No fleet strip —
  // multi-run switch stays on [ ] / f keys only.
  // Shrink on short TTYs so the tree keeps at least a few rows.
  const digestPlain = Array.isArray(model.digestLines)
    ? model.digestLines.map((l) => String(l)).filter((l) => l.trim() !== "")
    : [];
  const headerSoFar = lines.length;
  const footerGuess = 3;
  const minTree = 3;
  const digestBudget = Math.max(0, rows - headerSoFar - footerGuess - minTree);
  const digestShow = digestPlain.slice(0, Math.min(3, digestBudget));
  for (const dl of digestShow) {
    // First line = tallies (slightly brighter); rest dim attention detail.
    const isTally = /^\d+ working/.test(dl);
    push(` ${isTally ? brand.title(dl) : brand.dim(dl)}`);
  }
  // Transient toasts (opened tab, errors) go in the footer — never expand the header.

  hline();

  const selectedKey = model.selected?.key;
  // Footer: rule + optional full-width status/error line + key hints.
  // Status never shares the keys row (right-side toast was clipped).
  const hasStatus = typeof model.statusBanner === "string" && model.statusBanner.trim() !== "";
  const footerBase = hasStatus ? 3 : 2;
  const headerUsed = lines.length;
  // Activity strip: separator + label + up to N lines. Shrink/hide on short TTYs
  // so the workflow tree keeps at least a few rows.
  const wantActivity = model.selectedActivity != null;
  const freeForBodyAndActivity = Math.max(0, rows - headerUsed - footerBase);
  const minBody = Math.min(3, freeForBodyAndActivity);
  const activityCap = wantActivity
    ? Math.max(0, freeForBodyAndActivity - minBody - 2) // -2 for rule + label
    : 0;
  const activityLines = Math.min(ACTIVITY_STRIP_LINES, activityCap);
  const showActivity = wantActivity && activityLines > 0;
  const activityReserve = showActivity ? 1 + 1 + activityLines : 0;
  const footerReserve = footerBase + activityReserve;
  const bodyBudget = Math.max(0, rows - headerUsed - footerReserve);

  const outlineRows = Array.isArray(model.outlineRows) ? model.outlineRows : null;
  const hasTree = (outlineRows && outlineRows.length > 0) || (Array.isArray(model.phases) && model.phases.length > 0);

  // Tree prefix width must fit the deepest nested group (│  │  └─ …), not a
  // shallow TREE_BUDGET of 6 — otherwise deep rows shove status/model columns.
  /** @param {boolean[]} isLastStack */
  const treePrefixFor = (isLastStack) => {
    const stack = Array.isArray(isLastStack) ? isLastStack : [true];
    let tree = "";
    const depth = Math.max(0, stack.length - 1);
    for (let d = 0; d < depth; d++) tree += stack[d] ? "   " : "│  ";
    tree += stack[depth] ? "└─ " : "├─ ";
    return tree;
  };
  let treeBudget = TREE_BUDGET;
  if (outlineRows && outlineRows.length > 0) {
    for (const row of outlineRows) {
      const t = treePrefixFor(row.isLast);
      treeBudget = Math.max(treeBudget, treePlainLen(t));
    }
  }
  // Cap so name/model still fit on narrow TTYs.
  treeBudget = Math.min(treeBudget, Math.max(TREE_BUDGET, Math.floor(cols * 0.35)));

  // caret(1)+sp + treeBudget + nameW + sp + STATUS + sp + ATTEMPTS + sp + BACKEND + sp + model
  const fixedChrome = 1 + 1 + treeBudget + 1 + STATE_W + 1 + ATT_W + 1 + BACKEND_W + 1;
  // Wide TTYs: give the tree name more room; model keeps the remainder.
  const nameW = Math.max(12, Math.min(40, cols - fixedChrome - 18));
  const modelW = Math.max(8, cols - fixedChrome - nameW - 1);

  /** @type {{ text: string, key: string | null }[]} */
  const body = [];
  const pushBody = (text, key = null) => body.push({ text, key });

  // Column legend (subtle, not washed-out)
  if (bodyBudget > 4 && hasTree) {
    const left = `${" ".repeat(2)}${" ".repeat(treeBudget)}${"workflow tree".padEnd(nameW)}`;
    const right = `${"status".padEnd(STATE_W)} ${"attempts".padStart(ATT_W)} ${"backend".padEnd(BACKEND_W)} model`;
    pushBody(brand.muted(padVis(`${left} ${right}`, cols)));
  }

  if (!hasTree) {
    pushBody(brand.dim("  (no nodes yet — waiting for workflow…)"));
  } else if (outlineRows && outlineRows.length > 0) {
    // Graph / unified tree paint (supports nested parallel groups).
    for (const row of outlineRows) {
      const n = row.node;
      const tree = treePrefixFor(row.isLast);
      if (n.kind === "group") {
        const expand = n.expanded === false ? "▸" : "▾";
        const childCount = n.children?.length ?? 0;
        const name = `${n.label || n.groupType || "group"} ${expand}`;
        pushBody(
          formatOutlineRow({
            sel: selectedKey === n.key,
            tree,
            treeBudget,
            name,
            state: effectiveDisplayState(n.state, model.status, model.live),
            attempt: 0,
            backend: "",
            modelLine: childCount > 0 ? `${childCount} nodes` : "",
            nameW,
            modelW,
            cols,
            nameIsPhase: true,
            tick: model.tick,
            runLive: model.live,
          }),
          n.key,
        );
      } else {
        pushBody(
          formatOutlineRow({
            sel: selectedKey === n.key || selectedKey === n.nodeId,
            tree,
            treeBudget,
            name: n.label || n.nodeId || n.key,
            state: effectiveDisplayState(n.state, model.status, model.live),
            attempt: n.attempt ?? 0,
            backend: n.backend || "",
            modelLine: n.modelLine || n.identity || "",
            nameW,
            modelW,
            cols,
            tick: model.tick,
            runLive: model.live,
          }),
          n.key,
        );
      }
    }
  } else {
    // Legacy phase paint (should be rare once outlineRows always populated).
    const nPhases = model.phases.length;
    for (let pi = 0; pi < nPhases; pi++) {
      const phase = model.phases[pi];
      const lastPhase = pi === nPhases - 1;
      const d0 = lastPhase ? "└─ " : "├─ ";
      const cont = lastPhase ? "   " : "│  ";
      const loopBit = phase.loopLabel ? ` · ${phase.loopLabel}` : "";
      if (phase.kind === "single") {
        const a = phase.agents[0];
        if (!a) continue;
        pushBody(
          formatOutlineRow({
            sel: selectedKey === a.nodeId,
            tree: d0,
            name: a.displayName || a.nodeId,
            state: effectiveDisplayState(a.state, model.status, model.live),
            attempt: a.attempt,
            backend: a.backend || "",
            modelLine: a.modelLine || a.identity || "",
            nameW,
            modelW,
            cols,
            tick: model.tick,
            runLive: model.live,
          }),
          a.nodeId,
        );
      } else {
        const t = phaseTallies(phase.agents);
        const phaseKey = `phase:${phase.id}`;
        pushBody(
          formatOutlineRow({
            sel: selectedKey === phaseKey,
            tree: d0,
            name: `${phase.title}${loopBit} ${phase.expanded ? "▾" : "▸"}`,
            state: effectiveDisplayState(phaseStatus(phase.agents), model.status, model.live),
            attempt: 0,
            backend: "",
            modelLine: `${t.n} agents`,
            nameW,
            modelW,
            cols,
            nameIsPhase: true,
            tick: model.tick,
            runLive: model.live,
          }),
          phaseKey,
        );
      }
    }
  }

  const selectedBodyIndex = body.findIndex((b) => b.key && b.key === selectedKey);
  const maxScroll = Math.max(0, body.length - bodyBudget);
  // freeScroll (wheel/page): keep user viewport. Selection moves re-clamp.
  const scroll =
    model.freeScroll === true
      ? Math.max(0, Math.min(maxScroll, Math.floor(model.scrollOffset ?? 0)))
      : clampScrollToSelection(model.scrollOffset ?? 0, selectedBodyIndex, body.length, bodyBudget);
  const clipped = body.slice(scroll, scroll + bodyBudget);
  for (const row of clipped) push(row.text);
  while (lines.length < rows - footerReserve) push("");
  while (lines.length > rows - footerReserve) lines.pop();

  if (showActivity && model.selectedActivity) {
    hline();
    const actLabel = model.selectedActivity.label || model.selectedActivity.nodeId || "agent";
    const actHead = brand.muted(` activity · ${actLabel}`);
    push(padVis(actHead, cols));
    const actLines = model.selectedActivity.lines ?? [];
    const isPhase = model.selectedActivity.kind === "phase";
    for (let i = 0; i < activityLines; i++) {
      const line = actLines[i];
      if (!line) {
        const empty = i === 0 ? (isPhase ? "  · phase · Enter expand/collapse" : "  · no recent tools") : "";
        push(padVis(brand.dim(empty), cols));
        continue;
      }
      const plain = formatActivityPlain(line);
      const painted =
        line.status === "running"
          ? brand.live(` ${plain}`)
          : line.status === "done"
            ? brand.okDim(` ${plain}`)
            : line.status === "error"
              ? brand.err(` ${plain}`)
              : brand.dim(` ${plain}`);
      push(padVis(painted, cols));
    }
  }

  hline();
  const selLabel = model.selected?.label || model.selected?.nodeId || "";
  const steerable = model.selected?.steerable === true;
  const scrollHint =
    body.length > bodyBudget
      ? brand.dim(`${scroll + 1}–${Math.min(body.length, scroll + bodyBudget)}/${body.length}`)
      : "";
  const hint =
    model.selected?.kind === "agent" && model.selected.nodeId
      ? model.herdrAvailable
        ? steerable
          ? `Enter → steer ${selLabel}`
          : `Enter → inspect ${selLabel}`
        : steerable
          ? `Enter → ${selLabel}`
          : `Enter → inspect ${selLabel}`
      : model.selected?.kind === "phase"
        ? "Enter expand/collapse"
        : "";
  // Full-width status/error line ABOVE key guidance (never clipped on the right).
  if (hasStatus) {
    const raw = String(model.statusBanner).replace(/\s+/g, " ").trim();
    const isErr = /fail|error|not found|unknown flag/i.test(raw);
    const painted = isErr ? brand.warn(` ${raw}`) : brand.live(` ${raw}`);
    push(padVis(painted, cols));
  }
  const footLeft = [brand.dim(model.footer), hint ? brand.dim(hint) : "", scrollHint]
    .filter(Boolean)
    .join(brand.dim("  ·  "));
  push(padVis(` ${footLeft}`, cols));

  while (lines.length < rows) lines.push(clipLine("", cols));
  // Attach scroll meta for the controller (non-enumerable-safe via return object path)
  const out = lines.slice(0, rows);
  /** @type {any} */
  const tagged = out;
  tagged.scrollOffset = scroll;
  tagged.bodyLen = body.length;
  tagged.bodyBudget = bodyBudget;
  tagged.selectedBodyIndex = selectedBodyIndex;
  // Row map for mouse click → body index (legend rows have key null).
  tagged.bodyKeys = body.map((b) => b.key);
  tagged.headerRows = headerUsed;
  return out;
}

/**
 * Outline row — pure tree left, fixed columns right:
 *   [caret][ ][tree……][name…………][ ][status][ ][attempts][ ][backend][ ][model……]
 *
 * `treeBudget` pads every tree prefix to the same width so nested rows do not
 * shift the status/attempts/backend/model columns.
 *
 * @param {{
 *   sel: boolean,
 *   tree: string,
 *   treeBudget?: number,
 *   name: string,
 *   state: string,
 *   attempt: number,
 *   backend?: string,
 *   modelLine?: string,
 *   identity?: string,
 *   nameW: number,
 *   modelW?: number,
 *   cols: number,
 *   nameIsPhase?: boolean,
 *   tick?: number,
 *   runLive?: boolean,
 *   legend?: boolean,
 * }} opts
 */
function formatOutlineRow(opts) {
  const st = opts.state === "" ? "" : String(opts.state);
  const caret = opts.sel ? brand.pick("▸") : " ";
  const treeBudget = typeof opts.treeBudget === "number" && opts.treeBudget > 0 ? opts.treeBudget : TREE_BUDGET;
  const treeRaw = String(opts.tree ?? "");
  const tLen = treePlainLen(treeRaw);
  // Keep glyphs tight against the name (no gap after ├─). Absorb leftover
  // tree-budget into the name field so status/attempts/model stay column-locked.
  const tree = brand.dim(treeRaw);
  const modelW = typeof opts.modelW === "number" ? opts.modelW : 24;
  const nameFieldW = Math.max(4, opts.nameW + (treeBudget - Math.min(treeBudget, tLen)));
  const rawName = opts.name;
  const namePlain =
    rawName.length > nameFieldW ? `${rawName.slice(0, Math.max(0, nameFieldW - 1))}…` : rawName.padEnd(nameFieldW);

  let name;
  if (opts.legend) {
    name = brand.dim(namePlain);
  } else if (opts.sel) {
    // Selection: bold gold (never cyan — cyan = LIVE activity).
    name = brand.pick(namePlain);
  } else if (opts.nameIsPhase) {
    name =
      st === "in-progress"
        ? brand.hot(namePlain) // working phase: bold white
        : isFailedState(st)
          ? brand.err(namePlain)
          : brand.dim(namePlain);
  } else if (st === "in-progress") {
    // Working agent: bold default (white/fg) — activity, not selection.
    name = brand.hot(namePlain);
  } else if (isFailedState(st)) {
    name = brand.err(namePlain);
  } else if (isDoneState(st)) {
    name = brand.dim(namePlain);
  } else {
    name = brand.dim(namePlain);
  }

  // Status column: live work uses spinner here (not in the tree).
  let stTok;
  if (st === "") {
    stTok = "".padEnd(STATE_W);
  } else if (st === "in-progress" && opts.runLive) {
    const spin = SPIN[Math.abs(opts.tick ?? 0) % SPIN.length];
    stTok = spin.padEnd(STATE_W);
  } else {
    stTok = shortOutlineState(st).padEnd(STATE_W);
  }
  // Status: full semantic color (readable at full brightness — not dim grey).
  const stc =
    st === ""
      ? stTok
      : st === "in-progress"
        ? brand.live(stTok)
        : st === "stale" || st === "not-reached"
          ? brand.warn(stTok)
          : isFailedState(st)
            ? brand.err(stTok)
            : isDoneState(st)
              ? brand.ok(stTok)
              : stTok;

  // Attempts: right-aligned under "attempts" header.
  const attRaw = opts.attempt > 0 ? String(opts.attempt) : "·";
  const att = attRaw.padStart(ATT_W).slice(-ATT_W);

  // Backend (harness) column — separate from model + effort.
  let backendRaw = typeof opts.backend === "string" ? opts.backend : typeof opts.identity === "string" ? "" : "";
  if (backendRaw.length > BACKEND_W) {
    backendRaw = `${backendRaw.slice(0, Math.max(0, BACKEND_W - 1))}…`;
  }
  const backendCol = backendRaw.padEnd(BACKEND_W);

  // Model column: model id + effort (e.g. "claude-sonnet-5 xhigh").
  let modelRaw =
    typeof opts.modelLine === "string" && opts.modelLine !== ""
      ? opts.modelLine
      : typeof opts.identity === "string"
        ? opts.identity
        : "";
  if (modelRaw.length > modelW) {
    modelRaw = `${modelRaw.slice(0, Math.max(0, modelW - 1))}…`;
  }

  const core =
    backendRaw || modelRaw
      ? `${caret} ${tree}${name} ${stc} ${att} ${backendCol} ${modelRaw}`
      : `${caret} ${tree}${name} ${stc} ${att}`;
  return padVis(core, opts.cols);
}

/**
 * Toggle expand on a parallel phase by phase id.
 * @param {OutlinePhase[]} phases
 * @param {string} phaseId
 */
export function togglePhaseExpanded(phases, phaseId) {
  return phases.map((p) => (p.id === phaseId && p.kind === "parallel" ? { ...p, expanded: !p.expanded } : p));
}

/**
 * Create a live outline HUD controller.
 * @param {{ stdout?: NodeJS.WriteStream, useAltScreen?: boolean, rows?: number, cols?: number }} [opts]
 */
export function createCockpitOutlineHud(opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const useAltScreen = opts.useAltScreen !== undefined ? opts.useAltScreen : Boolean(stdout.isTTY);
  let entered = false;
  /** @type {ReturnType<typeof buildCockpitOutlineModel> | null} */
  let lastModel = null;
  /** @type {{ scrollOffset: number, bodyLen: number, bodyBudget: number, selectedBodyIndex: number, bodyKeys: (string|null)[], headerRows: number }} */
  let lastLayout = {
    scrollOffset: 0,
    bodyLen: 0,
    bodyBudget: 1,
    selectedBodyIndex: -1,
    bodyKeys: [],
    headerRows: 0,
  };
  /** @type {string[] | null} */
  let lastFrame = null;
  let lastCols = 0;
  let lastRows = 0;

  function size() {
    return {
      rows: Math.max(10, opts.rows || stdout.rows || Number(process.env.LINES) || 24),
      cols: Math.max(40, opts.cols || stdout.columns || Number(process.env.COLUMNS) || 80),
    };
  }

  /**
   * Write frame with minimal flicker: only rewrite changed lines when size is stable.
   * @param {string[]} frame
   * @param {{ rows: number, cols: number }} sz
   */
  function writeFrame(frame, sz) {
    const sameSize = lastFrame && lastFrame.length === frame.length && lastCols === sz.cols && lastRows === sz.rows;
    if (!sameSize) {
      stdout.write(CLEAR_HOME + frame.join("\n"));
    } else {
      // Synchronized update (no-op on terminals that ignore it) + line diffs.
      let out = `${ESC}[?2026h`;
      let dirty = 0;
      for (let i = 0; i < frame.length; i++) {
        if (frame[i] !== lastFrame[i]) {
          // row is 1-based; clear to EOL so shorter lines do not leave ghosts
          out += `${ESC}[${i + 1};1H${frame[i]}${ESC}[K`;
          dirty += 1;
        }
      }
      out += `${ESC}[?2026l`;
      if (dirty > 0) stdout.write(out);
    }
    lastFrame = frame.slice();
    lastCols = sz.cols;
    lastRows = sz.rows;
  }

  function paint() {
    if (!entered || !lastModel) return;
    const sz = size();
    const frame = renderCockpitOutlineFrame(lastModel, sz);
    /** @type {any} */
    const meta = frame;
    lastLayout = {
      scrollOffset: typeof meta.scrollOffset === "number" ? meta.scrollOffset : 0,
      bodyLen: typeof meta.bodyLen === "number" ? meta.bodyLen : 0,
      bodyBudget: typeof meta.bodyBudget === "number" ? meta.bodyBudget : 1,
      selectedBodyIndex: typeof meta.selectedBodyIndex === "number" ? meta.selectedBodyIndex : -1,
      bodyKeys: Array.isArray(meta.bodyKeys) ? meta.bodyKeys : [],
      headerRows: typeof meta.headerRows === "number" ? meta.headerRows : 0,
    };
    writeFrame(/** @type {string[]} */ (frame), sz);
  }

  function enter() {
    if (entered) return;
    entered = true;
    lastFrame = null;
    if (useAltScreen) stdout.write(`${ESC}[?1049h`);
    stdout.write(`${ESC}[?25l${CLEAR_HOME}`);
    if (typeof stdout.on === "function") stdout.on("resize", paint);
  }

  function exit() {
    if (!entered) return;
    entered = false;
    lastFrame = null;
    if (typeof stdout.off === "function") stdout.off("resize", paint);
    else stdout.removeListener?.("resize", paint);
    stdout.write(`${ESC}[?25h`);
    if (useAltScreen) stdout.write(`${ESC}[?1049l`);
    else stdout.write("\n");
  }

  /** @param {Parameters<typeof buildCockpitOutlineModel>[0]} partial */
  function update(partial) {
    lastModel = buildCockpitOutlineModel(partial);
    paint();
  }

  return {
    enter,
    exit,
    update,
    paint,
    get model() {
      return lastModel;
    },
    get layout() {
      return lastLayout;
    },
  };
}
