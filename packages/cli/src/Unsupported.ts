/**
 * The removal surface for 0.x commands and flags.
 *
 * A verb that 0.x had and rc.0 does not must fail with a sentence that names
 * the replacement, not with a usage error. `effect/unstable/cli` answers an
 * unknown subcommand with exit 2 and a "did you mean" list, which tells an
 * operator nothing about why `smithers rewind` stopped existing. So every
 * removed verb is registered as a hidden subcommand whose only behaviour is
 * to fail with {@link message}, and every removed flag is declared hidden on
 * the command that used to carry it.
 *
 * The tables below are the contract. `test/Verb.test.ts` pins the verb set and
 * `test/Bin.test.ts` pins the flags, so a verb cannot quietly reappear and a
 * flag cannot quietly become a usage error again.
 *
 * @since 1.0.0
 */
import * as CliError from "./CliError.ts"

/**
 * The documentation base every removal message points at.
 *
 * @category constants
 * @since 1.0.0
 */
export const migrationUrl = "https://smithers.sh/migration/1.0"

/**
 * One removed verb: its name, the anchor its message links to, and why it is
 * gone.
 *
 * `anchor` differs from `name` only for a sub-verb group, where the whole
 * group is documented under its parent (`worktrees list` links to
 * `#worktrees`).
 *
 * @category models
 * @since 1.0.0
 */
export interface RemovedVerb {
  readonly name: string
  readonly group: string
  readonly reason: string
  readonly subcommands?: ReadonlyArray<string> | undefined
}

const timeTravel = "time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred"
const recovery = "the run driver's heartbeat sweep owns recovery"
const uiHosting = "replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted"
const control = "not available; use `steer`, `signal`, `approve`, `deny`, `cancel`, `run --resume`"
const plugins = "moved to the plugins repository or deferred"
const packs = "JSX pack tooling is gone; `smithers migrate` replaces `upgrade`"
const approvals = "approvals park the run; use `ps --status waiting-approval`, `approve`, and `deny`"
const nodeDetail = "use `output`, `logs --json`, and the node-output projection"
const jsx = "removed with the JSX inline workflow"
const evaluation = "not part of the engine release"
const reserved = "not an rc.0 verb"

const removed = (group: string, reason: string, names: ReadonlyArray<string>): ReadonlyArray<RemovedVerb> =>
  names.map((name) => ({ name, group, reason }))

const removedGroup = (
  group: string,
  reason: string,
  name: string,
  subcommands: ReadonlyArray<string>
): RemovedVerb => ({ name, group, reason, subcommands })

/**
 * Every verb removed in 1.0.0-rc.0.
 *
 * @category constants
 * @since 1.0.0
 */
export const removedVerbs: ReadonlyArray<RemovedVerb> = [
  ...removed("Time travel and checkpoints", timeTravel, [
    "replay",
    "rewind",
    "fork",
    "timetravel",
    "snapshots",
    "restore",
    "snapshot-hook",
    "revert",
    "retry-task",
    "tree",
    "graph",
    "timeline",
    "diff"
  ]),
  removedGroup("Time travel and checkpoints", timeTravel, "worktrees", ["list", "prune"]),
  ...removed("Hijack and pause", control, ["hijack", "pause"]),
  // Bare `gateway` survives as the `serve` alias, so only the two subcommands
  // are removed. They are a group rather than plain verbs for exactly that
  // reason: the parent still runs.
  removedGroup("Old gateway and UI hosting", uiHosting, "gateway", ["status", "stop"]),
  ...removed("Old gateway and UI hosting", uiHosting, ["ui", "gui", "monitor"]),
  ...removed("Supervision", recovery, ["supervise", "supervisor", "top"]),
  ...removed("Evaluation and optimization", evaluation, ["eval", "optimize", "scores"]),
  ...removed("Chat and narration", jsx, ["chat", "chat-create", "what", "ask"]),
  removedGroup("Accounts and providers", plugins, "agents", [
    "add",
    "list",
    "reauth",
    "remove",
    "test",
    "capabilities",
    "doctor"
  ]),
  ...removed("Accounts and providers", plugins, [
    "usage",
    "claude-shell",
    "hermes",
    "listeners",
    "observability",
    "alerts"
  ]),
  removedGroup("Accounts and providers", plugins, "herdr", ["status", "attach", "open", "clean"]),
  removedGroup("Accounts and providers", plugins, "openapi", ["list", "generate"]),
  removedGroup("Accounts and providers", plugins, "token", ["issue", "exec", "revoke"]),
  removedGroup("Accounts and providers", `${plugins} (cron returns on @smthrs/triggers)`, "cron", [
    "start",
    "add",
    "list",
    "rm"
  ]),
  ...removed("Packs and scaffolding", packs, [
    "make-workflow",
    "starters",
    "share",
    "add",
    "remove",
    "eject",
    "upgrade"
  ]),
  removedGroup("Packs and scaffolding", packs, "packs", ["list", "update"]),
  // The singular `workflow` is the removed-command contract's packs row, not the `workflows`
  // did-you-mean key: what an operator lost with `workflow path` is pack
  // tooling, not a listing. `workflow list` survives as the `ls` alias and is
  // registered as a real subcommand of the group.
  removedGroup("Packs and scaffolding", packs, "workflow", [
    "run",
    "path",
    "create",
    "inspect",
    "skills",
    "doctor"
  ]),
  removedGroup("Human requests", approvals, "human", ["list", "resolve"]),
  ...removed("Human requests", approvals, ["ask-human"]),
  ...removed("Node detail", nodeDetail, ["node", "tail"]),
  ...removed("Review and release", reserved, ["review", "release", "test"]),
  ...removed("Old aliases and did-you-mean keys", "`docs-full` becomes `docs --full`", ["docs-full"]),
  ...removed("Old aliases and did-you-mean keys", "use `ps`", ["list-runs", "runs"]),
  ...removed("Old aliases and did-you-mean keys", "use `ls`", ["list", "workflows"]),
  ...removed("Old aliases and did-you-mean keys", "use `cancel`", ["stop", "kill"]),
  ...removed("Old aliases and did-you-mean keys", "use `up`", ["start", "exec"]),
  ...removed("Old aliases and did-you-mean keys", "use `status`", ["show"]),
  ...removed("Old aliases and did-you-mean keys", "use `logs`", ["log"]),
  ...removed("Old aliases and did-you-mean keys", "use `--help`", ["help"])
]

