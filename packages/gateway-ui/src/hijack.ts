/**
 * PTY hijack model helpers, shared by every host that renders a hijack surface.
 *
 * The gateway reports which nodes have a resumable agent session
 * (GET /v1/api/runs/:id/hijack-candidates, from persisted attempt meta) and
 * serves an interactive hand-off over the /v1/pty/hijack websocket, which
 * spawns `smithers hijack <runId> --target <nodeId>` in a real PTY. These
 * helpers decide when a host shows the affordance and build the websocket URL;
 * the terminal itself lives in ./OneshotSurface.tsx.
 */

import { normalizeStatus } from "@smthrs/ui";

/** A node whose recorded attempts can be resumed by `smithers hijack`. */
export type HijackCandidate = {
  nodeId: string;
  engine: string;
  mode: string;
};

/** Which hijack affordance a host shows for a node. */
export type HijackAction = { kind: "hijack" | "reopen"; label: string };

/** Live status of one PTY hijack websocket. */
export type HijackStatus = "connecting" | "connected" | "exited" | "closed" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Candidates out of the hijack-candidates HTTP body (`{ok,data:{candidates}}`). */
export function hijackCandidatesOf(body: unknown): HijackCandidate[] {
  if (!isRecord(body)) return [];
  const data = isRecord(body.data) ? body.data : body;
  const rows = Array.isArray(data.candidates) ? data.candidates : [];
  const out: HijackCandidate[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const nodeId = asString(row.nodeId);
    const engine = asString(row.engine);
    if (!nodeId || !engine) continue;
    out.push({ nodeId, engine, mode: asString(row.mode) ?? "native-cli" });
  }
  return out;
}

export function hijackCandidateForNode(
  candidates: readonly HijackCandidate[],
  nodeId: string | undefined,
): HijackCandidate | null {
  if (!nodeId) return null;
  return candidates.find((candidate) => candidate.nodeId === nodeId) ?? null;
}

/**
 * Which hijack affordance a host shows for a node.
 *
 * - No recorded session for the node: none — the button is hidden.
 * - Run still running and the node is live: "Hijack" (a live hand-off: the
 *   engine parks the run and `smithers hijack` resumes the agent session).
 * - Run no longer running: "Reopen session" (post-mortem resume of the
 *   recorded session — works for finished AND failed nodes).
 * - Node finished but the run is still running: none. `smithers hijack`
 *   against a live run requests a hand-off of the WHOLE run, which is not
 *   what reopening an old node's session means; wait for the run to settle.
 */
export function hijackActionFor(
  runStatus: string | undefined,
  nodeLive: boolean,
  hasCandidate: boolean,
): HijackAction | null {
  if (!hasCandidate) return null;
  const runLive = normalizeStatus(runStatus) === "running";
  if (runLive) {
    return nodeLive ? { kind: "hijack", label: "Hijack" } : null;
  }
  return { kind: "reopen", label: "Reopen session" };
}

/**
 * Websocket URL for the gateway's PTY hijack channel. Mirrors the transport
 * shape of smithers cloud terminals: binary frames are PTY bytes, text frames
 * are JSON control messages.
 */
export function ptyHijackUrl(
  origin: string,
  runId: string,
  nodeId: string | undefined,
  size: { cols: number; rows: number },
  token?: string,
): string {
  const url = new URL("/v1/pty/hijack", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("runId", runId);
  if (nodeId) url.searchParams.set("nodeId", nodeId);
  url.searchParams.set("cols", String(Math.max(2, Math.floor(size.cols) || 80)));
  url.searchParams.set("rows", String(Math.max(2, Math.floor(size.rows) || 24)));
  // Browsers cannot set an Authorization header on a WebSocket upgrade. The
  // Gateway explicitly accepts the same bearer through this query parameter.
  if (token) url.searchParams.set("token", token);
  return url.toString();
}
