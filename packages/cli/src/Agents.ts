/**
 * Wiring Smithers into the agents an operator already runs.
 *
 * Two commands share this module. `smithers mcp add` writes the stdio MCP
 * server entry into an agent's own configuration, and `smithers skills add`
 * writes the `smithers` skill into the directory that agent reads skills from.
 *
 * rc.0 knows two agents, Claude Code and Codex, because those are the two the
 * release supports directly; every other 0.x target (Hermes, OpenClaw, Pi)
 * moved to the plugins repository with its adapter. Writing is always
 * additive and idempotent: an entry that is already correct is left alone, and
 * an agent whose configuration cannot be written gets the snippet printed
 * instead of a silent failure.
 *
 * @since 1.0.0
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * The MCP server name Smithers registers under.
 *
 * @category constants
 * @since 1.0.0
 */
export const serverName = "smithers"

/**
 * One agent this CLI can wire itself into.
 *
 * @category models
 * @since 1.0.0
 */
export interface Agent {
  readonly id: string
  /** The agent's MCP server map, relative to the home directory. */
  readonly mcpConfig: ReadonlyArray<string>
  /** Where the agent reads skills from, relative to the home directory. */
  readonly skillsDirectory: ReadonlyArray<string>
}

/**
 * The agents rc.0 wires.
 *
 * @category constants
 * @since 1.0.0
 */
export const agents: ReadonlyArray<Agent> = [
  { id: "claude", mcpConfig: [".claude.json"], skillsDirectory: [".claude", "skills"] },
  { id: "codex", mcpConfig: [".codex", "mcp.json"], skillsDirectory: [".codex", "skills"] }
]

/**
 * Finds one agent by id.
 *
 * @category getters
 * @since 1.0.0
 */
export const find = (id: string): Agent | undefined => agents.find((agent) => agent.id === id)

/**
 * The launch command an agent should start the MCP server with.
 *
 * The current executable and entry are used verbatim rather than a package
 * runner: a checkout under development must register the CLI under edit, and
 * an installed CLI registers its own installed path. 0.x registered
 * `bunx smthrs --mcp`, which silently pointed every agent at the last
 * published build.
 *
 * @category constructors
 * @since 1.0.0
 */
export const launchCommand = (
  execPath: string = process.execPath,
  entry: string = process.argv[1] ?? "smithers"
): { readonly command: string; readonly args: ReadonlyArray<string> } => ({
  command: execPath,
  args: [entry, "--mcp"]
})

/**
 * What one wiring attempt did.
 *
 * @category models
 * @since 1.0.0
 */
export interface Wired {
  readonly agent: string
  readonly path: string
  readonly status: "written" | "unchanged" | "failed"
  readonly reason?: string | undefined
}

const readJson = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/**
 * Registers the Smithers MCP server with one agent.
 *
 * @category constructors
 * @since 1.0.0
 */
export const addMcp = (agent: Agent, home: string = homedir()): Wired => {
  const path = join(home, ...agent.mcpConfig)
  const entry = launchCommand()
  try {
    const document = readJson(path)
    const servers = document["mcpServers"] !== null && typeof document["mcpServers"] === "object"
      ? { ...document["mcpServers"] as Record<string, unknown> }
      : {}
    const desired = { command: entry.command, args: [...entry.args] }
    if (JSON.stringify(servers[serverName]) === JSON.stringify(desired)) {
      return { agent: agent.id, path, status: "unchanged" }
    }
    servers[serverName] = desired
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ ...document, mcpServers: servers }, null, 2)}\n`, "utf8")
    return { agent: agent.id, path, status: "written" }
  } catch (error) {
    return {
      agent: agent.id,
      path,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * The manual instructions printed when automatic registration fails.
 *
 * The `--` separator matters: without it an agent's own argument parser reads
 * `--mcp` as one of its flags and rejects the registration.
 *
 * @category constructors
 * @since 1.0.0
 */
export const manualInstructions = (targets: ReadonlyArray<string> = agents.map((agent) => agent.id)): string => {
  const entry = launchCommand()
  const launch = [entry.command, ...entry.args].join(" ")
  return [
    "Could not register the Smithers MCP server automatically.",
    "",
    "Register it with the agent's own CLI. The `--` separator is required so the",
    "agent treats everything after it as the launch command, not its own flags:",
    "",
    ...targets.map((target) => `  ${target} mcp add ${serverName} -- ${launch}`),
    "",
    "Or add it to the agent's MCP configuration by hand:",
    "",
    "  {",
    '    "mcpServers": {',
    `      "${serverName}": { "command": ${JSON.stringify(entry.command)}, "args": ${JSON.stringify(entry.args)} }`,
    "    }",
    "  }",
    "",
    "Docs: https://smithers.sh/integrations/mcp-server"
  ].join("\n")
}

/**
 * The `smithers` skill, generated from the shipped verb table so it cannot
 * describe a command this release does not have.
 *
 * @category constructors
 * @since 1.0.0
 */
export const skill = (verbs: ReadonlyArray<{ readonly name: string; readonly help: string }>): string =>
  [
    "---",
    "name: smithers",
    "description: Plan, approve, run, and inspect durable Smithers flows from the command line.",
    "---",
    "",
    "# Smithers",
    "",
    "Smithers runs durable flows: work that survives a process restart, parks for",
    "a human approval, and can be cancelled, steered, and replayed from its own",
    "journal. Drive it with the commands below rather than re-implementing",
    "retries, approvals, or background processes yourself.",
    "",
    "## Commands",
    "",
    ...verbs.map((verb) => `- \`smithers ${verb.name}\` — ${verb.help}.`),
    "",
    "## The usual shape",
    "",
    "```sh",
    "smithers ls                      # what flows this project has",
    "smithers up <flow> -d            # launch one detached; prints its run id",
    "smithers ps                      # what is running",
    "smithers logs <run-id> --follow  # watch it",
    "smithers approve <payload>       # release a run parked on an approval",
    "smithers cancel <run-id>         # stop it, durably",
    "```",
    "",
    "A run that parks for approval exits 3. `--json` makes every command print",
    "one machine-readable document.",
    ""
  ].join("\n")

/**
 * Installs the skill into one agent's skills directory.
 *
 * @category constructors
 * @since 1.0.0
 */
export const addSkill = (
  agent: Agent,
  contents: string,
  home: string = homedir()
): Wired => {
  const path = join(home, ...agent.skillsDirectory, serverName, "SKILL.md")
  try {
    if (existsSync(path) && readFileSync(path, "utf8") === contents) {
      return { agent: agent.id, path, status: "unchanged" }
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, "utf8")
    return { agent: agent.id, path, status: "written" }
  } catch (error) {
    return {
      agent: agent.id,
      path,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Lists where the skill is installed.
 *
 * @category getters
 * @since 1.0.0
 */
export const listSkills = (home: string = homedir()): ReadonlyArray<
  { readonly agent: string; readonly path: string; readonly installed: boolean }
> =>
  agents.map((agent) => {
    const path = join(home, ...agent.skillsDirectory, serverName, "SKILL.md")
    return { agent: agent.id, path, installed: existsSync(path) }
  })
