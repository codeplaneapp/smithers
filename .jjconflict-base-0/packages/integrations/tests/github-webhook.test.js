import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Effect } from "effect";
import { createTestAdapter, seedWaitingEventRun } from "./helpers.js";
import { makeIntegrationRuntime } from "../src/core/IntegrationRuntime.js";
import { decodeGitHubWebhook, githubWebhookSourceConfig, makeGitHubWebhookSource, } from "../src/github/GitHubWebhookSource.js";
import { GitHubPullRequestEventSchema } from "../src/github/schemas.js";

const SECRET = "gh-webhook-secret";

// Captured-shape GitHub `pull_request.opened` delivery (trimmed to the fields
// the integration reads plus representative extras; real wire format).
const PULL_REQUEST_PAYLOAD = {
    action: "opened",
    number: 7,
    pull_request: {
        id: 1479442,
        number: 7,
        state: "open",
        title: "Add durable webhook ingress",
        body: "Fixes #6",
        draft: false,
        html_url: "https://github.com/acme/app/pull/7",
        user: { login: "octocat", id: 1 },
        head: { ref: "feature/webhooks", sha: "0f1e2d3c4b5a", repo: { full_name: "acme/app" } },
        base: { ref: "main", sha: "a1b2c3d4e5f6" },
    },
    repository: {
        id: 296,
        full_name: "acme/app",
        name: "app",
        owner: { login: "acme", id: 2 },
        default_branch: "main",
    },
    sender: { login: "octocat", id: 1 },
};

/**
 * @param {object} payload
 * @param {{ event?: string; deliveryId?: string; secret?: string }} [options]
 */
function signedRequest(payload, options = {}) {
    const rawBody = JSON.stringify(payload);
    return {
        rawBody,
        headers: {
            "x-github-event": options.event ?? "pull_request",
            "x-github-delivery": options.deliveryId ?? "delivery-0001",
            "x-hub-signature-256": `sha256=${createHmac("sha256", options.secret ?? SECRET).update(rawBody).digest("hex")}`,
        },
    };
}

describe("decodeGitHubWebhook", () => {
    test("fans one pull_request delivery out per (name, correlation) variant", () => {
        const events = decodeGitHubWebhook(signedRequest(PULL_REQUEST_PAYLOAD), 1234);
        const combos = events.map((e) => [e.eventName, e.correlationId]);
        expect(combos).toEqual([
            ["integration:github:pull_request", "acme/app#7"],
            ["integration:github:pull_request", "acme/app"],
            ["integration:github:pull_request", null],
            ["integration:github:pull_request.opened", "acme/app#7"],
            ["integration:github:pull_request.opened", "acme/app"],
            ["integration:github:pull_request.opened", null],
        ]);
        // dedupeKey embeds the variant so redelivery dedupes per variant while
        // one delivery's own fan-out never self-dedupes.
        expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(6);
        expect(events[0].dedupeKey).toBe("delivery-0001:integration:github:pull_request:acme/app#7");
        for (const event of events) {
            expect(event.source).toBe("github");
            expect(event.receivedAtMs).toBe(1234);
            expect(event.payload).toEqual(PULL_REQUEST_PAYLOAD);
            expect(GitHubPullRequestEventSchema.parse(event.payload).pull_request.number).toBe(7);
        }
    });
    test("push (no action, no number) → base name with repo + null correlations", () => {
        const events = decodeGitHubWebhook(signedRequest({
            ref: "refs/heads/main",
            before: "aaa",
            after: "bbb",
            repository: { full_name: "acme/app" },
        }, { event: "push", deliveryId: "delivery-push" }));
        expect(events.map((e) => [e.eventName, e.correlationId])).toEqual([
            ["integration:github:push", "acme/app"],
            ["integration:github:push", null],
        ]);
    });
    test("rejects deliveries missing the event or delivery-id header", () => {
        const request = signedRequest(PULL_REQUEST_PAYLOAD);
        expect(() => decodeGitHubWebhook({ ...request, headers: { ...request.headers, "x-github-event": undefined } })).toThrow(/X-GitHub-Event/);
        expect(() => decodeGitHubWebhook({ ...request, headers: { ...request.headers, "x-github-delivery": undefined } })).toThrow(/X-GitHub-Delivery/);
    });
});

