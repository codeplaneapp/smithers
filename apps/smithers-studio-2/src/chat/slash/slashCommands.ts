import type { SlashCommand } from "./SlashCommand";

/**
 * The slash catalog. Order is the autocomplete order. Each entry maps to a
 * Smithers CLI feature; `resolveSlashAction` turns a chosen command + args into
 * a concrete action (open an overlay, switch shells, or prompt the agent).
 */
export const slashCommands: SlashCommand[] = [
  { name: "workflow", summary: "Run a workflow", feature: "smithers up / workflow", argHint: "<name>" },
  { name: "issue", summary: "Create or open an issue", feature: "issue management", argHint: "<title|#>" },
  { name: "pr", summary: "Open a pull request view", feature: "VCS / landings", argHint: "<#>" },
  { name: "prompt", summary: "Ask the agent directly", feature: "smithers ask", argHint: "<question>" },
  { name: "runs", summary: "Show the run board", feature: "smithers ps", argHint: "" },
  { name: "memory", summary: "Browse cross-run memory", feature: "smithers memory", argHint: "" },
  { name: "terminal", summary: "Open a live terminal", feature: "hijack / PTY", argHint: "" },
  { name: "sandbox", summary: "Spin up a sandbox", feature: "sandbox / JJHub", argHint: "" },
  { name: "web", summary: "Open a site the agent can use", feature: "agent browse", argHint: "<url>" },
  { name: "studio", summary: "Switch to the classic tabbed shell", feature: "—", argHint: "" },
  { name: "chat", summary: "Switch to the chat shell", feature: "—", argHint: "" },
];
