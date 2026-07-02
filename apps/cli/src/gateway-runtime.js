import { randomBytes, createHash } from "node:crypto";
import {
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

const AUTOSTART_LOCK_STALE_MS = 30_000;
const HEALTH_TIMEOUT_MS = 1_500;

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
    const root = env.SMITHERS_GATEWAY_STATE_DIR ?? join(tmpdir(), "smithers-gateway");
    const key = createHash("sha256").update(canonicalWorkspacePath(workspace)).digest("hex").slice(0, 32);
    return {
        dir: root,
        stateFile: join(root, `${key}.json`),
        lockFile: join(root, `${key}.lock`),
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
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {GatewayRuntimeState | null}
 */
export function readGatewayRuntimeState(workspace, env = process.env) {
    const { stateFile } = gatewayRuntimePaths(workspace, env);
    let raw;
    try {
        raw = readFileSync(stateFile, "utf8");
    }
    catch {
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
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
 * Fetch /health and verify the answering gateway serves `workspace`.
 * Returns the health identity on match, null on any failure or mismatch
 * (an old gateway without identity on the wire never verifies).
 *
 * @param {string} url
 * @param {string} workspace
 * @returns {Promise<{ workspaceRoot: string; backend: string | null; version: string | null; pid: number; startedAtMs: number } | null>}
 */
export async function verifyGatewayHealthIdentity(url, workspace) {
    let health;
    try {
        const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (!res.ok)
            return null;
        health = await res.json();
    }
    catch {
        return null;
    }
    const identity = health?.identity;
    if (!identity || typeof identity.workspaceRoot !== "string")
        return null;
    if (canonicalWorkspacePath(identity.workspaceRoot) !== canonicalWorkspacePath(workspace))
        return null;
    return identity;
}

/**
 * Find the running singleton gateway for `workspace`: read the state file,
 * check the pid, verify the /health identity. Stale state (dead pid,
 * unreachable, wrong workspace) is deleted and treated as absent.
 *
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ state: GatewayRuntimeState; identity: { workspaceRoot: string; pid: number } } | null>}
 */
export async function discoverWorkspaceGateway(workspace, env = process.env) {
    const state = readGatewayRuntimeState(workspace, env);
    if (!state)
        return null;
    if (!isGatewayPidAlive(state.pid)) {
        clearGatewayRuntimeState(workspace, state.pid, env);
        return null;
    }
    const identity = await verifyGatewayHealthIdentity(state.url, workspace);
    if (!identity) {
        clearGatewayRuntimeState(workspace, state.pid, env);
        return null;
    }
    return { state, identity };
}

/**
 * Claim the per-workspace autostart lock so two racing clients spawn one
 * daemon: O_EXCL create; on EEXIST steal only when the holder is dead or
 * the claim is older than 30s. Returns null when someone else holds it.
 *
 * @param {string} workspace
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ release: () => void } | null}
 */
export function claimGatewayAutostartLock(workspace, env = process.env) {
    const { dir, lockFile } = gatewayRuntimePaths(workspace, env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = `${JSON.stringify({ pid: process.pid, atMs: Date.now() })}\n`;
    const tryClaim = () => {
        try {
            writeFileSync(lockFile, payload, { flag: "wx", mode: 0o600 });
            return true;
        }
        catch {
            return false;
        }
    };
    if (!tryClaim()) {
        let holder = null;
        try {
            holder = JSON.parse(readFileSync(lockFile, "utf8"));
        }
        catch {
            // Unreadable lock: treat as stale.
        }
        const holderAlive = holder && isGatewayPidAlive(holder.pid);
        const holderFresh = holder && Date.now() - (holder.atMs ?? 0) < AUTOSTART_LOCK_STALE_MS;
        if (holderAlive && holderFresh)
            return null;
        rmSync(lockFile, { force: true });
        if (!tryClaim())
            return null;
    }
    return {
        release: () => {
            try {
                const holder = JSON.parse(readFileSync(lockFile, "utf8"));
                if (holder?.pid !== process.pid)
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
    return env.SMITHERS_TOKEN ?? env.SMITHERS_API_KEY ?? null;
}

/**
 * Poll until the workspace gateway is discoverable, for autostart waiters.
 *
 * @param {string} workspace
 * @param {{ timeoutMs?: number; intervalMs?: number; env?: NodeJS.ProcessEnv }} [opts]
 */
export async function waitForWorkspaceGateway(workspace, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 30_000;
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
