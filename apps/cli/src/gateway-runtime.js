import { randomBytes, createHash } from "node:crypto";
import {
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Runtime state for the per-workspace singleton gateway (spec:
 * .smithers/specs/singleton-gateway.md, decisions 3-7).
 *
 * The daemon records where it listens (and, with --mint-token, the bearer)
 * in a per-workspace file under the OS temp dir; clients discover a running
 * gateway by reading the file and verifying the process is alive AND the
 * /health identity names the same workspace. The file lives outside the
 * repo so stale `.smithers/.gitignore` packs can never commit a token, and
 * it dies with the machine like the pid it records.
 *
 * @typedef {{
 *   pid: number;
 *   host: string;
 *   port: number;
 *   url: string;
 *   token: string | null;
 *   workspaceRoot: string;
 *   backend: string | null;
 *   version: string | null;
 *   protocol: number | null;
 *   startedAtMs: number;
 * }} GatewayRuntimeState
 */

const GATEWAY_RUNTIME_DIR_NAME = "smithers-gateway";
const AUTOSTART_LOCK_STALE_MS = 5 * 60_000;
const AUTOSTART_WAIT_TIMEOUT_MS = 2 * 60_000;
const DAEMON_START_LOCK_STALE_MS = 10 * 60_000;
const HEALTH_TIMEOUT_MS = 1_500;
// A transient /health failure must not be lethal: the daemon writes its state
// file exactly ONCE (after listen()) and nothing ever rewrites it, so deleting
// the file for a LIVE gateway permanently orphans it — `smithers gateway stop`
// stops finding it, its minted token is lost, and the next autostart spawns a
// SECOND gateway over the same store. Retry briefly before giving up, and only
// delete on the definitive outcomes the spec sanctions (singleton-gateway.md
// decision 4: dead pid, identity mismatch, connection refused).
const HEALTH_VERIFY_ATTEMPTS = 3;
const HEALTH_VERIFY_BACKOFF_MS = 200;

function currentUid() {
    return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function defaultGatewayRuntimeDir(env) {
    const uid = currentUid();
    if (process.platform === "linux" && uid !== null) {
        if (env.XDG_RUNTIME_DIR)
            return join(env.XDG_RUNTIME_DIR, GATEWAY_RUNTIME_DIR_NAME);
        return join(tmpdir(), `${GATEWAY_RUNTIME_DIR_NAME}-${uid}`);
    }
    return join(tmpdir(), GATEWAY_RUNTIME_DIR_NAME);
}

/**
 * @param {string} path
 * @param {string} message
 */
function gatewayRuntimeTrustError(path, message) {
    const error = new Error(`${message}: ${path}`);
    /** @type {NodeJS.ErrnoException} */ (error).code = "GATEWAY_STATE_UNTRUSTED";
    return error;
}

/**
 * @param {string} path
 * @param {import("node:fs").Stats} stats
 * @param {string} kind
 */
function assertOwnedRuntimePath(path, stats, kind) {
    const uid = currentUid();
    if (uid === null)
        return;
    if (stats.uid !== uid) {
        throw gatewayRuntimeTrustError(path, `${kind} is owned by uid ${stats.uid}, not current uid ${uid}`);
    }
    if ((stats.mode & 0o022) !== 0) {
        throw gatewayRuntimeTrustError(path, `${kind} is writable by group or other users`);
    }
}

/**
 * @param {string} dir
 */
function assertGatewayRuntimeDirTrusted(dir) {
    const stats = lstatSync(dir);
    if (!stats.isDirectory()) {
        throw gatewayRuntimeTrustError(dir, "Gateway runtime path is not a directory");
    }
    assertOwnedRuntimePath(dir, stats, "Gateway runtime directory");
}

/**
 * @param {string} file
 * @param {string} kind
 * @returns {import("node:fs").Stats | null}
 */
function gatewayRuntimeFileStats(file, kind) {
    try {
        const stats = lstatSync(file);
        if (!stats.isFile()) {
            throw gatewayRuntimeTrustError(file, `${kind} is not a regular file`);
        }
        assertOwnedRuntimePath(file, stats, kind);
        return stats;
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT")
            return null;
        throw error;
    }
}

/**
 * @param {string} file
 * @param {string} kind
 * @returns {boolean}
 */
function assertGatewayRuntimeFileTrusted(file, kind) {
    return gatewayRuntimeFileStats(file, kind) !== null;
}

/**
 * @param {string} dir
 */
function ensureGatewayRuntimeDir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertGatewayRuntimeDirTrusted(dir);
}

/**
 * Canonicalize a workspace path for identity comparison. realpath both what
 * the CLI resolved and what the gateway advertises: on macOS tmp workspaces
 * one side may say /var/... and the other /private/var/....
 *
 * @param {string} path
 */
export function canonicalWorkspacePath(path) {
    try {
        return realpathSync(resolve(path));
    }
    catch {
        return resolve(path);
    }
}

/**
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 */
export function gatewayRuntimePaths(workspace, env = process.env) {
    const root = env.SMITHERS_GATEWAY_STATE_DIR ?? defaultGatewayRuntimeDir(env);
    const key = createHash("sha256").update(canonicalWorkspacePath(workspace)).digest("hex").slice(0, 32);
    return {
        dir: root,
        stateFile: join(root, `${key}.json`),
        logFile: join(root, `${key}.log`),
        lockFile: join(root, `${key}.lock`),
        daemonStartLockFile: join(root, `${key}.start.lock`),
    };
}

export function mintGatewayToken() {
    return randomBytes(32).toString("hex");
}

/**
 * @param {number} pid
 */
export function isGatewayPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means the pid exists but belongs to another user.
        return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
    }
}

