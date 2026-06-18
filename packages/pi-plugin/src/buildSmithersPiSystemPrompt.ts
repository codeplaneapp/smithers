import {
  renderSmithersAgentPromptGuidance,
  type SmithersAgentContract,
} from "@smithers-orchestrator/agents/agent-contract";
import type { SmithersPiRunContext } from "./SmithersPiRunContext.js";
import { normalizeState } from "./runtime/normalizeState.js";

function toolRef(contract: SmithersAgentContract, name: string, prefix = "smithers_") {
  return contract.tools.some((tool) => tool.name === name) ? `\`${prefix}${name}\`` : undefined;
}

function buildTypicalWorkflowGuidance(contract: SmithersAgentContract) {
  const discover = toolRef(contract, "list_workflows");
  const run = toolRef(contract, "run_workflow");
  const listRuns = toolRef(contract, "list_runs");
  const getRun = toolRef(contract, "get_run");
  const watchRun = toolRef(contract, "watch_run");
  const explainRun = toolRef(contract, "explain_run");
  const listApprovals = toolRef(contract, "list_pending_approvals");
  const resolveApproval = toolRef(contract, "resolve_approval");
  const getNodeDetail = toolRef(contract, "get_node_detail");
  const getRunEvents = toolRef(contract, "get_run_events");
  const listArtifacts = toolRef(contract, "list_artifacts");
  const getTranscript = toolRef(contract, "get_chat_transcript");
  const revertAttempt = toolRef(contract, "revert_attempt");
  const steps = [
    "**Write a workflow** -> Use your Smithers knowledge to help the user write workflow files.",
  ];

  if (discover && run) {
    steps.push(`**Run it** -> Use ${discover} to find workflow IDs, then ${run} to launch the workflow.`);
  } else if (run) {
    steps.push(`**Run it** -> Use ${run} to launch the workflow.`);
  }

  const monitorTools = [listRuns, getRun, watchRun, explainRun].filter(Boolean);
  if (monitorTools.length > 0) {
    steps.push(
      `**Monitor** -> Use ${monitorTools.join(", ")} to inspect progress, or tell the user about \`/smithers\`.`,
    );
  }

  const approvalTools = [listApprovals, resolveApproval].filter(Boolean);
  if (approvalTools.length > 0) {
    steps.push(`**Approve** -> Use ${approvalTools.join(", ")} when runs are waiting for approval.`);
  }

  const debugTools = [getNodeDetail, getRunEvents, listArtifacts, getTranscript].filter(Boolean);
  if (debugTools.length > 0) {
    steps.push(`**Debug** -> Use ${debugTools.join(", ")} to gather evidence before changing anything.`);
  }

  if (revertAttempt) {
    steps.push(
      `**Revert** -> Use ${revertAttempt} only when the user explicitly asks to roll back or time travel.`,
    );
  }

  return steps.map((step, index) => `${index + 1}. ${step}`);
}

export function buildSmithersPiSystemPrompt(
  baseSystemPrompt: string,
  docs: string,
  contract: SmithersAgentContract,
  activeRun?: SmithersPiRunContext,
) {
  const sections = [
    "\n\n# Smithers Documentation\n",
    "You are a Smithers workflow expert. Prefer the live Smithers tools over shelling out when they can answer the request.\n",
    "## Smithers PI Extension - User Guide\n",
    "The user is running PI with the Smithers extension. When they ask about capabilities, slash commands, or how to use this environment, refer to this section.\n",
    "### Tools (available to you, the agent)",
    renderSmithersAgentPromptGuidance(contract, { toolNamePrefix: "smithers_" }),
    "",
    "### Slash Commands (available to the user)",
    "Tell the user about these when they ask what they can do:",
    "- `/smithers` - Opens the live run inspector with a virtualized tree, frame scrubber, Output/Diff/Logs inspector tabs, heartbeat indicators, and ghost node badges.",
    "- `/smithers-watch <runId>` - Attaches the inspector and event stream to a run by ID.",
    "- `/smithers-runs` - Lists tracked runs and makes the selected run active.",
    "- `/smithers-approve` - Interactive approval flow for nodes waiting on approval.",
    "- `/smithers-cancel [runId]` - Cancels a running workflow with confirmation.",
    "",
    "### UI Features (always active)",
    "- **Header**: Shows run state, the active run ID, engine and sandbox/viewer heartbeat indicators, and reconnect status.",
    "- **Tree**: Left pane virtualized run tree. Failed descendants bubble an error marker to collapsed ancestors, and removed selected nodes stay inspectable as ghosts.",
    "- **Inspector**: Right pane Output, Diff, and Logs tabs for the selected node.",
    "- **Frame Scrubber**: Browse historical frames and return to live mode.",
    "- **Stale Banner**: Appears while the gateway stream is disconnected long enough that the displayed tree may be stale.",
    "",
    "### Flags (passed via CLI)",
    "- `--smithers-url` - Smithers server or gateway URL (default: http://127.0.0.1:7331)",
    "- `--smithers-key` - Smithers API key (also reads SMITHERS_API_KEY env var)",
    "",
    "### Typical Workflows",
    ...buildTypicalWorkflowGuidance(contract),
    "",
    "---\n",
    docs,
  ];

  if (activeRun) {
    sections.push("\n## Active Run Context");
    sections.push(`Run: ${activeRun.runId} (${activeRun.workflowName})`);
    sections.push(`Status: ${activeRun.status}`);

    const waitingNodes = activeRun.nodeStates.filter((node) => {
      const state = normalizeState(node.state);
      return state === "waiting-approval" || state === "waiting-timer";
    });
    if (waitingNodes.length > 0) {
      sections.push(`Nodes waiting approval: ${waitingNodes.map((node) => node.nodeId).join(", ")}`);
    }

    const recentErrors = activeRun.errors.slice(-3);
    if (recentErrors.length > 0) {
      sections.push(`Recent errors: ${recentErrors.join("; ")}`);
    }
  }

  return baseSystemPrompt + sections.join("\n");
}
