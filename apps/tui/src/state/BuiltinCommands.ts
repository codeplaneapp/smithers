import type { CommandEntry } from "./CommandRegistry"
import type { TranscriptStore } from "./Transcript"

/** The commands available in every TUI session, independent of transport. */
export const builtinCommands = (store: TranscriptStore): ReadonlyArray<CommandEntry> => [
  {
    name: "clear",
    metadata: { summary: "Clear the conversation transcript" },
    run: () => {
      store.clear()
      return { status: "executed" }
    }
  },
  {
    name: "quit",
    metadata: { summary: "Exit the chat client" },
    run: (_args, ctx) => {
      ctx.quit()
      return { status: "executed" }
    }
  },
  {
    name: "help",
    metadata: { summary: "List available commands" },
    run: () => ({
      status: "executed",
      value: "Commands: /clear, /help, /quit. Anything else is sent to the agent."
    })
  }
]
