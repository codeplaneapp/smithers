import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the Claude Code subscription OAuth token for an account. Tries the
 * account's `configDir/.credentials.json` first (the cross-platform location
 * when `CLAUDE_CONFIG_DIR` is set), then falls back to the macOS Keychain item
 * `Claude Code-credentials`.
 *
 * Returns `null` when no credential can be read, so the adapter degrades to a
 * "none" report rather than throwing. The token is returned only to mint an
 * outbound Authorization header; callers must never log or persist it.
 *
 * @param {{ configDir?: string }} account
 * @param {NodeJS.Platform} [platform]
 * @returns {{ accessToken: string; expiresAt?: number } | null}
 */
export function readClaudeCredentials(account, platform = process.platform) {
    if (account.configDir) {
        const path = join(account.configDir, ".credentials.json");
        if (existsSync(path)) {
            const parsed = parseCredentials(readFileSafe(path));
            if (parsed) return parsed;
        }
    }
    if (platform === "darwin") {
        const result = spawnSync(
            "security",
            ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
            { stdio: ["ignore", "pipe", "ignore"], timeout: 4_000 },
        );
        if (result.status === 0) {
            const parsed = parseCredentials(result.stdout?.toString("utf8") ?? "");
            if (parsed) return parsed;
        }
    }
    return null;
}

/**
 * @param {string} path
 * @returns {string}
 */
function readFileSafe(path) {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return "";
    }
}

/**
 * @param {string} raw
 * @returns {{ accessToken: string; expiresAt?: number } | null}
 */
function parseCredentials(raw) {
    if (!raw.trim()) return null;
    try {
        const json = JSON.parse(raw);
        const oauth = json?.claudeAiOauth;
        const accessToken = oauth?.accessToken;
        if (typeof accessToken !== "string" || accessToken === "") return null;
        const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
        return { accessToken, expiresAt };
    } catch {
        return null;
    }
}
