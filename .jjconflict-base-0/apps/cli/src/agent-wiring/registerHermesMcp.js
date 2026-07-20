import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parse, stringify } from "yaml";

/**
 * Registers the Smithers MCP server in Hermes's config (`~/.hermes/config.yaml`).
 *
 * Hermes is a native MCP client but is not covered by the `add-mcp` tool, so we
 * write its `mcp_servers` entry directly — mirroring the Amp special-case in the
 * underlying skill/MCP framework. The Hermes config is YAML; existing content is
 * preserved and only the `smithers` server entry is added or replaced.
 *
 * @param {object} opts
 * @param {string} [opts.name] Server name (default `"smithers"`).
 * @param {string} opts.command Executable agents will run (e.g. `"bunx"`).
 * @param {string[]} opts.args Arguments for the command (e.g. `["smithers-orchestrator", "--mcp"]`).
 * @param {string} [opts.homeDir] Home directory override (for tests).
 * @returns {{ agent: "Hermes"; registered: boolean; path: string; reason?: string }}
 */
export function registerHermesMcp({ name = "smithers", command, args, homeDir = homedir() }) {
  const hermesDir = join(homeDir, ".hermes");
  const configPath = join(hermesDir, "config.yaml");

  // Detect Hermes by the presence of its config directory.
  if (!existsSync(hermesDir)) {
    return { agent: "Hermes", registered: false, path: configPath, reason: "not-detected" };
  }

  /** @type {Record<string, any>} */
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = parse(readFileSync(configPath, "utf8")) ?? {};
    } catch {
      return { agent: "Hermes", registered: false, path: configPath, reason: "unparseable-config" };
    }
    if (typeof config !== "object" || Array.isArray(config)) {
      return { agent: "Hermes", registered: false, path: configPath, reason: "unparseable-config" };
    }
  }

  const servers = config.mcp_servers && typeof config.mcp_servers === "object" ? config.mcp_servers : {};
  servers[name] = { command, args };
  config.mcp_servers = servers;

  if (!existsSync(dirname(configPath))) mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringify(config));

  return { agent: "Hermes", registered: true, path: configPath };
}
