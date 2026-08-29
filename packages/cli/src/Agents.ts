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

import * as Docs from "./Docs.ts"

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
    "    \"mcpServers\": {",
    `      "${serverName}": { "command": ${JSON.stringify(entry.command)}, "args": ${JSON.stringify(entry.args)} }`,
    "    }",
    "  }",
    "",
    "Docs: https://smithers.sh/integrations/mcp-server"
  ].join("\n")
}

/**
 * Where the curated `smithers` skill is read from, in order.
 *
 * `skills add` installs one hand-written file, not a rendering of the verb
 * table. The curated skill teaches the routing rules, the mental model, the
 * removed-verb table, and the MCP tool split, and a file generated from the
 * verb list carries none of that (rc-contract ruling F2: rc.0 `skills add`
 * "writes the single curated `smithers` skill ... and generates no per-verb
 * skills").
 *
 * A published install reads the packaged copy the docs generator writes into
 * this package. A source checkout has no packaged copy until `pnpm docs:llms`
 * has run, so it falls back to the curated source the generator copies from.
 *
 * @category constructors
 * @since 1.0.0
 */
export const skillSources = (docsDirectory: string = Docs.directory()): ReadonlyArray<string> => [
  join(docsDirectory, "SKILL.md"),
  join(docsDirectory, "..", "..", "..", "skills", "smithers", "SKILL.md")
]

/**
 * The curated `smithers` skill, read from the first source that exists.
 *
 * Missing is reported, never substituted: installing a generated stub under
 * the curated skill's name is the failure this function exists to prevent, so
 * an installation with no curated file says so instead of writing something
 * else.
 *
 * @category constructors
 * @since 1.0.0
 */
export const skill = (
  docsDirectory: string = Docs.directory()
):
  | { readonly _tag: "found"; readonly path: string; readonly contents: string }
  | { readonly _tag: "missing"; readonly searched: ReadonlyArray<string> } =>
{
  const searched = skillSources(docsDirectory)
  for (const path of searched) {
    if (existsSync(path)) return { _tag: "found", path, contents: readFileSync(path, "utf8") }
  }
  return { _tag: "missing", searched }
}

/**
 * The message printed when no curated skill ships with this installation.
 *
 * @category constructors
 * @since 1.0.0
 */
export const skillMissing = (searched: ReadonlyArray<string>): string =>
  `No curated smithers skill in this installation. Looked in ${searched.join(", ")}. ` +
  `Run \`pnpm docs:llms\` in a source checkout, or reinstall @smthrs/cli.`

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
