import { DEBATE_E2E_PROMPT } from "./cerebrasDebate.js";

export function generateRuntimeWorkflowFromPrompt(prompt = DEBATE_E2E_PROMPT) {
  const normalized = prompt.trim() || DEBATE_E2E_PROMPT;
  const lower = normalized.toLowerCase();

  if (lower.includes("communism") && lower.includes("capitalism") && lower.includes("debate")) {
    return {
      name: "communism-capitalism-debate-loop",
      nodes: [
        { id: "debate_loop", label: "Debate Loop", kind: "loop", dependsOn: [] },
        { id: "capitalism_round_1", label: "Capitalism LM R1", kind: "agent", dependsOn: ["debate_loop"] },
        { id: "communism_round_1", label: "Communism LM R1", kind: "agent", dependsOn: ["capitalism_round_1"] },
        { id: "capitalism_round_2", label: "Capitalism LM R2", kind: "agent", dependsOn: ["communism_round_1"] },
        { id: "communism_round_2", label: "Communism LM R2", kind: "agent", dependsOn: ["capitalism_round_2"] },
        { id: "judge_final", label: "Judge LM", kind: "agent", dependsOn: ["communism_round_2"] },
      ],
    };
  }

  const nodes = [
    { id: "intake", label: "Intake", kind: "agent", dependsOn: [] },
    { id: "plan", label: "Plan", kind: "agent", dependsOn: ["intake"] },
  ];
  if (/(research|audit|investigate)/.test(lower)) nodes.push({ id: "research", label: "Research", kind: "agent", dependsOn: ["plan"] });
  if (/(worktree|branch|patch|diff)/.test(lower)) nodes.push({ id: "worktree", label: "Worktree", kind: "worktree", dependsOn: [nodes.at(-1).id] });
  if (/(loop|iterate|retry)/.test(lower)) nodes.push({ id: "iteration_loop", label: "Ralph Loop", kind: "loop", dependsOn: [nodes.at(-1).id] });
  nodes.push({ id: "implement", label: "Implement", kind: "agent", dependsOn: [nodes.at(-1).id] });
  if (/(sandbox|safe|isolate)/.test(lower)) nodes.push({ id: "sandbox_verify", label: "Sandbox Verify", kind: "sandbox", dependsOn: ["implement"] });
  if (/(docs|documentation|readme)/.test(lower)) nodes.push({ id: "document", label: "Document", kind: "agent", dependsOn: ["implement"] });
  nodes.push({ id: "validate", label: "Validate", kind: "agent", dependsOn: [nodes.at(-1).id] });
  if (/(approval|human|operator|release|deploy|ship)/.test(lower)) nodes.push({ id: "approval", label: "Approval", kind: "approval", dependsOn: ["validate"] });

  return {
    name: normalized.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "generated-workflow",
    nodes,
  };
}
