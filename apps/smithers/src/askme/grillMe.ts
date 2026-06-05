import type { Edge } from "@xyflow/react";
import { workflowToFlow, type WorkflowSpec } from "./workflowFlow";

/**
 * The grill-me workflow as a static diagram: a topic enters a loop that runs a
 * grilling task each iteration until the requirements are resolved. Mirrors the
 * real `.smithers/workflows/grill-me.tsx` (Start → Loop → Grill Task → Resolved).
 */
const GRILL_SPEC: WorkflowSpec = {
  name: "grill-me",
  description: "Interview loop that grills you until the requirements are clear.",
  nodes: [
    { id: "start", label: "Start", kind: "signal", output: "topic", dependsOn: [] },
    {
      id: "loop",
      label: "Grill Loop",
      kind: "loop",
      output: "iterations",
      dependsOn: ["start"],
    },
    {
      id: "grill",
      label: "Grill Task",
      kind: "agent",
      output: "question",
      dependsOn: ["loop"],
    },
    {
      id: "end",
      label: "Resolved",
      kind: "merge",
      output: "shared understanding",
      dependsOn: ["grill"],
    },
  ],
};

const flow = workflowToFlow(GRILL_SPEC);

/** The grilling loop-back edge — added on top of the linear dagre layout. */
const loopBack: Edge = {
  id: "grill->loop",
  source: "grill",
  target: "loop",
  type: "smoothstep",
  animated: true,
  label: "not resolved",
  style: { stroke: "#6d56d8" },
  labelStyle: { fill: "#6d56d8", fontSize: 11, fontWeight: 600 },
};

export const GRILL_NODES = flow.nodes;
export const GRILL_EDGES: Edge[] = [...flow.edges, loopBack];

/**
 * System prompt that turns the chat into the grill-me interview. Adapted from
 * `.smithers/prompts/grill-me.mdx` for a one-question-per-turn browser chat.
 */
export const GRILL_SYSTEM_PROMPT = `You are Smithers running an "Ask Me" interview. Interview the user relentlessly about every aspect of their idea or plan until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one.

Rules:
- Ask exactly ONE question per message. Never bundle multiple questions together.
- For every question, give your own recommended answer and one short line of reasoning.
- Make questions concrete and decision-focused, and build on the user's earlier answers.
- When the requirements are clear enough that you could confidently write a spec, stop asking and summarize the shared understanding instead.`;
