import { runNodeKey, type GatewayRunNode, type GatewayEventFrame } from "@smthrs/gateway-client";
import type { SelectOption } from "@opentui/core";
import { unwrapEvent } from "./eventFrame.ts";

const RUNNING_STATUSES = new Set(["running", "active"]);

/**
 * Tree-status running nodes. The gateway run-tree normalizes most non-root nodes
 * to `queued`/`waiting`/`ok` (only the root mirrors a live run's `running`
 * state), so on its own this finds at most the root. Kept as a fallback and
 * combined with the event-derived signal in {@link hijackCandidates}.
 */
export function runningNodes(nodes: readonly GatewayRunNode[]): GatewayRunNode[] {
  return nodes.filter((n) => RUNNING_STATUSES.has(n.status ?? ""));
}

const START_HINTS = ["node.start", "node.begin", "nodestarted", "agent.start", "tool.use", "toolcallstarted"];
const END_HINTS = [
  "node.end",
  "node.finish",
  "node.complete",
  "nodefinished",
  "node.fail",
  "node.error",
  "nodefailed",
  "node.cancel",
  "nodecancelled",
  "nodeskipped",
];

function matchesAny(name: string, hints: readonly string[]): boolean {
  return hints.some((h) => name.includes(h));
}

function activeAttemptKey(nodeId: string, payload: Record<string, unknown> | undefined): string {
  const rawIteration = payload?.["iteration"] ?? payload?.["attempt"];
  return JSON.stringify([nodeId, typeof rawIteration === "number" ? rawIteration : 0]);
}

function hasAttemptIdentity(payload: Record<string, unknown> | undefined): boolean {
  const rawIteration = payload?.["iteration"] ?? payload?.["attempt"];
  return typeof rawIteration === "number";
}

/**
 * Node ids with a live agent session, derived from events: a node that has a
 * start signal more recently than any terminal signal is still running. This is
 * the reliable hijack signal the run-tree status can't give us (it flattens
 * non-root nodes to `queued`).
 */
export function activeNodeIdsFromEvents(events: readonly GatewayEventFrame[]): Set<string> {
  const activeAttempts = new Map<string, string>();
  for (const ev of events) {
    const { name: rawName, payload } = unwrapEvent(ev);
    const name = rawName.toLowerCase();
    // Deliberately only the nodeId/node_id keys — NOT the `nodeid` variant that
    // normalizeFrame/extractNodeId also accept — to keep this signal's matching
    // behavior unchanged.
    const rawNodeId = payload?.["nodeId"] ?? payload?.["node_id"];
    const nodeId = typeof rawNodeId === "string" ? rawNodeId : undefined;
    if (!nodeId) continue;
    if (matchesAny(name, END_HINTS)) {
      if (hasAttemptIdentity(payload)) {
        activeAttempts.delete(activeAttemptKey(nodeId, payload));
      } else {
        for (const [key, activeNodeId] of activeAttempts) {
          if (activeNodeId === nodeId) activeAttempts.delete(key);
        }
      }
    } else if (matchesAny(name, START_HINTS)) {
      activeAttempts.set(activeAttemptKey(nodeId, payload), nodeId);
    }
  }
  return new Set(activeAttempts.values());
}

/**
 * Hijack candidates for the picker: nodes with a live agent session (from
 * events), enriched with tree metadata when available and falling back to a
 * synthetic running node when the tree hasn't materialized them. Tree-status
 * running nodes (e.g. the root of a live run) are appended so there is always
 * something to hand off to when the run is live.
 */
export function hijackCandidates(
  nodes: readonly GatewayRunNode[],
  events: readonly GatewayEventFrame[],
): GatewayRunNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const result: GatewayRunNode[] = [];
  const seen = new Set<string>();

  for (const id of activeNodeIdsFromEvents(events)) {
    const node = byId.get(id) ?? { id, name: id, kind: "task", status: "running" };
    result.push(node);
    seen.add(id);
  }
  for (const node of runningNodes(nodes)) {
    if (!seen.has(node.id)) {
      result.push(node);
      seen.add(node.id);
    }
  }
  return result;
}

/** Status a pinned row shows once its live session is gone (see {@link pinnedHijackRows}). */
export const ENDED_ROW_STATUS = "ended";

/**
 * Pin the picker's rows to stable positions across candidate churn.
 *
 * The select highlights by numeric INDEX (its `options` setter only clamps the
 * index, it never re-anchors to the selected value) while
 * {@link hijackCandidates} is recomputed from live events on every frame — so a
 * node completing and dropping out would slide every later row UP under the
 * operator's highlight, and Enter would hand the terminal to a node they never
 * pointed at. Rows the picker has already shown therefore keep their position —
 * refreshed from the live candidate, or marked {@link ENDED_ROW_STATUS} once
 * their session is gone — and fresh candidates append at the end, so a row index
 * can never change meaning while the picker stays open. Returns `prev` itself
 * when nothing moved so callers can memoize on the result.
 */