/**
 * One removed flag, declared hidden on the command that used to carry it.
 *
 * @category models
 * @since 1.0.0
 */
export interface RemovedFlag {
  /** The rc.0 command the flag is declared on; `""` names the shared globals. */
  readonly parent: string
  readonly flag: string
  readonly reason: string
  readonly anchor: string
}

/**
 * Every flag removed in 1.0.0-rc.0.
 *
 * `--backend` is the one entry that is not a plain refusal: `--backend sqlite`
 * names the supported backend and is accepted as a no-op, and only another
 * value fails. {@link Environment.unsupportedBackend} owns that distinction.
 *
 * @category constants
 * @since 1.0.0
 */
export const removedFlags: ReadonlyArray<RemovedFlag> = [
  {
    parent: "steer",
    flag: "takeover",
    reason: "hijack is not available; `steer --message` is the only mode",
    anchor: "hijack"
  },
  { parent: "up", flag: "serve", reason: uiHosting, anchor: "ui" },
  { parent: "up", flag: "interactive", reason: uiHosting, anchor: "ui" },
  { parent: "up", flag: "supervise", reason: uiHosting, anchor: "ui" },
  { parent: "up", flag: "herdr", reason: uiHosting, anchor: "ui" },
  { parent: "up", flag: "monitor", reason: uiHosting, anchor: "ui" },
  { parent: "up", flag: "report", reason: uiHosting, anchor: "ui" },
  { parent: "up", flag: "force", reason: recovery, anchor: "supervision" },
  { parent: "up", flag: "steal-ownership", reason: recovery, anchor: "supervision" },
  { parent: "up", flag: "resume-claim-owner", reason: recovery, anchor: "supervision" },
  { parent: "up", flag: "resume-claim-heartbeat", reason: recovery, anchor: "supervision" },
  { parent: "up", flag: "resume-restore-owner", reason: recovery, anchor: "supervision" },
  { parent: "up", flag: "resume-restore-heartbeat", reason: recovery, anchor: "supervision" },
  {
    parent: "up",
    flag: "max-concurrency",
    reason: "parallelism is declared by the flow and bounded by plan admission",
    anchor: "plan-admission"
  },
  {
    parent: "migrate",
    flag: "to",
    reason: "SQLite only; the 0.x database move is removed",
    anchor: "databases"
  },
  {
    parent: "init",
    flag: "global",
    reason: "rc.0 has no global pack; seats resolve from environment keys",
    anchor: "init"
  },
  {
    parent: "",
    flag: "backend",
    reason: "SQLite only (`--backend sqlite` is accepted as a no-op)",
    anchor: "databases"
  }
]

/**
 * The removal sentence for one verb.
 *
 * @category constructors
 * @since 1.0.0
 */
export const message = (verb: string, reason: string, anchor: string = verb): string =>
  `smithers ${verb} was removed in 1.0.0-rc.0: ${reason}. See ${migrationUrl}#${anchor}`

/**
 * The removal sentence for one flag.
 *
 * @category constructors
 * @since 1.0.0
 */
