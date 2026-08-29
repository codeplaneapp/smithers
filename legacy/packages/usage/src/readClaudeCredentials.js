import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reads the Claude Code subscription OAuth token for an account. Tries the
 * account's `configDir/.credentials.json` first (the cross-platform location
 * when `CLAUDE_CONFIG_DIR` is set), then the macOS Keychain: Claude Code keys
 * per-config-dir logins as `Claude Code-credentials-<first 8 hex of
 * sha256(configDir)>`, so an isolated account's item is tried before the
 * unsuffixed default-install item. For accounts with a `configDir`, the
 * unsuffixed item is NOT used as a fallback — it belongs to the default
 * `~/.claude` login and would silently attribute another account's token.
 *
 * Returns `null` when no credential can be read, so the adapter degrades to a
 * "none" report rather than throwing. The token is returned only to mint an
 * outbound Authorization header; callers must never log or persist it.
 *
 * @param {{ configDir?: string }} account
 * @param {NodeJS.Platform} [platform]
 * @param {typeof spawnSync} [spawn] Injectable for tests; defaults to `node:child_process` `spawnSync`.
 * @param {string} [homeDir] Injectable for tests; defaults to `node:os` `homedir()`.
 * @returns {{ accessToken: string; expiresAt?: number; subscriptionType?: string } | null}
 */
export function readClaudeCredentials(account, platform = process.platform, spawn = spawnSync, homeDir = homedir()) {
  const effectiveConfigDir = account.configDir ?? join(homeDir, ".claude");
  const path = join(effectiveConfigDir, ".credentials.json");
  if (existsSync(path)) {
    const parsed = parseCredentials(readFileSafe(path));
    if (parsed) return parsed;
  }
  if (platform === "darwin") {
    const isDefaultDir = !account.configDir || account.configDir === join(homeDir, ".claude");
    const services = [
      ...(account.configDir ? [`Claude Code-credentials-${claudeKeychainSuffix(account.configDir)}`] : []),
      // The unsuffixed item belongs to the default ~/.claude install only.
      ...(isDefaultDir ? ["Claude Code-credentials"] : []),
    ];
    for (const service of services) {
      const result = spawn("security", ["find-generic-password", "-s", service, "-w"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4_000,
      });
      if (result.status === 0) {
        const parsed = parseCredentials(result.stdout?.toString("utf8") ?? "");
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

/**
 * Claude Code's per-config-dir Keychain item suffix.
 *
 * @param {string} configDir
 * @returns {string}
 */
export function claudeKeychainSuffix(configDir) {
  return createHash("sha256").update(configDir).digest("hex").slice(0, 8);
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
 * @returns {{ accessToken: string; expiresAt?: number; subscriptionType?: string } | null}
 */
function parseCredentials(raw) {
  if (!raw.trim()) return null;
  try {
    const json = JSON.parse(raw);
    const oauth = json?.claudeAiOauth;
    const accessToken = oauth?.accessToken;
    if (typeof accessToken !== "string" || accessToken === "") return null;
    const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
    const subscriptionType = typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType : undefined;
    return { accessToken, expiresAt, subscriptionType };
  } catch {
    return null;
  }
}
