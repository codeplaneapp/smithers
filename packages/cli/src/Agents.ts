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
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
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

/** Why an existing configuration cannot be updated in place, if it cannot. */
interface Unusable {
  readonly reason: string
}

interface Configuration {
  readonly document: Record<string, unknown>
  readonly source: Buffer | undefined
  readonly mode: number | undefined
}

const isUnusable = (value: Configuration | Unusable): value is Unusable => "reason" in value

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

/**
 * Reads an agent's configuration, or says why it must not be written over.
 *
 * A missing file is the first-run case and reads as an empty document. Every
 * other unreadable shape is refused rather than replaced: treating a parse
 * failure as `{}` meant one stray comma in an operator's `~/.claude.json`
 * turned the whole file into a document holding nothing but the Smithers
 * server entry, with no copy of what was there before.
 */
const readJson = (path: string): Configuration | Unusable => {
  let descriptor: number
  try {
    descriptor = openSync(path, "r")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { document: {}, source: undefined, mode: undefined }
    return { reason: `${path} could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  let source: Buffer
  let mode: number
  try {
    source = readFileSync(descriptor)
    mode = fstatSync(descriptor).mode & 0o777
  } catch (error) {
    return { reason: `${path} could not be read: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    closeSync(descriptor)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source.toString("utf8"))
  } catch (error) {
    return {
      reason: `${path} is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }). Fix the file, then run this again.`
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: `${path} has a root that is not a JSON object. Fix the file, then run this again.` }
  }
  return { document: parsed as Record<string, unknown>, source, mode }
}

const sourceStillMatches = (path: string, source: Buffer | undefined, mode: number | undefined): boolean => {
  try {
    const current = readFileSync(path)
    return source !== undefined && current.equals(source) && (statSync(path).mode & 0o777) === mode
  } catch (error) {
    return source === undefined && errorCode(error) === "ENOENT"
  }
}

const syncPath = (path: string): void => {
  const descriptor = openSync(path, "r")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
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
  const lockPath = `${path}.smithers.lock`
  let lock: number | undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
    lock = openSync(lockPath, "wx", 0o600)
    const configuration = readJson(path)
    if (isUnusable(configuration)) {
      return { agent: agent.id, path, status: "failed", reason: configuration.reason }
    }
    const { document, mode, source } = configuration
    const existing = document["mcpServers"]
    if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
      return {
        agent: agent.id,
        path,
        status: "failed",
        reason: `${path} has an mcpServers member that is not an object. Fix the file, then run this again.`
      }
    }
    const servers = existing === undefined ? {} : { ...existing as Record<string, unknown> }
    const desired = { command: entry.command, args: [...entry.args] }
    if (JSON.stringify(servers[serverName]) === JSON.stringify(desired)) {
      return { agent: agent.id, path, status: "unchanged" }
    }
    servers[serverName] = desired
    // Temp-plus-rename, mode preserved: a crash between truncation and the
    // last byte would otherwise leave the operator with a half-written
    // configuration and no copy of the original.
    const temporary = `${path}.smithers-${process.pid}-${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ ...document, mcpServers: servers }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: mode ?? 0o600
    })
    try {
      if (mode !== undefined) chmodSync(temporary, mode)
      syncPath(temporary)
      if (!sourceStillMatches(path, source, mode)) {
        return {
          agent: agent.id,
          path,
          status: "failed",
          reason: `${path} changed while Smithers was preparing the update. No change was written; run this again.`
        }
      }
      renameSync(temporary, path)
      syncPath(dirname(path))
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // The temp file is already gone, which is the outcome this wanted.
      }
      throw error
    }
    return { agent: agent.id, path, status: "written" }
  } catch (error) {
    return {
      agent: agent.id,
      path,
      status: "failed",
      reason: errorCode(error) === "EEXIST" && lock === undefined
        ? `${path} is being updated by another Smithers process. No change was written; run this again.`
        : error instanceof Error
        ? error.message
        : String(error)
    }
  } finally {
    if (lock !== undefined) {
      closeSync(lock)
      unlinkSync(lockPath)
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
 * verb list carries none of that (release policy: rc.0 `skills add`
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
  // `<package>/docs/..` is the package root in both layouts, so the checkout
  // source is two levels above it. Counting from the docs directory itself
  // landed on `packages/skills` once the package was built, because `dist`
  // adds a level the count did not know about.
  join(docsDirectory, "..", "..", "..", "skills", "smithers", "SKILL.md")
]

/**
 * What the curated-skill lookup found.
 *
 * @category models
 * @since 1.0.0
 */
export type CuratedSkill =
  | { readonly _tag: "found"; readonly path: string; readonly contents: string }
  | { readonly _tag: "missing"; readonly searched: ReadonlyArray<string> }

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
export const skill = (docsDirectory: string = Docs.directory()): CuratedSkill => {
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
