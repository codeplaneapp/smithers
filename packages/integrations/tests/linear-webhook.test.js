import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { computeHmacSha256Hex } from "../src/core/verifySignature.js";
import { makeWebhookSource } from "../src/core/EventSource.js";
import { decodeLinearWebhook, makeLinearWebhookSource, verifyLinearWebhook } from "../src/linear/LinearWebhookSource.js";
import { linearCommentEventSchema, linearIssueEventSchema } from "../src/linear/schemas.js";

const SECRET = "linear-webhook-secret";

/**
 * Realistic Linear issue webhook delivery (shape per Linear docs: action,
 * type, data, updatedFrom on updates, webhookId + webhookTimestamp).
 * @param {Record<string, any>} [overrides]
 */
function issueUpdatePayload(overrides = {}) {
    return {
        action: "update",
        actor: { id: "user-1", name: "Will" },
        createdAt: "2026-07-01T10:00:00.000Z",
        data: {
            id: "issue-uuid-42",
            identifier: "ENG-42",
            title: "Fix login button",
            priority: 2,
            state: { id: "state-in-progress", name: "In Progress", type: "started" },
            team: { id: "team-eng-id", key: "ENG", name: "Engineering" },
            url: "https://linear.app/acme/issue/ENG-42",
        },
        updatedFrom: {
            updatedAt: "2026-07-01T09:59:00.000Z",
            stateId: "state-todo",
            priority: 3,
        },
        url: "https://linear.app/acme/issue/ENG-42",
        type: "Issue",
        organizationId: "org-1",
        webhookTimestamp: Date.now(),
        webhookId: "webhook-config-1",
        ...overrides,
    };
}

/**
 * @param {Record<string, any>} payload
 * @param {{ secret?: string; deliveryId?: string }} [options]
 * @returns {import("../src/core/EventSource.ts").WebhookRequest}
 */
function signedRequest(payload, options = {}) {
    const rawBody = JSON.stringify(payload);
    return {
        headers: {
            "linear-signature": computeHmacSha256Hex(rawBody, options.secret ?? SECRET),
            "linear-event": payload["type"],
            ...(options.deliveryId ? { "linear-delivery": options.deliveryId } : {}),
        },
        rawBody,
    };
}

describe("verifyLinearWebhook", () => {
    test("accepts a correctly signed, fresh delivery", () => {
        expect(verifyLinearWebhook(signedRequest(issueUpdatePayload()), SECRET)).toBe(true);
    });
    test("rejects a bad signature", () => {
        const request = signedRequest(issueUpdatePayload(), { secret: "wrong-secret" });
        expect(verifyLinearWebhook(request, SECRET)).toBe(false);
    });
    test("rejects a stale webhookTimestamp (replay protection, ~1min window)", () => {
        const stale = issueUpdatePayload({ webhookTimestamp: Date.now() - 2 * 60_000 });
        expect(verifyLinearWebhook(signedRequest(stale), SECRET)).toBe(false);
    });
    test("rejects a missing webhookTimestamp", () => {
        const payload = issueUpdatePayload();
        delete payload["webhookTimestamp"];
        expect(verifyLinearWebhook(signedRequest(payload), SECRET)).toBe(false);
    });
    test("tolerates second-precision timestamps", () => {
        const seconds = issueUpdatePayload({ webhookTimestamp: Math.floor(Date.now() / 1000) });
        expect(verifyLinearWebhook(signedRequest(seconds), SECRET)).toBe(true);
    });
});

describe("decodeLinearWebhook", () => {
    test("emits action-specific + base events across identifier/teamKey/null correlations", () => {
        const request = signedRequest(issueUpdatePayload(), { deliveryId: "delivery-1" });
        const events = decodeLinearWebhook(request);
        const shapes = events.map((event) => [event.eventName, event.correlationId]);
        expect(shapes).toEqual([
            ["integration:linear:issue.update", "ENG-42"],
            ["integration:linear:issue.update", "ENG"],
            ["integration:linear:issue.update", null],
            ["integration:linear:issue", "ENG-42"],
            ["integration:linear:issue", "ENG"],
            ["integration:linear:issue", null],
        ]);
        // Every variant of one delivery has a distinct dedupeKey, all rooted
        // in the delivery id so a redelivery collides with the original.
        const keys = events.map((event) => event.dedupeKey);
        expect(new Set(keys).size).toBe(events.length);
        for (const key of keys) {
            expect(key.startsWith("delivery-1#")).toBe(true);
        }
        // Payload passes the typed schema and keeps updatedFrom.
        const parsed = linearIssueEventSchema.parse(events[0].payload);
        expect(parsed.updatedFrom).toMatchObject({ stateId: "state-todo" });
        expect(parsed.data.identifier).toBe("ENG-42");
    });
    test("falls back to webhookId+entity identity when Linear-Delivery is absent", () => {
        const events = decodeLinearWebhook(signedRequest(issueUpdatePayload()));
        expect(events[0].dedupeKey).toContain("webhook-config-1:issue.update".replace(".update", ""));
        expect(events[0].dedupeKey).toContain("issue-uuid-42");
    });
    test("decodes comment webhooks, correlating on the parent issue identifier", () => {
        const payload = issueUpdatePayload({
            action: "create",
            type: "Comment",
            data: {
                id: "comment-uuid-1",
                body: "Looks good",
                issueId: "issue-uuid-42",
                issue: { id: "issue-uuid-42", identifier: "ENG-42", title: "Fix login button", team: { id: "team-eng-id", key: "ENG" } },
            },
            updatedFrom: undefined,
        });
        const events = decodeLinearWebhook(signedRequest(payload));
        expect(events.map((e) => [e.eventName, e.correlationId])).toEqual([
            ["integration:linear:comment.create", "ENG-42"],
            ["integration:linear:comment.create", "ENG"],
            ["integration:linear:comment.create", null],
            ["integration:linear:comment", "ENG-42"],
            ["integration:linear:comment", "ENG"],
            ["integration:linear:comment", null],
        ]);
        const parsed = linearCommentEventSchema.parse(events[0].payload);
        expect(parsed.data.body).toBe("Looks good");
    });
});

describe("makeLinearWebhookSource", () => {
    test("plugs into core makeWebhookSource: verified deliveries enqueue, bad/stale reject", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource(makeLinearWebhookSource({ webhookSecret: SECRET })));
        const accepted = await Effect.runPromise(webhook.offer(signedRequest(issueUpdatePayload())));
        expect(accepted).toEqual({ accepted: 6 });
        const badSignature = await Effect.runPromise(Effect.flip(webhook.offer(signedRequest(issueUpdatePayload(), { secret: "nope" }))));
        expect(badSignature.details?.["reason"]).toBe("invalid-signature");
        const stale = await Effect.runPromise(Effect.flip(webhook.offer(signedRequest(issueUpdatePayload({ webhookTimestamp: Date.now() - 10 * 60_000 })))));
        expect(stale.details?.["reason"]).toBe("invalid-signature");
        await Effect.runPromise(webhook.shutdown);
    });
    test("rejects everything when no webhook secret is configured", async () => {
        const webhook = await Effect.runPromise(makeWebhookSource(makeLinearWebhookSource({})));
        const error = await Effect.runPromise(Effect.flip(webhook.offer(signedRequest(issueUpdatePayload()))));
        expect(error.details?.["reason"]).toBe("invalid-signature");
        await Effect.runPromise(webhook.shutdown);
    });
});
