import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseListenerRegistry,
  planGitHubListenerReconciliation,
  readListenerRegistry,
  reconcileGitHubListeners,
} from "../src/github/ListenerRegistry.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const listener = (overrides = {}) => ({
  id: "github-issues",
  provider: "github",
  repository: "acme/app",
  events: ["issues", "issue_comment"],
  workflow: "github-issues",
  callbackUrl: "https://gateway.example/webhooks/github-issues",
  secretEnv: "TEST_GITHUB_WEBHOOK_SECRET",
  active: true,
  ...overrides,
});

const registry = (listeners = [listener()]) => ({ version: 1, listeners });
const hook = (overrides = {}) => ({
  id: 41,
  active: true,
  events: ["issue_comment", "issues"],
  config: {
    url: "https://gateway.example/webhooks/github-issues",
    content_type: "json",
    insecure_ssl: "0",
  },
  ...overrides,
});

describe("GitHub listener registry", () => {
  test("parses the workspace file and applies defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-listeners-"));
    roots.push(root);
    mkdirSync(join(root, ".smithers"));
    const raw = registry([{ ...listener(), active: undefined }]);
    writeFileSync(join(root, ".smithers/listeners.json"), JSON.stringify(raw));
    expect(readListenerRegistry(root).listeners[0].active).toBe(true);
  });

  test("reports user-facing JSON and schema paths", () => {
    expect(() => parseListenerRegistry("{", "custom.json")).toThrow(/custom\.json is not valid JSON/);
    expect(() =>
      parseListenerRegistry(
        registry([listener({ repository: "not-a-repo", callbackUrl: "http://unsafe/webhooks/github-issues" })]),
      ),
    ).toThrow(/listeners\[0\]\.repository|repository/);
    expect(() => parseListenerRegistry(registry([listener(), listener()]))).toThrow(/duplicate listener id/);
    // The Gateway route is /^\/webhooks\/([^/]+)$/, so a trailing slash names
    // a path GitHub could only ever get a 404 from.
    expect(() =>
      parseListenerRegistry(registry([listener({ callbackUrl: "https://gateway.example/webhooks/github-issues/" })])),
    ).toThrow(/path must be \/webhooks\/github-issues/);
  });

  test("reports each unowned hook once per repository, never twice and never beside its conflict", () => {
    const listeners = [
      listener({ id: "one", workflow: "one", callbackUrl: "https://gateway.example/webhooks/one" }),
      listener({ id: "two", workflow: "two", callbackUrl: "https://gateway.example/webhooks/two" }),
    ];
    const actions = planGitHubListenerReconciliation({
      registry: registry(listeners),
      state: { version: 1, github: [] },
      hooksByRepository: {
        "acme/app": [
          hook({ id: 7, config: { url: "https://someone.example/hook" } }),
          hook({ id: 8, config: { url: "https://gateway.example/webhooks/two" } }),
        ],
      },
    });
    expect(actions.filter((action) => action.action === "leave")).toEqual([
      expect.objectContaining({ hookId: 7, repository: "acme/app" }),
    ]);
    expect(actions.filter((action) => action.action === "conflict")).toEqual([
      expect.objectContaining({ hookId: 8, listenerId: "two" }),
    ]);
  });

  test("plans create, update, delete, idempotent noop, conflict, and leaves unowned hooks alone", () => {
    const current = listener();
    const state = {
      version: 1,
      github: [
        { listenerId: current.id, repository: current.repository, hookId: 41, callbackUrl: current.callbackUrl },
        { listenerId: "removed", repository: current.repository, hookId: 42, callbackUrl: "https://old.example/hook" },
      ],
    };
    const remote = {
      "acme/app": [
        hook({ active: false }),
        hook({ id: 42, config: { url: "https://old.example/hook" } }),
        hook({ id: 99, config: { url: "https://someone.example/hook" } }),
      ],
    };
    const actions = planGitHubListenerReconciliation({ registry: registry(), state, hooksByRepository: remote });
    expect(actions).toContainEqual(expect.objectContaining({ action: "update", listenerId: current.id, hookId: 41 }));
    expect(actions).toContainEqual(
      expect.objectContaining({ action: "delete", listenerId: "removed", hookId: 42, destructive: true }),
    );
    expect(actions).toContainEqual(expect.objectContaining({ action: "leave", hookId: 99 }));

    const matching = planGitHubListenerReconciliation({
      registry: registry(),
      state: { version: 1, github: [state.github[0]] },
      hooksByRepository: { "acme/app": [hook()] },
    });
    expect(matching).toEqual([expect.objectContaining({ action: "noop", hookId: 41 })]);

    const create = planGitHubListenerReconciliation({
      registry: registry(),
      state: { version: 1, github: [] },
      hooksByRepository: { "acme/app": [] },
    });
    expect(create).toEqual([expect.objectContaining({ action: "create", listenerId: current.id })]);
    const conflict = planGitHubListenerReconciliation({
      registry: registry(),
      state: { version: 1, github: [] },
      hooksByRepository: { "acme/app": [hook()] },
    });
    expect(conflict).toEqual([expect.objectContaining({ action: "conflict", hookId: 41 })]);
  });
});

