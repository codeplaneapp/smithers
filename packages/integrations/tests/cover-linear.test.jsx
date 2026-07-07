// Coverage for the Linear GraphQL client's error/retry/resolution branches and
// the Linear component listener render-prop + outbound deps guard. A scripted
// real HTTP GraphQL server (no mocks) returns the exact wire shapes each branch
// needs; the real fetch-based client talks to it.
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { Effect } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmithers, renderFrame } from "smithers-orchestrator";
import { SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";
import { LinearClient, LinearClientLive, makeLinearClient, normalizeLinearPriority } from "../src/linear/LinearClient.js";
import { configureLinear } from "../src/linear/config.js";
import { verifyLinearWebhook, makeLinearWebhookSource, decodeLinearWebhook } from "../src/linear/LinearWebhookSource.js";
import { computeHmacSha256Hex } from "../src/core/verifySignature.js";
import { CreateIssue, OnIssueUpdate } from "../src/linear/components.js";

const API_KEY = "lin_cover_key";

function startScriptServer() {
    /** @type {{ operation: string; variables: any }[]} */
    const requests = [];
    /** @type {Map<string, Array<{ status?: number; headers?: Record<string,string>; data?: any; errors?: any; raw?: string }>>} */
    const scripts = new Map();
    const server = Bun.serve({
        port: 0,
        fetch: async (request) => {
            const body = /** @type {any} */ (await request.json());
            const query = String(body.query ?? "");
            const variables = body.variables ?? {};
            const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "unknown";
            requests.push({ operation, variables });
            const queue = scripts.get(operation);
            const next = queue && queue.length > 0 ? queue.shift() : null;
            if (!next) {
                return Response.json({ errors: [{ message: `no script for ${operation}` }] });
            }
            if (next.raw !== undefined) {
                return new Response(next.raw, {
                    status: next.status ?? 200,
                    headers: { "content-type": "application/json", ...(next.headers ?? {}) },
                });
            }
            const payload = next.errors !== undefined ? { errors: next.errors } : { data: next.data };
            return new Response(JSON.stringify(payload), {
                status: next.status ?? 200,
                headers: { "content-type": "application/json", ...(next.headers ?? {}) },
            });
        },
    });
    return {
        url: `http://localhost:${server.port}`,
        requests,
        /** @param {string} operation */
        script: (operation, response) => {
            const queue = scripts.get(operation) ?? [];
            queue.push(response);
            scripts.set(operation, queue);
        },
        stop: () => server.stop(true),
    };
}

/** @type {ReturnType<typeof startScriptServer>[]} */
const servers = [];
function server() {
    const s = startScriptServer();
    servers.push(s);
    return s;
}
afterEach(() => {
    configureLinear({});
    for (const s of servers.splice(0)) s.stop();
});

function client(url) {
    return makeLinearClient({ apiKey: API_KEY, apiBaseUrl: url });
}

const TEAM = { id: "team-eng-id", key: "ENG", name: "Engineering" };

describe("LinearClientLive layer + priority validation", () => {
    test("LinearClientLive provides a working client service", async () => {
        const s = server();
        s.script("TeamByKey", { data: { teams: { nodes: [TEAM] } } });
        const team = await Effect.runPromise(Effect.gen(function* () {
            const svc = yield* LinearClient;
            return yield* svc.resolveTeam({ teamKey: "ENG" });
        }).pipe(Effect.provide(LinearClientLive({ apiKey: API_KEY, apiBaseUrl: s.url }))));
        expect(team.id).toBe("team-eng-id");
    });
    test("normalizeLinearPriority rejects out-of-range/non-integer numbers and unknown names", () => {
        expect(() => normalizeLinearPriority(3.5)).toThrow(/0-4/);
        expect(() => normalizeLinearPriority(9)).toThrow(/0-4/);
        expect(() => normalizeLinearPriority(-1)).toThrow(/0-4/);
        expect(() => normalizeLinearPriority(/** @type {any} */ ("gigantic"))).toThrow(/Unknown Linear priority/);
    });
});

describe("query retry + HTTP error branches", () => {
    test("retries honoring x-ratelimit-requests-reset when retry-after is unparseable", async () => {
        const s = server();
        s.script("TeamByKey", {
            status: 429,
            headers: { "retry-after": "soon", "x-ratelimit-requests-reset": String(Date.now() + 40) },
        });
        s.script("TeamByKey", { data: { teams: { nodes: [TEAM] } } });
        const team = await Effect.runPromise(client(s.url).resolveTeam({ teamKey: "ENG" }));
        expect(team.id).toBe("team-eng-id");
        expect(s.requests.filter((r) => r.operation === "TeamByKey")).toHaveLength(2);
    }, 10_000);

    test("falls back to exponential backoff when the reset header is non-positive", async () => {
        const s = server();
        s.script("TeamByKey", { status: 500, headers: { "x-ratelimit-requests-reset": "0" } });
        s.script("TeamByKey", { data: { teams: { nodes: [TEAM] } } });
        const team = await Effect.runPromise(client(s.url).resolveTeam({ teamKey: "ENG" }));
        expect(team.id).toBe("team-eng-id");
        expect(s.requests.filter((r) => r.operation === "TeamByKey")).toHaveLength(2);
    }, 10_000);

    test("gives up after MAX_ATTEMPTS on persistent 429s", async () => {
        const s = server();
        for (let i = 0; i < 6; i += 1) {
            s.script("TeamByKey", { status: 429, headers: { "retry-after": "0" } });
        }
        const error = await Effect.runPromise(Effect.flip(client(s.url).resolveTeam({ teamKey: "ENG" })));
        expect(error.message).toMatch(/after \d+ attempts/);
        expect(error.details?.status).toBe(429);
    }, 15_000);

    test("a non-ok, non-retryable status fails with the response errors", async () => {
        const s = server();
        s.script("TeamByKey", { status: 400, errors: [{ message: "Bad Request field" }] });
        const error = await Effect.runPromise(Effect.flip(client(s.url).resolveTeam({ teamKey: "ENG" })));
        expect(error.message).toMatch(/responded 400/);
        expect(error.details?.errors).toEqual(["Bad Request field"]);
    });

    test("a GraphQL errors array surfaces as a delivery-failed error", async () => {
        const s = server();
        s.script("Issue", { data: null, errors: [{ message: "Entity not found" }] });
        const error = await Effect.runPromise(Effect.flip(client(s.url).getIssue("ENG-404")));
        expect(error.message).toContain("Entity not found");
    });

    test("a network error is wrapped as delivery-failed", async () => {
        const dead = makeLinearClient({ apiKey: API_KEY, apiBaseUrl: "http://127.0.0.1:1/graphql" });
        const error = await Effect.runPromise(Effect.flip(dead.query("query Ping { viewer { id } }")));
        expect(error.message).toMatch(/network error/);
    });

    test("a non-JSON response body surfaces as decode-failed", async () => {
        const s = server();
        s.script("TeamByKey", { status: 200, raw: "<html>not json</html>" });
        const error = await Effect.runPromise(Effect.flip(client(s.url).resolveTeam({ teamKey: "ENG" })));
        expect(error.message).toMatch(/non-JSON response/);
    });
});

describe("resolution + mutation failure branches", () => {
    test("resolveTeam requires teamId or teamKey", async () => {
        const s = server();
        const error = await Effect.runPromise(Effect.flip(client(s.url).resolveTeam({})));
        expect(error.message).toMatch(/team is required/);
    });
    test("resolveTeam fails when the key is unknown", async () => {
        const s = server();
        s.script("TeamByKey", { data: { teams: { nodes: [] } } });
        const error = await Effect.runPromise(Effect.flip(client(s.url).resolveTeam({ teamKey: "ZZ" })));
        expect(error.message).toMatch(/with key "ZZ" not found/);
    });
    test("resolveStateId fails when the workflow state name is unknown", async () => {
        const s = server();
        s.script("WorkflowStates", { data: { workflowStates: { nodes: [{ id: "s1", name: "Todo" }] } } });
        const error = await Effect.runPromise(Effect.flip(client(s.url).resolveStateId("team-eng-id", "Nope")));
        expect(error.message).toMatch(/workflow state "Nope" not found/);
    });
    test("resolveLabelIds reports the missing labels (matched ones are collected)", async () => {
        const s = server();
        s.script("IssueLabels", { data: { issueLabels: { nodes: [{ id: "l-bug", name: "Bug" }] } } });
        const error = await Effect.runPromise(Effect.flip(client(s.url).resolveLabelIds("team-eng-id", ["Bug", "Ghost"])));
        expect(error.message).toMatch(/label\(s\) not found for team: Ghost/);
    });
    test("getIssue fails when the issue lookup returns null without an error", async () => {
        const s = server();
        s.script("Issue", { data: { issue: null } });
        const error = await Effect.runPromise(Effect.flip(client(s.url).getIssue("issue-uuid-x")));
        expect(error.message).toMatch(/not found/);
    });
    test("createIssue passes stateId/labelIds through and fails on an unsuccessful mutation", async () => {
        const s = server();
        s.script("IssueCreate", { data: { issueCreate: { success: false } } });
        const error = await Effect.runPromise(Effect.flip(client(s.url).createIssue({
            teamId: "team-eng-id",
            title: "x",
            stateId: "state-1",
            labelIds: ["label-1"],
        })));
        expect(error.message).toMatch(/issueCreate did not return an issue/);
        const create = s.requests.find((r) => r.operation === "IssueCreate");
        expect(create?.variables.input).toMatchObject({ stateId: "state-1", labelIds: ["label-1"], teamId: "team-eng-id" });
    });
    test("updateIssue by UUID fails on an unsuccessful mutation", async () => {
        const s = server();
        s.script("IssueUpdate", { data: { issueUpdate: { success: false } } });
        const error = await Effect.runPromise(Effect.flip(client(s.url).updateIssue("issue-uuid-1", { title: "new" })));
        expect(error.message).toMatch(/issueUpdate did not return an issue/);
    });
    test("commentOnIssue by UUID fails on an unsuccessful mutation", async () => {
        const s = server();
        s.script("CommentCreate", { data: { commentCreate: { success: false } } });
        const error = await Effect.runPromise(Effect.flip(client(s.url).commentOnIssue("issue-uuid-1", "hi")));
        expect(error.message).toMatch(/commentCreate did not return a comment/);
    });
    test("buildIssueInput requires a team to resolve a state NAME or label names", async () => {
        const s = server();
        s.script("Issue", { data: { issue: { id: "issue-uuid-1", identifier: "ENG-1", title: "t", url: "u" } } });
        const stateErr = await Effect.runPromise(Effect.flip(client(s.url).updateIssue("issue-uuid-1", { stateName: "Done" })));
        expect(stateErr.message).toMatch(/state name requires the issue's team/);

        const s2 = server();
        s2.script("Issue", { data: { issue: { id: "issue-uuid-2", identifier: "ENG-2", title: "t", url: "u" } } });
        const labelErr = await Effect.runPromise(Effect.flip(client(s2.url).updateIssue("issue-uuid-2", { labels: ["Bug"] })));
        expect(labelErr.message).toMatch(/label names requires the issue's team/);
    });
});

describe("LinearWebhookSource edge branches", () => {
    const SECRET = "cover-linear-secret";
    test("verifyLinearWebhook rejects a correctly-signed but non-JSON body", () => {
        const rawBody = "this is not json";
        const request = {
            headers: { "linear-signature": computeHmacSha256Hex(rawBody, SECRET) },
            rawBody,
        };
        expect(verifyLinearWebhook(request, SECRET)).toBe(false);
    });
    test("makeLinearWebhookSource verify returns false when no secret is configured", () => {
        configureLinear({});
        const source = makeLinearWebhookSource({ webhookSecret: "" });
        expect(source.verify({ headers: {}, rawBody: "{}" })).toBe(false);
    });
    test("makeLinearWebhookSource decodes a signed delivery", () => {
        const source = makeLinearWebhookSource({ webhookSecret: SECRET, capacity: 8 });
        const payload = { action: "create", type: "Issue", data: { identifier: "ENG-7", team: { key: "ENG" } }, webhookTimestamp: Date.now() };
        const rawBody = JSON.stringify(payload);
        const request = { headers: { "linear-signature": computeHmacSha256Hex(rawBody, SECRET) }, rawBody };
        expect(source.verify(request)).toBe(true);
        const events = source.decode(request);
        expect(events.some((e) => e.correlationId === "ENG-7")).toBe(true);
        expect(decodeLinearWebhook(request).length).toBe(events.length);
    });
});

const NullContext = React.createContext(/** @type {any} */ (null));

function makeApi(schemas) {
    const dir = mkdtempSync(join(tmpdir(), "smithers-lin-cov-"));
    return createSmithers(schemas, { dbPath: join(dir, "db.sqlite") });
}

function render(workflow, ctx) {
    return Effect.runPromise(renderFrame(workflow, new SmithersCtx({
        iteration: 0,
        input: {},
        outputs: {},
        zodToKeyName: workflow.zodToKeyName,
        ...ctx,
    })));
}

describe("Linear listener render-prop branches", () => {
    const payloadSchema = z.object({ action: z.string() }).passthrough();

    test("invokes children with the parsed signal payload once the row exists", async () => {
        const { smithers, Workflow } = makeApi({ upd: payloadSchema });
        /** @type {any[]} */
        const seen = [];
        const workflow = smithers(() => React.createElement(Workflow, { name: "lin-children" },
            React.createElement(OnIssueUpdate, {
                id: "upd",
                issueId: "ENG-1",
                schema: payloadSchema,
                children: (payload) => {
                    seen.push(payload);
                    return null;
                },
            })));
        const frame = await render(workflow, {
            runId: "lin-children",
            outputs: { upd: [{ runId: "lin-children", nodeId: "upd", iteration: 0, action: "update" }] },
        });
        expect(frame.tasks.find((t) => t.nodeId === "upd")).toBeDefined();
        expect(seen[0].action).toBe("update");
    });

    test("renders only the wait node while the signal row is absent", async () => {
        const { smithers, Workflow } = makeApi({ upd: payloadSchema });
        let called = false;
        const workflow = smithers(() => React.createElement(Workflow, { name: "lin-children-wait" },
            React.createElement(OnIssueUpdate, {
                id: "upd",
                issueId: "ENG-1",
                schema: payloadSchema,
                children: () => {
                    called = true;
                    return null;
                },
            })));
        await render(workflow, { runId: "lin-children-wait" });
        expect(called).toBe(false);
    });

    test("children without a workflow context throw", () => {
        expect(() => renderToStaticMarkup(React.createElement(OnIssueUpdate, {
            id: "upd",
            issueId: "ENG-1",
            schema: payloadSchema,
            smithersContext: NullContext,
            children: () => null,
        }))).toThrow(/workflow context/);
    });

    test("children without a schema prop throw", async () => {
        const { smithers, Workflow } = makeApi({ upd: payloadSchema });
        const workflow = smithers(() => React.createElement(Workflow, { name: "lin-children-noschema" },
            React.createElement(OnIssueUpdate, {
                id: "upd",
                issueId: "ENG-1",
                children: () => null,
            })));
        await expect(render(workflow, { runId: "lin-children-noschema" })).rejects.toThrow(/require a `schema`/);
    });
});

describe("Linear outbound deps guard", () => {
    test("an outbound component with deps but no workflow context throws", () => {
        const outputSchema = z.object({ id: z.string(), identifier: z.string(), title: z.string(), url: z.string() });
        expect(() => renderToStaticMarkup(React.createElement(CreateIssue, {
            id: "create",
            output: /** @type {any} */ (outputSchema),
            deps: { note: /** @type {any} */ (z.object({ text: z.string() })) },
            smithersContext: NullContext,
            teamKey: "ENG",
            title: "x",
            config: { apiKey: API_KEY, apiBaseUrl: "http://unused" },
        }))).toThrow(/workflow context/);
    });
});
