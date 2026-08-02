import type {
  CronListRequest,
  ListApprovalsRequest,
  ListDocsRequest,
  ListMemoryFactsRequest,
  ListRunsRequest,
  ListScoresRequest,
  ListTicketsRequest,
  ListWorkflowsRequest,
} from "@smthrs/protocol/gateway-rpc";

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
};

export const smithersCollectionKeys = {
  all: ["smithers"] as const,
  runs: (params: ListRunsRequest = {}) => ["smithers", "runs", stable(params)] as const,
  run: (runId: string) => ["smithers", "runs", runId] as const,
  runTree: (runId: string) => ["smithers", "runTree", runId] as const,
  events: (runId: string, limit?: number) => ["smithers", "events", runId, limit ?? null] as const,
  approvals: (params: ListApprovalsRequest = {}) => ["smithers", "approvals", stable(params)] as const,
  workflows: (params: ListWorkflowsRequest = {}) => ["smithers", "workflows", stable(params)] as const,
  docs: (params: ListDocsRequest = {}) => ["smithers", "docs", stable(params)] as const,
  prompts: () => ["smithers", "prompts"] as const,
  scores: (params: ListScoresRequest = { runId: "" }) => ["smithers", "scores", stable(params)] as const,
  tickets: (params: ListTicketsRequest = {}) => ["smithers", "tickets", stable(params)] as const,
  memoryFacts: (params: ListMemoryFactsRequest = {}) => ["smithers", "memoryFacts", stable(params)] as const,
  crons: (params: CronListRequest = {}) => ["smithers", "crons", stable(params)] as const,
};
