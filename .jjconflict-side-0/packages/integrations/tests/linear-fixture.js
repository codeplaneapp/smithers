// Real Linear GraphQL fixture server (Bun.serve) — deterministic wire-format
// responses for the queries/mutations the Linear client uses. No mocks: the
// client speaks real HTTP + GraphQL JSON to this server.

/**
 * @typedef {{ operation: string; variables: Record<string, any>; authorization: string | null }} RecordedRequest
 */

/**
 * @param {{ rateLimit429Times?: number; retryAfterSeconds?: number }} [options]
 */
export function startLinearFixture(options = {}) {
    let remaining429 = options.rateLimit429Times ?? 0;
    const retryAfterSeconds = options.retryAfterSeconds ?? 0;
    /** @type {RecordedRequest[]} */
    const requests = [];
    /** @type {Map<string, any>} */
    const issues = new Map();
    let issueCounter = 0;
    let commentCounter = 0;

    const TEAMS = [{ id: "team-eng-id", key: "ENG", name: "Engineering" }];
    const STATES = [
        { id: "state-todo", name: "Todo", type: "unstarted" },
        { id: "state-in-progress", name: "In Progress", type: "started" },
        { id: "state-done", name: "Done", type: "completed" },
    ];
    const LABELS = [
        { id: "label-bug", name: "Bug" },
        { id: "label-infra", name: "Infra" },
    ];

    /** @param {any} issue */
    const issueView = (issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        team: { id: issue.teamId, key: "ENG" },
    });

    const server = Bun.serve({
        port: 0,
        fetch: async (request) => {
            if (request.method !== "POST") {
                return new Response("method not allowed", { status: 405 });
            }
            const body = /** @type {any} */ (await request.json());
            const query = String(body.query ?? "");
            const variables = body.variables ?? {};
            const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "unknown";
            requests.push({
                operation,
                variables,
                authorization: request.headers.get("authorization"),
            });
            if (remaining429 > 0) {
                remaining429 -= 1;
                return new Response(JSON.stringify({ errors: [{ message: "Rate limited" }] }), {
                    status: 429,
                    headers: {
                        "Content-Type": "application/json",
                        "Retry-After": String(retryAfterSeconds),
                    },
                });
            }
            /** @param {any} data */
            const ok = (data) => Response.json({ data });
            /** @param {string} message */
            const gqlError = (message) => Response.json({ errors: [{ message }] });
            switch (operation) {
                case "TeamByKey": {
                    const nodes = TEAMS.filter((team) => team.key === variables.key);
                    return ok({ teams: { nodes } });
                }
                case "WorkflowStates":
                    return variables.teamId === "team-eng-id"
                        ? ok({ workflowStates: { nodes: STATES } })
                        : ok({ workflowStates: { nodes: [] } });
                case "IssueLabels":
                    return variables.teamId === "team-eng-id"
                        ? ok({ issueLabels: { nodes: LABELS } })
                        : ok({ issueLabels: { nodes: [] } });
                case "Issue": {
                    const issue = issues.get(variables.id) ??
                        [...issues.values()].find((entry) => entry.identifier === variables.id);
                    return issue
                        ? ok({ issue: issueView(issue) })
                        : gqlError(`Entity not found: Issue - ${variables.id}`);
                }
                case "IssueCreate": {
                    const input = variables.input ?? {};
                    if (!input.teamId || !TEAMS.some((team) => team.id === input.teamId)) {
                        return gqlError("Argument Validation Error: teamId");
                    }
                    issueCounter += 1;
                    const id = `issue-uuid-${issueCounter}`;
                    const issue = {
                        id,
                        identifier: `ENG-${issueCounter}`,
                        title: input.title,
                        url: `https://linear.app/acme/issue/ENG-${issueCounter}`,
                        teamId: input.teamId,
                        ...input,
                    };
                    issues.set(id, issue);
                    return ok({ issueCreate: { success: true, issue: issueView(issue) } });
                }
                case "IssueUpdate": {
                    const issue = issues.get(variables.id);
                    if (!issue) {
                        return gqlError(`Entity not found: Issue - ${variables.id}`);
                    }
                    Object.assign(issue, variables.input ?? {});
                    return ok({ issueUpdate: { success: true, issue: issueView(issue) } });
                }
                case "CommentCreate": {
                    const input = variables.input ?? {};
                    const issue = issues.get(input.issueId);
                    if (!issue) {
                        return gqlError(`Entity not found: Issue - ${input.issueId}`);
                    }
                    commentCounter += 1;
                    return ok({
                        commentCreate: {
                            success: true,
                            comment: {
                                id: `comment-uuid-${commentCounter}`,
                                body: input.body,
                                issue: { id: issue.id, identifier: issue.identifier },
                            },
                        },
                    });
                }
                default:
                    return gqlError(`Unknown operation: ${operation}`);
            }
        },
    });

    return {
        url: `http://localhost:${server.port}`,
        requests,
        issues,
        /** @param {string} operation */
        requestCount: (operation) => requests.filter((entry) => entry.operation === operation).length,
        stop: () => server.stop(true),
    };
}
