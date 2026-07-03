import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The per-workspace gateway runtime state written by `smithers gateway`
 * (see apps/cli/src/gateway-runtime.js — this MIRRORS that convention, since
 * packages/tui cannot import apps/cli). The file carries the singleton
 * gateway's url + bearer token, which is exactly what the monitor needs to
 * REUSE the workspace gateway instead of spawning a new detached one on a
 * random port every invocation.
 *
 * Two halves of the convention MUST match the writer exactly or reuse silently
 * never works:
 *   - the directory ({@link defaultGatewayRuntimeDir}) — the daemon writes to a
 *     uid-scoped dir on Linux, so a fixed `$TMPDIR/smithers-gateway` reads a dir
 *     the daemon never wrote (and that any local user could pre-seed);
 *   - the key — the workspace ROOT (walking up to the `.smithers`/`smithers.db`
 *     anchor), not the raw cwd, so a monitor launched from a subdirectory hashes
 *     the same file the CLI wrote.
 * The apps/cli parity test (apps/cli/tests/gateway-runtime-state-parity.test.js)
 * guards these against drift.
 */
export interface WorkspaceGatewayState {
  pid: number;
  url: string;
  token: string | null;
  workspaceRoot: string;
}

const GATEWAY_RUNTIME_DIR_NAME = "smithers-gateway";

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function canonicalWorkspacePath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
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
 * Mirror apps/cli/src/gateway-runtime.js `defaultGatewayRuntimeDir` EXACTLY.
 * On Linux the daemon writes to `$XDG_RUNTIME_DIR/smithers-gateway` (or a
 * uid-scoped `$TMPDIR/smithers-gateway-<uid>` when XDG is unset) so the state
 * file lives in a directory only the current user owns; everywhere else it is
 * `$TMPDIR/smithers-gateway`. An explicit `$SMITHERS_GATEWAY_STATE_DIR` wins on
 * both sides.
 */
function defaultGatewayRuntimeDir(env: Record<string, string | undefined>): string {
  const uid = currentUid();
  if (process.platform === "linux" && uid !== null) {
    if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, GATEWAY_RUNTIME_DIR_NAME);
    return join(tmpdir(), `${GATEWAY_RUNTIME_DIR_NAME}-${uid}`);
  }
  return join(tmpdir(), GATEWAY_RUNTIME_DIR_NAME);
}

/**
 * Resolve the workspace root whose gateway state file to read, mirroring the
 * CLI's `resolveGatewayWorkspace` precedence (apps/cli/src/index.js): the
 * nearest ancestor holding a `.smithers/` pack wins, else the nearest ancestor
 * holding a `smithers.db`. A monitor launched from a SUBDIRECTORY must hash the
 * same workspace root the CLI hashed or it keys a different file and never finds
 * the singleton. `SMITHERS_WORKSPACE_ROOT` (set by the launcher when it already
 * resolved the workspace) short-circuits the walk; direct `smithers-mon`
 * invocations rely on the walk-up.
 */
export function resolveMonitorWorkspaceRoot(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const pinned = env.SMITHERS_WORKSPACE_ROOT;
  if (typeof pinned === "string" && pinned.length > 0) return resolve(pinned);
  const start = resolve(cwd);
  // Pass 1: nearest ancestor with a `.smithers/` pack — its directory is the
  // workspace root (the CLI keys off `dirname(localPackDir)`).
  for (let dir = start; ; ) {
    if (isDirectory(join(dir, ".smithers"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Pass 2: nearest ancestor holding a `smithers.db` (projects with no pack).
  for (let dir = start; ; ) {
    if (isRegularFile(join(dir, "smithers.db"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * The state directory + file for a workspace root, mirroring
 * gateway-runtime.js `gatewayRuntimePaths` so reader and writer cannot diverge.
 */
export function workspaceGatewayStatePath(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
): { dir: string; stateFile: string } {
  const dir = env.SMITHERS_GATEWAY_STATE_DIR ?? defaultGatewayRuntimeDir(env);
  const key = createHash("sha256").update(canonicalWorkspacePath(workspaceRoot)).digest("hex").slice(0, 32);
  return { dir, stateFile: join(dir, `${key}.json`) };
}

/**
 * Trust the state file's directory + file before trusting the url+token inside
 * (the CLI applies the same ownership/permission gate via
 * `assertGatewayRuntimeStateFileTrusted`). On multi-user Linux the state dir can
 * live under a shared tmp; without this check a local attacker could pre-seed
 * `<sha256(workspace)>.json` and, by advertising a `token: null` and an
 * attacker-controlled `url`, make the monitor send the victim's bearer token
 * (SMITHERS_TOKEN/SMITHERS_API_KEY) to their server. Require the dir and file to
 * be owned by the current uid and NOT group/other-writable on POSIX systems. A
 * legitimate CLI-written file (0o600 in a 0o700 uid-owned dir) passes there;
 * Windows lacks equivalent uid/mode bits in Node's Stats, so the regular-file
 * and directory checks above form the trust gate on that platform.
 */
function pathOwnedAndPrivate(stats: import("node:fs").Stats): boolean {
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) return false;
  if (process.platform === "win32") return true;
  return (stats.mode & 0o022) === 0;
}

function stateFileTrusted(dir: string, stateFile: string): boolean {
  let dirStats: import("node:fs").Stats;
  let fileStats: import("node:fs").Stats;
  try {
    dirStats = lstatSync(dir);
    fileStats = lstatSync(stateFile);
  } catch {
    return false;
  }
  if (!dirStats.isDirectory() || !fileStats.isFile()) return false;
  return pathOwnedAndPrivate(dirStats) && pathOwnedAndPrivate(fileStats);
}

/**
 * Read the workspace's gateway runtime state, returning it only when the file
 * is TRUSTED (owner + permissions), parses, records THIS workspace, and the
 * recorded gateway process is still alive. Never throws — a missing/stale/
 * foreign/untrusted state file is simply `null` (callers fall through to
 * autostart). `cwd` is the starting directory; the workspace root is resolved
 * from it via {@link resolveMonitorWorkspaceRoot}.
 */
export function readWorkspaceGatewayState(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): WorkspaceGatewayState | null {
  const workspaceRoot = resolveMonitorWorkspaceRoot(cwd, env);
  const { dir, stateFile } = workspaceGatewayStatePath(workspaceRoot, env);
  if (!stateFileTrusted(dir, stateFile)) {
    // A missing file is the normal "no gateway running" case; only warn when a
    // file is PRESENT but untrusted, so an exfiltration attempt is diagnosable.
    if (existsSync(stateFile)) {
      process.stderr.write(
        `[smithers-mon] Ignoring untrusted gateway state file ${stateFile} (unexpected owner or permissions).\n`,
      );
    }
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(stateFile, "utf8");
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
  // Identity: the recorded workspace must be the one we resolved. The CLI's
  // discoverWorkspaceGateway verifies identity over /health; the monitor only
  // has `servesRun` as a partial backstop, so reject a file that names a
  // different workspace up front rather than trusting its url+token.
  if (canonicalWorkspacePath(state.workspaceRoot) !== canonicalWorkspacePath(workspaceRoot)) {
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
