/*
 * The one-tool agent contract ("commands are the app"), ported from flows/ui
 * src/ui/runtime/agentTools.ts: the agent reaches the app through ONE tool —
 * list the registered commands with the live app state, or execute one by
 * name through the identical code path the buttons and slash menu use.
 *
 * Wave 3b: the chat tool-call loop binds to this contract. The turn carries
 * `agentToolSpecs`; a `tool_call` frame executes through
 * `CommandRegistry.executeForAgent` (actor smithers), and the honest result
 * string below is what the continuation turn posts back to the model.
 */
import type { AgentToolSpec } from "smithers-shared/NativeAgent"
import type { CommandRegistry } from "./Commands"
import type { CatalogItem, FlowEntry } from "./registry"
import { itemOf, visible } from "./registry"

export type { AgentToolSpec }

export interface AgentToolCall {
  readonly name: string
  readonly arguments: string
}

/**
 * The flows the agent may see and call.
 *
 * This is the registry itself narrowed to model-invocable entries and then to
 * the unhidden ones — not a second catalog. The trigger axis is the
 * descriptor's own `modelInvocable` flag, so user-only browser mechanics are
 * absent structurally rather than by a filter that could be forgotten.
 */
const agentVisible = (entries: ReadonlyArray<FlowEntry>): Array<CatalogItem> => visible(entries.map(itemOf))

/**
 * The agent's live catalog as instruction material (Wave 13 §F): the same set
 * the "list" action returns, so the generated capability section of the system
 * prompt and the tool can never disagree about what the agent can do.
 */
export const agentVisibleCatalog = (
  callable: ReadonlyArray<FlowEntry>
): ReadonlyArray<{ readonly name: string; readonly summary: string; readonly args?: string }> =>
  agentVisible(callable).map((command) => ({
    name: command.name,
    summary: command.summary,
    ...(command.args === undefined ? {} : { args: command.args })
  }))

/*
 * The honest tool-result error when the model reaches for user-only chrome
 * (§2a): name the visible alternative so the model can tell the user where
 * the affordance actually lives instead of promising an act it cannot take.
 */
const USER_ONLY_ALTERNATIVES: Readonly<Record<string, string>> = {
  "auth.sign-in":
    "sign-in is a button the human clicks — invoke auth.prompt instead, which renders that button in the chat",
  "auth.sign-out": "sign-out is a control the human clicks — it lives in their slash menu",
  reset: "resetting the conversation is the human's dev affordance — suggest /clear if they want a fresh chat",
  theme: "the color theme is the human's own choice — they set it with /theme",
  "dark-mode": "the light/dark toggle is a button the human clicks",
  "chat.stop": "stopping a response is the human's Escape key / stop button",
  send: "the composer belongs to the human — answer with text instead",
  "card.maximize": "maximizing a card is the human's explicit act — your invocation renders the embedded card",
  "card.minimize": "minimizing a card is the human's explicit act"
}

export const userOnlyError = (name: string): string =>
  `failed: /${name} is user-only — ${
    USER_ONLY_ALTERNATIVES[name] ?? "it is a control the human clicks, already visible on their screen"
  }`

/** The one tool the chat model gets. */
export const commandsToolSpec: AgentToolSpec = {
  type: "function",
  name: "commands",
  description: "action \"list\" returns {state, commands}: the live app state (surface, whether work is " +
    "connected, whether a turn is streaming) and every command callable right now. " +
    "action \"execute\" runs one command by name through the same code path the UI buttons " +
    "and slash commands use.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "execute"], description: "list commands or execute one." },
      name: {
        type: "string",
        description:
          "The command name (required for execute), e.g. \"browser\" — the catalog's leading slash is accepted too."
      },
      args: { type: "string", description: "Optional argument text for commands that accept it." }
    },
    required: ["action"],
    additionalProperties: false
  }
}

export const agentToolSpecs: ReadonlyArray<AgentToolSpec> = [commandsToolSpec]

/**
 * Execute one model tool call through the app's command dispatch. Results are
 * honest strings — "executed /name", "unknown-command: name", "failed: <error>"
 * — so they round-trip into the transcript unchanged. An unknown TOOL name is
 * an honest error string too, never a crash.
 */
export const executeAgentToolCall = async (
  registry: CommandRegistry,
  call: AgentToolCall
): Promise<string> => {
  if (call.name !== commandsToolSpec.name) return `unknown-tool: ${call.name}`
  let input: { readonly action?: unknown; readonly name?: unknown; readonly args?: unknown }
  try {
    input = JSON.parse(call.arguments) as typeof input
  } catch {
    return "failed: the commands tool arguments were not valid JSON"
  }
  if (input.action === "list") {
    return JSON.stringify({
      state: registry.state(),
      commands: agentVisible(registry.callable()).map((command) => ({
        name: command.name,
        summary: command.summary,
        ...(command.args === undefined ? {} : { acceptsArgs: true, args: command.args })
      }))
    })
  }
  if (input.action !== "execute") {
    return "failed: the commands tool action must be \"list\" or \"execute\""
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    return "failed: the execute action requires a command name"
  }
  /*
   * The model reads command names in their user-facing spelling — the
   * generated catalog and every result string here write "/browser" — so a
   * leading slash in the tool call is the model speaking the app's own
   * dialect, not a typo. The agent boundary strips it exactly as the
   * composer's parseSubmit strips the human's; the registry's names stay
   * bare. (Live on canary, execute {"name":"/browser"} died as
   * unknown-command and the turn degraded into asking permission.)
   */
  const name = input.name.trim().replace(/^\/+/, "")
  if (name === "") {
    return "failed: the execute action requires a command name"
  }
  /*
   * The trigger axis, enforced structurally: a user-only command is neither
   * listed nor executable by the agent — the model gets the honest error
   * naming the visible alternative, never a silent refusal.
   */
  const target = registry.find(name)
  if (target !== undefined && !registry.callable().includes(target)) {
    return userOnlyError(name)
  }
  /*
   * The agent-mode run (requirement axis): an unmet requirement comes back
   * as an honest failure naming the missing step — the model can tell the
   * user, but can never park work that fires after its turn ends.
   */
  const outcome = await registry.runAsAgent(
    name,
    typeof input.args === "string" ? input.args : undefined
  )
  switch (outcome.status) {
    case "executed":
      return outcome.value ?? `executed /${name}`
    case "unknown-command":
      /*
       * The recovery is in the error: a dead-end "unknown-command" left
       * the live model telling the USER to run the command. Point it back
       * at the list action so the retry happens in the same turn.
       */
      return `unknown-command: ${name} — no command has that name; use the list action for every command callable right now`
    case "failed":
      return `failed: ${outcome.error}`
  }
}