function startGitHubFixture({ denied = false } = {}) {
  let hooks = [];
  const requests = [];
  let nextId = 100;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json();
      requests.push({
        method: request.method,
        path: url.pathname,
        body,
        authorization: request.headers.get("authorization"),
      });
      const json = (value, status = 200) => Response.json(value, { status });
      if (url.pathname === "/repos/acme/app/hooks" && request.method === "GET") {
        return denied ? json({ message: "Resource not accessible by personal access token" }, 403) : json(hooks);
      }
      if (url.pathname === "/repos/acme/app/hooks" && request.method === "POST") {
        const created = {
          id: nextId++,
          active: body.active,
          events: body.events,
          config: { ...body.config, secret: undefined },
        };
        hooks.push(created);
        return json(created, 201);
      }
      const match = url.pathname.match(/^\/repos\/acme\/app\/hooks\/(\d+)$/);
      if (match && request.method === "PATCH") {
        const id = Number(match[1]);
        hooks = hooks.map((existing) =>
          existing.id === id
            ? { id, active: body.active, events: body.events, config: { ...body.config, secret: undefined } }
            : existing,
        );
        return json(hooks.find((existing) => existing.id === id));
      }
      if (match && request.method === "DELETE") {
        hooks = hooks.filter((existing) => existing.id !== Number(match[1]));
        return new Response(null, { status: 204 });
      }
      return json({ message: "Not Found" }, 404);
    },
  });
  return {
    server,
    requests,
    get hooks() {
      return hooks;
    },
    setHooks(nextHooks) {
      hooks = nextHooks;
    },
    url: `http://127.0.0.1:${server.port}`,
  };
}

describe("GitHub listener reconciliation over the real REST client", () => {
  test("dry-runs by default, applies explicitly, and re-reconciles idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-listeners-"));
    roots.push(root);
    mkdirSync(join(root, ".smithers"));
    writeFileSync(join(root, ".smithers/listeners.json"), JSON.stringify(registry()));
    const fixture = startGitHubFixture();
    try {
      const options = {
        workspaceRoot: root,
        token: "token-never-log",
        apiBaseUrl: fixture.url,
        env: { TEST_GITHUB_WEBHOOK_SECRET: "secret-never-log" },
      };
      const dryRun = await reconcileGitHubListeners(options);
      expect(dryRun.actions).toContainEqual(expect.objectContaining({ action: "create" }));
      expect(fixture.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
      expect(() => readFileSync(join(root, ".smithers/listeners.state.json"))).toThrow();

      const applied = await reconcileGitHubListeners({ ...options, apply: true });
      expect(applied.applied).toHaveLength(1);
      expect(fixture.hooks).toHaveLength(1);
      const stateText = readFileSync(join(root, ".smithers/listeners.state.json"), "utf8");
      expect(stateText).not.toContain("secret-never-log");
      expect(stateText).not.toContain("token-never-log");

      const repeated = await reconcileGitHubListeners({ ...options, apply: true });
      expect(repeated.actions).toContainEqual(expect.objectContaining({ action: "noop" }));
      expect(repeated.applied).toHaveLength(0);
      expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(1);

      fixture.setHooks([
        { ...fixture.hooks[0], active: false },
        hook({ id: 999, config: { url: "https://someone.example/hook" } }),
      ]);
      const updated = await reconcileGitHubListeners({ ...options, apply: true });
      expect(updated.applied).toContainEqual(expect.objectContaining({ action: "update", hookId: 100 }));
      expect(fixture.hooks.find((remote) => remote.id === 100)?.active).toBe(true);
      expect(fixture.hooks.some((remote) => remote.id === 999)).toBe(true);

      writeFileSync(join(root, ".smithers/listeners.json"), JSON.stringify(registry([])));
      const deletePlan = await reconcileGitHubListeners({ ...options, apply: true });
      expect(deletePlan.skipped).toContainEqual(expect.objectContaining({ action: "delete", hookId: 100 }));
      expect(fixture.hooks.some((remote) => remote.id === 100)).toBe(true);

      const deleted = await reconcileGitHubListeners({ ...options, apply: true, allowDelete: true });
      expect(deleted.applied).toContainEqual(expect.objectContaining({ action: "delete", hookId: 100 }));
      expect(fixture.hooks.map((remote) => remote.id)).toEqual([999]);
    } finally {
      fixture.server.stop(true);
    }
  });

  test("preflights missing credentials and permissions before mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-listeners-"));
    roots.push(root);
    mkdirSync(join(root, ".smithers"));
    writeFileSync(join(root, ".smithers/listeners.json"), JSON.stringify(registry()));
    // An explicit `env` replaces the ambient one: a GITHUB_TOKEN that happens
    // to be exported must never silently pick the account whose repository
    // webhooks get mutated.
    const ambientToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ambient-token-must-not-be-used";
    try {
      await expect(reconcileGitHubListeners({ workspaceRoot: root, token: "", env: {} })).rejects.toThrow(
        /requires SMITHERS_GITHUB_TOKEN/,
      );
    } finally {
      if (ambientToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = ambientToken;
    }
    await expect(
      reconcileGitHubListeners({ workspaceRoot: root, token: "present", apply: true, env: {} }),
    ).rejects.toThrow(/TEST_GITHUB_WEBHOOK_SECRET/);
    const fixture = startGitHubFixture({ denied: true });
    try {
      await expect(
        reconcileGitHubListeners({
          workspaceRoot: root,
          token: "present",
          apiBaseUrl: fixture.url,
          env: { TEST_GITHUB_WEBHOOK_SECRET: "present" },
        }),
      ).rejects.toThrow(/Webhooks read\/write/);
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.server.stop(true);
    }
  });
});
