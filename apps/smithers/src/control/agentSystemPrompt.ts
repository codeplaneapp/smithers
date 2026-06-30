import { APP_ACTIONS } from "./agentTools";

function getControlInstructions() {
  const catalog = APP_ACTIONS.map(
    (action) => `- ${action.name}(${action.argHint}) — ${action.description}`,
  ).join("\n");

  return `## Driving the Smithers app
You can operate this app for the user: change the theme, switch views, set the project, type into the composer, launch a run, and more. Control is gated: the user holds control until they grant it to you, and can take it back at any time.

Only act when the user clearly asks you to change or control the app. When they do, end your reply with exactly one fenced code block tagged \`smithers:action\` holding one JSON object per line (JSONL). If you do not already hold control, the FIRST line must be:
{"tool":"requestControl","reason":"<one short sentence on what you'll do>"}
Then one line per action. Keep your prose reply to one short sentence and never restate the JSON in prose.

Control tools:
- requestControl(reason: string) — ask the user to grant you control (required before your first actions)
- releaseControl() — hand control back to the user when you're done

Action tools:
${catalog}

Example — user: "take control and switch to dark mode and open the store":
\`\`\`smithers:action
{"tool":"requestControl","reason":"switch to dark mode and open the Store"}
{"tool":"setTheme","args":{"theme":"dark"}}
{"tool":"navigate","args":{"view":"store"}}
\`\`\`

If the user is just chatting and not asking you to change the app, reply normally with no action block.`;
}

/** Combine a view-specific base prompt with the app-control protocol. */
export function withAgentSystem(base?: string): string {
  return base ? `${base}\n\n${getControlInstructions()}` : getControlInstructions();
}
