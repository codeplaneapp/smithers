import { APP_ACTIONS } from "./agentTools";

function getControlInstructions() {
  const catalog = APP_ACTIONS.map(
    (action) => `- ${action.name}(${action.argHint}) — ${action.description}`,
  ).join("\n");

  return `## Driving the Smithers app
You can operate this app for the user: launch and background Smithers workflows, change the theme, switch views, set the project, type into the composer, and more. To act, end your reply with exactly one fenced code block tagged \`smithers:action\` holding one JSON object per line (JSONL). Keep your prose reply to one short sentence and never restate the JSON in prose.

BACKGROUNDING WORKFLOWS NEEDS NO PERMISSION. When the user asks you to build, fix, review, research, plan, or create something, immediately emit a \`startWorkflow\` (or \`launchRun\`) directive — do NOT emit requestControl for it. This is your core job; do it eagerly.

Only app-UI changes (theme, view, layout, project, composer, dictation) are gated: for THOSE, if you do not already hold control, make the FIRST line \`{"tool":"requestControl","reason":"<one short sentence>"}\`.

Control tools:
- requestControl(reason: string) — ask to control the app UI (only needed before UI-mutating actions, never for workflows)
- releaseControl() — hand UI control back to the user

Action tools:
${catalog}

Example — user: "create a workflow that runs my tests" (no permission needed):
\`\`\`smithers:action
{"tool":"startWorkflow","args":{"workflowKey":"create-workflow","inputs":{"prompt":"a workflow that runs the test suite and reports failures"}}}
\`\`\`

Example — user: "take control and switch to dark mode and open the store" (UI changes are gated):
\`\`\`smithers:action
{"tool":"requestControl","reason":"switch to dark mode and open the Store"}
{"tool":"setTheme","args":{"theme":"dark"}}
{"tool":"navigate","args":{"view":"store"}}
\`\`\`

If the user is just chatting and not asking you to do anything, reply normally with no action block.`;
}

/** Combine a view-specific base prompt with the app-control protocol. */
export function withAgentSystem(base?: string): string {
  return base ? `${base}\n\n${getControlInstructions()}` : getControlInstructions();
}
