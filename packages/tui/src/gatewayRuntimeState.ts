import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The per-workspace gateway runtime state written by `smithers gateway`
 * (see apps/cli/src/gateway-runtime.js — this mirrors that convention, since
 * packages/tui cannot import apps/cli). The file lives at
 * `$SMITHERS_GATEWAY_STATE_DIR ?? $TMPDIR/smithers-gateway/<sha256(workspace)[:32]>.json`
 * and carries the singleton gateway's url + bearer token, which is exactly what
 * the monitor needs to REUSE the workspace gateway instead of spawning a new
 * detached one on a random port every invocation.
 */
export interface WorkspaceGatewayState {
  pid: number;
  url: string;
  token: string | null;
  workspaceRoot: string;
}

function canonicalWorkspacePath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read the workspace's gateway runtime state, returning it only when the file
 * parses, matches this workspace, and the recorded gateway process is still
 * alive. Never throws — a missing/stale/foreign state file is simply `null`
 * (callers fall through to autostart).
 */
export function readWorkspaceGatewayState(
  workspace: string,
  env: Record<string, string | undefined> = process.env,
): WorkspaceGatewayState | null {
  const root = env.SMITHERS_GATEWAY_STATE_DIR ?? join(tmpdir(), "smithers-gateway");
  const key = createHash("sha256").update(canonicalWorkspacePath(workspace)).digest("hex").slice(0, 32);
  let raw: string;
  try {
    raw = readFileSync(join(root, `${key}.json`), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const state = parsed as Record<string, unknown>;
  if (typeof state.pid !== "number" || typeof state.url !== "string" || typeof state.workspaceRoot !== "string") {
    return null;
  }
  if (!isPidAlive(state.pid)) return null;
  return {
    pid: state.pid,
    url: state.url.replace(/\/+$/, ""),
    token: typeof state.token === "string" && state.token.length > 0 ? state.token : null,
    workspaceRoot: state.workspaceRoot,
  };
}
