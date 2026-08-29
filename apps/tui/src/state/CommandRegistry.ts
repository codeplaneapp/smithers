/*
 * The TUI's slash-command registry: one dispatch path for every "/name args"
 * submission, everything else falls through to the agent as a prompt.
 *
 * This mirrors the flows-are-the-app pattern in
 * apps/ui/src/mainview/flows/{Commands,registry,SlashPayload}.ts — one
 * registry, one parse-then-dispatch path, argument text turned into a typed
 * shape exactly once — cut down to what the TUI can actually run.
 *
 * The cut matters: apps/ui executes flows locally through
 * `@smthrs/harness/FlowBinding` (an Effect-based, agent-callable capability).
 * apps/tui has no local flow-execution engine at all — it is a thin client
 * that ships every prompt to a remote agent turn transport (see
 * agent/transport.ts) and renders the frames that come back. A "command"
 * here is therefore a small CLIENT-LOCAL affordance (clear the transcript,
 * exit) that never reaches the agent, not an executable flow the agent could
 * also call. Making TUI commands agent-callable flows would mean extending
 * the agent turn wire contract in smithers-shared/NativeAgent (and whatever
 * runs on the other end of it) to carry a flow-call kind — a server-side
 * decision this module does not make.
 */

/** UI-catalog copy for one registered command. */
export interface CommandMetadata {
  readonly summary: string
  /** Not listed in the slash menu; still runnable by typing its full name. */
  readonly hidden?: boolean
  /** The argument hint shown in the menu, e.g. "<text>". Cosmetic only here. */
  readonly args?: string
}

/** What a command's `run` needs from the app to act. */
export interface CommandContext {
  readonly quit: () => void
}

export type CommandOutcome =
  | { readonly status: "executed"; readonly value?: string }
  | { readonly status: "unknown-command" }
  | { readonly status: "failed"; readonly error: string }

/** One registered command: its identity, catalog copy, and handler. */
export interface CommandEntry {
  readonly name: string
  readonly metadata: CommandMetadata
  readonly run: (args: string | undefined, ctx: CommandContext) => CommandOutcome
}

/** A needle matches a command by name or summary, case-insensitively. */
const matches = (entry: CommandEntry, needle: string): boolean => {
  const query = needle.trim().toLowerCase()
  if (query === "") return true
  return entry.name.toLowerCase().includes(query) || entry.metadata.summary.toLowerCase().includes(query)
}

/** How directly a command answers a needle, best first — see registry.ts's nameRank for the full doctrine. */
const nameRank = (entry: CommandEntry, query: string): number => {
  if (query === "") return 0
  const name = entry.name.toLowerCase()
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (name.includes(query)) return 2
  return 3
}

/** A listing longer than this is a wall, not a menu. */
export const SLASH_MENU_CAP = 8

/** The slash menu's listing for one needle, closest match first, capped. */
export const slashItems = (
  needle: string,
  entries: ReadonlyArray<CommandEntry>
): ReadonlyArray<CommandEntry> => {
  const query = needle.trim().toLowerCase()
  return entries
    .filter((entry) => entry.metadata.hidden !== true && matches(entry, needle))
    .sort((left, right) => nameRank(left, query) - nameRank(right, query))
    .slice(0, SLASH_MENU_CAP)
}

// Flow syntax is deliberately narrower than arbitrary prompt text, so a typo
// or trailing punctuation after a slash goes to the agent, not to a command.
const COMMAND_NAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/

export type Submit =
  | { readonly kind: "empty" }
  | { readonly kind: "command"; readonly name: string; readonly args?: string }
  | { readonly kind: "unknown-command"; readonly name: string }
  | { readonly kind: "prompt"; readonly text: string }

/** Splits only the leading slash-command token; arguments remain opaque text. */
const commandHead = (text: string): { readonly name: string; readonly args?: string } | undefined => {
  if (!text.startsWith("/")) return undefined
  const separator = text.search(/\s/u)
  const name = text.slice(1, separator === -1 ? undefined : separator)
  if (!COMMAND_NAME.test(name)) return undefined
  if (separator === -1) return { name }
  const args = text.slice(separator).trim()
  return args === "" ? { name } : { name, args }
}

/**
 * Parses the composer draft: blank (or bare "/") submits nothing, a
 * registered command name dispatches, a leading token that IS command
 * syntax but names nothing registered is refused by name rather than handed
 * to the model as prose, and everything else is a prompt.
 */
export const parseSubmit = (input: string, entries: ReadonlyArray<CommandEntry>): Submit => {
  const text = input.trim()
  if (text === "" || text === "/") return { kind: "empty" }
  const invocation = commandHead(text)
  if (invocation === undefined) return { kind: "prompt", text }
  const entry = entries.find((candidate) => candidate.name === invocation.name)
  if (entry === undefined) return { kind: "unknown-command", name: invocation.name }
  return { kind: "command", name: invocation.name, ...(invocation.args === undefined ? {} : { args: invocation.args }) }
}

export class CommandRegistry {
  constructor(private readonly entries: ReadonlyArray<CommandEntry>) {}

  readonly all = (): ReadonlyArray<CommandEntry> => this.entries

  readonly slashItems = (needle: string): ReadonlyArray<CommandEntry> => slashItems(needle, this.entries)

  readonly run = (name: string, args: string | undefined, ctx: CommandContext): CommandOutcome => {
    const entry = this.entries.find((candidate) => candidate.name === name)
    if (entry === undefined) return { status: "unknown-command" }
    return entry.run(args, ctx)
  }
}
