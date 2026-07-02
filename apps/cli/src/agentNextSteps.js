import { hasCustomUi } from "./monitoring-suggestion.js";

/**
 * Shared "what next" guidance appended to user-facing CLI commands, aimed at
 * the AI agent operating the CLI on the user's behalf. Single source of truth
 * so every command suggests the same three things in the same words:
 *
 *  1. Build or open a custom workflow UI (`.smithers/ui/<workflowId>.tsx`
 *     authored with the smithers-orchestrator/gateway-react hooks, opened via
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
 * @param {{
 *   workflowId?: string;
 *   workflowFile?: string;
 *   runId?: string;
 *   hasUi?: boolean;
 *   cwd?: string;
 *   uiOpened?: boolean;
 *   omitUi?: boolean;
 *   justRan?: "graph" | "tree";
 * }} [context]
 * @returns {{ description: string; commands: { command: string; description: string }[] }}
 */
export function buildAgentNextSteps(context = {}) {
    const { workflowId, workflowFile, runId, uiOpened, omitUi, justRan } = context;
    const cwd = context.cwd ?? process.cwd();
    const hasUi = context.hasUi ?? (workflowId ? hasCustomUi(workflowId, cwd) : false);
    const runRef = runId ?? "<runId>";
    const uiFile = `.smithers/ui/${workflowId ?? "<workflowId>"}.tsx`;
    const buildWorkflowLine =
        "Ask the user clarifying questions about what they want next, then guide them through building or iterating a smithers workflow: " +
        'run `smithers workflow run create-workflow --prompt "<what the workflow should do>"` (or `smithers make-workflow`) to have smithers build it.';
    const commands = [];
    const lines = ["Suggest to the user:"];
    if (uiOpened) {
        lines.push(`1. Iterate on the workflow UI source at ${uiFile} (built with the smithers-orchestrator/gateway-react hooks); the Gateway serves the file from disk, so edits show up on browser refresh.`);
        lines.push("2. Open the full Smithers control-plane UI with `smithers ui --app`.");
        lines.push(`3. Build custom UIs for other workflows that lack one: author .smithers/ui/<workflowId>.tsx with the gateway-react hooks, then open it with \`smithers ui <runId>\`.`);
        lines.push(`4. ${buildWorkflowLine}`);
        commands.push({ command: "ui --app", description: "Open the full Smithers control-plane UI" });
    }
    else {
        let step = 1;
        if (!omitUi) {
            if (hasUi) {
                lines.push(`${step}. Open the custom workflow UI: run \`smithers ui ${runRef}\` (a UI already exists at ${uiFile}). \`smithers ui --app\` opens the full Smithers control-plane UI.`);
                commands.push({ command: `ui ${runRef}`, description: "Open the custom workflow UI" });
            }
            else {
                lines.push(`${step}. Build the user a custom workflow UI: author ${uiFile} with the smithers-orchestrator/gateway-react hooks, then open it with \`smithers ui ${runRef}\`. \`smithers ui --app\` opens the full Smithers control-plane UI.`);
                commands.push({ command: `ui ${runRef}`, description: `Open the workflow UI (after authoring ${uiFile})` });
            }
            commands.push({ command: "ui --app", description: "Open the full Smithers control-plane UI" });
            step += 1;
        }
        const vizParts = [];
        if (workflowFile && justRan !== "graph") {
            vizParts.push(`\`smithers graph ${workflowFile}\` renders the workflow graph without executing it`);
            commands.push({ command: `graph ${workflowFile}`, description: "Visualize the workflow graph" });
        }
        else if (!workflowFile) {
            vizParts.push("`smithers graph <workflow-file>` renders the workflow graph without executing it");
        }
        if (runId && justRan !== "tree") {
            vizParts.push(`\`smithers tree ${runId}\` prints the live run tree`);
            commands.push({ command: `tree ${runId}`, description: "Visualize the run tree" });
        }
        else if (runId) {
            vizParts.push(`\`smithers tree ${runId} --watch\` streams the run tree live`);
            commands.push({ command: `tree ${runId} --watch`, description: "Watch the run tree live" });
        }
        else {
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