export function pinnedHijackRows(
  prev: readonly GatewayRunNode[],
  candidates: readonly GatewayRunNode[],
): readonly GatewayRunNode[] {
  const live = new Map(candidates.map((n) => [runNodeKey(n), n] as const));
  const pinned = new Set(prev.map((n) => runNodeKey(n)));
  const rows = prev.map((row) => {
    const current = live.get(runNodeKey(row));
    if (current) return current;
    return row.status === ENDED_ROW_STATUS ? row : { ...row, status: ENDED_ROW_STATUS };
  });
  for (const node of candidates) {
    if (!pinned.has(runNodeKey(node))) rows.push(node);
  }
  const unchanged = rows.length === prev.length && rows.every((row, i) => row === prev[i]);
  return unchanged ? prev : rows;
}

export function nodeSelectOption(node: GatewayRunNode): SelectOption {
  // The select `value` is the UNIQUE row key (runNodeKey), NOT the logical id:
  // loop/retry attempts share a logical `id`, so keying the option on `id` would
  // make every attempt collapse onto the first row and the user could never
  // distinctly pick a later attempt. The caller resolves the chosen node back by
  // this same key. The hijack CLI itself can only target a node id (it picks the
  // latest attempt), so the iteration is surfaced in the description to make that
  // ambiguity explicit when more than one attempt exists.
  const iterationNote = typeof node.iteration === "number" ? `  attempt: #${node.iteration}` : "";
  return {
    name: node.name ?? node.id,
    description: `id: ${node.id}  kind: ${node.kind ?? "task"}  status: ${node.status ?? "unknown"}${iterationNote}`,
    value: runNodeKey(node),
  };
}

export function hijackExitMessage(code: number | null): string {
  if (code === null) return "exited (error)";
  if (code === 0) return "exited ok";
  return `exited (code ${code})`;
}

// ─── Hijack session lifecycle (suspend/spawn/cleanup) ─────────────────────────

/**
 * POSIX lets us put the hijack child in its own process GROUP (spawn detached)
 * and kill the whole group (negative pid) so a native agent CLI can't leave
 * orphaned descendants attached to the terminal. Windows has no process groups
 * or negative pids, so we kill the direct child there.
 */
export const SUPPORTS_PROCESS_GROUPS = process.platform !== "win32";

/** Minimal child-process surface the hijack session needs (real `ChildProcess` satisfies it). */
export type HijackChildLike = {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};

/** The renderer surface the session toggles (real OpenTUI `CliRenderer` satisfies it). */
export type HijackRendererLike = {
  suspend(): void;
  resume(): void;
};

/**
 * Terminate the hijack child. On POSIX the child leads its own group (spawned
 * detached), so `process.kill(-pid)` signals the whole group — including agent
 * subprocesses it forked. Falls back to a direct `kill` if the group signal
 * fails or the platform lacks groups. No-op once the child has exited.
 */
export function killHijackChild(child: HijackChildLike | null): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (SUPPORTS_PROCESS_GROUPS && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      /* group gone or never formed — fall through to direct kill */
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

/**
 * Run one hijack hand-off: suspend the renderer, spawn the child, and wire its
 * exit back through `onDone`. Returns a cleanup that kills the child (whole
 * process group on POSIX) and restores the renderer — so an unmount mid-session
 * never leaves the terminal suspended or the agent orphaned. The renderer is
 * resumed EXACTLY once across every path (close, error, throw, or unmount).
 *
 * Pure of React/child_process so tests can drive it with a fake renderer and a
 * fake child instead of a real TTY/agent.
 */
export function startHijackSession(opts: {
  renderer: HijackRendererLike;
  spawnChild: () => HijackChildLike;
  killChild?: (child: HijackChildLike) => void;
  onDone: (code: number | null) => void;
}): () => void {
  const kill = opts.killChild ?? killHijackChild;
  let settled = false;
  let child: HijackChildLike | null = null;

  const resumeOnce = () => {
    if (settled) return;
    settled = true;
    try {
      opts.renderer.resume();
    } catch {
      /* renderer already torn down */
    }
  };

  try {
    opts.renderer.suspend();
    child = opts.spawnChild();
    child.on("close", (code) => {
      if (settled) return;
      resumeOnce();
      opts.onDone(code ?? null);
    });
    child.on("error", () => {
      if (settled) return;
      resumeOnce();
      opts.onDone(null);
    });
  } catch {
    resumeOnce();
    opts.onDone(null);
  }

  return () => {
    if (child) kill(child);
    resumeOnce();
  };
}
