import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Registers the Smithers MCP server in OpenClaw's config (`~/.openclaw/openclaw.json`).
 *
 * OpenClaw is a native MCP client but is not covered by the `add-mcp` tool, so we
 * write its `mcp.servers` entry directly. Existing config is preserved and only the
 * `smithers` server entry is added or replaced. If the existing file cannot be
 * parsed as JSON (e.g. it uses JSON5 comments), we skip rather than clobber it.
 *
 * @param {object} opts
 * @param {string} [opts.name] Server name (default `"smithers"`).
 * @param {string} opts.command Executable agents will run (e.g. `"bunx"`).
 * @param {string[]} opts.args Arguments for the command (e.g. `["smithers-orchestrator", "--mcp"]`).
 * @param {string} [opts.homeDir] Home directory override (for tests).
 * @returns {{ agent: "OpenClaw"; registered: boolean; path: string; reason?: string }}
 */
export function registerOpenClawMcp({ name = "smithers", command, args, homeDir = homedir() }) {
  const openclawDir = join(homeDir, ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");

  // Detect OpenClaw by the presence of its config directory.
  if (!existsSync(openclawDir)) {
    return { agent: "OpenClaw", registered: false, path: configPath, reason: "not-detected" };
  }

  /** @type {Record<string, any>} */
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8")) ?? {};
    } catch {
      return { agent: "OpenClaw", registered: false, path: configPath, reason: "unparseable-config" };
    }
    if (typeof config !== "object" || Array.isArray(config)) {
      return { agent: "OpenClaw", registered: false, path: configPath, reason: "unparseable-config" };
    }
  }

  const mcp = config.mcp && typeof config.mcp === "object" ? config.mcp : {};
  const servers = mcp.servers && typeof mcp.servers === "object" ? mcp.servers : {};
  servers[name] = { command, args };
  mcp.servers = servers;
  config.mcp = mcp;

  if (!existsSync(dirname(configPath))) mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return { agent: "OpenClaw", registered: true, path: configPath };
}
