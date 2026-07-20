/**
 * Parses a `mcp add` / `skills add` argv into supplementary-wiring options, or
 * returns `null` when argv is not one of those commands.
 *
 * Mirrors the flags the underlying framework honors: `--no-global`, repeatable
 * `--agent`/`-a`, and (for MCP) `--command`/`-c`. Unknown flags and their values
 * are ignored.
 *
 * @param {string[]} argv
 * @returns {null | { kind: "mcp" | "skills"; global: boolean; agents?: string[]; command?: string; args?: string[] }}
 */
export function parseAgentWiringArgv(argv) {
  const positionals = [];
  const agents = [];
  let global = true;
  let commandOverride;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--no-global") {
      global = false;
    } else if (tok === "--global") {
      global = true;
    } else if (tok === "--agent" || tok === "-a") {
      const value = argv[++i];
      if (value) agents.push(value.toLowerCase());
    } else if (tok.startsWith("--agent=")) {
      agents.push(tok.slice("--agent=".length).toLowerCase());
    } else if (tok === "--command" || tok === "-c") {
      commandOverride = argv[++i];
    } else if (tok.startsWith("--command=")) {
      commandOverride = tok.slice("--command=".length);
    } else if (!tok.startsWith("-")) {
      positionals.push(tok);
    }
  }

  const [cmd, sub] = positionals;
  if ((cmd !== "mcp" && cmd !== "skills") || sub !== "add") return null;

  /** @type {{ kind: "mcp" | "skills"; global: boolean; agents?: string[]; command?: string; args?: string[] }} */
  const result = { kind: cmd, global };
  if (agents.length) result.agents = agents;
  if (commandOverride) {
    const parts = commandOverride.trim().split(/\s+/);
    result.command = parts[0];
    result.args = parts.slice(1);
  }
  return result;
}
