import type { Effect } from "effect";
import type { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/** A Linear priority: 0 none, 1 urgent, 2 high, 3 normal, 4 low — or a name. */
export type LinearPriority = number | "none" | "urgent" | "high" | "normal" | "medium" | "low";

export type LinearTeamRef = { id: string; key?: string; name?: string };

export type LinearIssueResult = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  team?: { id: string; key?: string } | null;
};

export type LinearCommentResult = {
  id: string;
  body: string;
  issue?: { id: string; identifier?: string } | null;
};

export type CreateIssueInput = {
  /** Team key like `ENG` (resolved to a team id via lookup). */
  teamKey?: string;
  /** Team id (skips the lookup). One of teamKey/teamId is required. */
  teamId?: string;
  title: string;
  description?: string;
  priority?: LinearPriority;
  /** Label names (resolved to label ids per team, cached). */
  labels?: string[];
  /** Raw label ids (skip resolution). */
  labelIds?: string[];
  /** Workflow state name like `In Progress` (resolved per team, cached). */
  stateName?: string;
  stateId?: string;
  assigneeId?: string;
  projectId?: string;
  estimate?: number;
  dueDate?: string;
};

export type UpdateIssueFields = {
  title?: string;
  description?: string;
  priority?: LinearPriority;
  labels?: string[];
  labelIds?: string[];
  stateName?: string;
  stateId?: string;
  assigneeId?: string;
  projectId?: string;
  estimate?: number;
  dueDate?: string;
};

/**
 * Plain-fetch Linear GraphQL client (no @linear/sdk). All methods are
 * Effects failing with `IntegrationError` (a SmithersError); 429/5xx
 * responses are retried honoring `Retry-After` /
 * `X-RateLimit-Requests-Reset`. The API key is never logged or embedded in
 * error messages.
 */
export type LinearClientService = {
  /** Raw GraphQL request; resolves with the `data` payload. */
  query: (gql: string, variables?: Record<string, unknown>) => Effect.Effect<any, SmithersError>;
  /** Resolve a team by key (`ENG`) or pass through an explicit id. Cached. */
  resolveTeam: (ref: { teamId?: string; teamKey?: string }) => Effect.Effect<LinearTeamRef, SmithersError>;
  /** Resolve a workflow-state name to its id for a team. Cached per team. */
  resolveStateId: (teamId: string, stateName: string) => Effect.Effect<string, SmithersError>;
  /** Resolve label names to ids for a team. Cached per team. */
  resolveLabelIds: (teamId: string, names: string[]) => Effect.Effect<string[], SmithersError>;
  /** Fetch an issue by UUID or identifier like `ENG-123`. */
  getIssue: (idOrIdentifier: string) => Effect.Effect<LinearIssueResult, SmithersError>;
  createIssue: (input: CreateIssueInput) => Effect.Effect<LinearIssueResult, SmithersError>;
  updateIssue: (idOrIdentifier: string, fields: UpdateIssueFields) => Effect.Effect<LinearIssueResult, SmithersError>;
  commentOnIssue: (idOrIdentifier: string, body: string) => Effect.Effect<LinearCommentResult, SmithersError>;
};
