import { Effect } from "effect";
import { getLinearClient } from "./client";
import type {
  LinearIssue,
  LinearTeam,
  LinearProject,
  LinearComment,
  LinearIssueStatus,
  ListIssuesParams,
} from "./types";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";

function resolveIssueEffect(node: any) {
  return Effect.gen(function* () {
    const [state, assignee, labels, project] = yield* Effect.all([
      fromPromise("resolve linear issue state", () => node.state),
      fromPromise("resolve linear issue assignee", () => node.assignee),
      fromPromise("resolve linear issue labels", () => node.labels()),
      fromPromise("resolve linear issue project", () => node.project),
    ], { concurrency: "unbounded" });
    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description ?? null,
      priority: node.priority,
      priorityLabel: node.priorityLabel,
      state: state ? { id: state.id, name: state.name, type: state.type } : null,
      assignee: assignee
        ? { id: assignee.id, name: assignee.name, email: assignee.email }
        : null,
      labels: labels.nodes.map((l: any) => ({ id: l.id, name: l.name })),
      project: project ? { id: project.id, name: project.name } : null,
      createdAt: node.createdAt.toISOString(),
      updatedAt: node.updatedAt.toISOString(),
      url: node.url,
    } satisfies LinearIssue;
  }).pipe(
    Effect.annotateLogs({
      issueId: node.id,
      identifier: node.identifier,
    }),
    Effect.withLogSpan("linear:resolve-issue"),
  );
}

export function useLinear() {
  const client = getLinearClient();

  return {
    listIssues(params: ListIssuesParams = {}): Promise<LinearIssue[]> {
      const filter: any = {};
      if (params.teamId) filter.team = { id: { eq: params.teamId } };
      if (params.assigneeId)
        filter.assignee = { id: { eq: params.assigneeId } };
      if (params.stateType) filter.state = { type: { eq: params.stateType } };
      if (params.labels?.length)
        filter.labels = { name: { in: params.labels } };

      return runPromise(
        Effect.gen(function* () {
          const result = yield* fromPromise("list linear issues", () =>
            client.issues({
              filter,
              first: params.limit ?? 50,
            }),
          );
          return yield* Effect.all(
            result.nodes.map((node: any) => resolveIssueEffect(node)),
            { concurrency: "unbounded" },
          );
        }).pipe(
          Effect.annotateLogs({
            teamId: params.teamId ?? "",
            assigneeId: params.assigneeId ?? "",
            stateType: params.stateType ?? "",
            limit: params.limit ?? 50,
          }),
          Effect.withLogSpan("linear:list-issues"),
        ),
      );
    },

    getIssue(idOrIdentifier: string): Promise<LinearIssue> {
      return runPromise(
        Effect.gen(function* () {
          const node = yield* fromPromise("get linear issue", () =>
            client.issue(idOrIdentifier),
          );
          return yield* resolveIssueEffect(node);
        }).pipe(
          Effect.annotateLogs({ idOrIdentifier }),
          Effect.withLogSpan("linear:get-issue"),
        ),
      );
    },

    updateIssueState(
      issueId: string,
      stateId: string,
    ): Promise<boolean> {
      return runPromise(
        fromPromise("update linear issue state", () =>
          client.updateIssue(issueId, { stateId }),
        ).pipe(
          Effect.map((result) => result.success),
          Effect.annotateLogs({ issueId, stateId }),
          Effect.withLogSpan("linear:update-issue-state"),
        ),
      );
    },

    addComment(issueId: string, body: string): Promise<string> {
      return runPromise(
        Effect.gen(function* () {
          const result = yield* fromPromise("create linear comment", () =>
            client.createComment({ issueId, body }),
          );
          const commentRef = result.comment;
          const comment = commentRef
            ? yield* fromPromise("resolve created linear comment", () => commentRef)
            : undefined;
          return comment?.id ?? "";
        }).pipe(
          Effect.annotateLogs({
            issueId,
            bodyLength: body.length,
          }),
          Effect.withLogSpan("linear:add-comment"),
        ),
      );
    },

    listComments(issueId: string): Promise<LinearComment[]> {
      return runPromise(
        Effect.gen(function* () {
          const issue = yield* fromPromise("get linear issue for comments", () =>
            client.issue(issueId),
          );
          const comments = yield* fromPromise("list linear comments", () =>
            issue.comments(),
          );
          return comments.nodes.map((c: any) => ({
            id: c.id,
            body: c.body,
            createdAt: c.createdAt.toISOString(),
            user: c._user ? { id: c._user.id, name: c._user.name } : null,
          }));
        }).pipe(
          Effect.annotateLogs({ issueId }),
          Effect.withLogSpan("linear:list-comments"),
        ),
      );
    },

    listTeams(): Promise<LinearTeam[]> {
      return runPromise(
        fromPromise("list linear teams", () => client.teams()).pipe(
          Effect.map((result) =>
            result.nodes.map((t: any) => ({
              id: t.id,
              name: t.name,
              key: t.key,
              description: t.description ?? null,
            })),
          ),
          Effect.withLogSpan("linear:list-teams"),
        ),
      );
    },

    listProjects(): Promise<LinearProject[]> {
      return runPromise(
        fromPromise("list linear projects", () => client.projects()).pipe(
          Effect.map((result) =>
            result.nodes.map((p: any) => ({
              id: p.id,
              name: p.name,
              description: p.description ?? null,
              state: p.state,
              url: p.url,
            })),
          ),
          Effect.withLogSpan("linear:list-projects"),
        ),
      );
    },

    listIssueStatuses(teamId: string): Promise<LinearIssueStatus[]> {
      return runPromise(
        Effect.gen(function* () {
          const team = yield* fromPromise("get linear team", () =>
            client.team(teamId),
          );
          const states = yield* fromPromise("list linear issue statuses", () =>
            team.states(),
          );
          return states.nodes.map((s: any) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            position: s.position,
          }));
        }).pipe(
          Effect.annotateLogs({ teamId }),
          Effect.withLogSpan("linear:list-issue-statuses"),
        ),
      );
    },
  };
}
