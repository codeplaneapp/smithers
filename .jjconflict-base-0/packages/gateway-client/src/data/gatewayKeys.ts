import { smithersCollectionKeys } from "./smithersCollectionKeys.ts";

export const gatewayKeys = {
  workflows: smithersCollectionKeys.workflows,
  runs: smithersCollectionKeys.runs,
  run: smithersCollectionKeys.run,
  devtoolsSnapshot: smithersCollectionKeys.runTree,
  approvals: smithersCollectionKeys.approvals,
  nodeOutput: (runId: string, nodeId: string, iteration = 0) =>
    ["smithers", "nodeOutput", runId, nodeId, iteration] as const,
  nodeDiff: (runId: string, nodeId: string, iteration = 0) =>
    ["smithers", "nodeDiff", runId, nodeId, iteration] as const,
  cronList: smithersCollectionKeys.crons,
  memoryFacts: smithersCollectionKeys.memoryFacts,
  prompts: smithersCollectionKeys.prompts,
  scores: smithersCollectionKeys.scores,
  tickets: smithersCollectionKeys.tickets,
  runEvents: smithersCollectionKeys.events,
  devtools: smithersCollectionKeys.runTree,
} as const;
