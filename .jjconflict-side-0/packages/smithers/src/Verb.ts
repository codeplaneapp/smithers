/**
 * The command surface of `smthrs` in 1.0.0-rc.0.
 *
 * At the import reference this module projected `SystemFlows.catalog`
 * directly, so eleven verbs existed only as bodiless reserved flows that
 * planned and exited 0. The CLI contract forbids that partial
 * appearance: a verb either ships with a handler (the shipped-command contract, {@link shipped})
 * or is removed and says so (the removed-command contract, `Unsupported.removedVerbs`).
 *
 * This table is therefore the authority, and `test/Verb.test.ts` pins it. The
 * reserved flow ids that survive are still named here so a catalog change
 * cannot silently desynchronise the two.
 *
 * @since 1.0.0
 */
import { SystemFlows } from "@smthrs/control"

/**
 * One command that ships in rc.0.
 *
 * `aliases` are alternate spellings accepted by the parser. They are hidden
 * from `--help`, because help lists the canonical surface; the alias set is
 * pinned by the tests instead.
 *
 * @category models
 * @since 1.0.0
 */
export interface Verb {
  readonly name: string
  readonly help: string
  readonly aliases: ReadonlyArray<string>
  /** The reserved system-flow id, for the verbs the control catalog reserves. */
  readonly flowId?: `system/${string}` | undefined
  /**
   * Whether `effect/unstable/cli` provides this one itself. `completions` is a
   * built-in global flag (`--completions <shell>`), not a subcommand, so it is
   * part of the shipped surface without being part of the command tree.
   */
  readonly builtin?: boolean | undefined
}

const catalogFlowId = (name: string): `system/${string}` | undefined =>
  SystemFlows.catalog.find((entry) => entry.verb === name)?.flowId

const verb = (name: string, help: string, aliases: ReadonlyArray<string> = []): Verb => {
  const flowId = catalogFlowId(name)
  return { name, help, aliases, ...(flowId === undefined ? {} : { flowId }) }
}

/**
 * Every command that ships in rc.0.
 *
 * @category constants
 * @since 1.0.0
 */
export const shipped: ReadonlyArray<Verb> = [
  verb("plan", "Render a flow plan and its complete approval payload"),
  verb("run", "Run an approved plan payload, or resume a parked run", ["resume"]),
  verb("up", "Plan, approve, and run one flow; -d launches it detached"),
  verb("approve", "Approve the complete serialized approval payload"),
  verb("deny", "Deny the complete serialized approval payload"),
  verb("cancel", "Cancel a durable run"),
  verb("signal", "Deliver a durable JSON signal to a run"),
  verb("steer", "Send a durable, attributed steering message to a run"),
  verb("ls", "List the flows discovered under this project", ["workflow list"]),
  verb("ps", "List durable runs"),
  verb("status", "Show the diagnosis card for one run, or the run listing", ["inspect", "why"]),
  verb("logs", "Read run events; --follow streams future events", ["events"]),
  verb("output", "Print one registered node output"),
  verb("down", "Cancel every non-terminal run"),
  verb("serve", "Host the control server for this project", ["gateway"]),
  verb("init", "Scaffold flows/<name>/flow.mdx and ignore .flows/"),
  verb("doctor", "Report registry, database, runtime, and provider readiness"),
  verb("migrate", "Convert a Smithers 0.x project to the 1.0 authoring model"),
  // No compaction: `Journal.compact` refuses a run the fence still owns, and
  // a terminal run's fence is exactly what retention deletes, so the two run
  // in the wrong order to be one pass. The contract's the shipped-command contract wording is
  // the thing that has to change; this verb says what it does.
  verb("gc", "Delete terminal runs older than a threshold, with the rows they own"),
  verb("memory", "Read and write namespaced facts in the control database"),
  verb("claude", "Claude Code plugin mirror protocol"),
  verb("mcp", "Wire the Smithers MCP server into an agent"),
  verb("update", "Check npm for a newer @smthrs/cli"),
  verb("bug", "Report a bug with a run digest attached"),
  { ...verb("completions", "Print a shell completion script"), builtin: true }
]

/**
 * The verbs that are subcommands of the command tree, which is every shipped
 * verb except the ones `effect/unstable/cli` provides as built-in flags.
 *
 * @category constants
 * @since 1.0.0
 */
export const subcommands: ReadonlyArray<Verb> = shipped.filter((entry) => entry.builtin !== true)

/**
 * Every shipped command name.
 *
 * @category constants
 * @since 1.0.0
 */
export const names: ReadonlyArray<string> = shipped.map((entry) => entry.name)

/**
 * Finds one shipped verb by name.
 *
 * @category getters
 * @since 1.0.0
 */
export const find = (name: string): Verb | undefined => shipped.find((entry) => entry.name === name)
