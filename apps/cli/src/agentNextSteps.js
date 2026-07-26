import { isAbsolute, relative } from "node:path";
import { hasCustomUi } from "./monitoring-suggestion.js";

/**
 * Render a workflow file path the way a human would type it: relative to the
 * cwd when it lives underneath it (so a next-step reads `smithers graph
 * .smithers/workflows/hello.tsx`, not a wrapping absolute `/private/tmp/...`
 * path), but left absolute when it points outside the cwd.
 *
 * @param {string | undefined} workflowFile
 * @param {string} cwd
 * @returns {string | undefined}
 */
function displayWorkflowFile(workflowFile, cwd) {
  if (!workflowFile) return workflowFile;
  if (!isAbsolute(workflowFile)) return workflowFile;
  const rel = relative(cwd, workflowFile);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return workflowFile;
  return rel;
}

/**
 * A human watching a terminal wants a short "here's what you can do next" list,
 * not the agent-facing "Suggest to the user: 1. …" script (which tells an AI to
 * ask the human clarifying questions). The commands are useful to both; only
 * the framing differs. Returns the same `{ description, commands }` shape.
 *
 * @param {{ workflowId?: string; workflowFile?: string; runId?: string; hasUi?: boolean; cwd?: string; omitUi?: boolean }} context
 * @returns {{ description: string; commands: { command: string; description: string }[] }}
 */
function buildHumanNextSteps(context = {}) {
  const { workflowId, runId, omitUi } = context;
  const cwd = context.cwd ?? process.cwd();
  const workflowFile = displayWorkflowFile(context.workflowFile, cwd);
  const hasUi = context.hasUi ?? (workflowId ? hasCustomUi(workflowId, cwd) : false);
  const commands = [];
  if (runId && !omitUi && hasUi) {
    commands.push({ command: `ui ${runId}`, description: "Open the run's workflow UI in your browser" });
  }
  if (runId) {
    commands.push({ command: `inspect ${runId}`, description: "See full run state, outputs, and any gates" });
  }
  if (workflowFile) {
    commands.push({ command: `graph ${workflowFile}`, description: "Diagram how this workflow runs" });
  }
  commands.push({
    command: 'make-workflow "<describe the workflow>"',
    description: "Build your own workflow from a description",
  });
  // No description of our own: the caller supplies the "Next steps:" header via
  // withAgentNextSteps's ownDescription, so returning one here double-prints it.
  return { description: "", commands };
}

/**
 * Shared "what next" guidance appended to user-facing CLI commands, aimed at
 * the AI agent operating the CLI on the user's behalf. Single source of truth
 * so every command suggests the same three things in the same words:
 *
 *  1. Build or open a custom workflow UI (`.smithers/ui/<workflowId>.tsx`
 *     authored with the smithers-orchestrator/gateway-react hooks, declared in
 *     the workflow with `<UI entry="../ui/<workflowId>.tsx" />`, opened via
 *     `smithers ui <runId>`; `smithers ui --app` for the full control plane).
 *  2. Visualize the workflow (`smithers graph <file>`, `smithers tree <runId>`,
 *     the `--interactive` full-screen TUI).
 *  3. Ask the user clarifying questions, then guide them through building or
 *     iterating a smithers workflow (`smithers workflow run create-workflow
 *     --prompt "..."`, or `smithers make-workflow`).
 *
 * Returns a cta fragment `{ description, commands }` for incur's `c.ok(data,
 * { cta })`, which renders as human text on a TTY and as a structured `cta`
 * key under `--json`. Callers merge `commands` after their own command list.
 *
 * `justRan` names the command the caller itself just executed so the guidance
 * never re-suggests it verbatim (`smithers graph <file>` re-suggesting
 * `graph <file>` is a pure no-op; `smithers tree <runId>` suggests
 * `tree <runId> --watch` instead, which is a genuinely new action).
 *
 * When `human` is set the caller is a person watching a terminal (not an AI
 * driving the CLI), so the concise {@link buildHumanNextSteps} list is returned
 * instead of the agent script.
 *
 * @param {{
 *   workflowId?: string;
 *   workflowFile?: string;
 *   runId?: string;
 *   hasUi?: boolean;
 *   cwd?: string;
 *   uiOpened?: boolean;
 *   omitUi?: boolean;
 *   human?: boolean;
 *   justRan?: "graph" | "tree";
 * }} [context]
 * @returns {{ description: string; commands: { command: string; description: string }[] }}
 */
