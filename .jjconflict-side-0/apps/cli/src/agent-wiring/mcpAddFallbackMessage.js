/**
 * Builds the guidance printed when `smithers mcp add` fails inside the
 * registration helper.
 *
 * The helper (`add-mcp`) requires the launch command as a single quoted
 * positional. When a runner or shell word-splits `bunx smithers-orchestrator
 * --mcp`, the helper's argument parser sees a bare `--mcp` token and aborts with
 * `unknown option '--mcp'` (older paths) or `too many arguments`. The reliable
 * recovery is to register with the agent's own CLI using a `--` separator, so
 * the agent never parses `--mcp` as one of its own flags.
 *
 * @param {{ launchCommand?: string; agents?: string[] }} [opts]
 * @returns {string}
 */
export function mcpAddFallbackMessage(opts = {}) {
  const launchCommand = opts.launchCommand ?? "bunx smithers-orchestrator --mcp";
  // Show the agent(s) the user targeted; otherwise the two most common CLIs.
  const targets = opts.agents?.length ? opts.agents : ["codex", "claude"];
  const directCommands = targets.map((agent) => `  ${agent} mcp add smithers -- ${launchCommand}`);

  const [command, ...args] = launchCommand.split(/\s+/);
  const jsonArgs = args.map((a) => JSON.stringify(a)).join(", ");

  return [
    "Could not auto-register the Smithers MCP server.",
    `This often means a runner word-split the launch command and the helper rejected the bare "--mcp" flag.`,
    "",
    "Register it directly with your agent's CLI instead. The `--` separator is required so",
    'the agent treats everything after it as the launch command, not its own flags:',
    "",
    ...directCommands,
    "",
    "Or add it to the agent's MCP config by hand:",
    "",
    "  {",
    '    "mcpServers": {',
    `      "smithers": { "command": ${JSON.stringify(command)}, "args": [${jsonArgs}] }`,
    "    }",
    "  }",
    "",
    "Docs: https://smithers.sh/integrations/mcp-server",
  ].join("\n");
}
