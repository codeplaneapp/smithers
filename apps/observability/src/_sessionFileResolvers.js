import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listJsonlFiles(dir) {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        const nested = await Promise.all(entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) return listJsonlFiles(path);
            return entry.isFile() && path.endsWith(".jsonl") ? [path] : [];
        }));
        return nested.flat();
    } catch {
        return [];
    }
}

/**
 * @param {any} agent
 * @returns {string[]}
 */
function buildCodexSessionRoots(agent) {
    const custom = agent?.opts?.sessionDir ?? agent?.opts?.codexSessionDir;
    if (typeof custom === "string" && custom) return [custom];
    if (String(agent?.constructor?.name ?? "") !== "CodexAgent") return [];
    return [join(homedir(), ".codex", "sessions")];
}

/**
 * @param {any} agent
 * @returns {string[]}
 */
function buildClaudeSessionRoots(agent) {
    const custom = agent?.opts?.sessionDir ??
        agent?.opts?.claudeProjectsDir ??
        agent?.opts?.projectsDir;
    if (typeof custom === "string" && custom) return [custom];
    if (String(agent?.constructor?.name ?? "") !== "ClaudeCodeAgent") return [];
    return [join(homedir(), ".claude", "projects")];
}

/**
 * @param {any} agent
 * @returns {string[]}
 */
function buildPiSessionRoots(agent) {
    if (typeof agent?.opts?.session === "string" && agent.opts.session) {
        return [agent.opts.session];
    }
    const custom = agent?.opts?.sessionDir;
    if (typeof custom === "string" && custom) return [custom];
    if (String(agent?.constructor?.name ?? "") !== "PiAgent") return [];
    return [join(homedir(), ".pi", "agent", "sessions")];
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function sanitizeClaudeProjectPath(cwd) {
    return cwd.replace(/[\\/]/g, "-");
}

/**
 * @param {unknown} sessionCwd
 * @param {string} cwd
 * @returns {boolean}
 */
function isCorrelatedSessionCwd(sessionCwd, cwd) {
    if (typeof sessionCwd !== "string" || !sessionCwd) return false;
    return (sessionCwd === cwd ||
        sessionCwd.startsWith(`${cwd}/`) ||
        cwd.startsWith(`${sessionCwd}/`));
}

/**
 * @param {any} agent
 * @param {string} [sessionId]
 * @returns {Promise<string | null>}
 */
export async function resolvePiSessionFile(agent, sessionId) {
    if (typeof agent?.opts?.session === "string" && agent.opts.session) {
        return agent.opts.session;
    }
    if (!sessionId) return null;
    for (const root of buildPiSessionRoots(agent)) {
        const files = await listJsonlFiles(root);
        const match = files.find((file) => file.includes(sessionId));
        if (match) return match;
    }
    return null;
}

/**
 * @param {any} agent
 * @param {string} cwd
 * @param {string} [sessionId]
 * @returns {Promise<string | null>}
 */
export async function resolveClaudeSessionFile(agent, cwd, sessionId) {
    if (!sessionId) return null;
    for (const root of buildClaudeSessionRoots(agent)) {
        const direct = join(root, sanitizeClaudeProjectPath(cwd), `${sessionId}.jsonl`);
        try {
            const info = await stat(direct);
            if (info.isFile()) return direct;
        } catch {}
        const files = await listJsonlFiles(root);
        const match = files.find((file) => basename(file) === `${sessionId}.jsonl`);
        if (match) return match;
    }
    return null;
}

/**
 * @param {any} agent
 * @param {string} cwd
 * @param {number} startedAtMs
 * @returns {Promise<string | null>}
 */
export async function resolveCodexSessionFile(agent, cwd, startedAtMs) {
    const dayFolders = new Set();
    for (const offset of [-1, 0, 1]) {
        const day = new Date(startedAtMs + offset * 24 * 60 * 60 * 1000);
        dayFolders.add(join(String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0")));
        dayFolders.add(join(String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")));
    }
    const dayRoots = buildCodexSessionRoots(agent).flatMap((root) => [...dayFolders].map((folder) => join(root, folder)));
    const candidates = (await Promise.all(dayRoots.map((root) => listJsonlFiles(root)))).flat();
    /** @type {{ file: string; delta: number } | null} */
    let best = null;
    for (const file of candidates) {
        try {
            const firstLine = (await readFile(file, "utf8")).split(/\r?\n/, 1)[0];
            if (!firstLine) continue;
            const parsed = JSON.parse(firstLine);
            if (parsed?.type !== "session_meta") continue;
            const sessionCwd = parsed?.payload?.cwd;
            const sessionTs = Date.parse(String(parsed?.payload?.timestamp ?? parsed?.timestamp ?? ""));
            if (!isCorrelatedSessionCwd(sessionCwd, cwd) || !Number.isFinite(sessionTs)) continue;
            const delta = Math.abs(sessionTs - startedAtMs);
            if (!best || delta < best.delta) best = { file, delta };
        } catch {}
    }
    return best?.file ?? null;
}