describe("makeGitHubWebhookSource", () => {
    test("verifies X-Hub-Signature-256 with real HMAC and enqueues the fan-out", async () => {
        const webhook = await Effect.runPromise(makeGitHubWebhookSource({ webhookSecret: SECRET }));
        const bad = await Effect.runPromise(webhook.offer({
            ...signedRequest(PULL_REQUEST_PAYLOAD),
            headers: {
                ...signedRequest(PULL_REQUEST_PAYLOAD).headers,
                "x-hub-signature-256": "sha256=" + "0".repeat(64),
            },
        }).pipe(Effect.flip));
        expect(bad.details?.reason).toBe("invalid-signature");
        const accepted = await Effect.runPromise(webhook.offer(signedRequest(PULL_REQUEST_PAYLOAD)));
        expect(accepted).toEqual({ accepted: 6 });
        await Effect.runPromise(webhook.shutdown);
    });
    test("requires a webhook secret", () => {
        expect(() => githubWebhookSourceConfig({ webhookSecret: "" })).toThrow(/webhookSecret/);
    });
});

describe("GitHub webhook → IntegrationRuntime → signal row (end-to-end-ish)", () => {
    const { adapter } = createTestAdapter();
    const runtime = makeIntegrationRuntime({
        adapter,
        webhookSources: [githubWebhookSourceConfig({ webhookSecret: SECRET })],
    });
    afterAll(() => runtime.shutdown());
    test("wakes runs parked on the per-action AND base signal variants", async () => {
        await seedWaitingEventRun(adapter, {
            runId: "run-action",
            signalName: "integration:github:pull_request.opened",
            correlationId: "acme/app#7",
        });
        await seedWaitingEventRun(adapter, {
            runId: "run-base",
            signalName: "integration:github:pull_request",
            correlationId: "acme/app",
        });
        await seedWaitingEventRun(adapter, {
            runId: "run-any",
            signalName: "integration:github:pull_request",
            correlationId: null,
        });
        expect(runtime.hasWebhookSource("github")).toBe(true);
        const result = await runtime.handleWebhook("github", signedRequest(PULL_REQUEST_PAYLOAD, { deliveryId: "delivery-e2e" }));
        expect(result).toEqual({ accepted: 6 });
        const deadline = Date.now() + 5_000;
        /** @type {Record<string, any[]>} */
        let rows = {};
        while (Date.now() < deadline) {
            rows = {
                action: await adapter.listSignals("run-action", { signalName: "integration:github:pull_request.opened" }),
                base: await adapter.listSignals("run-base", { signalName: "integration:github:pull_request" }),
                any: await adapter.listSignals("run-any", { signalName: "integration:github:pull_request" }),
            };
            if (rows.action.length && rows.base.length && rows.any.length)
                break;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(rows.action).toHaveLength(1);
        expect(rows.base).toHaveLength(1);
        expect(rows.any).toHaveLength(1);
        expect(rows.action[0].correlationId).toBe("acme/app#7");
        expect(rows.action[0].receivedBy).toBe("integration:github");
        expect(JSON.parse(rows.action[0].payloadJson).pull_request.title).toBe("Add durable webhook ingress");
        // GitHub redelivery of the same delivery id is fully deduped.
        await runtime.handleWebhook("github", signedRequest(PULL_REQUEST_PAYLOAD, { deliveryId: "delivery-e2e" }));
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(await adapter.listSignals("run-action", { signalName: "integration:github:pull_request.opened" })).toHaveLength(1);
    });
});