/**
 * Verify the state file's directory and file metadata before trusting its
 * contents. Returns false when no state file exists.
 *
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function assertGatewayRuntimeStateFileTrusted(workspace, env = process.env) {
    const { dir, stateFile } = gatewayRuntimePaths(workspace, env);
    const exists = assertGatewayRuntimeFileTrusted(stateFile, "Gateway runtime state file");
    if (!exists)
        return false;
    assertGatewayRuntimeDirTrusted(dir);
    return true;
}

/**
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {GatewayRuntimeState | null}
 */
export function readGatewayRuntimeState(workspace, env = process.env) {
    const { stateFile } = gatewayRuntimePaths(workspace, env);
    if (!assertGatewayRuntimeStateFileTrusted(workspace, env))
        return null;
    let raw;
    try {
        raw = readFileSync(stateFile, "utf8");
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT")
            throw error;
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object")
            return null;
        if (typeof parsed.pid !== "number" || typeof parsed.url !== "string" || typeof parsed.workspaceRoot !== "string")
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}

/**
 * Atomic write (tmp + rename) with owner-only permissions: the state file
 * may carry the gateway bearer token.
 *
 * @param {string} workspace
 * @param {GatewayRuntimeState} state
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the state file path
 */
export function writeGatewayRuntimeState(workspace, state, env = process.env) {
    const { dir, stateFile } = gatewayRuntimePaths(workspace, env);
    ensureGatewayRuntimeDir(dir);
    const tmpFile = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tmpFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpFile, stateFile);
    return stateFile;
}

/**
 * Remove the state file, but only when it still describes `pid` (a crashed
 * daemon's successor must not have its fresh state deleted by the old
 * process's shutdown path).
 *
 * @param {string} workspace
 * @param {number} [pid]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function clearGatewayRuntimeState(workspace, pid, env = process.env) {
    const { stateFile } = gatewayRuntimePaths(workspace, env);
    if (pid !== undefined) {
        const current = readGatewayRuntimeState(workspace, env);
        if (current && current.pid !== pid)
            return;
    }
    rmSync(stateFile, { force: true });
}

/**
 * Whether a fetch failure means NOTHING accepts connections at the target —
 * the spec's deletable-stale case — as opposed to a timeout/reset while a
 * server is (possibly) still there. Node's undici nests the errno under
 * `cause`; bun's fetch reports the bun-flavored "ConnectionRefused" code.
 *
 * @param {unknown} error
 */
function isConnectionRefused(error) {
    let cursor = error;
    while (cursor && typeof cursor === "object") {
        const code = /** @type {{ code?: unknown }} */ (cursor).code;
        if (code === "ECONNREFUSED" || code === "ConnectionRefused")
            return true;
        cursor = /** @type {{ cause?: unknown }} */ (cursor).cause;
    }
    return false;
}

/**
 * Probe /health once and CLASSIFY the outcome, so callers can tell a
 * definitive verdict from a transient blip:
 *
 *  - ok: the answering gateway advertises this workspace.
 *  - "mismatch": a server ANSWERED but is not this workspace's gateway (no
 *    identity on the wire — an older library — or a different workspaceRoot).
 *    Definitive: retrying will not turn it into our gateway.
 *  - "refused": nothing accepts connections on the recorded address — the
 *    spec-sanctioned deletable-stale case.
 *  - "transient": timeout, socket reset, non-OK status, or an unparsable
 *    body. The gateway runs workflow engines in-process, so a busy event
 *    loop can miss the probe window; this is NOT proof it is gone.
 *
 * @param {string} url
 * @param {string} workspace
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true; identity: { workspaceRoot: string; backend: string | null; version: string | null; pid: number; startedAtMs: number } } | { ok: false; reason: "mismatch" | "refused" | "transient" }>}
 */
