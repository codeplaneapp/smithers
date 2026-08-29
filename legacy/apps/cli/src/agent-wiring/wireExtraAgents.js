import { homedir } from "node:os";

import { linkPiSkills } from "./linkPiSkills.js";
import { registerHermesMcp } from "./registerHermesMcp.js";
import { registerHermesPlugin } from "./registerHermesPlugin.js";
import { registerOpenClawMcp } from "./registerOpenClawMcp.js";
import { registerOpenClawPlugin } from "./registerOpenClawPlugin.js";

/** Agent ids handled here that the underlying `mcp add` / `skills add` does not reach. */
export const EXTRA_MCP_AGENTS = ["hermes", "openclaw"];
export const EXTRA_SKILL_AGENTS = ["pi"];

/**
 * Detects the package-manager runner (`npx`, `pnpx`, `bunx`) the same way the
 * underlying MCP framework (incur) does, so Hermes/OpenClaw get the launcher that
 * actually exists on this host instead of a hardcoded `bunx` that may be absent.
 * Mirrors incur's `detectRunner` (env-based, no extra deps).
 *
 * @returns {"npx" | "pnpx" | "bunx"}
 */
function detectRunner() {
  const userAgent = process.env.npm_config_user_agent ?? "";
  const execPath = process.env.npm_execpath ?? "";
  if (userAgent.includes("pnpm") || execPath.includes("pnpm")) return "pnpx";
  if (userAgent.includes("bun") || execPath.includes("bun")) return "bunx";
  return "npx";
}

/**
 * Wires Smithers into agents the underlying skill/MCP framework does not cover:
 * Hermes/OpenClaw (native MCP config plus native plugin surfaces) and Pi (skills
 * directory). Run as a supplementary step after `mcp add` / `skills add`.
 *
 * @param {object} opts
 * @param {"mcp" | "skills"} opts.kind Which install ran.
 * @param {string} [opts.name] MCP server name (default `"smithers"`).
 * @param {string} [opts.command] MCP launch executable (default: the detected runner — `npx`/`pnpx`/`bunx` — matching what incur registers for other agents).
 * @param {string[]} [opts.args] MCP launch args (default `["smthrs", "--mcp"]`).
 * @param {boolean} [opts.global] Install globally (default `true`).
 * @param {string} [opts.cwd] Working directory for project-scoped installs.
 * @param {string[]} [opts.agents] Optional `--agent` filter; when set, only these ids are wired.
 * @param {string} [opts.homeDir] Home directory override (for tests).
 * @returns {Array<{ agent: string; registered?: boolean; installedPlugin?: boolean; enabled?: boolean; linked?: string[]; path: string; reason?: string }>}
 */
export function wireExtraAgents({
  kind,
  name = "smithers",
  command = detectRunner(),
  args = ["smthrs", "--mcp"],
  global = true,
  cwd = process.cwd(),
  agents,
  homeDir = homedir(),
}) {
  const wants = (id) => !agents || agents.includes(id);
  const results = [];

  if (kind === "mcp") {
    if (wants("hermes")) {
      // The bare MCP entry is the floor (tools work even with user plugins
      // disabled); the native plugin is the rich surface (slash commands,
      // status injector, lifecycle hooks, bundled skill, approval buttons).
      results.push(registerHermesMcp({ name, command, args, homeDir }));
      results.push(registerHermesPlugin({ homeDir }));
    }
    if (wants("openclaw")) {
      results.push(registerOpenClawMcp({ name, command, args, homeDir }));
      results.push(registerOpenClawPlugin({ homeDir }));
    }
  } else if (kind === "skills") {
    if (wants("pi")) results.push(linkPiSkills({ global, cwd, homeDir }));
  }

  return results;
}
