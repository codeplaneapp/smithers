import React from "react";
import blessed from "neo-blessed";
import { createBlessedRenderer } from "@dino-dna/react-tui";
import {
  DEBATE_E2E_PROMPT,
  defaultModelForProvider,
  PROVIDER_OPTIONS,
  runDebateWorkflow,
} from "../../smithers-demo/src/cerebrasDebate.js";
import { generateRuntimeWorkflowFromPrompt } from "../../smithers-demo/src/workflowRuntime.js";
import { renderWorkflowGraph } from "./tuiGraph.mjs";
import { buttonLabelForRunState, statusIdForRole } from "./tuiState.mjs";

const screen = blessed.screen({
  smartCSR: true,
  title: "Smithers React TUI Demo",
});

screen.key(["C-c", "q"], () => process.exit(0));

const render = createBlessedRenderer(blessed, screen);
const container = blessed.box({ width: "100%", height: "100%" });
screen.append(container);

function App() {
  const provider = process.env.OPENAI_API_KEY
    ? "openai"
    : process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : "cerebras";
  const apiKey =
    process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.CEREBRAS_API_KEY ?? "";
  const envVar = PROVIDER_OPTIONS[provider].envVar;
  const model = process.env.SMITHERS_TUI_MODEL ?? defaultModelForProvider(provider);
  const [prompt, setPrompt] = React.useState(DEBATE_E2E_PROMPT);
  const [runState, setRunState] = React.useState("idle");
  const [status, setStatus] = React.useState(
    apiKey
      ? `${PROVIDER_OPTIONS[provider].label} ready from ${envVar}. Type a prompt, Generate the graph, or Run Workflow.`
      : `Set ${envVar} before running this TUI. Graph regeneration still works locally.`,
  );
  const [nodeStatuses, setNodeStatuses] = React.useState({});
  const abortRef = React.useRef(null);
  const spec = generateRuntimeWorkflowFromPrompt(prompt);
  const graph = renderWorkflowGraph(spec, nodeStatuses);

  function resetRunState(nextStatus) {
    abortRef.current = null;
    setRunState("idle");
    setNodeStatuses({});
    if (nextStatus) setStatus(nextStatus);
  }

  function cancelRun() {
    abortRef.current?.abort(new Error("Workflow cancelled"));
    setRunState("cancelled");
    setNodeStatuses((current) =>
      Object.fromEntries(Object.entries(current).map(([id, state]) => [id, state === "running" ? "cancelled" : state])),
    );
    setStatus("Workflow cancelled. Edit the prompt or Run Workflow again.");
  }

  async function run() {
    if (runState === "running") {
      cancelRun();
      return;
    }
    if (runState === "done") {
      resetRunState(`Ready. Run Workflow starts ${PROVIDER_OPTIONS[provider].label} again.`);
      return;
    }
    if (!apiKey) {
      setStatus(`Set ${envVar} before running live generation.`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setRunState("running");
    setNodeStatuses({});
    setStatus(`Running ${PROVIDER_OPTIONS[provider].label} debate loop with ${model}...`);
    try {
      const result = await runDebateWorkflow({
        apiKey,
        provider,
        model,
        prompt,
        rounds: 2,
        signal: controller.signal,
        onStep: (step) => {
          setNodeStatuses((current) => ({
            ...current,
            [statusIdForRole(step.role)]: step.status === "complete" ? "complete" : "running",
          }));
        },
      });
      abortRef.current = null;
      setRunState("done");
      setNodeStatuses((current) => ({ ...current, judge_final: "complete" }));
      setStatus(`Done. ${result.transcript.length} workflow steps completed. Press Done to reset.`);
    } catch (error) {
      abortRef.current = null;
      if (controller.signal.aborted) {
        setRunState("cancelled");
        setStatus("Workflow cancelled. Edit the prompt or Run Workflow again.");
      } else {
        setRunState("error");
        setNodeStatuses((current) =>
          Object.fromEntries(Object.entries(current).map(([id, state]) => [id, state === "running" ? "error" : state])),
        );
        setStatus(error instanceof Error ? error.message : String(error));
      }
    }
  }

  function regenerate(value) {
    const nextPrompt = value || DEBATE_E2E_PROMPT;
    abortRef.current?.abort(new Error("Workflow cancelled"));
    setPrompt(nextPrompt);
    setRunState("idle");
    setNodeStatuses({});
    setStatus(`Graph regenerated with ${generateRuntimeWorkflowFromPrompt(nextPrompt).nodes.length} nodes.`);
  }

  return React.createElement(
    "box",
    { width: "100%", height: "100%", border: "line", label: " Smithers Workflow TUI " },
    React.createElement("text", {
      top: 1,
      left: 2,
      width: "80%",
      content: `${PROVIDER_OPTIONS[provider].label}  |  ${model}  |  ${apiKey ? `${envVar} set` : `${envVar} missing`}`,
    }),
    React.createElement("button", {
      top: 1,
      right: 2,
      width: 18,
      height: 3,
      border: "line",
      content: buttonLabelForRunState(runState),
      align: "center",
      valign: "middle",
      mouse: true,
      keys: true,
      onPress: run,
    }),
    React.createElement("text", { top: 4, left: 2, width: "96%", content: status }),
    React.createElement("box", {
      top: 6,
      left: 2,
      right: 2,
      bottom: 5,
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      mouse: true,
      content: graph,
      label: runState === "running" ? " Workflow running " : " Workflow graph ",
    }),
    React.createElement("textbox", {
      bottom: 1,
      left: 2,
      right: 22,
      height: 3,
      border: "line",
      inputOnFocus: true,
      onSubmit: regenerate,
      label: " Workflow prompt ",
    }),
    React.createElement("button", {
      bottom: 1,
      right: 2,
      width: 18,
      height: 3,
      border: "line",
      content: "Generate",
      align: "center",
      valign: "middle",
      mouse: true,
      keys: true,
      onPress: () => regenerate(prompt),
    }),
  );
}

render(React.createElement(App), container);
screen.render();

if (process.env.SMITHERS_TUI_SMOKE === "1") {
  setTimeout(() => {
    screen.destroy();
    process.exit(0);
  }, 50);
}