export async function probeGatewayHealthIdentity(url, workspace, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
    let health;
    try {
        const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
            return { ok: false, reason: "transient" };
        health = await res.json();
    }
    catch (error) {
        return { ok: false, reason: isConnectionRefused(error) ? "refused" : "transient" };
    }
    const identity = health?.identity;
    if (!identity || typeof identity.workspaceRoot !== "string")
        return { ok: false, reason: "mismatch" };
    if (canonicalWorkspacePath(identity.workspaceRoot) !== canonicalWorkspacePath(workspace))
        return { ok: false, reason: "mismatch" };
    return { ok: true, identity };
}

/**
 * Fetch /health and verify the answering gateway serves `workspace`.
 * Returns the health identity on match, null on any failure or mismatch
 * (an old gateway without identity on the wire never verifies). Callers that
 * need to distinguish WHY it failed use {@link probeGatewayHealthIdentity}.
 *
 * @param {string} url
 * @param {string} workspace
 * @returns {Promise<{ workspaceRoot: string; backend: string | null; version: string | null; pid: number; startedAtMs: number } | null>}
 */
export async function verifyGatewayHealthIdentity(url, workspace) {
    const outcome = await probeGatewayHealthIdentity(url, workspace);
    return outcome.ok ? outcome.identity : null;
}

/**
 * Find the running singleton gateway for `workspace`: read the state file,
 * check the pid, verify the /health identity. Stale state (dead pid, identity
 * mismatch, connection refused) is deleted and treated as absent — but a
 * TRANSIENT probe failure (timeout/reset while the pid is alive) is retried
 * and, if it persists, reported as absent WITHOUT deleting the state file:
 * the file is written once at daemon startup and never rewritten, so deleting
 * it for a merely-busy gateway would permanently orphan a live daemon (stop
 * can't find it, autostart doubles it up on the same store).
 *
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ attempts?: number; backoffMs?: number; healthTimeoutMs?: number }} [opts]
 * @returns {Promise<{ state: GatewayRuntimeState; identity: { workspaceRoot: string; pid: number } } | null>}
 */
export async function discoverWorkspaceGateway(workspace, env = process.env, opts = {}) {
    const state = readGatewayRuntimeState(workspace, env);
    if (!state)
        return null;
    if (!isGatewayPidAlive(state.pid)) {
        clearGatewayRuntimeState(workspace, state.pid, env);
        return null;
    }
    const attempts = Math.max(1, opts.attempts ?? HEALTH_VERIFY_ATTEMPTS);
    const backoffMs = opts.backoffMs ?? HEALTH_VERIFY_BACKOFF_MS;
    /** @type {{ ok: false; reason: "mismatch" | "refused" | "transient" }} */
    let failure = { ok: false, reason: "transient" };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0)
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        const outcome = await probeGatewayHealthIdentity(state.url, workspace, { timeoutMs: opts.healthTimeoutMs });
        if (outcome.ok)
            return { state, identity: outcome.identity };
        failure = outcome;
        // A mismatch is definitive: an answering server that is not this
        // workspace's gateway will not become it on the next attempt.
        if (outcome.reason === "mismatch")
            break;
    }
    // The pid is ALIVE here, so only the definitive outcomes may delete the
    // write-once state file. A timeout/transient error keeps it: the gateway
    // may just be busy, and deleting would orphan it for its whole lifetime.
    if (failure.reason !== "transient") {
        clearGatewayRuntimeState(workspace, state.pid, env);
    }
    return null;
}

/**
 * @typedef {{ release: () => void }} GatewayRuntimeLock
 */

/**
 * @param {string} lockFile
 * @param {string} claimId
 */
function writeGatewayLockClaim(lockFile, claimId) {
    const payload = `${JSON.stringify({ pid: process.pid, atMs: Date.now(), claimId })}\n`;
    writeFileSync(lockFile, payload, { flag: "wx", mode: 0o600 });
}

/**
 * @param {string} lockFile
 * @returns {{ claim: { pid?: number; atMs?: number; claimId?: string } | null; stats: import("node:fs").Stats } | null}
 */
function readGatewayLockRecord(lockFile) {
    const stats = gatewayRuntimeFileStats(lockFile, "Gateway runtime lock file");
    if (!stats)
        return null;
    try {
        const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
        return { claim: parsed && typeof parsed === "object" ? parsed : null, stats };
    }
    catch {
        return { claim: null, stats };
    }
}

/**
 * @param {string} lockFile
 * @param {string} claimId
 */
function gatewayLockMatches(lockFile, claimId) {
    const holder = readGatewayLockRecord(lockFile)?.claim;
    return holder?.pid === process.pid && holder?.claimId === claimId;
}

/**
 * @param {string} lockFile
 */