export const flagMessage = (removedFlag: RemovedFlag): string => {
  const command = removedFlag.parent === "" ? "" : `${removedFlag.parent} `
  return `smithers ${command}--${removedFlag.flag} was removed in 1.0.0-rc.0: ${removedFlag.reason}. ` +
    `See ${migrationUrl}#${removedFlag.anchor}`
}

/**
 * The failure a removed verb raises: exit 1, never a usage error.
 *
 * @category constructors
 * @since 1.0.0
 */
export const verbError = (verb: RemovedVerb, subcommand?: string | undefined): CliError.UnsupportedError =>
  new CliError.UnsupportedError({
    message: message(
      subcommand === undefined ? verb.name : `${verb.name} ${subcommand}`,
      verb.reason,
      verb.name
    )
  })

/**
 * Removed verbs whose bare spelling still runs something, so a refusal has to
 * read the form rather than the name.
 *
 * `gateway` is the `serve` alias and only `gateway status|stop` are removed.
 * `workflow list` is the `ls` alias and every other `workflow` form is gone,
 * the bare parent included. `Command.ts` registers both by hand for the same
 * reason.
 */
const survivingParents = new Set(["gateway", "workflow"])

/**
 * The refusal an argument vector earns before anything boots, or `undefined`.
 *
 * A removed verb is a sentence, not work. Answering it from the command tree
 * meant answering it from inside `NodeControl.layer`, so the process created
 * `<cwd>/.flows/` and opened `engine.db` and `control.db` before it printed:
 * an operator who typed a 0.x verb got a project state directory as the side
 * effect of being told the verb is gone, and the eight-at-a-time spawns in
 * `scripts/docs-removals.test.mjs` contended on those two SQLite files.
 *
 * The scan is deliberately narrow, the way `bin.ts` reads `--help` and
 * `--version`: it fires only for `smithers <verb> [<positional>...]`, and any
 * flag anywhere in the vector sends the invocation down the ordinary path.
 * A flag can take a value, a value can be spelled like a verb, and the
 * registered hidden commands in `Command.ts` are still the authority for every
 * shape this one declines to read. Missing a refusal here costs the old
 * startup; misreading one would print the wrong sentence.
 *
 * @category getters
 * @since 1.0.0
 */
export const refusal = (args: ReadonlyArray<string>): CliError.UnsupportedError | undefined => {
  const [name, ...rest] = args
  if (name === undefined || name.startsWith("-")) return undefined
  if (rest.some((argument) => argument.startsWith("-"))) return undefined
  const verb = removedVerbs.find((entry) => entry.name === name)
  if (verb === undefined) return undefined
  const form = rest[0]
  if (!survivingParents.has(name)) {
    return verbError(verb, verb.subcommands === undefined ? undefined : form)
  }
  // `gateway` runs `serve`, so only the two named subcommands refuse.
  if (name === "gateway") {
    return form !== undefined && verb.subcommands!.includes(form) ? verbError(verb, form) : undefined
  }
  // `workflow` refuses every form but the surviving `list` alias, bare
  // `workflow` included, which is what `Command.ts` does with `rest[0]`.
  return form === "list" ? undefined : verbError(verb, form)
}

/**
 * Whether a flow id belongs to the control plane's reserved catalog.
 *
 * `@smthrs/control`'s `SystemFlows.catalog` reserves one `system/*` id per
 * command-line verb so a projection has a flow row to hang off. rc.0 ships a
 * body for none of them.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isReservedFlow = (flowId: string): boolean => flowId.startsWith("system/")

/**
 * The failure naming a reserved flow raises.
 *
 * A bodiless flow plans and launches perfectly well: the run row is durable,
 * the receipt says `Accepted`, and then nothing ever happens, because there is
 * no graph to execute. That partial appearance
 * forbids, so the verbs that take a flow id refuse the reserved ones outright.
 *
 * @category constructors
 * @since 1.0.0
 */
export const reservedFlowError = (verb: string, flowId: string): CliError.UnsupportedError =>
  new CliError.UnsupportedError({
    message: `smithers ${verb} ${flowId}: ${flowId} is a reserved system flow id and carries no body in ` +
      `1.0.0-rc.0, so a launch would park with nothing to run. Name a flow from \`smithers ls\`. ` +
      `See ${migrationUrl}#flows`
  })

/**
 * The failure a removed flag raises: exit 1, never a usage error.
 *
 * @category constructors
 * @since 1.0.0
 */
export const flagError = (removedFlag: RemovedFlag): CliError.UnsupportedError =>
  new CliError.UnsupportedError({ message: flagMessage(removedFlag) })

/**
 * Looks up one removed flag by the command it is declared on and its name.
 *
 * @category getters
 * @since 1.0.0
 */
export const findFlag = (parent: string, flag: string): RemovedFlag => {
  const found = removedFlags.find((entry) => entry.parent === parent && entry.flag === flag)
  if (found === undefined) throw new Error(`No removed flag ${parent} --${flag} is declared`)
  return found
}
