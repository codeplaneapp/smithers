// Coverage for the GitHub REST client rate-limit/retry-header/schema/pagination
// edge branches, the outbound deps-without-context guard, and the OnWebhook
// children render-prop plus the issue/comment/push sugar listeners. Real
// GitHub-REST fixture over HTTP + real renderFrame — no mocks.
import { afterAll, describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { Effect, Schema } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmithers, renderFrame } from "smithers-orchestrator";
import { SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";
import { makeGitHubClient, githubClientLayer, GitHubClient } from "../src/github/GitHubClient.js";
import { OnWebhook, OnIssueOpened, OnIssueComment, OnPush } from "../src/github/components/OnWebhook.js";
import { Comment } from "../src/github/components/outbound.js";

function startFixture() {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      const json = (/** @type {unknown} */ payload, init = {}) =>
        new Response(JSON.stringify(payload), {
          ...init,
          headers: { "content-type": "application/json", .../** @type {any} */ (init).headers },
        });
      if (url.pathname === "/rl-403-remaining0") {
        return json(
          { message: "Forbidden" },
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 1),
            },
          },
        );
      }
      if (url.pathname === "/rl-403-past-reset") {
        return json(
          { message: "Forbidden" },
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) - 100),
            },
          },
        );
      }
      if (url.pathname === "/server-500") {
        return json({ message: "Internal" }, { status: 500, headers: { "retry-after": "later" } });
      }
      if (url.pathname === "/plain-text") {
        return new Response("just plain text, not json", { status: 200 });
      }
      if (url.pathname === "/single-object") {
        return json({ id: 1, name: "solo" });
      }
      if (url.pathname === "/typed") {
        return json({ login: "octocat", id: 583231 });
      }
      return json({ message: "Not Found" }, { status: 404 });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}` };
}

const fixture = startFixture();
afterAll(() => fixture.server.stop(true));

describe("GitHubClient rate-limit + parsing edge branches", () => {
  test("403 with x-ratelimit-remaining=0 is rate-limited and honors x-ratelimit-reset", async () => {
    const client = makeGitHubClient({ token: "t", apiBaseUrl: fixture.url, maxRetries: 0 });
    const error = await Effect.runPromise(client.request("GET", "/rl-403-remaining0").pipe(Effect.flip));
    expect(error.details?.status).toBe(403);
    expect(error.details?.rateLimited).toBe(true);
    expect(error.details?.retryable).toBe(true);
    expect(typeof error.details?.retryAfterMs).toBe("number");
  }, 10_000);

  test("a past x-ratelimit-reset falls through to a null retryAfterMs", async () => {
    const client = makeGitHubClient({ token: "t", apiBaseUrl: fixture.url, maxRetries: 0 });
    const error = await Effect.runPromise(client.request("GET", "/rl-403-past-reset").pipe(Effect.flip));
    expect(error.details?.rateLimited).toBe(true);
    expect(error.details?.retryAfterMs).toBeNull();
  }, 10_000);

  test("retryable 5xx with an unparseable retry-after yields a null retryAfterMs", async () => {
    const client = makeGitHubClient({ token: "t", apiBaseUrl: fixture.url, maxRetries: 0 });
    const error = await Effect.runPromise(client.request("GET", "/server-500").pipe(Effect.flip));
    expect(error.details?.status).toBe(500);
    expect(error.details?.retryable).toBe(true);
    expect(error.details?.retryAfterMs).toBeNull();
  }, 10_000);

  test("a non-JSON success body is returned as raw text", async () => {
    const client = makeGitHubClient({ token: "t", apiBaseUrl: fixture.url });
    const body = await Effect.runPromise(client.request("GET", "/plain-text"));
    expect(body).toBe("just plain text, not json");
  });

  test("paginate wraps a single non-array page object into the items array", async () => {
    const client = makeGitHubClient({ token: "t", apiBaseUrl: fixture.url });
    const items = await Effect.runPromise(client.paginate("/single-object"));
    expect(items).toEqual([{ id: 1, name: "solo" }]);
  });

  test("request decodes the response against an Effect Schema when one is given", async () => {
    const client = makeGitHubClient({ token: "t", apiBaseUrl: fixture.url });
    const user = await Effect.runPromise(
      client.request("GET", "/typed", undefined, {
        schema: Schema.Struct({ login: Schema.String, id: Schema.Number }),
      }),
    );
    expect(user).toEqual({ login: "octocat", id: 583231 });
  });

  test("a response that violates the given schema fails as decode-failed", async () => {
    const client = makeGitHubClient({ token: "t", apiBaseUrl: fixture.url });
    const error = await Effect.runPromise(
      client
        .request("GET", "/typed", undefined, {
          schema: Schema.Struct({ login: Schema.Number }),
        })
        .pipe(Effect.flip),
    );
    expect(error.details?.reason).toBe("decode-failed");
    expect(error.message).toContain("schema validation");
  });

  test("githubClientLayer builds a Layer that provides the client", async () => {
    const layer = githubClientLayer({ token: "t", apiBaseUrl: fixture.url });
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* GitHubClient;
        return typeof client.request;
      }).pipe(Effect.provide(layer)),
    );
    expect(resolved).toBe("function");
  });
});

const NullContext = React.createContext(/** @type {any} */ (null));

function makeApi(schemas) {
  const dir = mkdtempSync(join(tmpdir(), "smithers-gh-cov-"));
  return createSmithers(schemas, { dbPath: join(dir, "db.sqlite") });
}

function render(workflow, ctx) {
  return Effect.runPromise(
    renderFrame(
      workflow,
      new SmithersCtx({
        iteration: 0,
        input: {},
        outputs: {},
        zodToKeyName: workflow.zodToKeyName,
        ...ctx,
      }),
    ),
  );
}

describe("OnWebhook sugar listeners compile to the right signal names", () => {
  test("OnIssueOpened / OnIssueComment / OnPush", async () => {
    const issues = z.object({ action: z.string() }).passthrough();
    const comment = z.object({ action: z.string() }).passthrough();
    const push = z.object({ ref: z.string() }).passthrough();
    const { smithers, Workflow } = makeApi({ issues, comment, push });
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "gh-sugar" },
        React.createElement(OnIssueOpened, { id: "opened", repo: "acme/app", schema: issues }),
        React.createElement(OnIssueComment, { id: "commented", repo: "acme/app", number: 3, schema: comment }),
        React.createElement(OnPush, { id: "pushed", repo: "acme/app", schema: push }),
      ),
    );
    const frame = await render(workflow, { runId: "gh-sugar" });
    const byId = Object.fromEntries(frame.tasks.map((task) => [task.nodeId, task]));
    expect(byId["opened"].meta.__eventName).toBe("integration:github:issues.opened");
    expect(byId["commented"].meta.__eventName).toBe("integration:github:issue_comment.created");
    expect(byId["commented"].meta.__correlationId).toBe("acme/app#3");
    expect(byId["pushed"].meta.__eventName).toBe("integration:github:push");
  });
});

describe("OnWebhook children render-prop", () => {
  test("invokes children with the parsed payload once the signal row exists", async () => {
    const prSchema = z.object({ action: z.string() }).passthrough();
    const { smithers, Workflow } = makeApi({ pr: prSchema });
    /** @type {any[]} */
    const seen = [];
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "gh-children" },
        React.createElement(OnWebhook, {
          id: "pr",
          event: "pull_request",
          schema: prSchema,
          children: (payload) => {
            seen.push(payload);
            return null;
          },
        }),
      ),
    );
    const frame = await render(workflow, {
      runId: "gh-children",
      outputs: { pr: [{ runId: "gh-children", nodeId: "pr", iteration: 0, action: "opened", extra: "x" }] },
    });
    expect(frame.tasks.find((task) => task.nodeId === "pr")).toBeDefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].action).toBe("opened");
  });

  test("renders only the wait node while the signal row is absent", async () => {
    const prSchema = z.object({ action: z.string() }).passthrough();
    const { smithers, Workflow } = makeApi({ pr: prSchema });
    let called = false;
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "gh-children-wait" },
        React.createElement(OnWebhook, {
          id: "pr",
          event: "pull_request",
          schema: prSchema,
          children: () => {
            called = true;
            return null;
          },
        }),
      ),
    );
    const frame = await render(workflow, { runId: "gh-children-wait" });
    expect(frame.tasks.find((task) => task.nodeId === "pr")).toBeDefined();
    expect(called).toBe(false);
  });

  test("children without a workflow context throw loudly", async () => {
    const prSchema = z.object({ action: z.string() }).passthrough();
    const { smithers, Workflow } = makeApi({ pr: prSchema });
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "gh-children-noctx" },
        React.createElement(OnWebhook, {
          id: "pr",
          event: "pull_request",
          schema: prSchema,
          smithersContext: NullContext,
          children: () => null,
        }),
      ),
    );
    await expect(render(workflow, { runId: "gh-children-noctx" })).rejects.toThrow(/workflow context/);
  });
});

describe("github outbound deps guard", () => {
  test("an outbound component with deps but no workflow context throws", async () => {
    const { smithers, Workflow, outputs } = makeApi({
      comment: z.object({ id: z.number(), url: z.string() }),
      note: z.object({ text: z.string() }),
    });
    const workflow = smithers(() =>
      React.createElement(
        Workflow,
        { name: "gh-deps-noctx" },
        React.createElement(Comment, {
          id: "c",
          output: outputs.comment,
          deps: { note: outputs.note },
          smithersContext: NullContext,
          repo: "acme/app",
          number: 1,
          body: "hi",
          __config: { token: "t", apiBaseUrl: fixture.url },
        }),
      ),
    );
    await expect(render(workflow, { runId: "gh-deps-noctx" })).rejects.toThrow(/workflow context/);
  });
});