function moveStaleGatewayLockAside(lockFile) {
    const staleFile = `${lockFile}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.stale`;
    try {
        renameSync(lockFile, staleFile);
        return staleFile;
    }
    catch {
        return null;
    }
}

/**
 * @param {import("node:fs").Stats} a
 * @param {import("node:fs").Stats} b
 */
function sameRuntimeFile(a, b) {
    return a.dev === b.dev && a.ino === b.ino;
}

/**
 * @param {string} staleFile
 * @param {string} lockFile
 */
function restoreMovedFreshLock(staleFile, lockFile) {
    try {
        renameSync(staleFile, lockFile);
    }
    catch {
        rmSync(staleFile, { force: true });
    }
}

/**
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} env
 * @param {string} lockFile
 * @param {number} staleMs
 * @param {{ beforeStaleRename?: () => void }} [opts]
 * @returns {GatewayRuntimeLock | null}
 */
function claimGatewayRuntimeLock(workspace, env, lockFile, staleMs, opts = {}) {
    const { dir } = gatewayRuntimePaths(workspace, env);
    ensureGatewayRuntimeDir(dir);
    const claimId = randomBytes(16).toString("hex");
    const tryClaim = () => {
        try {
            writeGatewayLockClaim(lockFile, claimId);
            return gatewayLockMatches(lockFile, claimId);
        }
        catch {
            return false;
        }
    };
    if (!tryClaim()) {
        const holderRecord = readGatewayLockRecord(lockFile);
        const holder = holderRecord?.claim;
        const holderAlive = holder && isGatewayPidAlive(holder.pid);
        const holderFresh = holder && Date.now() - (holder.atMs ?? 0) < staleMs;
        if (holderAlive && holderFresh)
            return null;
        opts.beforeStaleRename?.();
        const staleFile = moveStaleGatewayLockAside(lockFile);
        if (!staleFile)
            return null;
        const movedStats = gatewayRuntimeFileStats(staleFile, "Moved gateway runtime lock file");
        if (holderRecord && movedStats && !sameRuntimeFile(holderRecord.stats, movedStats)) {
            restoreMovedFreshLock(staleFile, lockFile);
            return null;
        }
        try {
            if (!tryClaim())
                return null;
        }
        finally {
            rmSync(staleFile, { force: true });
        }
    }
    return {
        release: () => {
            try {
                if (!gatewayLockMatches(lockFile, claimId))
                    return;
            }
            catch {
                // Fall through and remove: an unreadable lock helps nobody.
            }
            rmSync(lockFile, { force: true });
        },
    };
}

/**
 * Claim the per-workspace autostart lock so two racing clients spawn one
 * daemon: O_EXCL create; on EEXIST steal only when the holder is dead or
 * the claim is older than the autostart wait window. Returns null when
 * someone else holds it.
 *
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ beforeStaleRename?: () => void }} [opts]
 * @returns {GatewayRuntimeLock | null}
 */
export function claimGatewayAutostartLock(workspace, env = process.env, opts = {}) {
    const { lockFile } = gatewayRuntimePaths(workspace, env);
    return claimGatewayRuntimeLock(workspace, env, lockFile, AUTOSTART_LOCK_STALE_MS, opts);
}

/**
 * Claim the daemon's start lock. This lock is separate from the client
 * autostart lock: an autostart parent holds the client lock while waiting for
 * the child, and the child must still be able to serialize daemon boot.
 *
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {GatewayRuntimeLock | null}
 */
export function claimGatewayDaemonStartLock(workspace, env = process.env) {
    const { daemonStartLockFile } = gatewayRuntimePaths(workspace, env);
    return claimGatewayRuntimeLock(workspace, env, daemonStartLockFile, DAEMON_START_LOCK_STALE_MS);
}

/**
 * Resolve the bearer for a gateway URL: the workspace state file when it
 * names this URL, then the explicit env pins the TUI already honors.
 *
 * @param {string | undefined} workspace
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveGatewayBearer(workspace, url, env = process.env) {
    if (workspace) {
        const state = readGatewayRuntimeState(workspace, env);
        if (state?.token && state.url.replace(/\/+$/, "") === url.replace(/\/+$/, ""))
            return state.token;
    }
    return env.SMITHERS_TOKEN || env.SMITHERS_API_KEY || null;
}

/**
 * Poll until the workspace gateway is discoverable, for autostart waiters.
 *
 * @param {string} workspace
 * @param {{ timeoutMs?: number; intervalMs?: number; env?: NodeJS.ProcessEnv }} [opts]
 */
export async function waitForWorkspaceGateway(workspace, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? AUTOSTART_WAIT_TIMEOUT_MS;
    const intervalMs = opts.intervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const discovered = await discoverWorkspaceGateway(workspace, opts.env);
        if (discovered)
            return discovered;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
}