export function buildAgentNextSteps(context = {}) {
  if (context.human) return buildHumanNextSteps(context);
  const { workflowId, runId, uiOpened, omitUi, justRan } = context;
  const cwd = context.cwd ?? process.cwd();
  const workflowFile = displayWorkflowFile(context.workflowFile, cwd);
  const hasUi = context.hasUi ?? (workflowId ? hasCustomUi(workflowId, cwd) : false);
  const runRef = runId ?? "<runId>";
  const uiFile = `.smithers/ui/${workflowId ?? "<workflowId>"}.tsx`;
  const buildWorkflowLine =
    "Ask the user clarifying questions about what they want next, then guide them through building or iterating a smithers workflow: " +
    'run `smithers workflow run create-workflow --prompt "<what the workflow should do>"` (or `smithers make-workflow`) to have smithers build it.';
  const commands = [];
  const lines = ["Suggest to the user:"];
  if (uiOpened) {
    lines.push(
      `1. Iterate on the workflow UI source at ${uiFile} (composed from the smithers-orchestrator/gateway-ui widgets and smithers-orchestrator/ui primitives over the gateway-react hooks, declared by the workflow's <UI> component); the Gateway serves the file from disk, so edits show up on browser refresh.`,
    );
    lines.push("2. Open the full Smithers control-plane UI with `smithers ui --app`.");
    lines.push(
      `3. Build custom UIs for other workflows that lack one: author .smithers/ui/<workflowId>.tsx by composing the smithers-orchestrator/gateway-ui widgets (WorkflowUiShell, RunTree, RunEventLog, ApprovalPanel, ...) and smithers-orchestrator/ui primitives over the gateway-react hooks, add \`<UI entry="../ui/<workflowId>.tsx" />\` to that workflow, then open it with \`smithers ui <runId>\`.`,
    );
    lines.push(`4. ${buildWorkflowLine}`);
    commands.push({ command: "ui --app", description: "Open the full Smithers control-plane UI" });
  } else {
    let step = 1;
    if (!omitUi) {
      if (hasUi) {
        lines.push(
          `${step}. Open the custom workflow UI: run \`smithers ui ${runRef}\` (a UI already exists at ${uiFile}). \`smithers ui --app\` opens the full Smithers control-plane UI.`,
        );
        commands.push({ command: `ui ${runRef}`, description: "Open the custom workflow UI" });
      } else {
        lines.push(
          `${step}. Build the user a custom workflow UI: author ${uiFile} by composing the smithers-orchestrator/gateway-ui widgets (WorkflowUiShell, RunTree, RunEventLog, ApprovalPanel, ...) and smithers-orchestrator/ui primitives over the gateway-react hooks, add \`<UI entry="../ui/${workflowId ?? "<workflowId>"}.tsx" />\` to the workflow, then open it with \`smithers ui ${runRef}\`. \`smithers ui --app\` opens the full Smithers control-plane UI.`,
        );
        commands.push({ command: `ui ${runRef}`, description: `Open the workflow UI (after authoring ${uiFile})` });
      }
      commands.push({ command: "ui --app", description: "Open the full Smithers control-plane UI" });
      step += 1;
    }
    const vizParts = [];
    if (workflowFile && justRan !== "graph") {
      vizParts.push(`\`smithers graph ${workflowFile}\` renders the workflow graph without executing it`);
      commands.push({ command: `graph ${workflowFile}`, description: "Visualize the workflow graph" });
    } else if (!workflowFile) {
      vizParts.push("`smithers graph <workflow-file>` renders the workflow graph without executing it");
    }
    if (runId && justRan !== "tree") {
      vizParts.push(`\`smithers tree ${runId}\` prints the live run tree`);
      commands.push({ command: `tree ${runId}`, description: "Visualize the run tree" });
    } else if (runId) {
      vizParts.push(`\`smithers tree ${runId} --watch\` streams the run tree live`);
      commands.push({ command: `tree ${runId} --watch`, description: "Watch the run tree live" });
    } else {
      vizParts.push("`smithers tree <runId>` prints a run's live tree");
    }
    vizParts.push("`smithers up --interactive` opens the full-screen TUI");
    lines.push(`${step}. Visualize the workflow and how it works: ${vizParts.join(", ")}.`);
    step += 1;
    lines.push(`${step}. ${buildWorkflowLine}`);
  }
  commands.push({
    command: 'workflow run create-workflow --prompt "<describe the workflow>"',
    description: "Have smithers build a new workflow from a description",
  });
  return { description: lines.join("\n"), commands };
}
