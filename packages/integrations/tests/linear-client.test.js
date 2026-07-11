import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { startLinearFixture } from "./linear-fixture.js";
import { configureLinear } from "../src/linear/config.js";
import { makeLinearClient, normalizeLinearPriority } from "../src/linear/LinearClient.js";

const API_KEY = "lin_api_test_key_do_not_log";

/** @type {ReturnType<typeof startLinearFixture>[]} */
const fixtures = [];

/** @param {Parameters<typeof startLinearFixture>[0]} [options] */
function fixture(options) {
    const started = startLinearFixture(options);
    fixtures.push(started);
    return started;
}

afterEach(() => {
    configureLinear({});
    for (const started of fixtures.splice(0)) {
        started.stop();
    }
});

describe("normalizeLinearPriority", () => {
    test("ports eliza's priority vocabulary and validates numbers", () => {
        expect(normalizeLinearPriority("urgent")).toBe(1);
        expect(normalizeLinearPriority("high")).toBe(2);
        expect(normalizeLinearPriority("normal")).toBe(3);
        expect(normalizeLinearPriority("medium")).toBe(3);
        expect(normalizeLinearPriority("low")).toBe(4);
        expect(normalizeLinearPriority("none")).toBe(0);
        expect(normalizeLinearPriority(2)).toBe(2);
        expect(normalizeLinearPriority(undefined)).toBeUndefined();
        expect(() => normalizeLinearPriority(7)).toThrow();
        expect(() => normalizeLinearPriority(/** @type {any} */ ("blocker"))).toThrow();
    });
});

describe("LinearClient", () => {
    test("createIssue resolves teamKey/stateName/labels/priority and returns the identifier", async () => {
        const server = fixture();
        const client = makeLinearClient({ apiKey: API_KEY, apiBaseUrl: server.url });
        const issue = await Effect.runPromise(client.createIssue({
            teamKey: "ENG",
            title: "Fix login button",
            description: "Broken on mobile",
            priority: "high",
            stateName: "in progress",
            labels: ["bug"],
        }));
        expect(issue.identifier).toBe("ENG-1");
        expect(issue.url).toContain("ENG-1");
        const create = server.requests.find((r) => r.operation === "IssueCreate");
        expect(create?.variables["input"]).toMatchObject({
            teamId: "team-eng-id",
            title: "Fix login button",
            description: "Broken on mobile",
            priority: 2,
            stateId: "state-in-progress",
            labelIds: ["label-bug"],
        });
        // API key goes raw in Authorization (Linear personal key style).
        expect(create?.authorization).toBe(API_KEY);
        // Lookups are cached per client: a second create re-uses team/state/label lookups.
        await Effect.runPromise(client.createIssue({ teamKey: "ENG", title: "Second", stateName: "Todo", labels: ["Infra"] }));
        expect(server.requestCount("TeamByKey")).toBe(1);
        expect(server.requestCount("WorkflowStates")).toBe(1);
        expect(server.requestCount("IssueLabels")).toBe(1);
        expect(server.requestCount("IssueCreate")).toBe(2);
    });

    test("updateIssue accepts an ENG-123 identifier and resolves state names via the issue's team", async () => {
        const server = fixture();
        const client = makeLinearClient({ apiKey: API_KEY, apiBaseUrl: server.url });
        await Effect.runPromise(client.createIssue({ teamKey: "ENG", title: "To update" }));
        const updated = await Effect.runPromise(client.updateIssue("ENG-1", { stateName: "Done", priority: "urgent" }));
        expect(updated.identifier).toBe("ENG-1");
        const update = server.requests.find((r) => r.operation === "IssueUpdate");
        expect(update?.variables["id"]).toBe("issue-uuid-1");
        expect(update?.variables["input"]).toMatchObject({ stateId: "state-done", priority: 1 });
    });

    test("commentOnIssue resolves the identifier to the issue id", async () => {
        const server = fixture();
        const client = makeLinearClient({ apiKey: API_KEY, apiBaseUrl: server.url });
        await Effect.runPromise(client.createIssue({ teamKey: "ENG", title: "To comment" }));
        const comment = await Effect.runPromise(client.commentOnIssue("ENG-1", "LGTM"));
        expect(comment.body).toBe("LGTM");
        expect(comment.issue?.identifier).toBe("ENG-1");
        const create = server.requests.find((r) => r.operation === "CommentCreate");
        expect(create?.variables["input"]).toEqual({ issueId: "issue-uuid-1", body: "LGTM" });
    });

    test("retries 429 responses honoring Retry-After, then succeeds", async () => {
        const server = fixture({ rateLimit429Times: 1, retryAfterSeconds: 0 });
        const client = makeLinearClient({ apiKey: API_KEY, apiBaseUrl: server.url });
        const issue = await Effect.runPromise(client.createIssue({ teamId: "team-eng-id", title: "Rate limited once" }));
        expect(issue.identifier).toBe("ENG-1");
        // First request 429'd and was retried.
        expect(server.requests.length).toBe(2);
    });

    test("surfaces GraphQL errors as IntegrationError without leaking the API key", async () => {
        const server = fixture();
        const client = makeLinearClient({ apiKey: API_KEY, apiBaseUrl: server.url });
        const error = await Effect.runPromise(Effect.flip(client.getIssue("ENG-999")));
        expect(error.name).toBe("IntegrationError");
        expect(error.message).toContain("Entity not found");
        expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(API_KEY);
    });

    test.each([
        ["GraphQL error", 200],
        ["HTTP error", 403],
    ])("redacts provider-reflected credentials from a %s", async (_label, status) => {
        const reflected = Bun.serve({
            port: 0,
            fetch: (request) => {
                const authorization = request.headers.get("authorization") ?? "";
                return Response.json({
                    errors: [{
                        message: `denied reflected=${authorization} raw=${authorization.replace(/^Bearer\s+/, "")}`,
                    }],
                }, { status });
            },
        });
        try {
            const apiKey = "Bearer linear-provider-secret";
            const client = makeLinearClient({
                apiKey,
                apiBaseUrl: `http://localhost:${reflected.port}`,
            });
            const error = await Effect.runPromise(Effect.flip(
                client.query("query Viewer { viewer { id } }"),
            ));
            const serialized = JSON.stringify({
                message: error.message,
                summary: error.summary,
                details: error.details,
                cause: error.cause instanceof Error
                    ? { name: error.cause.name, message: error.cause.message }
                    : error.cause,
            });
            expect(serialized).not.toContain("linear-provider-secret");
            expect(serialized).not.toContain(apiKey);
            expect(serialized).toContain("[REDACTED]");
        } finally {
            reflected.stop(true);
        }
    });

    test("fails fast with a clear error when no API key is configured", async () => {
        const server = fixture();
        configureLinear({});
        const client = makeLinearClient({ apiBaseUrl: server.url });
        const error = await Effect.runPromise(Effect.flip(client.query("query { viewer { id } }")));
        expect(error.message).toContain("SMITHERS_LINEAR_API_KEY");
        expect(server.requests.length).toBe(0);
    });

    test("configureLinear registry and explicit config both reach the client", async () => {
        const server = fixture();
        configureLinear({ apiKey: API_KEY, apiBaseUrl: server.url });
        const client = makeLinearClient();
        await Effect.runPromise(client.resolveTeam({ teamKey: "ENG" }));
        expect(server.requests[0]?.authorization).toBe(API_KEY);
    });
});
