export type ClaudeWorkflowGeneratorOptions = {
  workflowPath: string;
  outputPath: string;
  workflowName: string;
  phasePlan: {
    phases: readonly { title: string; detail?: string }[];
    nodes: readonly { nodeId: string; label: string; phase: string; kind: string }[];
  };
  mirrorAllNodes: boolean;
  collapsePhases: boolean;
};
